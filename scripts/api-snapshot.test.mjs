// Tests for scripts/api-snapshot.mjs — run: node --test scripts/api-snapshot.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, compare, shapeOf } from './api-snapshot.mjs';

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema) => ({ content: { 'application/json': { schema } } });

/** A small API that exercises refs, arrays of objects, nested refs, recursion, enums, nullability and constraints. */
function fixture() {
  return {
    openapi: '3.0.0',
    info: { title: 'Fixture', version: '1' },
    paths: {
      '/api/v1/items': {
        post: {
          operationId: 'ItemsController_create',
          tags: ['Items'],
          'x-roles': ['ADMIN', 'MENTOR'],
          security: [{ bearer: [] }],
          parameters: [{ name: 'dryRun', in: 'query', required: false, schema: { type: 'boolean' } }],
          requestBody: { required: true, ...json(ref('CreateItemDto')) },
          responses: {
            201: json({
              type: 'object',
              required: ['id', 'tags', 'owner'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: ['DRAFT', 'PUBLISHED'] },
                score: { type: 'integer', nullable: true },
                count: { type: 'integer' },
                tags: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, weight: { type: 'number' } } } },
                owner: ref('Owner'),
              },
            }),
            400: json(ref('Error')),
          },
        },
      },
      '/api/v1/items/{id}': {
        get: {
          operationId: 'ItemsController_findOne',
          tags: ['Items'],
          'x-roles': ['STUDENT', 'ADMIN'],
          security: [{ bearer: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'view', in: 'query', required: false, schema: { type: 'string', enum: ['full', 'summary'] } },
          ],
          responses: { 200: json(ref('Owner')) },
        },
      },
    },
    components: {
      schemas: {
        CreateItemDto: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', maxLength: 100 },
            kind: { type: 'string', enum: ['NOTE', 'BOOK'] },
            count: { type: 'integer', minimum: 0 },
            note: { type: 'string', nullable: true },
            meta: { type: 'object', properties: { source: { type: 'string' } } },
          },
        },
        Owner: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, profile: ref('Profile') } },
        Profile: { type: 'object', properties: { displayName: { type: 'string' }, parent: ref('Profile') } },
        Error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  };
}

function diff(mutate) {
  const before = fixture();
  const after = structuredClone(before);
  mutate(after);
  return compare(buildSnapshot(before), buildSnapshot(after));
}
const S = (doc) => doc.components.schemas;
const createResp = (doc) => doc.paths['/api/v1/items'].post.responses[201].content['application/json'].schema;
const has = (list, ...parts) => list.some((l) => parts.every((p) => l.includes(p)));
const none = (res) => res.breaking.length === 0 && res.review.length === 0 && res.additive.length === 0;

/** Saved contract snapshots (docs/baseline). CURRENT_SNAPSHOT is the latest approved contract. */
const P0_03_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-08.json';
const P1_04_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-09-p1-04.json';
const P1_05_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-09-p1-05.json';
const P1_06_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-06.json';
const P1_08_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-08.json';
const P1_09_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-09.json';
const P1_10_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-10.json';
const P1_10_H4_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-10-h4.json';
const P1_10_MONITORING_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-10-monitoring.json';
const P1_11_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-11.json';
const SCHOOL_AFFILIATION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-school-affiliation.json';
const AFFILIATION_HARDENING_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-11-affiliation-hardening.json';
const SCHOOL_ADMINISTRATION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-11-school-administration.json';
const SCHOOL_CLAIMS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-11-school-claims.json';
const SCHOOL_IMPORT_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-11-school-import.json';
const SCHOOL_DIRECTORY_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-11-school-directory.json';
const SCHOOL_SYNC_STAGING_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-11-school-sync-staging.json';
const SCHOOL_SYNC_APPLY_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-11-school-sync-apply.json';
const API_CAPABILITIES_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-12-api-capabilities.json';
const YEAR_ACTIVATION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-13-year-activation.json';
const LOGOUT_SESSION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-13-logout-session.json';
const REVIEW_QUEUE_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-14-review-queue.json';
const REPORT_FILTERS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-14-report-export-filters.json';
const LIST_FILTERS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-14-assignment-list-filters.json';
const EMAIL_DELIVERIES_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-14-email-deliveries.json';
const CODELESS_SCHOOLS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-14-codeless-schools.json';
const RELEASE_PERMISSIONS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-14-release-permissions.json';
const SCHOOL_VERIFICATION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-14-school-verification.json';
const POST_PHASE1_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-14-post-phase1.json';
const REGISTRATION_DETAILS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-15-registration-details.json';
/**
 * Registration details (owner approval as a baseline pending): optional student fields (date of birth, phones, own
 * country, official home place; homeLocation optional with the home place) and coach application fields (country,
 * occupation, education level, Olympiad interests); the profile and admin user responses return the student fields.
 * Additive only; chained after the post-Phase-1 bundle.
 */
const REGISTRATION_DETAILS_ADDITIONS = [
  'GET /api/v1/admin/users › response 200 application/json.data[].country: new field',
  'GET /api/v1/admin/users › response 200 application/json.data[].dateOfBirth: new field',
  'GET /api/v1/admin/users › response 200 application/json.data[].guardianPhone: new field',
  'GET /api/v1/admin/users › response 200 application/json.data[].homeDistrict: new field',
  'GET /api/v1/admin/users › response 200 application/json.data[].homeProvince: new field',
  'GET /api/v1/admin/users › response 200 application/json.data[].homeSector: new field',
  'GET /api/v1/admin/users › response 200 application/json.data[].phone: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.country: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.dateOfBirth: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.guardianPhone: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.homeDistrict: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.homeProvince: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.homeSector: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.phone: new field',
  'GET /api/v1/me › response 200 application/json.country: new field',
  'GET /api/v1/me › response 200 application/json.dateOfBirth: new field',
  'GET /api/v1/me › response 200 application/json.guardianPhone: new field',
  'GET /api/v1/me › response 200 application/json.homeDistrict: new field',
  'GET /api/v1/me › response 200 application/json.homeProvince: new field',
  'GET /api/v1/me › response 200 application/json.homeSector: new field',
  'GET /api/v1/me › response 200 application/json.phone: new field',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.country: new field',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.dateOfBirth: new field',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.guardianPhone: new field',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.homeDistrict: new field',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.homeProvince: new field',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.homeSector: new field',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.phone: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.country: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.dateOfBirth: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.guardianPhone: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.homeDistrict: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.homeProvince: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.homeSector: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.phone: new field',
  'PATCH /api/v1/me › response 200 application/json.country: new field',
  'PATCH /api/v1/me › response 200 application/json.dateOfBirth: new field',
  'PATCH /api/v1/me › response 200 application/json.guardianPhone: new field',
  'PATCH /api/v1/me › response 200 application/json.homeDistrict: new field',
  'PATCH /api/v1/me › response 200 application/json.homeProvince: new field',
  'PATCH /api/v1/me › response 200 application/json.homeSector: new field',
  'PATCH /api/v1/me › response 200 application/json.phone: new field',
  'POST /api/v1/admin/users › response 201 application/json.country: new field',
  'POST /api/v1/admin/users › response 201 application/json.dateOfBirth: new field',
  'POST /api/v1/admin/users › response 201 application/json.guardianPhone: new field',
  'POST /api/v1/admin/users › response 201 application/json.homeDistrict: new field',
  'POST /api/v1/admin/users › response 201 application/json.homeProvince: new field',
  'POST /api/v1/admin/users › response 201 application/json.homeSector: new field',
  'POST /api/v1/admin/users › response 201 application/json.phone: new field',
  'POST /api/v1/admin/users/invite › response 201 application/json.user.country: new field',
  'POST /api/v1/admin/users/invite › response 201 application/json.user.dateOfBirth: new field',
  'POST /api/v1/admin/users/invite › response 201 application/json.user.guardianPhone: new field',
  'POST /api/v1/admin/users/invite › response 201 application/json.user.homeDistrict: new field',
  'POST /api/v1/admin/users/invite › response 201 application/json.user.homeProvince: new field',
  'POST /api/v1/admin/users/invite › response 201 application/json.user.homeSector: new field',
  'POST /api/v1/admin/users/invite › response 201 application/json.user.phone: new field',
  'POST /api/v1/auth/login › response 200 application/json.user.country: new field',
  'POST /api/v1/auth/login › response 200 application/json.user.dateOfBirth: new field',
  'POST /api/v1/auth/login › response 200 application/json.user.guardianPhone: new field',
  'POST /api/v1/auth/login › response 200 application/json.user.homeDistrict: new field',
  'POST /api/v1/auth/login › response 200 application/json.user.homeProvince: new field',
  'POST /api/v1/auth/login › response 200 application/json.user.homeSector: new field',
  'POST /api/v1/auth/login › response 200 application/json.user.phone: new field',
  'POST /api/v1/auth/register/student › request application/json.dateOfBirth: new optional field',
  'POST /api/v1/auth/register/student › request application/json.guardianPhone: new optional field',
  'POST /api/v1/auth/register/student › request application/json.homeCountry: new optional field',
  'POST /api/v1/auth/register/student › request application/json.homeDistrict: new optional field',
  'POST /api/v1/auth/register/student › request application/json.homeLocation: field is now optional',
  'POST /api/v1/auth/register/student › request application/json.homeProvince: new optional field',
  'POST /api/v1/auth/register/student › request application/json.homeSector: new optional field',
  'POST /api/v1/auth/register/student › request application/json.phone: new optional field',
  'POST /api/v1/auth/register/student › response 201 application/json.country: new field',
  'POST /api/v1/auth/register/student › response 201 application/json.dateOfBirth: new field',
  'POST /api/v1/auth/register/student › response 201 application/json.guardianPhone: new field',
  'POST /api/v1/auth/register/student › response 201 application/json.homeDistrict: new field',
  'POST /api/v1/auth/register/student › response 201 application/json.homeProvince: new field',
  'POST /api/v1/auth/register/student › response 201 application/json.homeSector: new field',
  'POST /api/v1/auth/register/student › response 201 application/json.phone: new field',
  'POST /api/v1/mentor-requests › request application/json.country: new optional field',
  'POST /api/v1/mentor-requests › request application/json.educationLevel: new optional field',
  'POST /api/v1/mentor-requests › request application/json.occupation: new optional field',
  'POST /api/v1/mentor-requests › request application/json.olympiadInterests: new optional field',
  'POST /api/v1/mentor-requests › response 201 application/json.country: new field',
  'POST /api/v1/mentor-requests › response 201 application/json.educationLevel: new field',
  'POST /api/v1/mentor-requests › response 201 application/json.occupation: new field',
  'POST /api/v1/mentor-requests › response 201 application/json.olympiadInterests: new field',
];
const PROFILE_PICTURES_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-15-profile-pictures.json';
const ACCOUNT_STATES_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-16-account-states.json';
const BULK_OPERATIONS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-17-bulk-operations.json';
const FORM_AVAILABILITY_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-15-form-availability.json';
/** Notification switches for Head Coaches (2026-11-17): HEAD_COACH on the three /me/notification-settings routes; nothing else. */
const ROLE_NOTIFICATION_SETTINGS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-17-role-notification-settings.json';
/** Application details and request more information (2026-11-17, ADR-009): additive only. */
const APPLICATION_DETAILS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-17-application-details.json';
/** Student date of birth required (owner, 2026-11-17): one approved breaking change, nothing else. */
const STUDENT_DOB_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-17-student-date-of-birth.json';
/** Optional profile picture at registration (REG-02, 2026-11-18): one public upload operation; additive only. */
const REGISTRATION_AVATAR_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-18-registration-avatar.json';
/** Registration timeline (REG-13, 2026-11-18): one administrators' read operation. */
const REGISTRATION_TIMELINE_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-18-registration-timeline.json';
/** Teacher–student access (TS-1…TS-6, 2026-11-18): assignments, school access, delegation student scope, bulk actions — additive only. */
const TEACHER_STUDENT_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-18-teacher-student-access.json';
/**
 * Owner decisions 9.2 / 9.3 (2026-11-18): guardianPhone required at student self-registration (one approved breaking
 * change); PUT /me/date-of-birth (first-sign-in date of birth); /me/avatar responses documented as the profile.
 */
const APPROVED_DECISIONS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-18-approved-decisions.json';
/** Teacher–student access + decisions 9.2 / 9.3 (this branch is stacked on feat/applications-complete). SR-1 changes no API. */
const TEACHER_STUDENT_DECISIONS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-18-teacher-student-decisions.json';
/** Final review (2026-11-18, owner approvals): date-of-birth corrections and application picture review — additive only. */
const FINAL_REVIEW_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-18-final-review.json';
/** Teacher–student access + every change of feat/applications-complete up to the final review (this branch is stacked on it). */
const TEACHER_STUDENT_FINAL_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-18-teacher-student-final.json';
/**
 * Integration on develop (2026-11-18, SEC-05): the applicant's one-time "more information" token moves from the URL path
 * to the request body (URLs reach proxy and platform access logs). The two path routes were never released.
 */
const INFO_REQUEST_TOKEN_BODY_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-18-info-request-token-body.json';
/**
 * Countries (design area 1 as simplified by the owner, 2026-11-19): the public country list and its administration
 * (reference.manage) — additive only, no response field of an existing operation changes.
 */
const COUNTRIES_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-countries.json';
/**
 * Coach subject interests (owner decision 2026-11-19, Option A — the existing olympiadInterests): required on every new
 * coach application (one approved breaking change) and editable by an Administrator on a Coach account (one optional field).
 */
const COACH_INTERESTS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-coach-interests.json';
/**
 * Primary teacher of a school (owner decision 2026-11-19): `role` on teacher–school links (filter ?role=), an
 * Administrator's reassignment route and the teacher's own schools — additive only.
 */
const PRIMARY_TEACHER_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-primary-teacher.json';
/** Schools table (2026-11-19): GET /admin/schools sorts by name or verified students (sort, order) — additive only. */
const SCHOOLS_TABLE_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-schools-table.json';
/**
 * Generic bulk engine (2026-11-19): the /admin/bulk/* routes, and reassignTeacher (with fromTeacherId / toTeacherId) on
 * /admin/users/bulk — additive only: no existing operation's response, required field or status changes.
 */
const BULK_ENGINE_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-bulk-engine.json';
/**
 * Generic bulk routes, documented (2026-11-19): response schemas, examples and error codes of the eight /admin/bulk/*
 * routes (test/bulk-openapi-contract.e2e-spec.ts checks real responses against them). Documentation only.
 */
const BULK_ENGINE_RESPONSES_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-bulk-engine-responses.json';
/**
 * Test Management, Phase 1 (WS3, owner-approved plan 2026-11-19): /admin/tests (tests, questions, paper and marking guide)
 * and /admin/test-markers (marker authorisations) — additive only: 19 routes, 7 request schemas.
 */
const TEST_MANAGEMENT_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-test-management.json';
/**
 * Test Management, Phase 2 (WS3, owner-approved plan 2026-11-19): deadlines, extensions, student and teacher submissions
 * with every version, tracking — /me/tests, /teacher/tests, /admin/tests/:id/extensions|extension-targets|submissions —
 * additive only: 25 routes, 4 request schemas.
 */
const TEST_SUBMISSIONS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-test-submissions.json';
/**
 * Test Management, Phase 3 (WS3, owner-approved plan 2026-11-19): distribution, blind marking, second marking, review,
 * approval, locking, the mark-change log — /admin/tests/:id/marking… and /marking… — additive only: 19 routes, 12 request
 * schemas.
 */
