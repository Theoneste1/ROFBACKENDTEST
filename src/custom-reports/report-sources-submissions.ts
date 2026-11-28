/**
 * Submission reports (owner 2026-11-28): every submitted test answer, one row per submission — an answer moved to
 * another test or level by "Reassign submission" is the SAME row (its current test and level), so it is never counted
 * twice; its corrections (TestSubmissionCorrection, append-only) give the original test, subject and level, the reason,
 * who corrected it and when.
 *
 * Scope "submissions" (custom-reports.service.ts scopeFor): Administrators every answer; a Head Coach the answers of
 * the subjects of their programmes; a Teacher the answers of the students of their schools; nobody else — a Coach never
 * (blind marking: markers must not see whose paper is whose), a Student never. Sharing a report never widens that.
 * No paper code, typed answer, page or mark is offered here: identities and codes stay apart (blind marking).
 */
import { TestSubmissionStatus } from '../generated/prisma/enums.js';
import type { FieldDef, FilterOp, SourceDef } from './report-sources.js';
import { choiceField, dateField, pathField, personFields, textField, vals } from './report-sources-admin.js';

/** The corrections of a row, oldest first (as selected below). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a row of the submissions table
const corrections = (r: any): any[] => (Array.isArray(r.corrections) ? r.corrections : []);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const first = (r: any) => corrections(r)[0] ?? null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const last = (r: any) => corrections(r).at(-1) ?? null;
const name = (p: { firstName?: string; lastName?: string } | null | undefined) => (p ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || null : null);
/** A level code as people read it (JUNIOR → Junior). */
const levelLabel = (code: string | null | undefined) => (code ? (code === 'ALL' ? 'Every level' : code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ')) : null);

/** Corrected: yes / no (filterable: has a correction, or none). */
const corrected: FieldDef = {
  key: 'corrected', label: 'Corrected', type: 'boolean',
  value: (r) => corrections(r).length > 0,
  where: (op: FilterOp, v: unknown) => {
    if (op !== 'eq' || (v !== true && v !== false && v !== 'true' && v !== 'false')) return null;
    return v === true || v === 'true' ? { corrections: { some: {} } } : { corrections: { none: {} } };
  },
};

/** A value of the first correction (the original) or the latest (the reason, who, when); not filterable or sortable. */
const fromCorrection = (key: string, label: string, pick: (r: unknown) => string | Date | null, type: 'text' | 'date' = 'text'): FieldDef =>
  pathField({ key, label, path: ['id'], type, filterable: false, sortable: false, display: pick });

export const SUBMISSION_SOURCES: Readonly<Record<string, SourceDef>> = {
  SUBMISSIONS: {
    key: 'SUBMISSIONS', label: 'Test submissions (with corrections)', group: 'Learning', model: 'testSubmission', scope: 'submissions',
    // Only answers that were submitted (a row with no version is an upload in progress).
    rows: { versionCount: { gt: 0 } },
    select: {
      id: true, status: true, level: true, firstSubmittedAt: true, lastSubmittedAt: true,
      test: { select: { title: true, division: true, discipline: { select: { name: true } } } },
      student: { select: { firstName: true, lastName: true, username: true, school: { select: { name: true, district: true } } } },
      corrections: {
        orderBy: { createdAt: 'asc' },
        select: {
          createdAt: true, reason: true, fromTestTitle: true, fromSubjectName: true, fromLevel: true, toTestTitle: true, toSubjectName: true, toLevel: true,
          actor: { select: { firstName: true, lastName: true } },
        },
      },
      _count: { select: { corrections: true } },
    },
    defaultOrder: [{ firstSubmittedAt: { sort: 'desc', nulls: 'last' } }],
    summary: ['status', 'subject', 'level', 'school', 'corrected'],
    fields: [
      personFields('student', 'Student')[0],
      textField('studentUsername', 'Student username', ['student', 'username']),
      textField('school', 'School', ['student', 'school', 'name'], false, 2),
      textField('schoolDistrict', 'School district', ['student', 'school', 'district'], true, 2),
      textField('subject', 'Subject', ['test', 'discipline', 'name']),
      pathField({ key: 'level', label: 'Level', path: ['level'], type: 'text', nullable: true, display: (r) => levelLabel(r.level) }),
      // Round: the test's title (owner 2026-11-28: no separate round field).
      textField('test', 'Test / round', ['test', 'title']),
      pathField({ key: 'testLevel', label: 'Test is for', path: ['test', 'division'], type: 'text', display: (r) => levelLabel(r.test?.division) }),
      dateField('submittedAt', 'Submitted', ['firstSubmittedAt'], true),
      dateField('lastSubmittedAt', 'Last version', ['lastSubmittedAt'], true),
      choiceField('status', 'Status', ['status'], vals(TestSubmissionStatus)),
      corrected,
      // How many corrections: sortable (by the relation count), not filterable (use "Corrected").
      { key: 'corrections', label: 'Corrections', type: 'number', value: (r) => r._count?.corrections ?? 0, orderBy: (dir: 'asc' | 'desc') => [{ corrections: { _count: dir } }] },
      fromCorrection('originalTest', 'Original test', (r) => first(r)?.fromTestTitle ?? null),
      fromCorrection('originalSubject', 'Original subject', (r) => first(r)?.fromSubjectName ?? null),
      fromCorrection('originalLevel', 'Original level', (r) => (first(r) ? levelLabel(first(r).fromLevel) : null)),
      fromCorrection('correctionReason', 'Correction reason', (r) => last(r)?.reason ?? null),
      fromCorrection('correctedBy', 'Corrected by', (r) => name(last(r)?.actor)),
      fromCorrection('correctedAt', 'Corrected on', (r) => last(r)?.createdAt ?? null, 'date'),
    ],
  },
};
