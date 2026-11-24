/**
 * Generic bulk routes — documented response shapes (OpenAPI only; nothing here is validated at runtime). The
 * contract test test/bulk-openapi-contract.e2e-spec.ts checks every real response of the generic routes against the
 * schemas generated from these classes (docs/api/openapi.json), so the documentation cannot drift from the code.
 */
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';

import { BulkItemOutcome, BulkOperationStatus } from '../generated/prisma/client.js';

const ID = '66b583ed-4ce5-42b3-a88a-c883790299b9';
const OP_ID = 'e2b3266d-e35d-474b-82b1-45840159a03b';
const ADMIN_ID = '56c6b1d8-847e-4ab1-bf81-fabc57b4b463';
const TOKEN = 'v2.56c6b1d8-847e-4ab1-bf81-fabc57b4b463.3.1795096604.qXU5yP57r5WWO5R5Hdt9ouAlLSCktMjkMtrDc5SaGyg.aKL8dXsRQ_vHpKzy7JXs8xWCAiD9pYy65kOGUVvmuVo';
const FREE_OBJECT = { type: 'object', additionalProperties: true } as const;

export class BulkActorSummary {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() username: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
}

export class BulkOperationView {
  @ApiProperty({ format: 'uuid' }) id: string;
  /** The record type (USER, …). */
  @ApiProperty({ example: 'USER' }) entityType: string;
  @ApiProperty({ example: 'suspend' }) action: string;
  /** The action's normalised parameters (never a password; a message's body is kept for the e-mail job). */
  @ApiProperty(FREE_OBJECT) params: Record<string, unknown>;
  /** The confirmed selection: { mode: 'ids', ids } or { mode: 'filter', filter }. */
  @ApiProperty(FREE_OBJECT) selection: Record<string, unknown>;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty({ enum: BulkOperationStatus, enumName: 'BulkOperationStatus' }) status: BulkOperationStatus;
  @ApiProperty({ type: 'integer' }) total: number;
  @ApiProperty({ type: 'integer' }) succeeded: number;
  @ApiProperty({ type: 'integer' }) failed: number;
  @ApiProperty({ type: 'integer' }) skipped: number;
  @ApiProperty() idempotencyKey: string;
  @ApiProperty({ type: String, nullable: true }) emailJobId: string | null;
  @ApiProperty({ type: String, nullable: true }) requestId: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finishedAt: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) cancelledAt: string | null;
  @ApiProperty({ example: 'ADMIN' }) actorRole: string;
  /** Null when the administrator's account no longer exists. */
  @ApiProperty({ type: () => BulkActorSummary, nullable: true }) actor: BulkActorSummary | null;
}

export class BulkOperationProgress extends BulkOperationView {
  @ApiProperty({ type: 'integer' }) pending: number;
  @ApiProperty({ type: 'integer' }) processing: number;
  /** total − pending − processing. */
  @ApiProperty({ type: 'integer' }) processed: number;
}

export class BulkExecuteResult {
  @ApiProperty({ type: () => BulkOperationView }) operation: BulkOperationView;
  /** false: created now (202); true: the idempotencyKey was already used — the same operation (200). */
  @ApiProperty() alreadyExisted: boolean;
}

export class BulkPreviewWarning {
  @ApiProperty({ example: 'INCLUDES_YOURSELF' }) code: string;
  @ApiProperty({ type: 'integer' }) count: number;
  @ApiProperty() message: string;
}

export class BulkPreviewResult {
  @ApiProperty() action: string;
  @ApiProperty(FREE_OBJECT) params: Record<string, unknown>;
  @ApiProperty(FREE_OBJECT) selection: Record<string, unknown>;
  @ApiProperty({ type: 'integer' }) total: number;
  /** How many of them the action will change, when it can be told in advance (USER activateNow); the warnings say why the others are skipped. */
  @ApiPropertyOptional({ type: 'integer' }) willApply?: number;
  /** At most 10 matching records (USER: id, username, firstName, lastName, role, accountStatus). */
  @ApiProperty({ type: 'array', items: FREE_OBJECT }) sample: Array<Record<string, unknown>>;
  @ApiProperty({ type: () => [BulkPreviewWarning] }) warnings: BulkPreviewWarning[];
  @ApiProperty({ type: [String] }) consequences: string[];
  @ApiProperty() requiresReason: boolean;
  @ApiProperty() requiresStepUp: boolean;
  /** The confirmation to execute with: opaque, 15 minutes, for you only, one operation. */
  @ApiProperty() selectionToken: string;
  @ApiProperty() entityType: string;
  @ApiProperty({ type: String, format: 'date-time' }) confirmationExpiresAt: string;
}