const TEST_MARKING_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-19-test-marking.json';
/**
 * Test Management, Phase 4 (WS3, owner-approved plan 2026-11-19): publication with the Administrators' override,
 * results for students and teachers, internal rankings, reports, dashboards — additive only: 17 routes, 2 request
 * schemas; PUBLISHED accepted as a review filter and an expected status.
 */
const TEST_RESULTS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-20-test-results.json';
/**
 * Gender at every sign-up (owner, 2026-11-20): `gender` (FEMALE | MALE) becomes a required request field of the three
 * public sign-ups. Deliberately breaking for those three requests only; the frontend that sends it ships with it.
 */
const REGISTRATION_GENDER_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-20-registration-gender.json';
/**
 * Home location on every registration form and profile edit (owner, 2026-11-20; homeLocationRules): the home country
 * becomes required on the student sign-up (homeCountry) and the coach application (country); the Rwandan place is
 * required only for Rwanda (teacher homeDistrict / homeSector become optional; homeProvince added); profile edits accept
 * the home country and place.
 */
const HOME_LOCATION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-20-home-location.json';
/**
 * The generic bulk engine on top of the sign-up work (2026-11-20): the bulk branch merged with develop (Test Management,
 * gender, home location). Additive only against the home-location snapshot: the eight /admin/bulk/* routes, their
 * documented responses and reassignTeacher on /admin/users/bulk.
 */
const BULK_ENGINE_MERGED_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-20-bulk-engine-merged.json';
/** Gender step (owner, 2026-11-20): PUT /me/gender for accounts without one; an Administrator corrects it. Additive only. */
const GENDER_STEP_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-20-gender-step.json';
/** The generic bulk engine on top of the gender step (2026-11-20): additive only against the gender-step snapshot. */
const BULK_ENGINE_ON_GENDER_STEP_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-20-bulk-engine-gender-step.json';
const OLYMPIAD_OTHER_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-21-olympiad-other.json';
/**
 * Teacher self-service and locked test submissions (owner, 2026-11-21): an Administrator authorizes / cancels one more
 * version of a submitted answer; revokes / restores a teacher's test submission for students; a teacher filters the
 * test's students by level and subject. Additive only against the "Other" Olympiad interest snapshot.
 */
const TEACHER_SELF_SERVICE_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-21-teacher-self-service.json';
/**
 * Olympiad levels (owner, 2026-11-21): Junior / Middle / Senior, separate from the grade — a student's level (view, set,
 * follow the grade again; bulk setOlympiadLevel), MIDDLE tests and level filters. Additive only against the teacher
 * self-service snapshot.
 */
const OLYMPIAD_LEVELS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-22-divisions-levels.json';
/**
 * The school code is the identifier (owner, 2026-11-22): a directory sync run may import new schools only (mode
 * NEW_ONLY); teacher registration's "My school is not listed" carries the school's official details. Additive only
 * against the Olympiad levels snapshot.
 */
const SCHOOL_CODES_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-22-school-codes.json';
/**
 * Registration data (owner 2026-11-23): Super Administrators list, filter, export and edit every eligible registration
 * field (registrationData.manage), with saved filters and column layouts. Additive only against the school codes snapshot.
 */
const REGISTRATION_DATA_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-23-registration-data.json';
/** A code-less school's code given at registration (owner 2026-11-23): one optional field on two requests. Additive only. */
const SCHOOL_CODE_AT_REGISTRATION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-23-school-code-at-registration.json';
/**
 * Coaches across their programmes (owner 2026-11-23): the coach's students and published results, and a coach's programme
 * access for Administrators and Head Coaches. Additive only against the school codes snapshot.
 */
const COACH_ACCESS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-23-coach-programme-access.json';
/**
 * School list filters on every field of the NESA file (owner, 2026-11-23): ownership, cell, village, a contact value,
 * with or without an e-mail or phone, programme category. Additive only against the school codes snapshot.
 */
const SCHOOL_FILTERS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-23-school-filters.json';
/**
 * E-mail activation per sign-up form, off by default (owner, 2026-11-23): the forms' availability change accepts
 * requireEmailVerification. Additive only against the school codes snapshot.
 */
const FORM_EMAIL_VERIFICATION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-23-form-email-verification.json';
/**
 * News subscribers (owner, 2026-11-23): public subscribe / unsubscribe (incl. RFC 8058 one-click) and /admin/subscribers
 * (list, summary, export, add, import, edit, erase, mailings). Additive only against the school-codes snapshot.
 */
const SUBSCRIBERS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-23-subscribers.json';
/**
 * View as, read only (owner, 2026-11-23): an administrator starts viewing as a lower-ranked user (a single-use ticket),
 * the viewing tab exchanges it for a 30-minute viewing token and ends the session. Additive only against the school
 * codes snapshot.
 */
const VIEW_AS_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-24-view-as.json';
/**
 * Integration of the 2026-11-23 branches (audit 2026-11-24): every branch above together. Breaking and review: none.
 */
const INTEGRATION_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-24-integration.json';
/**
 * Activate now (owner 2026-11-24): an administrator activates an account awaiting setup (POST /admin/users/:id/activate-now)
 * and bulk action activateNow, whose preview tells how many will be activated (willApply). Additive only against the
 * integration snapshot.
 */
const ACTIVATE_NOW_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-24-activate-now.json';
/**
 * Banking information (owner 2026-11-25): GET / PUT /me/banking (Teachers, Coaches and Head Coaches), GET
 * /admin/users/:id/banking, the Users list's ?banking= filter, and the documentation correction: a route open to every
 * signed-in user lists all six roles in x-roles (it listed STUDENT, MENTOR, ADMIN). Additive only.
 */
const BANKING_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-25-banking-details.json';
/** Banking editing (owner 2026-11-25): PUT /admin/users/:id/banking — an administrator edits a person's details. Additive only. */
const BANKING_EDIT_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-25-banking-edit.json';
/** Reports with any data (owner 2026-11-25): templates (isTemplate on create / save). Additive only. */
const REPORT_TEMPLATES_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-25-report-templates.json';
/** The coach queue's "To mark" filter (2026-11-26): state=TO_MARK on GET /api/v1/marking/queue. Additive only. */
const QUEUE_TO_MARK_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-26-queue-to-mark.json';
/**
 * Question-level marking (design Rev 5.2, 2027-01), after the queue's "To mark" filter: /api/v1/marking/tasks (the
 * shared pool), /api/v1/admin/tests/{id}/question-marking (mode, markers, tasks, review, cycles, decisions, progress,
 * history, corrections) and the Super Admin's guide correctionReason. Additive only.
 */
const QUESTION_MARKING_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-26-question-marking.json';
const CURRENT_SNAPSHOT = QUESTION_MARKING_SNAPSHOT;
/** Bulk user operations (2026-11-17): preview, execute, progress, items, list, cancel, export. Additive only; after account states. */
const BULK_OPERATIONS_ADDITIONS = [
  'GET /api/v1/admin/users/bulk/{id}/items: operation added',
  'GET /api/v1/admin/users/bulk/{id}: operation added',
  'GET /api/v1/admin/users/bulk: operation added',
  'POST /api/v1/admin/users/bulk/export: operation added',
  'POST /api/v1/admin/users/bulk/preview: operation added',
  'POST /api/v1/admin/users/bulk/{id}/cancel: operation added',
  'POST /api/v1/admin/users/bulk: operation added',
  'schema BulkExecuteDto: added',
  'schema BulkExportDto: added',
  'schema BulkFilterDto: added',
  'schema BulkParamsDto: added',
  'schema BulkPreviewDto: added',
  'schema BulkSelectionDto: added',
];
/**
 * Account states (2026-11-16): accountStatus on the admin user records and the list filter, the status-change and
 * status-history routes. Chained after profile pictures. One approved breaking change: DELETE /admin/users/:id never
 * deletes any more (always 409 PERMANENT_DELETION_DISABLED — archive instead), so its 200 response is gone.
 */
const ACCOUNT_STATES_BREAKING = ['DELETE /api/v1/admin/users/{id}: response 200 body removed'];
const ACCOUNT_STATES_ADDITIONS = [
  'GET /api/v1/admin/users › response 200 application/json.data[].accountStatus: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.accountStatus: new field',
  'GET /api/v1/admin/users/{id}/status-history: operation added',
  'GET /api/v1/admin/users: new optional query parameter "accountStatus"',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.accountStatus: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.accountStatus: new field',
  'POST /api/v1/admin/users › response 201 application/json.accountStatus: new field',
  'POST /api/v1/admin/users/{id}/status-changes: operation added',
  'schema ChangeAccountStatusDto: added',
];
/**
 * Profile pictures (2026-11-15): upload, replace, remove, view; administrators on other accounts. Additive only;
 * chained after registration details.
 */
const PROFILE_PICTURES_ADDITIONS = [
  'DELETE /api/v1/admin/users/{id}/avatar: operation added',
  'DELETE /api/v1/me/avatar: operation added',
  'GET /api/v1/users/{id}/avatar: operation added',
  'PUT /api/v1/admin/users/{id}/avatar: operation added',
  'PUT /api/v1/me/avatar: operation added',
];
/**
 * Form availability (2026-11-15): the public view of each form and the administrators' management (forms.view,
 * forms.manageAvailability, forms.editMessages). Additive only; chained after bulk user operations.
 */
const FORM_AVAILABILITY_ADDITIONS = [
  'GET /api/v1/admin/forms/{key}/history: operation added',
  'GET /api/v1/admin/forms/{key}: operation added',
  'GET /api/v1/admin/forms: operation added',
  'GET /api/v1/forms/{key}: operation added',
  'GET /api/v1/forms: operation added',
  'PATCH /api/v1/admin/forms/{key}/availability: operation added',
  'PATCH /api/v1/admin/forms/{key}/messages: operation added',
  'schema UpdateFormAvailabilityDto: added',
  'schema UpdateFormMessagesDto: added',
];
/**
 * Post-Phase-1 bundle (owner approval as a baseline pending): Teacher Registration (self-registration, Administrator
 * review, school verification, the decision-notification delivery log, province in the school search) and students'
 * Olympiad interests (decision 8). Additive only; chained after the release candidate's last step (school verification).
 */
const POST_PHASE1_ADDITIONS = [
  'GET /api/v1/admin/notification-deliveries: operation added',
  'GET /api/v1/admin/reports/students › response 200 application/json.data[].olympiadInterests: new field',
  'GET /api/v1/admin/teacher-applications/{id}: operation added',
  'GET /api/v1/admin/teacher-applications: operation added',
  'GET /api/v1/admin/users › response 200 application/json.data[].olympiadInterests: new field',
  'GET /api/v1/admin/users/{id} › response 200 application/json.olympiadInterests: new field',
  'GET /api/v1/auth/register/teacher/availability: operation added',
  'GET /api/v1/me › response 200 application/json.olympiadInterests: new field',
  'GET /api/v1/schools/search › response 200 application/json[].province: new field',
  'PATCH /api/v1/admin/users/{id} › response 200 application/json.olympiadInterests: new field',
  'PATCH /api/v1/admin/users/{id}/status › response 200 application/json.olympiadInterests: new field',
  'PATCH /api/v1/me › request application/json.olympiadInterests: new optional field',
  'PATCH /api/v1/me › response 200 application/json.olympiadInterests: new field',
  'POST /api/v1/admin/notification-deliveries/{id}/retry: operation added',
  'POST /api/v1/admin/teacher-applications/{id}/approve: operation added',
  'POST /api/v1/admin/teacher-applications/{id}/reject: operation added',
  'POST /api/v1/admin/teacher-applications/{id}/school: operation added',
  'POST /api/v1/admin/users › response 201 application/json.olympiadInterests: new field',
  'POST /api/v1/admin/users/invite › response 201 application/json.user.olympiadInterests: new field',
  'POST /api/v1/auth/login › response 200 application/json.user.olympiadInterests: new field',
  'POST /api/v1/auth/register/student › request application/json.olympiadInterests: new optional field',
  'POST /api/v1/auth/register/student › response 201 application/json.olympiadInterests: new field',
  'POST /api/v1/auth/register/teacher: operation added',
  'schema ApproveTeacherApplicationDto: added',
  'schema RegisterTeacherDto: added',
  'schema RejectTeacherApplicationDto: added',
  'schema VerifyTeacherApplicationSchoolDto: added',
];

describe('identity', () => {
  test('identical documents produce no changes', () => {
    const res = diff(() => {});
    assert.equal(res.identical, true);
    assert.ok(none(res));
  });

  test('recursive schemas are compared without looping', () => {
    const res = diff((d) => { S(d).Profile.properties.displayName.type = 'integer'; });
    assert.ok(has(res.breaking, 'profile.displayName', 'type changed from string to integer'));
  });
});

describe('1. newly required request-body fields', () => {
  test('a new required field is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.code = { type: 'string' }; S(d).CreateItemDto.required.push('code'); });
    assert.ok(has(res.breaking, 'code', 'new required field'));
  });
  test('an existing optional field becoming required is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.required.push('kind'); });
    assert.ok(has(res.breaking, 'kind', 'now required'));
  });
  test('a new optional field is additive, not breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.code = { type: 'string' }; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'code', 'new optional field'));
  });
  test('a required field becoming optional is additive', () => {
    const res = diff((d) => { S(d).CreateItemDto.required = []; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'title', 'now optional'));
  });
});

describe('2. removed request fields and incompatible request types', () => {
  test('a removed request field is breaking', () => {
    const res = diff((d) => { delete S(d).CreateItemDto.properties.kind; });
    assert.ok(has(res.breaking, 'kind', 'field removed'));
  });
  test('a removed nested request field is breaking', () => {
    const res = diff((d) => { delete S(d).CreateItemDto.properties.meta.properties.source; });
    assert.ok(has(res.breaking, 'meta.source', 'field removed'));
  });
  test('an incompatible request type change is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.title.type = 'integer'; });
    assert.ok(has(res.breaking, 'title', 'type changed from string to integer'));
  });
  test('integer widened to number in a request is additive', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.count.type = 'number'; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'count', 'integer widened to number'));
  });
  test('a request field no longer accepting null is breaking; newly accepting null is additive', () => {
    const r1 = diff((d) => { delete S(d).CreateItemDto.properties.note.nullable; });
    assert.ok(has(r1.breaking, 'note', 'null no longer accepted'));
    const r2 = diff((d) => { S(d).CreateItemDto.properties.title.nullable = true; });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'title', 'null now accepted'));
  });
  test('tightened request constraints are breaking; loosened ones are additive', () => {
    const tight = diff((d) => { S(d).CreateItemDto.properties.title.maxLength = 50; S(d).CreateItemDto.properties.count.minimum = 1; });
    assert.ok(has(tight.breaking, 'title', 'maxLength 100 → 50'));
    assert.ok(has(tight.breaking, 'count', 'minimum 0 → 1'));
    const loose = diff((d) => { S(d).CreateItemDto.properties.title.maxLength = 200; });
    assert.equal(loose.breaking.length, 0);
    assert.ok(has(loose.additive, 'title', 'maxLength 100 → 200'));
  });
  test('a request body becoming required, or being removed, is breaking', () => {
    const r1 = diff((d) => { d.paths['/api/v1/items/{id}'].get.requestBody = { required: true, ...json({ type: 'object', properties: {} }) }; });
    assert.ok(has(r1.breaking, 'GET /api/v1/items/{id}', 'request body added'));
    const r2 = diff((d) => { delete d.paths['/api/v1/items'].post.requestBody; });
    assert.ok(has(r2.breaking, 'request body removed'));
  });
});

