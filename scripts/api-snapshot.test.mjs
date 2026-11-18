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
const CURRENT_SNAPSHOT = ROLE_NOTIFICATION_SETTINGS_SNAPSHOT;
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

  test('the P0-03 snapshot is the recorded historical evidence (fingerprint unchanged)', () => {
    const p0 = JSON.parse(readFileSync(P0_03_SNAPSHOT, 'utf8'));
    assert.equal(p0.fingerprint, '34d76bdd8e98257b66a6bf880527d0d25174806af44fc679ba298a5e3a7e59d7');
    assert.equal(p0.operations.length, 202);
  });
});