export class BulkUserSummary {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() username: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty() role: string;
  @ApiProperty() accountStatus: string;
}

export class BulkItemView {
  /** The record. */
  @ApiProperty() entityId: string;
  /** USER items: the account (= entityId); null for other record types. */
  @ApiProperty({ type: String, nullable: true }) userId: string | null;
  @ApiProperty({ enum: BulkItemOutcome, enumName: 'BulkItemOutcome' }) outcome: BulkItemOutcome;
  @ApiProperty({ type: String, nullable: true, example: 'ROLE_NOT_ASSIGNABLE' }) code: string | null;
  @ApiProperty({ type: String, nullable: true }) message: string | null;
  /** After restoring or reactivating: what still blocks sign-in (NOT_ACTIVATED, PENDING_APPROVAL…). */
  @ApiProperty({ type: [String] }) stillBlockedBy: string[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) processedAt: string | null;
  /** USER items: the account as it is now (null if it no longer exists). Other record types use their own key. */
  @ApiPropertyOptional({ type: () => BulkUserSummary, nullable: true }) user?: BulkUserSummary | null;
}

export class BulkPageMeta {
  @ApiProperty({ type: 'integer' }) total: number;
  @ApiProperty({ type: 'integer' }) page: number;
  @ApiProperty({ type: 'integer' }) limit: number;
  @ApiProperty({ type: 'integer' }) totalPages: number;
}

export class BulkOperationPage {
  @ApiProperty({ type: () => [BulkOperationView] }) data: BulkOperationView[];
  @ApiProperty({ type: () => BulkPageMeta }) meta: BulkPageMeta;
}

export class BulkItemPage {
  @ApiProperty({ type: () => [BulkItemView] }) data: BulkItemView[];
  @ApiProperty({ type: () => BulkPageMeta }) meta: BulkPageMeta;
}

export class BulkActionView {
  @ApiProperty({ example: 'suspend' }) action: string;
  /** Everything the caller needs: users.bulkManage and the single-record route's permission(s). */
  @ApiProperty({ type: [String] }) permissions: string[];
  @ApiProperty() requiresReason: boolean;
  @ApiProperty() consequence: string;
}

export class BulkExportView {
  @ApiProperty({ example: 'users.export' }) permission: string;
}

export class BulkEntityTypeView {
  @ApiProperty({ example: 'USER' }) entityType: string;
  @ApiProperty({ type: 'integer' }) maxIds: number;
  @ApiProperty({ type: 'integer' }) maxSelection: number;
  /** Null when the record type has no export, or the caller lacks its permission. */
  @ApiProperty({ type: () => BulkExportView, nullable: true }) export: BulkExportView | null;
  @ApiProperty({ type: () => [BulkActionView] }) actions: BulkActionView[];
}

export class BulkActionsView {
  @ApiProperty({ example: 'users.bulkManage' }) gate: string;
  /** The record types with at least one action (or an export) the caller may run now. */
  @ApiProperty({ type: () => [BulkEntityTypeView] }) entityTypes: BulkEntityTypeView[];
}

// ─── Examples (real responses of a local run, ids shortened only where noted) ────

const OPERATION_EXAMPLE = {
  id: OP_ID, entityType: 'USER', action: 'suspend', params: {}, selection: { mode: 'filter', filter: { search: 'ex.' } },
  reason: 'Term ended', status: 'PENDING', total: 3, succeeded: 0, failed: 0, skipped: 0, idempotencyKey: 'example-key-0001',
  emailJobId: null, requestId: '2b5f021d-4b9f-4143-9d5f-9877ab75cea9', createdAt: '2026-11-19T13:41:44.836Z', startedAt: null,
  finishedAt: null, cancelledAt: null, actorRole: 'ADMIN', actor: { id: ADMIN_ID, username: 'admin', firstName: 'admin', lastName: 'Test' },
};
const FINISHED = { ...OPERATION_EXAMPLE, status: 'COMPLETED', succeeded: 3, startedAt: '2026-11-19T13:41:44.879Z', finishedAt: '2026-11-19T13:41:44.983Z' };
const USER_SAMPLE = { id: ID, username: 'ex.0', firstName: 'Ex', lastName: 'N0', role: 'MENTOR', accountStatus: 'ACTIVE' };