describe('3. removed nested response fields (arrays and refs)', () => {
  test('a field removed inside an array of objects is breaking', () => {
    const res = diff((d) => { delete createResp(d).properties.tags.items.properties.weight; });
    assert.ok(has(res.breaking, 'tags[].weight', 'field removed'));
  });
  test('a field removed inside a referenced schema is breaking', () => {
    const res = diff((d) => { delete S(d).Owner.properties.profile; });
    assert.ok(has(res.breaking, 'owner.profile', 'field removed'));
    assert.ok(has(res.breaking, 'GET /api/v1/items/{id}', 'profile', 'field removed'));
  });
  test('a field removed two refs deep is breaking', () => {
    const res = diff((d) => { delete S(d).Profile.properties.displayName; });
    assert.ok(has(res.breaking, 'owner.profile.displayName', 'field removed'));
  });
  test('a new nested response field is additive, not breaking', () => {
    const res = diff((d) => { createResp(d).properties.tags.items.properties.colour = { type: 'string' }; S(d).Owner.properties.email = { type: 'string' }; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'tags[].colour', 'new field'));
    assert.ok(has(res.additive, 'owner.email', 'new field'));
  });
  test('a response field no longer always present needs review', () => {
    const res = diff((d) => { createResp(d).required = ['id', 'tags']; });
    assert.ok(has(res.review, 'owner', 'no longer always present'));
    assert.equal(res.breaking.length, 0);
  });
  test('a removed response status or content type is breaking', () => {
    const r1 = diff((d) => { delete d.paths['/api/v1/items'].post.responses[400]; });
    assert.ok(has(r1.breaking, 'response 400 removed'));
    const r2 = diff((d) => { const c = d.paths['/api/v1/items/{id}'].get.responses[200].content; c['application/xml'] = c['application/json']; delete c['application/json']; });
    assert.ok(has(r2.breaking, 'content type application/json removed'));
  });
});

describe('4. incompatible type changes', () => {
  test('a response field type change is breaking', () => {
    const res = diff((d) => { createResp(d).properties.id.type = 'integer'; });
    assert.ok(has(res.breaking, 'response 201', '.id', 'type changed from string to integer'));
  });
  test('object ↔ array is breaking', () => {
    const res = diff((d) => { createResp(d).properties.owner = { type: 'array', items: ref('Owner') }; });
    assert.ok(has(res.breaking, 'owner', 'type changed from object to array'));
  });
  test('a response field that may now be null is breaking; no longer null is additive', () => {
    const r1 = diff((d) => { createResp(d).properties.id.nullable = true; });
    assert.ok(has(r1.breaking, '.id', 'may now be null'));
    const r2 = diff((d) => { delete createResp(d).properties.score.nullable; });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'score', 'no longer null'));
  });
  test('integer → number in a response is breaking (clients may expect whole numbers)', () => {
    const res = diff((d) => { createResp(d).properties.count.type = 'number'; });
    assert.ok(has(res.breaking, 'count', 'type changed from integer to number'));
  });
  test('a changed string format is breaking', () => {
    const res = diff((d) => { createResp(d).properties.id.format = 'date-time'; });
    assert.ok(has(res.breaking, '.id', 'format changed from uuid to date-time'));
  });
  test('a parameter type change is breaking', () => {
    const res = diff((d) => { d.paths['/api/v1/items/{id}'].get.parameters[0].schema = { type: 'integer' }; });
    assert.ok(has(res.breaking, 'path parameter id', 'type changed from string to integer'));
  });
});

describe('5. enum changes', () => {
  test('a removed request enum value is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.kind.enum = ['NOTE']; });
    assert.ok(has(res.breaking, 'kind', 'enum values removed: BOOK'));
  });
  test('a removed query-parameter enum value is breaking', () => {
    const res = diff((d) => { d.paths['/api/v1/items/{id}'].get.parameters[1].schema.enum = ['full']; });
    assert.ok(has(res.breaking, 'query parameter view', 'enum values removed: summary'));
  });
  test('a new request enum value is additive', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.kind.enum = ['NOTE', 'BOOK', 'EBOOK']; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'kind', 'enum values added: EBOOK'));
  });
  test('restricting a free request value to an enum is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.title.enum = ['A', 'B']; });
    assert.ok(has(res.breaking, 'title', 'values now restricted'));
  });
  test('a new response enum value needs review (not silently additive, not breaking)', () => {
    const res = diff((d) => { createResp(d).properties.status.enum = ['DRAFT', 'PUBLISHED', 'ARCHIVED']; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.review, 'status', 'enum values added: ARCHIVED'));
  });
  test('a removed response enum value is additive', () => {
    const res = diff((d) => { createResp(d).properties.status.enum = ['PUBLISHED']; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'status', 'enum values removed: DRAFT'));
  });
});

describe('6. operation identity, roles and parameters', () => {
  test('a changed operationId is breaking', () => {
    const res = diff((d) => { d.paths['/api/v1/items'].post.operationId = 'ItemsController_add'; });
    assert.ok(has(res.breaking, 'POST /api/v1/items', 'operationId changed from ItemsController_create to ItemsController_add'));
  });
  test('an unchanged operationId reports nothing', () => {
    assert.ok(none(diff((d) => { d.paths['/api/v1/items'].post.operationId = 'ItemsController_create'; })));
  });
  test('a removed operation is breaking; an added one is additive', () => {
    const r1 = diff((d) => { delete d.paths['/api/v1/items/{id}']; });
    assert.ok(has(r1.breaking, 'GET /api/v1/items/{id}', 'operation removed'));
    const r2 = diff((d) => { d.paths['/api/v1/extra'] = { get: { operationId: 'x', responses: { 200: {} } } }; });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'GET /api/v1/extra', 'operation added'));
  });
  test('narrowed roles are breaking; widened roles are additive', () => {
    const r1 = diff((d) => { d.paths['/api/v1/items'].post['x-roles'] = ['ADMIN']; });
    assert.ok(has(r1.breaking, 'roles removed: MENTOR'));
    const r2 = diff((d) => { d.paths['/api/v1/items'].post['x-roles'] = ['ADMIN', 'MENTOR', 'TEACHER']; });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'roles added: TEACHER'));
  });
  test('protected → public needs a security review; public → protected is breaking', () => {
    const r1 = diff((d) => { d.paths['/api/v1/items'].post.security = []; });
    assert.ok(has(r1.review, 'now public'));
    const before = fixture(); before.paths['/api/v1/items'].post.security = [];
    const r2 = compare(buildSnapshot(before), buildSnapshot(fixture()));
    assert.ok(has(r2.breaking, 'now requires authentication'));
  });
  test('a new required parameter is breaking; a new optional one is additive; a removed one is breaking', () => {
    const r1 = diff((d) => { d.paths['/api/v1/items'].post.parameters.push({ name: 'schoolId', in: 'query', required: true, schema: { type: 'string' } }); });
    assert.ok(has(r1.breaking, 'new required query parameter "schoolId"'));
    const r2 = diff((d) => { d.paths['/api/v1/items'].post.parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer' } }); });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'new optional query parameter "page"'));
    const r3 = diff((d) => { d.paths['/api/v1/items'].post.parameters = []; });
    assert.ok(has(r3.breaking, 'query parameter "dryRun" removed'));
  });
});

describe('shapeOf', () => {
  test('records nullable, enum, format and request constraints', () => {
    assert.deepEqual(shapeOf({ type: 'string', nullable: true, enum: ['b', 'a'], format: 'uuid', maxLength: 5 }),
      { nullable: true, type: 'string', format: 'uuid', enum: ['a', 'b'], maxLength: 5 });
  });
});

describe('command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-snapshot-test-'));
  const run = (...args) => spawnSync(process.execPath, ['scripts/api-snapshot.mjs', ...args], { encoding: 'utf8' });
  const base = join(dir, 'base.json');
  const okDoc = join(dir, 'ok.json');
  const breakingDoc = join(dir, 'breaking.json');
  const additiveDoc = join(dir, 'additive.json');
  const reviewDoc = join(dir, 'review.json');
  writeFileSync(okDoc, JSON.stringify(fixture()));
  const b = fixture(); delete S(b).Profile.properties.displayName; writeFileSync(breakingDoc, JSON.stringify(b));
  const a = fixture(); S(a).Owner.properties.email = { type: 'string' }; writeFileSync(additiveDoc, JSON.stringify(a));
  const r = fixture(); createResp(r).properties.status.enum.push('ARCHIVED'); writeFileSync(reviewDoc, JSON.stringify(r));

  test('write, then compare with itself: identical, exit 0 with --strict', () => {
    assert.equal(run('write', base, '--openapi', okDoc).status, 0);
    const out = run('compare', base, '--openapi', okDoc, '--strict');
    assert.equal(out.status, 0);
    assert.match(out.stdout, /API identical to the baseline\./);
    assert.match(out.stdout, /Breaking changes: 0/);
  });
  test('a deliberate breaking change makes --strict exit 1', () => {
    run('write', base, '--openapi', okDoc);
    const out = run('compare', base, '--openapi', breakingDoc, '--strict');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /Breaking changes: [1-9]/);
  });
  test('without --strict a breaking change still exits 0 (report only)', () => {
    assert.equal(run('compare', base, '--openapi', breakingDoc).status, 0);
  });
  test('an additive change passes --strict', () => {
    const out = run('compare', base, '--openapi', additiveDoc, '--strict');
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Breaking changes: 0/);
    assert.match(out.stdout, /Additive changes: [1-9]/);
  });
  test('a review-only change passes --strict but fails --strict-review', () => {
    assert.equal(run('compare', base, '--openapi', reviewDoc, '--strict').status, 0);
    assert.equal(run('compare', base, '--openapi', reviewDoc, '--strict-review').status, 1);
  });
});

describe('real API (docs/api/openapi.json)', () => {
  test('the current OpenAPI document compared with itself: zero changes', () => {
    const doc = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8'));
    const res = compare(buildSnapshot(doc), buildSnapshot(doc));
    assert.equal(res.identical, true);
    assert.ok(none(res));
  });
  test('GET /api/v1 is documented: description pointing to docs/INTEGRATION.md, Cache-Control no-store, string feature names without an enum', () => {
    const doc = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8'));
    const ok = doc.paths['/api/v1'].get.responses['200'];
    assert.match(ok.description, /docs\/INTEGRATION\.md/);
    assert.match(ok.description, /LEGACY \/ NEW \/ UNKNOWN/);
    assert.equal(ok.headers['Cache-Control'].schema.example, 'no-store');
    const caps = ok.content['application/json'].schema.properties.capabilities;
    assert.deepEqual(caps.required, ['features', 'roles', 'schemaVersion']);
    assert.equal(caps.properties.schemaVersion.type, 'integer');
    for (const k of ['features', 'roles']) {
      assert.equal(caps.properties[k].type, 'array');
      assert.equal(caps.properties[k].items.type, 'string');
      assert.equal(caps.properties[k].items.enum, undefined, `${k}: no restrictive enum (clients ignore unknown names)`);
    }
  });
  test('the current approved snapshot (P1-04) matches the current document exactly', () => {
    assert.ok(existsSync(CURRENT_SNAPSHOT), `${CURRENT_SNAPSHOT} is missing`);
    const saved = JSON.parse(readFileSync(CURRENT_SNAPSHOT, 'utf8'));
    const res = compare(saved, buildSnapshot(JSON.parse(readFileSync('docs/api/openapi.json', 'utf8'))));
    assert.equal(res.versionMismatch, false, 'snapshot must be regenerated with the current snapshot version');
    assert.equal(res.identical, true);
    assert.ok(none(res));
  });
});

/**
 * Approved contract history. Each step from one saved snapshot to the next must
 * contain exactly the approved changes, so no unapproved change can be folded
 * into a new snapshot. The P0-03 snapshot is historical evidence and is never
 * regenerated.
 */