export const EXAMPLES = {
  preview: {
    action: 'suspend', params: {}, selection: { mode: 'filter', filter: { search: 'ex.' } }, total: 3, sample: [USER_SAMPLE],
    warnings: [], consequences: ['The accounts are blocked by an administrative restriction; every session ends at once. Nothing is deleted.'],
    requiresReason: true, requiresStepUp: false, selectionToken: TOKEN, entityType: 'USER', confirmationExpiresAt: '2026-11-19T13:56:44.000Z',
  },
  created: { operation: OPERATION_EXAMPLE, alreadyExisted: false },
  replay: { operation: { ...FINISHED }, alreadyExisted: true },
  progress: { ...FINISHED, pending: 0, processing: 0, processed: 3 },
  cancelled: { ...OPERATION_EXAMPLE, status: 'CANCELLED', skipped: 3, cancelledAt: '2026-11-19T13:42:00.000Z', finishedAt: '2026-11-19T13:42:00.000Z', pending: 0, processing: 0, processed: 3 },
  list: { data: [FINISHED], meta: { total: 1, page: 1, limit: 20, totalPages: 1 } },
  items: {
    data: [{
      entityId: ID, userId: ID, outcome: 'SUCCEEDED', code: null, message: null, stillBlockedBy: [], processedAt: '2026-11-19T13:41:44.949Z',
      user: { ...USER_SAMPLE, accountStatus: 'SUSPENDED' },
    }],
    meta: { total: 3, page: 1, limit: 2, totalPages: 2 },
  },
  actions: {
    gate: 'users.bulkManage',
    entityTypes: [{
      entityType: 'USER', maxIds: 1000, maxSelection: 50000, export: { permission: 'users.export' },
      actions: [
        { action: 'suspend', permissions: ['users.bulkManage', 'users.manage', 'users.suspend'], requiresReason: true,
          consequence: 'The accounts are blocked by an administrative restriction; every session ends at once. Nothing is deleted.' },
        { action: 'reassignTeacher', permissions: ['users.bulkManage', 'users.manageTeachers'], requiresReason: false,
          consequence: 'Each selected student assigned to the first teacher moves to the second: the old assignment ends and the new one starts together, or nothing changes for that student (a student outside the new teacher\'s schools needs a reason). Students not assigned to the first teacher are skipped. School links and student ownership never change. The new teacher is told once.' },
      ],
    }],
  },
  csv: '﻿firstName,lastName,username,email,role,accountStatus,school,gradeLevel,createdAt\r\nEx,N0,ex.0,ex.0@test.local,MENTOR,SUSPENDED,,,2026-11-19T13:41:44.700Z\r\n',
};

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Every error code a generic bulk route can answer, with its message (from the code that throws it). */
const ERROR_MESSAGES: Record<string, [number, string]> = {
  VALIDATION_FAILED:                [400, 'Title is required.'],
  BAD_REQUEST:                      [400, 'Validation failed (uuid is expected)'],
  BULK_ACTION_UNKNOWN:              [400, 'USER has no bulk action delete.'],
  ROLE_NOT_ALLOWED_IN_BULK:         [400, 'The Super Administrator role is never assigned in bulk.'],
  SAME_TEACHER:                     [400, 'Choose a different teacher to move the students to.'],
  NOT_A_TEACHER:                    [400, 'Only users with the TEACHER role can be given students.'],
  SELECTION_TOO_LARGE:              [400, 'The selection matches 51000 accounts; at most 50000 can be changed in one operation. Narrow the filters.'],
  CONFIRMATION_REQUIRED:            [400, 'Please confirm this action before it is applied to the selected records.'],
  REASON_REQUIRED:                  [400, 'Give a reason (3–500 characters).'],
  CONFIRMATION_INVALID:             [400, 'The confirmation is not valid. Preview the action again and confirm.'],
  EMPTY_SELECTION:                  [400, 'No account matches the selection.'],
  UNAUTHORIZED:                     [401, 'Unauthorized'],
  PERMISSION_REQUIRED:              [403, 'You do not have permission to do this. If you need it, ask an administrator.'],
  CONFIRMATION_WRONG_ADMINISTRATOR: [403, 'This confirmation was issued to another administrator. Preview the action yourself.'],
  STEP_UP_REQUIRED:                 [403, 'Confirm with your current password to change an Administrator or Super Administrator role.'],
  BULK_ENTITY_UNKNOWN:              [404, 'There is no bulk record type NOPE.'],
  BULK_EXPORT_UNAVAILABLE:          [404, 'SCHOOL records cannot be exported in bulk.'],
  NOT_FOUND:                        [404, 'Bulk operation not found.'],
  SELECTION_CHANGED:                [409, 'The selected accounts changed since the preview. Preview the action again and confirm the new selection.'],
  CONFIRMATION_USED:                [409, 'This confirmation was already used; preview again.'],
  IDEMPOTENCY_KEY_REUSED:           [409, 'This idempotencyKey was already used for another kind of bulk operation.'],
  OPERATION_FINISHED:               [409, 'This bulk operation has already finished.'],
  CONFIRMATION_EXPIRED:             [410, 'This confirmation has expired (15 minutes). Preview the action again and confirm.'],
  BULK_BUSY:                        [503, 'The accounts are busy. Try again in a moment.'],
};
const ERROR_NAMES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone', 503: 'Service Unavailable' };

/** The documented error codes of each generic route (the contract test checks every observed error against them). */
export const ROUTE_ERRORS = {
  actions:  ['UNAUTHORIZED', 'PERMISSION_REQUIRED'],
  list:     ['VALIDATION_FAILED', 'UNAUTHORIZED', 'PERMISSION_REQUIRED'],
  get:      ['BAD_REQUEST', 'UNAUTHORIZED', 'PERMISSION_REQUIRED', 'NOT_FOUND'],
  items:    ['VALIDATION_FAILED', 'BAD_REQUEST', 'UNAUTHORIZED', 'PERMISSION_REQUIRED', 'NOT_FOUND'],
  cancel:   ['BAD_REQUEST', 'UNAUTHORIZED', 'PERMISSION_REQUIRED', 'NOT_FOUND', 'OPERATION_FINISHED'],
  preview:  ['VALIDATION_FAILED', 'BULK_ACTION_UNKNOWN', 'ROLE_NOT_ALLOWED_IN_BULK', 'SAME_TEACHER', 'NOT_A_TEACHER', 'SELECTION_TOO_LARGE',
             'UNAUTHORIZED', 'PERMISSION_REQUIRED', 'BULK_ENTITY_UNKNOWN', 'NOT_FOUND'],
  execute:  ['VALIDATION_FAILED', 'BULK_ACTION_UNKNOWN', 'ROLE_NOT_ALLOWED_IN_BULK', 'SAME_TEACHER', 'NOT_A_TEACHER', 'SELECTION_TOO_LARGE',
             'CONFIRMATION_REQUIRED', 'REASON_REQUIRED', 'CONFIRMATION_INVALID', 'EMPTY_SELECTION', 'UNAUTHORIZED', 'PERMISSION_REQUIRED',
             'CONFIRMATION_WRONG_ADMINISTRATOR', 'STEP_UP_REQUIRED', 'BULK_ENTITY_UNKNOWN', 'NOT_FOUND', 'SELECTION_CHANGED', 'CONFIRMATION_USED',
             'IDEMPOTENCY_KEY_REUSED', 'CONFIRMATION_EXPIRED', 'BULK_BUSY'],
  export:   ['VALIDATION_FAILED', 'SELECTION_TOO_LARGE', 'UNAUTHORIZED', 'PERMISSION_REQUIRED', 'BULK_ENTITY_UNKNOWN', 'BULK_EXPORT_UNAVAILABLE'],
} as const;

/** One documented response per error status of the route: the Error schema, its codes, and an example of each. */
export function ApiBulkErrors(route: keyof typeof ROUTE_ERRORS) {
  const byStatus = new Map<number, string[]>();
  for (const code of ROUTE_ERRORS[route]) {
    const [status] = ERROR_MESSAGES[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return applyDecorators(...[...byStatus].map(([status, codes]) => ApiResponse({
    status,
    description: `Error codes: ${codes.join(', ')}.`,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
        examples: Object.fromEntries(codes.map((code) => [code, {
          summary: code,
          value: { statusCode: status, error: ERROR_NAMES[status], code, message: ERROR_MESSAGES[code][1] },
        }])),
      },
    },
  })));
}