describe('approved API contract history', () => {
  test('P0-03 (2026-11-08) → P1-04: exactly the two approved additive /me/permissions fields; nothing breaking or for review', () => {
    for (const f of [P0_03_SNAPSHOT, P1_04_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const p0 = JSON.parse(readFileSync(P0_03_SNAPSHOT, 'utf8'));
    const p104 = JSON.parse(readFileSync(P1_04_SNAPSHOT, 'utf8'));
    const res = compare(p0, p104);
    assert.equal(res.versionMismatch, false);
    assert.equal(res.identical, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/me/permissions › response 200 application/json.roleLabel: new field',
      'GET /api/v1/me/permissions › response 200 application/json.scopes: new field',
    ]);
  });

  test('P1-04 → P1-05 (role allow-list + M1): exactly the three new role values in four request enums; nothing breaking or for review', () => {
    for (const f of [P1_04_SNAPSHOT, P1_05_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_04_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_05_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/users › query parameter role: enum values added: HEAD_COACH, SUPER_ADMIN, TEACHER',
      'PATCH /api/v1/admin/users/{id} › request application/json.role: enum values added: HEAD_COACH, SUPER_ADMIN, TEACHER',
      'POST /api/v1/admin/users › request application/json.role: enum values added: HEAD_COACH, SUPER_ADMIN, TEACHER',
      'POST /api/v1/admin/users/invite › request application/json.role: enum values added: HEAD_COACH, SUPER_ADMIN, TEACHER',
    ]);
  });

  test('P1-05 → P1-06 (routes on permissions): only roles added — SUPER_ADMIN on administrative routes, HEAD_COACH on its course-work grants; nothing breaking or for review', () => {
    for (const f of [P1_05_SNAPSHOT, P1_06_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_05_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_06_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.equal(res.additive.length, 87);
    const added = {};
    for (const line of res.additive) {
      const m = /: roles added: (.+)$/.exec(line);
      assert.ok(m, `unexpected change: ${line}`);
      added[m[1]] = (added[m[1]] ?? 0) + 1;
    }
    assert.deepEqual(added, { SUPER_ADMIN: 73, HEAD_COACH: 13, 'HEAD_COACH, SUPER_ADMIN': 1 });
  });

  test('P1-06 → P1-08 (Super Admin): SUPER_ADMIN added to the 36 @Roles routes admitting ADMIN, plus the optional step-up field; nothing breaking or for review', () => {
    for (const f of [P1_06_SNAPSHOT, P1_08_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_06_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_08_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    const roles = res.additive.filter((l) => /: roles added: SUPER_ADMIN$/.test(l));
    const other = res.additive.filter((l) => !/: roles added: SUPER_ADMIN$/.test(l));
    assert.equal(roles.length, 36);
    assert.deepEqual(other, ['PATCH /api/v1/admin/users/{id} › request application/json.currentPassword: new optional field']);
  });

  test('P1-08 → P1-09 (permission overrides): exactly the five new operations, their request DTO and /me/permissions.overrides; nothing breaking or for review', () => {
    for (const f of [P1_08_SNAPSHOT, P1_09_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_08_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_09_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'DELETE /api/v1/admin/users/{id}/permission-overrides/{overrideId}: operation added',
      'GET /api/v1/admin/permissions/catalogue: operation added',
      'GET /api/v1/admin/users/{id}/permission-overrides: operation added',
      'GET /api/v1/admin/users/{id}/permissions: operation added',
      'GET /api/v1/me/permissions › response 200 application/json.overrides: new field',
      'POST /api/v1/admin/users/{id}/permission-overrides: operation added',
      'schema CreateOverrideDto: added',
    ]);
  });

  test('P1-09 → P1-10 (Head Coach programme scope): the programme, heads and members operations, their DTOs, /me/permissions.scopes.programmes and HEAD_COACH on coach assignments; nothing breaking or for review', () => {
    for (const f of [P1_09_SNAPSHOT, P1_10_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_09_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_10_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'DELETE /api/v1/admin/mentor-assignments/{id}: roles added: HEAD_COACH',
      'DELETE /api/v1/admin/programmes/{id}/members/{userId}: operation added',
      'GET /api/v1/admin/mentor-assignments: roles added: HEAD_COACH',
      'GET /api/v1/admin/programmes/{id}/heads: operation added',
      'GET /api/v1/admin/programmes/{id}/members: operation added',
      'GET /api/v1/me/permissions › response 200 application/json.scopes.programmes: new field',
      'GET /api/v1/programmes: operation added',
      'POST /api/v1/admin/mentor-assignments: roles added: HEAD_COACH',
      'POST /api/v1/admin/programmes/{id}/members: operation added',
      'PUT /api/v1/admin/programmes/{id}/heads: operation added',
      'schema AddProgrammeMemberDto: added',
      'schema SetProgrammeHeadsDto: added',
    ]);
  });

  test('P1-10 → P1-10 H4 (Head Coach course work): HEAD_COACH on the three read-only course-work views; nothing else', () => {
    for (const f of [P1_10_SNAPSHOT, P1_10_H4_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_10_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_10_H4_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/assignments/{id}/history: roles added: HEAD_COACH',
      'GET /api/v1/me/teaching: roles added: HEAD_COACH',
      'GET /api/v1/submissions/{id}/reviews: roles added: HEAD_COACH',
    ]);
  });

  test('P1-10 H4 → P1-10 part 3 (monitoring, coach invitation): HEAD_COACH on the programme-scoped monitoring routes and the invitation operation; nothing else', () => {
    for (const f of [P1_10_H4_SNAPSHOT, P1_10_MONITORING_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_10_H4_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_10_MONITORING_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/activity/summary: roles added: HEAD_COACH',
      'GET /api/v1/admin/activity: roles added: HEAD_COACH',
      'GET /api/v1/admin/dashboard: roles added: HEAD_COACH',
      'GET /api/v1/admin/reports/course-participation: roles added: HEAD_COACH',
      'GET /api/v1/admin/reports/mentor-activity: roles added: HEAD_COACH',
      'GET /api/v1/admin/reports/mentors: roles added: HEAD_COACH',
      'GET /api/v1/admin/reports/students: roles added: HEAD_COACH',
      'POST /api/v1/admin/programmes/{id}/coach-invitations: operation added',
      'schema InviteCoachDto: added',
    ]);
  });

  test('P1-10 part 3 → P1-11 (teachers, official school list): teacher routes and DTOs, school codes in search and registration; one approved breaking change', () => {
    for (const f of [P1_10_MONITORING_SNAPSHOT, P1_11_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_10_MONITORING_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_11_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    // Approved (owner decision 2026-11-10): a legacy school name that matches no official school, or
    // several, registers the student with no school. The current frontend already types school as nullable.
    assert.deepEqual(res.breaking, ['POST /api/v1/auth/register/student › response 201 application/json.school: may now be null']);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'DELETE /api/v1/admin/teacher-assignments/{id}: operation added',
      'DELETE /api/v1/admin/teachers/{id}/delegations/{overrideId}: operation added',
      'GET /api/v1/admin/teacher-assignments: operation added',
      'GET /api/v1/admin/teachers/{id}/delegations: operation added',
      'GET /api/v1/schools/locations: operation added',
      'GET /api/v1/schools/search › response 200 application/json[].code: new field',
      'GET /api/v1/schools/search › response 200 application/json[].district: new field',
      'GET /api/v1/schools/search › response 200 application/json[].sector: new field',
      'GET /api/v1/teacher/students/{id}/progress: operation added',
      'GET /api/v1/teacher/students/{id}: operation added',
      'GET /api/v1/teacher/students: operation added',
      'POST /api/v1/admin/teacher-assignments: operation added',
      'POST /api/v1/admin/teachers/{id}/delegations: operation added',
      'POST /api/v1/auth/register/student › request application/json.country: new optional field',
      'POST /api/v1/auth/register/student › request application/json.schoolCode: new optional field',
      'POST /api/v1/auth/register/student › request application/json.schoolLocation: field is now optional',
      'POST /api/v1/auth/register/student › request application/json.schoolName: field is now optional',
      'POST /api/v1/teacher/students/{id}/submissions: operation added',
      'schema CreateDelegationDto: added',
      'schema CreateTeacherSchoolDto: added',
    ]);
  });

  test('P1-11 → school administration PR A (student–school verification): the affiliation operations, their DTOs and registration schoolVerification; nothing else', () => {
    for (const f of [P1_11_SNAPSHOT, SCHOOL_AFFILIATION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_11_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_AFFILIATION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/school-affiliations/{id}: operation added',
      'GET /api/v1/admin/school-affiliations: operation added',
      'GET /api/v1/admin/users/{id}/school-affiliations: operation added',
      'GET /api/v1/me/school-affiliation: operation added',
      'POST /api/v1/admin/school-affiliations/{id}/reject: operation added',
      'POST /api/v1/admin/school-affiliations/{id}/revoke: operation added',
      'POST /api/v1/admin/school-affiliations/{id}/verify: operation added',
      'POST /api/v1/auth/register/student › response 201 application/json.schoolVerification: new field',
      'schema AffiliationReasonDto: added',
      'schema VerifyAffiliationDto: added',
    ]);
  });

  test('school administration PR A → PR A.1 (hardening): an Administrator may clear a student\'s school with schoolId: null; nothing else', () => {
    for (const f of [SCHOOL_AFFILIATION_SNAPSHOT, AFFILIATION_HARDENING_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_AFFILIATION_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(AFFILIATION_HARDENING_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ['PATCH /api/v1/admin/users/{id} › request application/json.schoolId: null now accepted']);
  });

  // Behaviour change not visible in the schema (documented, owner-approved): an invitation or a
  // CSV row naming a school by schoolName alone is now refused (400 SCHOOL_REFERENCE_REQUIRED /
  // row error) instead of creating that school; GET /schools and /schools/:id are deprecated
  // (same guard). Do not release to main before the frontend sends schoolId / schoolCode.
  test('PR A.1 → school administration PR B: /admin/schools operations and DTOs, schoolCode on user create / edit / invite; nothing else', () => {
    for (const f of [AFFILIATION_HARDENING_SNAPSHOT, SCHOOL_ADMINISTRATION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(AFFILIATION_HARDENING_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_ADMINISTRATION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/schools/{id}/students: operation added',
      'GET /api/v1/admin/schools/{id}: operation added',
      'GET /api/v1/admin/schools: operation added',
      'PATCH /api/v1/admin/schools/{id}/active: operation added',
      'PATCH /api/v1/admin/schools/{id}: operation added',
      'PATCH /api/v1/admin/users/{id} › request application/json.schoolCode: new optional field',
      'POST /api/v1/admin/schools: operation added',
      'POST /api/v1/admin/users › request application/json.schoolCode: new optional field',
      'POST /api/v1/admin/users/invite › request application/json.schoolCode: new optional field',
      'schema CreateSchoolDto: added',
      'schema SetSchoolActiveDto: added',
      'schema UpdateSchoolDto: added',
    ]);
  });

  test('PR B → school administration PR C: claim match / reopen / candidates, hasSchool filter, the student\'s own claim, registration place fields; nothing else', () => {
    for (const f of [SCHOOL_ADMINISTRATION_SNAPSHOT, SCHOOL_CLAIMS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_ADMINISTRATION_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_CLAIMS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/school-affiliations/{id}/candidates: operation added',
      'GET /api/v1/admin/school-affiliations: new optional query parameter "hasSchool"',
      'POST /api/v1/admin/school-affiliations/{id}/match: operation added',
      'POST /api/v1/admin/school-affiliations/{id}/reopen: operation added',
      'POST /api/v1/auth/register/student › request application/json.schoolDistrict: new optional field',
      'POST /api/v1/auth/register/student › request application/json.schoolProvince: new optional field',
      'POST /api/v1/auth/register/student › request application/json.schoolSector: new optional field',
      'POST /api/v1/me/school-affiliation: operation added',
      'schema MatchAffiliationDto: added',
      'schema StudentClaimDto: added',
    ]);
  });

  test('PR C → school administration PR D: the bulk school import and its template; nothing else', () => {
    for (const f of [SCHOOL_CLAIMS_SNAPSHOT, SCHOOL_IMPORT_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_CLAIMS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_IMPORT_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/schools/import-template: operation added',
      'POST /api/v1/admin/schools/import: operation added',
    ]);
  });

  test('PR D → school directory S1: contacts, offerings, history, reference data, new school fields and list filters; nothing else', () => {
    for (const f of [SCHOOL_IMPORT_SNAPSHOT, SCHOOL_DIRECTORY_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_IMPORT_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_DIRECTORY_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    // Not visible in the contract: 409 SCHOOL_NAME_TAKEN is no longer returned (names may repeat, M12) —
    // an identical name nearby is a POSSIBLE_DUPLICATE, elsewhere it is accepted.
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/schools/reference-data: operation added',
      'GET /api/v1/admin/schools/{id}/contacts: operation added',
      'GET /api/v1/admin/schools/{id}/history: operation added',
      'GET /api/v1/admin/schools/{id}/offerings: operation added',
      'GET /api/v1/admin/schools: new optional query parameter "accommodation"',
      'GET /api/v1/admin/schools: new optional query parameter "hasCode"',
      'GET /api/v1/admin/schools: new optional query parameter "hasSourceIssues"',
      'GET /api/v1/admin/schools: new optional query parameter "level"',
      'GET /api/v1/admin/schools: new optional query parameter "programme"',
      'PATCH /api/v1/admin/schools/{id} › request application/json.accommodation: new optional field',
      'PATCH /api/v1/admin/schools/{id} › request application/json.cell: new optional field',
      'PATCH /api/v1/admin/schools/{id} › request application/json.village: new optional field',
      'POST /api/v1/admin/schools › request application/json.accommodation: new optional field',
      'POST /api/v1/admin/schools › request application/json.cell: new optional field',
      'POST /api/v1/admin/schools › request application/json.village: new optional field',
      'POST /api/v1/admin/schools/{id}/contacts/{contactId}/verify: operation added',
      'PUT /api/v1/admin/schools/{id}/contacts: operation added',
      'PUT /api/v1/admin/schools/{id}/offerings: operation added',
      'schema ContactInputDto: added',
      'schema LevelInputDto: added',
      'schema ProgrammeInputDto: added',
      'schema PutSchoolContactsDto: added',
      'schema PutSchoolOfferingsDto: added',
      'schema VerifySchoolContactDto: added',
    ]);
  });

  test('S1 → school directory S2a: the sync dry run and its reports (runs, run, items, changes, report.csv); nothing else', () => {
    for (const f of [SCHOOL_DIRECTORY_SNAPSHOT, SCHOOL_SYNC_STAGING_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_DIRECTORY_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_SYNC_STAGING_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    // Not visible in the contract: GET /admin/schools/:id/history now masks contact values in
    // source records (R6) — the response shape is unchanged.
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/school-sync/runs/{id}/changes: operation added',
      'GET /api/v1/admin/school-sync/runs/{id}/items: operation added',
      'GET /api/v1/admin/school-sync/runs/{id}/report.csv: operation added',
      'GET /api/v1/admin/school-sync/runs/{id}: operation added',
      'GET /api/v1/admin/school-sync/runs: operation added',
      'POST /api/v1/admin/school-sync/runs: operation added',
    ]);
  });

  test('S2a → school directory S2b: review summary, categories, decisions, proposals, recompare, approve, apply, resolve; nothing else', () => {
    for (const f of [SCHOOL_SYNC_STAGING_SNAPSHOT, SCHOOL_SYNC_APPLY_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_SYNC_STAGING_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_SYNC_APPLY_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/school-sync/runs/{id}/categories: operation added',
      'GET /api/v1/admin/school-sync/runs/{id}/review: operation added',
      'POST /api/v1/admin/school-sync/runs/{id}/apply: operation added',
      'POST /api/v1/admin/school-sync/runs/{id}/approve: operation added',
      'POST /api/v1/admin/school-sync/runs/{id}/decisions: operation added',
      'POST /api/v1/admin/school-sync/runs/{id}/items/{itemId}/proposal: operation added',
      'POST /api/v1/admin/school-sync/runs/{id}/items/{itemId}/resolve: operation added',
      'POST /api/v1/admin/school-sync/runs/{id}/recompare: operation added',
      'schema ApplySyncRunDto: added',
      'schema CategoryApprovalDto: added',
      'schema ChangeDecisionDto: added',
      'schema ProposeResolutionDto: added',
      'schema ResolveAfterApplyDto: added',
      'schema SyncDecisionsDto: added',
    ]);
  });

  test('S2b → API capabilities: exactly the additive GET /api/v1 capabilities field; nothing else', () => {
    for (const f of [SCHOOL_SYNC_APPLY_SNAPSHOT, API_CAPABILITIES_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_SYNC_APPLY_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(API_CAPABILITIES_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ['GET /api/v1 › response 200 application/json.capabilities: new field']);
  });

  test('API capabilities → year activation: exactly the deliberate required expectedCurrentYearId on the start; nothing else', () => {
    // Deliberately BREAKING for callers of POST /admin/academic-years/:id/activate: a start must say
    // which year it expects to be current, so no client can start a year blind (a second start of
    // another planned year would otherwise close the year just started and promote every student
    // again). No released frontend calls this route (frontend main has no academic-year pages); the
    // frontend that does sends it, and offers the start only with the academicYearActivation feature.
    for (const f of [API_CAPABILITIES_SNAPSHOT, YEAR_ACTIVATION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(API_CAPABILITIES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(YEAR_ACTIVATION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, ['POST /api/v1/admin/academic-years/{id}/activate › request application/json.expectedCurrentYearId: new required field']);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, []);
  });

  test('year activation → logout session (H1): only POST /auth/logout becomes public; nothing else', () => {
    // Deliberate (H1, 2026-11-13): logout is authenticated by the refresh token (cookie or body), so
    // signing out also revokes the session after the 15-minute access token has expired. The tool
    // reports "roles removed" as breaking, but every caller that was allowed before still is (the
    // route now also admits callers without a valid access token); request and response are unchanged.
    for (const f of [YEAR_ACTIVATION_SNAPSHOT, LOGOUT_SESSION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(YEAR_ACTIVATION_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(LOGOUT_SESSION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, ['POST /api/v1/auth/logout: roles removed: ADMIN, MENTOR, STUDENT']);
    assert.deepEqual(res.review, ['POST /api/v1/auth/logout: now public (no authentication) — security review']);
    assert.deepEqual(res.additive, ['POST /api/v1/auth/logout: roles added: PUBLIC']);
  });

  test('logout session → review queue (M2/M3): three new optional query parameters on GET /mentor/reviews; nothing else', () => {
    // Additive: q, group and sort are optional, the default queue is unchanged, and the backend
    // advertises them with the reviewQueueFilters capability. (The answer's new `counts` field is not
    // part of the OpenAPI document: responses are recorded by the e2e suite.)
    for (const f of [LOGOUT_SESSION_SNAPSHOT, REVIEW_QUEUE_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(LOGOUT_SESSION_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(REVIEW_QUEUE_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/mentor/reviews: new optional query parameter "group"',
      'GET /api/v1/mentor/reviews: new optional query parameter "q"',
      'GET /api/v1/mentor/reviews: new optional query parameter "sort"',
    ]);
  });

  test('review queue → report export filters: the shared report filters on results.csv; nothing else', () => {
    // Additive: the Reports page sends its period, course and division to every export; results.csv
    // refused them (400). Enrolment already declared courseId (it answered FILTER_NOT_SUPPORTED); it now
    // applies it, which changes no schema.
    for (const f of [REVIEW_QUEUE_SNAPSHOT, REPORT_FILTERS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(REVIEW_QUEUE_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(REPORT_FILTERS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/reports/results.csv: new optional query parameter "academicYearId"',
      'GET /api/v1/admin/reports/results.csv: new optional query parameter "courseId"',
      'GET /api/v1/admin/reports/results.csv: new optional query parameter "divisionId"',
      'GET /api/v1/admin/reports/results.csv: new optional query parameter "from"',
      'GET /api/v1/admin/reports/results.csv: new optional query parameter "to"',
    ]);
  });

  test('report export filters → assignment list filters: progress/sort on My Assignments, statuses on the lists; nothing else', () => {
    // Additive: My Assignments filtered 50 loaded rows in the browser and the coach's grouped tabs
    // 100; the lists now filter and sort in the database (capability studentAssignmentFilters).
    for (const f of [REPORT_FILTERS_SNAPSHOT, LIST_FILTERS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(REPORT_FILTERS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(LIST_FILTERS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/assignments: new optional query parameter "statuses"',
      'GET /api/v1/me/assignments: new optional query parameter "progress"',
      'GET /api/v1/me/assignments: new optional query parameter "sort"',
      'GET /api/v1/me/assignments: new optional query parameter "statuses"',
    ]);
  });

  test('assignment list filters → e-mail deliveries: list every delivery and retry one; nothing else', () => {
    // Additive: failed account e-mails (invitations, resets, notices) were counted on the dashboard
    // but could not be listed or retried; only bulk-job deliveries could.
    for (const f of [LIST_FILTERS_SNAPSHOT, EMAIL_DELIVERIES_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(LIST_FILTERS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(EMAIL_DELIVERIES_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/email/deliveries: operation added',
      'POST /api/v1/admin/email/deliveries/{id}/retry: operation added',
    ]);
  });

  test('e-mail deliveries → codeless schools: registration and claims accept schoolId; nothing else', () => {
    // Additive (owner decision 2026-11-14): a school without an official code is chosen by its internal id.
    for (const f of [EMAIL_DELIVERIES_SNAPSHOT, CODELESS_SCHOOLS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(EMAIL_DELIVERIES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(CODELESS_SCHOOLS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'POST /api/v1/auth/register/student › request application/json.schoolId: new optional field',
      'POST /api/v1/me/school-affiliation › request application/json.schoolId: new optional field',
    ]);
  });

  test('codeless schools → release permissions: Head Coach student search added; Teachers lose the programme list (owner decision)', () => {
    // Owner decisions 2026-11-14: Head Coaches search students to add (additive); the unused TEACHER course
    // grants were removed, so GET /programmes (courses.view) no longer lists TEACHER. TEACHERS_ENABLED is
    // off in production and the teacher portal never called it — the one deliberate narrowing.
    for (const f of [CODELESS_SCHOOLS_SNAPSHOT, RELEASE_PERMISSIONS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(CODELESS_SCHOOLS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(RELEASE_PERMISSIONS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, ['GET /api/v1/programmes: roles removed: TEACHER']);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ['GET /api/v1/admin/programmes/{id}/student-candidates: operation added']);
  });

  test('release permissions → school verification: administrators verify a school; nothing else', () => {
    // Owner decision 2026-11-14: Teachers may name a school without an official code once an administrator
    // created and verified it. (GET /schools/search?teacherEligible is not visible here: that endpoint's
    // query parameters are not part of the generated OpenAPI; documented in docs/INTEGRATION.md.)
    for (const f of [RELEASE_PERMISSIONS_SNAPSHOT, SCHOOL_VERIFICATION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(RELEASE_PERMISSIONS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_VERIFICATION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ['POST /api/v1/admin/schools/{id}/verify: operation added', 'schema VerifySchoolDto: added']);
  });

  test('school verification → post-Phase-1 bundle (teacher registration + Olympiad interests): exactly the listed additions; nothing breaking or for review', () => {
    // One step for the bundle on top of the Phase 1 release candidate: teacher self-registration, decision
    // notifications (school verification, delivery log), province in the school search, and students' Olympiad
    // interests (registration, profile, admin views, report). The bundle's earlier step (e-mail deliveries →
    // 2026-11-14-teacher-registration-interests) is not part of this chain.
    for (const f of [SCHOOL_VERIFICATION_SNAPSHOT, POST_PHASE1_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_VERIFICATION_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(POST_PHASE1_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, POST_PHASE1_ADDITIONS);
  });

  test('post-Phase-1 bundle → registration details: exactly the listed additions; nothing breaking or for review', () => {
    for (const f of [POST_PHASE1_SNAPSHOT, REGISTRATION_DETAILS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(POST_PHASE1_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(REGISTRATION_DETAILS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, REGISTRATION_DETAILS_ADDITIONS);
  });

  test('registration details → profile pictures: exactly the five new avatar operations; nothing breaking or for review', () => {
    // avatarUrl already existed in every profile response; only the routes are new.
    for (const f of [REGISTRATION_DETAILS_SNAPSHOT, PROFILE_PICTURES_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(REGISTRATION_DETAILS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(PROFILE_PICTURES_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, PROFILE_PICTURES_ADDITIONS);
  });

  test('profile pictures → account states: the listed additions and one approved breaking change (DELETE never deletes)', () => {
    for (const f of [PROFILE_PICTURES_SNAPSHOT, ACCOUNT_STATES_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(PROFILE_PICTURES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(ACCOUNT_STATES_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    // Approved (owner, 2026-11-16): accounts are never deleted through the API; archive instead.
    assert.deepEqual(res.breaking, ACCOUNT_STATES_BREAKING);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ACCOUNT_STATES_ADDITIONS);
  });

  test('account states → bulk user operations: exactly the seven bulk routes and their request schemas; nothing breaking or for review', () => {
    for (const f of [ACCOUNT_STATES_SNAPSHOT, BULK_OPERATIONS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(ACCOUNT_STATES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(BULK_OPERATIONS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, BULK_OPERATIONS_ADDITIONS);
  });

  test('bulk user operations → form availability: exactly the seven form operations and their two request schemas; nothing breaking or for review', () => {
    for (const f of [BULK_OPERATIONS_SNAPSHOT, FORM_AVAILABILITY_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(BULK_OPERATIONS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(FORM_AVAILABILITY_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, FORM_AVAILABILITY_ADDITIONS);
  });

  test('form availability → Head Coach notification switches: HEAD_COACH added on the three settings routes; nothing else', () => {
    for (const f of [FORM_AVAILABILITY_SNAPSHOT, ROLE_NOTIFICATION_SETTINGS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(FORM_AVAILABILITY_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(ROLE_NOTIFICATION_SETTINGS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/me/notification-settings: roles added: HEAD_COACH',
      'PATCH /api/v1/me/notification-settings: roles added: HEAD_COACH',
      'POST /api/v1/me/notification-settings/reset: roles added: HEAD_COACH',
    ]);
  });

  test('Head Coach notification switches → application details and request more information: additive only', () => {
    for (const f of [ROLE_NOTIFICATION_SETTINGS_SNAPSHOT, APPLICATION_DETAILS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(ROLE_NOTIFICATION_SETTINGS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(APPLICATION_DETAILS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/applications/info-requests/{token}: operation added',
      'PATCH /api/v1/mentor-requests/{id}/reject: optional request body added',
      'POST /api/v1/admin/teacher-applications/{id}/request-info: operation added',
      'POST /api/v1/applications/info-requests/{token}: operation added',
      'POST /api/v1/auth/register/teacher › request application/json.position: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.yearsOfExperience: new optional field',
      'POST /api/v1/mentor-requests › request application/json.affiliation: new optional field',
      'POST /api/v1/mentor-requests › request application/json.expertise: new optional field',
      'POST /api/v1/mentor-requests › request application/json.phone: new optional field',
      'POST /api/v1/mentor-requests › request application/json.relevantExperience: new optional field',
      'POST /api/v1/mentor-requests › request application/json.yearsOfExperience: new optional field',
      'POST /api/v1/mentor-requests/{id}/request-info: operation added',
      'schema AnswerInfoRequestDto: added',
      'schema RejectMentorRequestDto: added',
      'schema RequestApplicationInfoDto: added',
    ]);
  });

  test('application details → student date of birth required: exactly one approved breaking change (owner, 2026-11-17)', () => {
    for (const f of [APPLICATION_DETAILS_SNAPSHOT, STUDENT_DOB_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(APPLICATION_DETAILS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(STUDENT_DOB_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, ['POST /api/v1/auth/register/student › request application/json.dateOfBirth: field is now required']);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, []);
  });

  test('student date of birth → registration avatar: one upload operation and its request schema; nothing breaking', () => {
    for (const f of [STUDENT_DOB_SNAPSHOT, REGISTRATION_AVATAR_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(STUDENT_DOB_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(REGISTRATION_AVATAR_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ['PUT /api/v1/auth/register/avatar: operation added', 'schema RegistrationAvatarDto: added']);
  });

  test('registration timeline → teacher–student access: additive only, exactly these changes', () => {
    for (const f of [REGISTRATION_TIMELINE_SNAPSHOT, TEACHER_STUDENT_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(REGISTRATION_TIMELINE_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(TEACHER_STUDENT_SNAPSHOT, 'utf8')));
    assert.deepEqual([res.breaking, res.review], [[], []]);
    assert.deepEqual([...res.additive].sort(), ["DELETE /api/v1/admin/teacher-students/{id}: operation added","DELETE /api/v1/admin/teachers/{id}/delegations/{overrideId}/students/{studentId}: operation added","GET /api/v1/admin/schools/{id}/access/students: operation added","GET /api/v1/admin/schools/{id}/access: operation added","GET /api/v1/admin/teacher-students: operation added","GET /api/v1/teacher/students/summary: operation added","GET /api/v1/teacher/students: new optional query parameter \"access\"","POST /api/v1/admin/teacher-students/reassign: operation added","POST /api/v1/admin/teacher-students: operation added","POST /api/v1/admin/teachers/{id}/delegations › request application/json.studentIds: new optional field","POST /api/v1/admin/teachers/{id}/delegations › request application/json.studentScope: new optional field","POST /api/v1/admin/teachers/{id}/delegations/{overrideId}/reviewed: operation added","POST /api/v1/admin/teachers/{id}/delegations/{overrideId}/students: operation added","POST /api/v1/admin/users/bulk › request application/json.action: enum values added: assignTeacher, grantDelegation, revokeDelegation, unassignTeacher","POST /api/v1/admin/users/bulk › request application/json.params.permission: new optional field","POST /api/v1/admin/users/bulk › request application/json.params.teacherId: new optional field","POST /api/v1/admin/users/bulk/preview › request application/json.action: enum values added: assignTeacher, grantDelegation, revokeDelegation, unassignTeacher","POST /api/v1/admin/users/bulk/preview › request application/json.params.permission: new optional field","POST /api/v1/admin/users/bulk/preview › request application/json.params.teacherId: new optional field","schema AssignTeacherStudentsDto: added","schema DelegationStudentsDto: added","schema ReassignTeacherStudentsDto: added"].sort());
  });

  test('registration avatar → registration timeline: one read operation; nothing else', () => {
    for (const f of [REGISTRATION_AVATAR_SNAPSHOT, REGISTRATION_TIMELINE_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(REGISTRATION_AVATAR_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(REGISTRATION_TIMELINE_SNAPSHOT, 'utf8')));
    assert.deepEqual([res.breaking, res.review, res.additive], [[], [], ['GET /api/v1/admin/users/{id}/registration-timeline: operation added']]);
  });

  test('registration timeline → approved decisions 9.2 / 9.3: exactly one approved breaking change (guardian phone), the date-of-birth step, avatar response bodies', () => {
    for (const f of [REGISTRATION_TIMELINE_SNAPSHOT, APPROVED_DECISIONS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(REGISTRATION_TIMELINE_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(APPROVED_DECISIONS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, ['POST /api/v1/auth/register/student › request application/json.guardianPhone: field is now required']);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'DELETE /api/v1/me/avatar: response 200 body added',
      'PUT /api/v1/me/avatar: response 200 body added',
      'PUT /api/v1/me/date-of-birth: operation added',
      'schema SetDateOfBirthDto: added',
    ]);
  });

  test('teacher–student access → + decisions 9.2 / 9.3: the same changes as on feat/applications-complete, nothing else', () => {
    for (const f of [TEACHER_STUDENT_SNAPSHOT, TEACHER_STUDENT_DECISIONS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(TEACHER_STUDENT_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(TEACHER_STUDENT_DECISIONS_SNAPSHOT, 'utf8')));
    const direct = compare(JSON.parse(readFileSync(REGISTRATION_TIMELINE_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(APPROVED_DECISIONS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual([res.breaking, res.review, res.additive], [direct.breaking, direct.review, direct.additive]);
  });

  test('approved decisions → final review: date-of-birth correction and history, application picture review; additive only', () => {
    for (const f of [APPROVED_DECISIONS_SNAPSHOT, FINAL_REVIEW_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(APPROVED_DECISIONS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(FINAL_REVIEW_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual([res.breaking, res.review], [[], []]);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/teacher-applications/{id}/avatar: operation added',
      'GET /api/v1/admin/users/{id}/date-of-birth-history: operation added',
      'GET /api/v1/mentor-requests/{id}/avatar: operation added',
      'PATCH /api/v1/mentor-requests/{id}/approve: optional request body added',
      'POST /api/v1/admin/teacher-applications/{id}/approve › request application/json.approvePicture: new optional field',
      'PUT /api/v1/admin/users/{id}/date-of-birth: operation added',
      'schema ApproveMentorRequestDto: added',
      'schema CorrectDateOfBirthDto: added',
    ]);
  });

  test('teacher–student + decisions → + final review: the same changes as on feat/applications-complete, nothing else', () => {
    for (const f of [TEACHER_STUDENT_DECISIONS_SNAPSHOT, TEACHER_STUDENT_FINAL_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(TEACHER_STUDENT_DECISIONS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(TEACHER_STUDENT_FINAL_SNAPSHOT, 'utf8')));
    const direct = compare(JSON.parse(readFileSync(APPROVED_DECISIONS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(FINAL_REVIEW_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual([res.breaking, res.review, res.additive], [direct.breaking, direct.review, direct.additive]);
  });

  test('teacher–student final → info-request token in the body (SEC-05): exactly the two path routes replaced, nothing else', () => {
    for (const f of [TEACHER_STUDENT_FINAL_SNAPSHOT, INFO_REQUEST_TOKEN_BODY_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(TEACHER_STUDENT_FINAL_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(INFO_REQUEST_TOKEN_BODY_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking.sort(), [
      'GET /api/v1/applications/info-requests/{token}: operation removed',
      'POST /api/v1/applications/info-requests/{token}: operation removed',
    ]);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'POST /api/v1/applications/info-requests/answer: operation added',
      'POST /api/v1/applications/info-requests/view: operation added',
      'schema AnswerInfoRequestDto: no longer defined (check uses above)',
      'schema AnswerInfoRequestWithTokenDto: added',
      'schema InfoRequestTokenDto: added',
    ]);
  });

  test('info-request token in the body → countries (owner decision 2026-11-19): additive only — 3 routes, 1 schema, no field change', () => {
    for (const f of [INFO_REQUEST_TOKEN_BODY_SNAPSHOT, COUNTRIES_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(INFO_REQUEST_TOKEN_BODY_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(COUNTRIES_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/countries: operation added',
      'GET /api/v1/countries: operation added',
      'PATCH /api/v1/admin/countries/{code}: operation added',
      'schema UpdateCountryDto: added',
    ]);
  });

  // The owner approved making the subjects REQUIRED on new coach applications (2026-11-19, Option A): a newly required
  // request field is breaking by design here, so it is pinned explicitly — with the one optional field that lets an
  // Administrator edit a Coach's subjects — and nothing else may change.
  test('countries → coach subject interests (owner decision 2026-11-19): the approved required field and one optional field, nothing else', () => {
    for (const f of [COUNTRIES_SNAPSHOT, COACH_INTERESTS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(COUNTRIES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(COACH_INTERESTS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, ['POST /api/v1/mentor-requests › request application/json.olympiadInterests: field is now required']);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ['PATCH /api/v1/admin/users/{id} › request application/json.olympiadInterests: new optional field']);
  });

  test('coach subject interests → primary teacher (owner decision 2026-11-19): additive only — 2 routes, 1 optional query parameter, no field change', () => {
    for (const f of [COACH_INTERESTS_SNAPSHOT, PRIMARY_TEACHER_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(COACH_INTERESTS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(PRIMARY_TEACHER_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/teacher-assignments: new optional query parameter "role"',
      'GET /api/v1/teacher/schools: operation added',
      'POST /api/v1/admin/teacher-assignments/{id}/primary: operation added',
    ]);
  });

  test('primary teacher → schools table (2026-11-19): additive only — 2 optional query parameters, no field change', () => {
    for (const f of [PRIMARY_TEACHER_SNAPSHOT, SCHOOLS_TABLE_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(PRIMARY_TEACHER_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOLS_TABLE_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/schools: new optional query parameter "order"',
      'GET /api/v1/admin/schools: new optional query parameter "sort"',
    ]);
  });

  test('schools table → Test Management Phase 1 (2026-11-19): additive only — 19 routes, 7 request schemas, no existing field changed', () => {
    for (const f of [SCHOOLS_TABLE_SNAPSHOT, TEST_MANAGEMENT_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOLS_TABLE_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(TEST_MANAGEMENT_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'DELETE /api/v1/admin/tests/{id}/files/{kind}: operation added',
      'DELETE /api/v1/admin/tests/{id}/questions/{questionId}: operation added',
      'DELETE /api/v1/admin/tests/{id}: operation added',
      'GET /api/v1/admin/test-markers/candidates: operation added',
      'GET /api/v1/admin/test-markers: operation added',
      'GET /api/v1/admin/tests/subjects: operation added',
      'GET /api/v1/admin/tests/{id}/files/{kind}: operation added',
      'GET /api/v1/admin/tests/{id}: operation added',
      'GET /api/v1/admin/tests: operation added',
      'PATCH /api/v1/admin/tests/{id}/questions/{questionId}: operation added',
      'PATCH /api/v1/admin/tests/{id}: operation added',
      'POST /api/v1/admin/test-markers/{id}/revoke: operation added',
      'POST /api/v1/admin/test-markers: operation added',
      'POST /api/v1/admin/tests/{id}/publish: operation added',
      'POST /api/v1/admin/tests/{id}/questions: operation added',
      'POST /api/v1/admin/tests/{id}/unpublish: operation added',
      'POST /api/v1/admin/tests: operation added',
      'PUT /api/v1/admin/tests/{id}/files/{kind}: operation added',
      'PUT /api/v1/admin/tests/{id}/questions/order: operation added',
      'schema CreateTestDto: added',
      'schema GrantMarkerDto: added',
      'schema ReorderTestQuestionsDto: added',
      'schema RevokeMarkerDto: added',
      'schema TestQuestionInputDto: added',
      'schema UpdateTestDto: added',
      'schema UpdateTestQuestionDto: added',
    ]);
  });

  test('Test Management Phase 1 → Phase 2 (2026-11-19): additive only — 25 routes, 4 request schemas, no existing field changed', () => {
    for (const f of [TEST_MANAGEMENT_SNAPSHOT, TEST_SUBMISSIONS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(TEST_MANAGEMENT_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(TEST_SUBMISSIONS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'DELETE /api/v1/me/tests/{id}/uploads/{uploadKey}/pages/{page}: operation added',
      'DELETE /api/v1/teacher/tests/{id}/students/{studentId}/uploads/{uploadKey}/pages/{page}: operation added',
      'GET /api/v1/admin/tests/{id}/extension-targets: operation added',
      'GET /api/v1/admin/tests/{id}/extensions: operation added',
      'GET /api/v1/admin/tests/{id}/submissions/{submissionId}/versions/{versionId}/pages/{page}: operation added',
      'GET /api/v1/admin/tests/{id}/submissions/{submissionId}: operation added',
      'GET /api/v1/admin/tests/{id}/submissions: operation added',
      'GET /api/v1/me/tests/{id}/paper: operation added',
      'GET /api/v1/me/tests/{id}/uploads/{uploadKey}: operation added',
      'GET /api/v1/me/tests/{id}/versions/{versionId}/pages/{page}: operation added',
      'GET /api/v1/me/tests/{id}: operation added',
      'GET /api/v1/me/tests: operation added',
      'GET /api/v1/teacher/tests/{id}/paper: operation added',
      'GET /api/v1/teacher/tests/{id}/students/{studentId}/uploads/{uploadKey}: operation added',
      'GET /api/v1/teacher/tests/{id}/students/{studentId}/versions/{versionId}/pages/{page}: operation added',
      'GET /api/v1/teacher/tests/{id}/students/{studentId}: operation added',
      'GET /api/v1/teacher/tests/{id}/students: operation added',
      'GET /api/v1/teacher/tests: operation added',
      'PATCH /api/v1/admin/tests/{id}/extensions/{extensionId}: operation added',
      'POST /api/v1/admin/tests/{id}/extensions/{extensionId}/cancel: operation added',
      'POST /api/v1/admin/tests/{id}/extensions: operation added',
      'POST /api/v1/me/tests/{id}/submission: operation added',
      'POST /api/v1/me/tests/{id}/uploads/{uploadKey}/pages/{page}: operation added',
      'POST /api/v1/teacher/tests/{id}/students/{studentId}/submission: operation added',
      'POST /api/v1/teacher/tests/{id}/students/{studentId}/uploads/{uploadKey}/pages/{page}: operation added',
      'schema CancelTestExtensionDto: added',
      'schema CreateTestExtensionDto: added',
      'schema SubmitTestAnswerDto: added',
      'schema UpdateTestExtensionDto: added',
    ]);
  });

  test('Test Management Phase 2 → Phase 3 (2026-11-19): additive only — 19 routes, 12 request schemas, no existing field changed', () => {
    for (const f of [TEST_SUBMISSIONS_SNAPSHOT, TEST_MARKING_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(TEST_SUBMISSIONS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(TEST_MARKING_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/tests/{id}/marking/history: operation added',
      'GET /api/v1/admin/tests/{id}/marking/submissions/{submissionId}: operation added',
      'GET /api/v1/admin/tests/{id}/marking/submissions: operation added',
      'GET /api/v1/admin/tests/{id}/marking: operation added',
      'GET /api/v1/marking/queue: operation added',
      'GET /api/v1/marking/submissions/{code}/marking-guide: operation added',
      'GET /api/v1/marking/submissions/{code}/pages/{page}: operation added',
      'GET /api/v1/marking/submissions/{code}/paper: operation added',
      'GET /api/v1/marking/submissions/{code}: operation added',
      'POST /api/v1/admin/tests/{id}/marking/assign: operation added',
      'POST /api/v1/admin/tests/{id}/marking/distribute: operation added',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/approve: operation added',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/choose: operation added',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/reassign: operation added',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/return: operation added',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/second-marking: operation added',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/unlock: operation added',
      'POST /api/v1/marking/submissions/{code}/marking/submit: operation added',
      'PUT /api/v1/marking/submissions/{code}/marking: operation added',
      'schema ApproveMarkingDto: added',
      'schema AssignMarkingDto: added',
      'schema ChooseMarkDto: added',
      'schema DistributeMarkingDto: added',
      'schema MarksInputDto: added',
      'schema ReassignMarkingDto: added',
      'schema RequestSecondMarkingDto: added',
      'schema ReturnMarkingDto: added',
      'schema SaveMarkingDto: added',
      'schema ScoreInputDto: added',
      'schema SubmitMarkingDto: added',
      'schema UnlockMarkingDto: added',
    ]);
  });

  test('home location → gender step (2026-11-20): additive only — PUT /me/gender and an Administrator correction', () => {
    for (const f of [HOME_LOCATION_SNAPSHOT, GENDER_STEP_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(HOME_LOCATION_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(GENDER_STEP_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'PATCH /api/v1/admin/users/{id} › request application/json.gender: new optional field',
      'PUT /api/v1/me/gender: operation added',
      'schema SetGenderDto: added',
    ]);
  });

  test('gender at sign-up → home location (2026-11-20): the deliberate required home country on two sign-ups; the rest additive', () => {
    // Deliberately BREAKING for two sign-up requests (owner, 2026-11-20: the home country is required on every
    // registration form); the frontend released with this backend sends it. Everything else is additive.
    for (const f of [REGISTRATION_GENDER_SNAPSHOT, HOME_LOCATION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(REGISTRATION_GENDER_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(HOME_LOCATION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking.sort(), [
      'POST /api/v1/auth/register/student › request application/json.homeCountry: field is now required',
      'POST /api/v1/mentor-requests › request application/json.country: field is now required',
    ]);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'PATCH /api/v1/admin/users/{id} › request application/json.homeCountry: new optional field',
      'PATCH /api/v1/admin/users/{id} › request application/json.homeDistrict: new optional field',
      'PATCH /api/v1/admin/users/{id} › request application/json.homeProvince: new optional field',
      'PATCH /api/v1/admin/users/{id} › request application/json.homeSector: new optional field',
      'PATCH /api/v1/me › request application/json.homeCountry: new optional field',
      'PATCH /api/v1/me › request application/json.homeDistrict: new optional field',
      'PATCH /api/v1/me › request application/json.homeProvince: new optional field',
      'PATCH /api/v1/me › request application/json.homeSector: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.homeDistrict: field is now optional',
      'POST /api/v1/auth/register/teacher › request application/json.homeProvince: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.homeSector: field is now optional',
      'POST /api/v1/mentor-requests › request application/json.homeDistrict: new optional field',
      'POST /api/v1/mentor-requests › request application/json.homeProvince: new optional field',
      'POST /api/v1/mentor-requests › request application/json.homeSector: new optional field',
    ]);
  });

  test('Test Management Phase 4 → gender at sign-up (2026-11-20): exactly the deliberate required gender on the three public sign-ups; nothing else', () => {
    // Deliberately BREAKING for the three sign-up requests (owner, 2026-11-20: gender is required at every sign-up).
    // A client that does not send it is refused (400); the frontend released with this backend sends it.
    for (const f of [TEST_RESULTS_SNAPSHOT, REGISTRATION_GENDER_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(TEST_RESULTS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(REGISTRATION_GENDER_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking.sort(), [
      'POST /api/v1/auth/register/student › request application/json.gender: new required field',
      'POST /api/v1/auth/register/teacher › request application/json.gender: new required field',
      'POST /api/v1/mentor-requests › request application/json.gender: new required field',
    ]);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, []);
  });

  test('Test Management Phase 3 → Phase 4 (2026-11-20): additive only — 17 routes, 2 request schemas, PUBLISHED accepted; no existing field changed', () => {
    for (const f of [TEST_MARKING_SNAPSHOT, TEST_RESULTS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(TEST_MARKING_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(TEST_RESULTS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/test-dashboard: operation added',
      'GET /api/v1/admin/test-reports: operation added',
      'GET /api/v1/admin/tests/{id}/marking/submissions › query parameter status: enum values added: PUBLISHED',
      'GET /api/v1/admin/tests/{id}/results/export.csv: operation added',
      'GET /api/v1/admin/tests/{id}/results/preview: operation added',
      'GET /api/v1/admin/tests/{id}/results/publications: operation added',
      'GET /api/v1/admin/tests/{id}/results/rankings: operation added',
      'GET /api/v1/admin/tests/{id}/results/report: operation added',
      'GET /api/v1/admin/tests/{id}/results: operation added',
      'GET /api/v1/marking/dashboard: operation added',
      'GET /api/v1/me/test-dashboard: operation added',
      'GET /api/v1/me/test-results/{testId}: operation added',
      'GET /api/v1/me/test-results: operation added',
      'GET /api/v1/teacher/test-dashboard: operation added',
      'GET /api/v1/teacher/test-results/{testId}/students/{studentId}: operation added',
      'GET /api/v1/teacher/test-results/{testId}: operation added',
      'GET /api/v1/teacher/test-results: operation added',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/approve › request application/json.expectedStatus: enum values added: PUBLISHED',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/choose › request application/json.expectedStatus: enum values added: PUBLISHED',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/return › request application/json.expectedStatus: enum values added: PUBLISHED',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/second-marking › request application/json.expectedStatus: enum values added: PUBLISHED',
      'POST /api/v1/admin/tests/{id}/marking/submissions/{submissionId}/unlock › request application/json.expectedStatus: enum values added: PUBLISHED',
      'POST /api/v1/admin/tests/{id}/results/publish/override: operation added',
      'POST /api/v1/admin/tests/{id}/results/publish: operation added',
      'schema OverridePublicationDto: added',
      'schema PublishTestResultsDto: added',
    ]);
  });

  test('schools table → generic bulk engine (2026-11-19): additive only — 8 routes, reassignTeacher on /admin/users/bulk, nothing breaking or for review', () => {
    for (const f of [SCHOOLS_TABLE_SNAPSHOT, BULK_ENGINE_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOLS_TABLE_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(BULK_ENGINE_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/bulk/actions: operation added',
      'GET /api/v1/admin/bulk/operations/{id}/items: operation added',
      'GET /api/v1/admin/bulk/operations/{id}: operation added',
      'GET /api/v1/admin/bulk/operations: operation added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: operation added',
      'POST /api/v1/admin/bulk/{entityType}/export: operation added',
      'POST /api/v1/admin/bulk/{entityType}/preview: operation added',
      'POST /api/v1/admin/bulk/{entityType}: operation added',
      'POST /api/v1/admin/users/bulk › request application/json.action: enum values added: reassignTeacher',
      'POST /api/v1/admin/users/bulk › request application/json.params.fromTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk › request application/json.params.toTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk/preview › request application/json.action: enum values added: reassignTeacher',
      'POST /api/v1/admin/users/bulk/preview › request application/json.params.fromTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk/preview › request application/json.params.toTeacherId: new optional field',
      'schema GenericBulkExecuteDto: added',
      'schema GenericBulkExportDto: added',
      'schema GenericBulkPreviewDto: added',
      'schema GenericBulkSelectionDto: added',
    ]);
    // The direct teacher–student routes and every other /admin/users/bulk operation are untouched.
    const touched = [...res.breaking, ...res.review, ...res.additive].filter((c) => /teacher-students|teachers\/\{id\}\/delegations/.test(c));
    assert.deepEqual(touched, []);
  });

  test('bulk engine → bulk engine response documentation (2026-11-19): the generic routes document their responses and errors; nothing else changes', () => {
    for (const f of [BULK_ENGINE_SNAPSHOT, BULK_ENGINE_RESPONSES_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(BULK_ENGINE_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(BULK_ENGINE_RESPONSES_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    // The one non-additive entry corrects the documentation of an unreleased route (added in the previous snapshot, same
    // PR): POST /admin/bulk/{entityType}/export has always answered 200 with text/csv, never the 201 Swagger guessed.
    assert.deepEqual(res.breaking, ['POST /api/v1/admin/bulk/{entityType}/export: response 201 removed']);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/bulk/actions: response 200 body added',
      'GET /api/v1/admin/bulk/actions: response 401 added',
      'GET /api/v1/admin/bulk/actions: response 403 added',
      'GET /api/v1/admin/bulk/operations/{id}/items: response 200 body added',
      'GET /api/v1/admin/bulk/operations/{id}/items: response 400 added',
      'GET /api/v1/admin/bulk/operations/{id}/items: response 401 added',
      'GET /api/v1/admin/bulk/operations/{id}/items: response 403 added',
      'GET /api/v1/admin/bulk/operations/{id}/items: response 404 added',
      'GET /api/v1/admin/bulk/operations/{id}: response 200 body added',
      'GET /api/v1/admin/bulk/operations/{id}: response 400 added',
      'GET /api/v1/admin/bulk/operations/{id}: response 401 added',
      'GET /api/v1/admin/bulk/operations/{id}: response 403 added',
      'GET /api/v1/admin/bulk/operations/{id}: response 404 added',
      'GET /api/v1/admin/bulk/operations: response 200 body added',
      'GET /api/v1/admin/bulk/operations: response 400 added',
      'GET /api/v1/admin/bulk/operations: response 401 added',
      'GET /api/v1/admin/bulk/operations: response 403 added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: response 200 body added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: response 400 added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: response 401 added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: response 403 added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: response 404 added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: response 409 added',
      'POST /api/v1/admin/bulk/{entityType}/export: response 200 added',
      'POST /api/v1/admin/bulk/{entityType}/export: response 400 added',
      'POST /api/v1/admin/bulk/{entityType}/export: response 401 added',
      'POST /api/v1/admin/bulk/{entityType}/export: response 403 added',
      'POST /api/v1/admin/bulk/{entityType}/export: response 404 added',
      'POST /api/v1/admin/bulk/{entityType}/preview: response 200 body added',
      'POST /api/v1/admin/bulk/{entityType}/preview: response 400 added',
      'POST /api/v1/admin/bulk/{entityType}/preview: response 401 added',
      'POST /api/v1/admin/bulk/{entityType}/preview: response 403 added',
      'POST /api/v1/admin/bulk/{entityType}/preview: response 404 added',
      'POST /api/v1/admin/bulk/{entityType}: response 200 added',
      'POST /api/v1/admin/bulk/{entityType}: response 202 body added',
      'POST /api/v1/admin/bulk/{entityType}: response 400 added',
      'POST /api/v1/admin/bulk/{entityType}: response 401 added',
      'POST /api/v1/admin/bulk/{entityType}: response 403 added',
      'POST /api/v1/admin/bulk/{entityType}: response 404 added',
      'POST /api/v1/admin/bulk/{entityType}: response 409 added',
      'POST /api/v1/admin/bulk/{entityType}: response 410 added',
      'POST /api/v1/admin/bulk/{entityType}: response 503 added',
      'schema BulkActionView: added',
      'schema BulkActionsView: added',
      'schema BulkActorSummary: added',
      'schema BulkEntityTypeView: added',
      'schema BulkExecuteResult: added',
      'schema BulkExportView: added',
      'schema BulkItemOutcome: added',
      'schema BulkItemPage: added',
      'schema BulkItemView: added',
      'schema BulkOperationPage: added',
      'schema BulkOperationProgress: added',
      'schema BulkOperationStatus: added',
      'schema BulkOperationView: added',
      'schema BulkPageMeta: added',
      'schema BulkPreviewResult: added',
      'schema BulkPreviewWarning: added',
      'schema BulkUserSummary: added',
    ]);
    // Only the eight generic routes change: no existing operation (/admin/users/bulk, teacher–student routes…) is touched.
    const touched = [...res.breaking, ...res.review, ...res.additive].filter((c) => !c.startsWith('schema ') && !c.includes('/api/v1/admin/bulk/'));
    assert.deepEqual(touched, []);
  });

  test('home location → generic bulk engine (2026-11-20): additive only — the bulk routes, their responses and reassignTeacher; nothing breaking or for review', () => {
    for (const f of [HOME_LOCATION_SNAPSHOT, BULK_ENGINE_MERGED_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(HOME_LOCATION_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(BULK_ENGINE_MERGED_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/bulk/actions: operation added',
      'GET /api/v1/admin/bulk/operations/{id}/items: operation added',
      'GET /api/v1/admin/bulk/operations/{id}: operation added',
      'GET /api/v1/admin/bulk/operations: operation added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: operation added',
      'POST /api/v1/admin/bulk/{entityType}/export: operation added',
      'POST /api/v1/admin/bulk/{entityType}/preview: operation added',
      'POST /api/v1/admin/bulk/{entityType}: operation added',
      'POST /api/v1/admin/users/bulk › request application/json.action: enum values added: reassignTeacher',
      'POST /api/v1/admin/users/bulk › request application/json.params.fromTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk › request application/json.params.toTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk/preview › request application/json.action: enum values added: reassignTeacher',
      'POST /api/v1/admin/users/bulk/preview › request application/json.params.fromTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk/preview › request application/json.params.toTeacherId: new optional field',
      'schema BulkActionView: added',
      'schema BulkActionsView: added',
      'schema BulkActorSummary: added',
      'schema BulkEntityTypeView: added',
      'schema BulkExecuteResult: added',
      'schema BulkExportView: added',
      'schema BulkItemOutcome: added',
      'schema BulkItemPage: added',
      'schema BulkItemView: added',
      'schema BulkOperationPage: added',
      'schema BulkOperationProgress: added',
      'schema BulkOperationStatus: added',
      'schema BulkOperationView: added',
      'schema BulkPageMeta: added',
      'schema BulkPreviewResult: added',
      'schema BulkPreviewWarning: added',
      'schema BulkUserSummary: added',
      'schema GenericBulkExecuteDto: added',
      'schema GenericBulkExportDto: added',
      'schema GenericBulkPreviewDto: added',
      'schema GenericBulkSelectionDto: added',
    ]);
  });

  test('the school code → registration data (2026-11-23): additive only — twelve Super-Administrator operations and their request bodies', () => {
    for (const f of [SCHOOL_CODES_SNAPSHOT, REGISTRATION_DATA_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(REGISTRATION_DATA_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'DELETE /api/v1/admin/registration-data/layouts/{category}: operation added',
      'DELETE /api/v1/admin/registration-data/saved-filters/{id}: operation added',
      'GET /api/v1/admin/registration-data/fields: operation added',
      'GET /api/v1/admin/registration-data/layouts/{category}: operation added',
      'GET /api/v1/admin/registration-data/saved-filters: operation added',
      'GET /api/v1/admin/registration-data/users/{id}: operation added',
      'PATCH /api/v1/admin/registration-data/users/{id}: operation added',
      'POST /api/v1/admin/registration-data/export: operation added',
      'POST /api/v1/admin/registration-data/query: operation added',
      'POST /api/v1/admin/registration-data/saved-filters: operation added',
      'PUT /api/v1/admin/registration-data/layouts/{category}: operation added',
      'PUT /api/v1/admin/registration-data/saved-filters/{id}: operation added',
      'schema RegistrationQueryDto: added',
      'schema RegistrationSortDto: added',
      'schema SaveRegistrationFilterDto: added',
      'schema SaveRegistrationLayoutDto: added',
      'schema UpdateRegistrationRecordDto: added',
    ]);
  });

  test('the school code → the code of a code-less school given at registration (2026-11-23): additive only — newSchoolCode on two requests', () => {
    for (const f of [SCHOOL_CODES_SNAPSHOT, SCHOOL_CODE_AT_REGISTRATION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_CODE_AT_REGISTRATION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'POST /api/v1/auth/register/student › request application/json.newSchoolCode: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.newSchoolCode: new optional field',
    ]);
  });

  test('the school code → coaches across their programmes (2026-11-23): additive only — five operations and one request body', () => {
    for (const f of [SCHOOL_CODES_SNAPSHOT, COACH_ACCESS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(COACH_ACCESS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/coaches/{id}/programme-access: operation added',
      'GET /api/v1/coach/students: operation added',
      'GET /api/v1/coach/test-results/{testId}/students/{studentId}: operation added',
      'GET /api/v1/coach/test-results/{testId}: operation added',
      'GET /api/v1/coach/test-results: operation added',
      'PUT /api/v1/admin/coaches/{id}/programme-access: operation added',
      'schema SetCoachAccessDto: added',
    ]);
  });

  test('Olympiad levels → the school code is the identifier (2026-11-22): additive only — the sync run mode; the details of an unlisted school and the confirmation on its one-step approval', () => {
    for (const f of [OLYMPIAD_LEVELS_SNAPSHOT, SCHOOL_CODES_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(OLYMPIAD_LEVELS_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'POST /api/v1/admin/school-sync/runs: new optional query parameter "mode"',
      'POST /api/v1/admin/teacher-applications/{id}/approve › request application/json.confirmPossibleDuplicate: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.proposedSchoolAccommodation: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.proposedSchoolCell: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.proposedSchoolCode: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.proposedSchoolOwnership: new optional field',
      'POST /api/v1/auth/register/teacher › request application/json.proposedSchoolVillage: new optional field',
    ]);
  });

  test('the school code is the identifier → school list filters on every NESA field (2026-11-23): additive only — seven optional query parameters', () => {
    for (const f of [SCHOOL_CODES_SNAPSHOT, SCHOOL_FILTERS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SCHOOL_FILTERS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), ['cell', 'contact', 'hasEmail', 'hasPhone', 'ownership', 'programmeCategory', 'village']
      .map((q) => `GET /api/v1/admin/schools: new optional query parameter "${q}"`));
  });

  test('the school code is the identifier → e-mail activation per sign-up form (2026-11-23): additive only — one optional field', () => {
    for (const f of [SCHOOL_CODES_SNAPSHOT, FORM_EMAIL_VERIFICATION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(FORM_EMAIL_VERIFICATION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ['PATCH /api/v1/admin/forms/{key}/availability › request application/json.requireEmailVerification: new optional field']);
  });

  test('the school code is the identifier → news subscribers (2026-11-23): additive only — 16 routes, 8 request schemas, no existing field changed', () => {
    for (const f of [SCHOOL_CODES_SNAPSHOT, SUBSCRIBERS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(SUBSCRIBERS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      "DELETE /api/v1/admin/subscribers/{id}: operation added",
      "GET /api/v1/admin/subscribers/export: operation added",
      "GET /api/v1/admin/subscribers/mailings/{id}: operation added",
      "GET /api/v1/admin/subscribers/mailings: operation added",
      "GET /api/v1/admin/subscribers/summary: operation added",
      "GET /api/v1/admin/subscribers: operation added",
      "PATCH /api/v1/admin/subscribers/{id}: operation added",
      "POST /api/v1/admin/subscribers/import: operation added",
      "POST /api/v1/admin/subscribers/mailings/preview: operation added",
      "POST /api/v1/admin/subscribers/mailings/test: operation added",
      "POST /api/v1/admin/subscribers/mailings/{id}/cancel: operation added",
      "POST /api/v1/admin/subscribers/mailings: operation added",
      "POST /api/v1/admin/subscribers: operation added",
      "POST /api/v1/public/subscribe: operation added",
      "POST /api/v1/public/unsubscribe/one-click: operation added",
      "POST /api/v1/public/unsubscribe: operation added",
      "schema AudienceDto: added",
      "schema CreateMailingDto: added",
      "schema CreateSubscriberDto: added",
      "schema MailingAudienceDto: added",
      "schema SubscribeDto: added",
      "schema TestMailingDto: added",
      "schema UnsubscribeDto: added",
      "schema UpdateSubscriberDto: added",
    ]);
  });

  test('the school code is the identifier → view as, read only (2026-11-23): additive only — three operations, two request schemas', () => {
    for (const f of [SCHOOL_CODES_SNAPSHOT, VIEW_AS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(VIEW_AS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'POST /api/v1/admin/users/{id}/view-as: operation added',
      'POST /api/v1/auth/view-as/end: operation added',
      'POST /api/v1/auth/view-as/exchange: operation added',
      'schema ExchangeViewAsDto: added',
      'schema StartViewAsDto: added',
    ]);
  });

  test('integration of the 2026-11-23 branches → activate now (2026-11-24): additive only — one operation, one bulk action, the preview\'s willApply', () => {
    for (const f of [INTEGRATION_SNAPSHOT, ACTIVATE_NOW_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(INTEGRATION_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(ACTIVATE_NOW_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'POST /api/v1/admin/bulk/{entityType}/preview › response 200 application/json.willApply: new field',
      'POST /api/v1/admin/users/bulk › request application/json.action: enum values added: activateNow',
      'POST /api/v1/admin/users/bulk/preview › request application/json.action: enum values added: activateNow',
      'POST /api/v1/admin/users/{id}/activate-now: operation added',
    ]);
  });

  test('activate now → banking information (2026-11-25): additive only — the banking operations, the list filter, and every-role x-roles on the any-signed-in routes', () => {
    for (const f of [ACTIVATE_NOW_SNAPSHOT, BANKING_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(ACTIVATE_NOW_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(BANKING_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    const ROLES_ADDED = ': roles added: HEAD_COACH, SUPER_ADMIN, TEACHER';
    assert.deepEqual(res.additive.filter((c) => !c.endsWith(ROLES_ADDED)).sort(), [
      'GET /api/v1/admin/users/{id}/banking: operation added',
      'GET /api/v1/admin/users: new optional query parameter "banking"',
      'GET /api/v1/me/banking: operation added',
      'PUT /api/v1/me/banking: operation added',
      'schema SaveBankingDto: added',
    ]);
    // The documentation correction: exactly the routes open to any signed-in user (neither @Roles nor a permission) —
    // they now list every role, as the guards admit every role there.
    const corrected = res.additive.filter((c) => c.endsWith(ROLES_ADDED)).map((c) => c.slice(0, -ROLES_ADDED.length));
    const doc = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8'));
    const anySignedIn = Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item)
      .filter(([, op]) => op && op.operationId && !op['x-permission'] && op['x-roles']?.length === 6)
      .map(([method]) => `${method.toUpperCase()} ${path}`));
    assert.equal(corrected.length, 65);
    for (const key of corrected) assert.ok(anySignedIn.includes(key), `${key}: open to every signed-in role`);
    const banking = doc.paths['/api/v1/me/banking'];
    for (const m of ['get', 'put']) assert.deepEqual([...banking[m]['x-roles']].sort(), ['HEAD_COACH', 'MENTOR', 'TEACHER']);
  });

  test("banking information → banking editing (2026-11-25): additive only — an administrator's edit operation", () => {
    for (const f of [BANKING_SNAPSHOT, BANKING_EDIT_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(BANKING_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(BANKING_EDIT_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, ['PUT /api/v1/admin/users/{id}/banking: operation added']);
    const op = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8')).paths['/api/v1/admin/users/{id}/banking'].put;
    assert.equal(op['x-permission'], 'users.manage');
  });

  test("banking editing → report templates (2026-11-25): additive only — isTemplate on saving a report", () => {
    for (const f of [BANKING_EDIT_SNAPSHOT, REPORT_TEMPLATES_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(BANKING_EDIT_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(REPORT_TEMPLATES_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'POST /api/v1/reports › request application/json.isTemplate: new optional field',
      'PUT /api/v1/reports/{id} › request application/json.isTemplate: new optional field',
    ]);
  });

  test('report templates → the queue "To mark" filter (2026-11-26): additive only — state=TO_MARK', () => {
    for (const f of [REPORT_TEMPLATES_SNAPSHOT, QUEUE_TO_MARK_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(REPORT_TEMPLATES_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(QUEUE_TO_MARK_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/marking/queue › query parameter state: enum values added: TO_MARK',
    ]);
  });

  test('the queue "To mark" filter → question-level marking (Rev 5.2): additive only — the 31 routes, their request schemas, correctionReason', () => {
    for (const f of [QUEUE_TO_MARK_SNAPSHOT, QUESTION_MARKING_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(QUEUE_TO_MARK_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(QUESTION_MARKING_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      "GET /api/v1/admin/tests/{id}/question-marking/history: operation added",
      "GET /api/v1/admin/tests/{id}/question-marking/markers: operation added",
      "GET /api/v1/admin/tests/{id}/question-marking/papers/{submissionId}/pages/{page}: operation added",
      "GET /api/v1/admin/tests/{id}/question-marking/progress: operation added",
      "GET /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}: operation added",
      "GET /api/v1/admin/tests/{id}/question-marking/tasks: operation added",
      "GET /api/v1/admin/tests/{id}/question-marking: operation added",
      "GET /api/v1/marking/tasks/{code}/{ref}/marking-guide: operation added",
      "GET /api/v1/marking/tasks/{code}/{ref}/pages/{page}: operation added",
      "GET /api/v1/marking/tasks/{code}/{ref}/paper: operation added",
      "GET /api/v1/marking/tasks/{code}/{ref}: operation added",
      "GET /api/v1/marking/tasks: operation added",
      "PATCH /api/v1/admin/tests/{id}/question-marking/mode: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/questions/{questionId}/wording-correction: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/structure-correction: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/generate: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/approve: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/assign: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/cancel-second: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/decide: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/release: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/reopen: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/return: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/review-hold: operation added",
      "POST /api/v1/admin/tests/{id}/question-marking/tasks/{taskId}/second-assessment: operation added",
      "POST /api/v1/marking/tasks/{code}/{ref}/claim: operation added",
      "POST /api/v1/marking/tasks/{code}/{ref}/heartbeat: operation added",
      "POST /api/v1/marking/tasks/{code}/{ref}/release: operation added",
      "POST /api/v1/marking/tasks/{code}/{ref}/submit: operation added",
      "PUT /api/v1/admin/tests/{id}/files/{kind}: new optional query parameter \"correctionReason\"",
      "PUT /api/v1/admin/tests/{id}/question-marking/questions/{questionId}/markers: operation added",
      "PUT /api/v1/marking/tasks/{code}/{ref}/marks: operation added",
      "schema AssignQuestionTaskDto: added",
      "schema DecideQuestionDto: added",
      "schema MarkingModeDto: added",
      "schema QuestionMarkersDto: added",
      "schema QuestionMarksDto: added",
      "schema QuestionReviewDto: added",
      "schema ReasonDto: added",
      "schema ReopenQuestionDto: added",
      "schema ReturnQuestionDto: added",
      "schema SecondAssessmentDto: added",
      "schema StructureCorrectionDto: added",
      "schema StructureQuestionDto: added",
      "schema WordingCorrectionDto: added"
    ]);
  });

  test('activate now (2026-11-24): the documented 200 response is { user, stillBlockedBy, message } — the shape the frontend reads', () => {
    const op = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8')).paths['/api/v1/admin/users/{id}/activate-now'].post;
    const schema = op.responses['200'].content['application/json'].schema;
    assert.deepEqual(schema.required, ['message', 'stillBlockedBy', 'user']);
    assert.equal(schema.properties.message.type, 'string');
    assert.equal(schema.properties.stillBlockedBy.type, 'array');
    assert.equal(schema.properties.stillBlockedBy.items.type, 'string');
    assert.deepEqual(schema.properties.user.required,
      ['accountStatus', 'activatedAt', 'firstName', 'id', 'isActive', 'isApproved', 'lastName', 'role', 'updatedAt', 'username']);
    assert.match(op.responses['200'].description, /stillBlockedBy/);
    const saved = JSON.parse(readFileSync(ACTIVATE_NOW_SNAPSHOT, 'utf8')).operations.find((o) => o.key === 'POST /api/v1/admin/users/{id}/activate-now');
    assert.notEqual(saved.responses['200'], null, 'the saved contract has the response body');
  });

  test('the school code is the identifier → integration of the 2026-11-23 branches (audit 2026-11-24): nothing breaking, nothing for review; every branch snapshot is contained', () => {
    for (const f of [SCHOOL_CODES_SNAPSHOT, INTEGRATION_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const base = JSON.parse(readFileSync(SCHOOL_CODES_SNAPSHOT, 'utf8'));
    const res = compare(base, JSON.parse(readFileSync(INTEGRATION_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    // Each branch's own additions are all present together.
    for (const branch of [REGISTRATION_DATA_SNAPSHOT, SCHOOL_CODE_AT_REGISTRATION_SNAPSHOT, COACH_ACCESS_SNAPSHOT, SCHOOL_FILTERS_SNAPSHOT, FORM_EMAIL_VERIFICATION_SNAPSHOT, SUBSCRIBERS_SNAPSHOT, VIEW_AS_SNAPSHOT]) {
      const own = compare(base, JSON.parse(readFileSync(branch, 'utf8'))).additive;
      assert.deepEqual([branch, own.filter((a) => !res.additive.includes(a))], [branch, []]);
    }
  });

  test('teacher self-service → divisions, Olympiad levels, course offerings, the profile overview, custom reports and table layouts (2026-11-22): additive only — each change listed', () => {
    for (const f of [TEACHER_SELF_SERVICE_SNAPSHOT, OLYMPIAD_LEVELS_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(TEACHER_SELF_SERVICE_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(OLYMPIAD_LEVELS_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'DELETE /api/v1/admin/table-layouts/{table}: operation added',
      'DELETE /api/v1/me/table-layouts/{table}: operation added',
      'DELETE /api/v1/reports/{id}: operation added',
      'GET /api/v1/admin/divisions/{id}/courses: operation added',
      'GET /api/v1/admin/students/{id}/olympiad-level: operation added',
      'GET /api/v1/admin/tests › query parameter division: enum restriction removed (any value)',
      'GET /api/v1/admin/tests/{id}/results › query parameter division: enum restriction removed (any value)',
      'GET /api/v1/admin/tests/{id}/results/rankings › query parameter division: enum restriction removed (any value)',
      'GET /api/v1/admin/tests/{id}/submissions › query parameter division: enum restriction removed (any value)',
      'GET /api/v1/admin/users: new optional query parameter \"order\"',
      'GET /api/v1/admin/users: new optional query parameter \"sort\"',
      'GET /api/v1/me/table-layouts/{table}: operation added',
      'GET /api/v1/reports/sources: operation added',
      'GET /api/v1/reports/{id}/export: operation added',
      'GET /api/v1/reports/{id}/grants: operation added',
      'GET /api/v1/reports/{id}/run: operation added',
      'GET /api/v1/reports/{id}: operation added',
      'GET /api/v1/reports: operation added',
      'GET /api/v1/students/{id}/overview: operation added',
      'GET /api/v1/teacher/tests/{id}/students › query parameter division: enum restriction removed (any value)',
      'PATCH /api/v1/admin/divisions/{id} › request application/json.sortOrder: new optional field',
      'PATCH /api/v1/admin/divisions/{id} › request application/json.suggestedGrades: new optional field',
      'PATCH /api/v1/admin/tests/{id} › request application/json.division: enum restriction removed (any value)',
      'POST /api/v1/admin/divisions: operation added',
      'POST /api/v1/admin/mentor-assignments/bulk: operation added',
      'POST /api/v1/admin/tests › request application/json.division: enum restriction removed (any value)',
      'POST /api/v1/admin/users/bulk › request application/json.action: enum values added: setOlympiadLevel',
      'POST /api/v1/admin/users/bulk › request application/json.params.olympiadLevel: new optional field',
      'POST /api/v1/admin/users/bulk/preview › request application/json.action: enum values added: setOlympiadLevel',
      'POST /api/v1/admin/users/bulk/preview › request application/json.params.olympiadLevel: new optional field',
      'POST /api/v1/reports/preview: operation added',
      'POST /api/v1/reports/{id}/preview: operation added',
      'POST /api/v1/reports: operation added',
      'PUT /api/v1/admin/divisions/{id}/courses: operation added',
      'PUT /api/v1/admin/students/{id}/olympiad-level: operation added',
      'PUT /api/v1/admin/table-layouts/{table}: operation added',
      'PUT /api/v1/me/table-layouts/{table}: operation added',
      'PUT /api/v1/reports/{id}/grants: operation added',
      'PUT /api/v1/reports/{id}: operation added',
      'schema BulkMentorAssignmentDto: added',
      'schema CoursePairDto: added',
      'schema CreateDivisionDto: added',
      'schema ReportDefinitionDto: added',
      'schema ReportFilterDto: added',
      'schema ReportGrantDto: added',
      'schema ReportSortDto: added',
      'schema SaveReportDto: added',
      'schema SaveTableLayoutDto: added',
      'schema SetDivisionCoursesDto: added',
      'schema SetOlympiadLevelDto: added',
      'schema SetReportGrantsDto: added',
    ]);
  });

  test('"Other" Olympiad interest → teacher self-service and locked submissions (2026-11-21): additive only — the resubmission and teacher test-submission routes, the level and subject filters', () => {
    for (const f of [OLYMPIAD_OTHER_SNAPSHOT, TEACHER_SELF_SERVICE_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(OLYMPIAD_OTHER_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(TEACHER_SELF_SERVICE_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'DELETE /api/v1/admin/tests/{id}/submissions/{submissionId}/resubmission: operation added',
      'GET /api/v1/admin/teachers/{id}/test-submission: operation added',
      'GET /api/v1/teacher/tests/{id}/students: new optional query parameter "division"',
      'GET /api/v1/teacher/tests/{id}/students: new optional query parameter "subject"',
      'POST /api/v1/admin/tests/{id}/submissions/{submissionId}/resubmission: operation added',
      'PUT /api/v1/admin/teachers/{id}/test-submission: operation added',
      'schema AuthorizeResubmissionDto: added',
      'schema SetTeacherTestSubmissionDto: added',
    ]);
  });

  test('generic bulk engine → "Other" Olympiad interest (2026-11-21): additive only — olympiadInterestOther, and olympiadInterests may be empty beside it', () => {
    for (const f of [BULK_ENGINE_ON_GENDER_STEP_SNAPSHOT, OLYMPIAD_OTHER_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(BULK_ENGINE_ON_GENDER_STEP_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(OLYMPIAD_OTHER_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    const routes = ['PATCH /api/v1/admin/users/{id}', 'PATCH /api/v1/me', 'POST /api/v1/auth/register/student', 'POST /api/v1/auth/register/teacher', 'POST /api/v1/mentor-requests'];
    assert.deepEqual(res.additive.sort(), routes.flatMap((r) => [
      `${r} › request application/json.olympiadInterestOther: new optional field`,
      `${r} › request application/json.olympiadInterests: minItems removed`,
    ]).sort());
  });

  test('gender step → generic bulk engine (2026-11-20): additive only — the bulk routes, their responses and reassignTeacher; nothing breaking or for review', () => {
    for (const f of [GENDER_STEP_SNAPSHOT, BULK_ENGINE_ON_GENDER_STEP_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(GENDER_STEP_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(BULK_ENGINE_ON_GENDER_STEP_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive.sort(), [
      'GET /api/v1/admin/bulk/actions: operation added',
      'GET /api/v1/admin/bulk/operations/{id}/items: operation added',
      'GET /api/v1/admin/bulk/operations/{id}: operation added',
      'GET /api/v1/admin/bulk/operations: operation added',
      'POST /api/v1/admin/bulk/operations/{id}/cancel: operation added',
      'POST /api/v1/admin/bulk/{entityType}/export: operation added',
      'POST /api/v1/admin/bulk/{entityType}/preview: operation added',
      'POST /api/v1/admin/bulk/{entityType}: operation added',
      'POST /api/v1/admin/users/bulk › request application/json.action: enum values added: reassignTeacher',
      'POST /api/v1/admin/users/bulk › request application/json.params.fromTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk › request application/json.params.toTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk/preview › request application/json.action: enum values added: reassignTeacher',
      'POST /api/v1/admin/users/bulk/preview › request application/json.params.fromTeacherId: new optional field',
      'POST /api/v1/admin/users/bulk/preview › request application/json.params.toTeacherId: new optional field',
      'schema BulkActionView: added',
      'schema BulkActionsView: added',
      'schema BulkActorSummary: added',
      'schema BulkEntityTypeView: added',
      'schema BulkExecuteResult: added',
      'schema BulkExportView: added',
      'schema BulkItemOutcome: added',
      'schema BulkItemPage: added',
      'schema BulkItemView: added',
      'schema BulkOperationPage: added',
      'schema BulkOperationProgress: added',
      'schema BulkOperationStatus: added',
      'schema BulkOperationView: added',
      'schema BulkPageMeta: added',
      'schema BulkPreviewResult: added',
      'schema BulkPreviewWarning: added',
      'schema BulkUserSummary: added',
      'schema GenericBulkExecuteDto: added',
      'schema GenericBulkExportDto: added',
      'schema GenericBulkPreviewDto: added',
      'schema GenericBulkSelectionDto: added',
    ]);
  });

  test('the P0-03 snapshot is the recorded historical evidence (fingerprint unchanged)', () => {
    const p0 = JSON.parse(readFileSync(P0_03_SNAPSHOT, 'utf8'));
    assert.equal(p0.fingerprint, '34d76bdd8e98257b66a6bf880527d0d25174806af44fc679ba298a5e3a7e59d7');
    assert.equal(p0.operations.length, 202);
  });
});
