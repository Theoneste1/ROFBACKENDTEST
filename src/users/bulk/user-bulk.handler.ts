/**
 * The USER record type of the bulk engine (2026-11-17; on the generic engine since 2026-11-19;
 * docs/operations/bulk-operations.md). Every action calls the same code as the single-account route, inside the
 * item transaction:
 *   activate … restore        → AccountStatusService.change            (POST /admin/users/:id/status-changes)
 *   assignRole, changeClassification → UsersService.update             (PATCH /admin/users/:id: RoleAssignmentPolicy,
 *                                                                        Super Admin rules, step-up)
 *   message                   → one EmailDelivery of the operation's EmailJob (the bulk e-mail outbox)
 *   activateNow               → AccountStatusService.activateNow       (POST /admin/users/:id/activate-now)
 *   assignTeacher … revokeDelegation, reassignTeacher → teacher-student-ops *InTx helpers
 *                                                      (POST /admin/teacher-students, …/reassign, delegation students)
 * The selection is GET /admin/users's filters (userListWhere); membership is guarded by trigger
 * user_bulk_membership_guard (advisory lock 8152026002).
 */
import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../audit/audit.service.js';
import { RoleAssignmentPolicy } from '../../auth/role-assignment.policy.js';
import type { BulkEntityHandler, Db, EngineSelection, ItemContext, ItemResult, PreviewWarning } from '../../bulk/bulk-handler.js';
import { auditSelection } from '../../bulk/bulk-operations.service.js';
import { BulkRegistry } from '../../bulk/bulk-registry.js';
import type { AuthUser } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { DecisionNotificationsService } from '../../decision-notifications/decision-notifications.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { sendCsvExport } from '../../reports/csv-stream.js';
import { idBatches, mapBatches } from '../../reports/csv.js';
import {
  activeSelectedOverride, addSelectionInTx, assignStudentInTx, endAssignmentInTx, ensureSelectedOverrideInTx, lockSelections, lockTeacher,
  removeSelectionInTx, type ItemResult as TsResult,
} from '../../teachers/teacher-student-ops.js';
import { activeSchoolsOf, visibilityOf } from '../../teachers/teacher-scope.js';
import { AccountStatusService } from '../account-status.service.js';
import { OlympiadLevelService } from '../olympiad-level.service.js';
import { userListWhere, UsersService } from '../users.service.js';
import {
  ACTION_RULES, activateNowBreakdown, BULK_MEMBERSHIP_KEY, MAX_IDS, MAX_SELECTION, normaliseParams, normaliseSelection, SKIP_CODES, statusDecision,
  TEACHER_LINK_ACTIONS, TEACHER_STUDENT_ACTIONS, type ActivateNowGroup, type BulkAction, type BulkParams, type BulkSelection,
} from './bulk-rules.js';
import { activateNowRefusal } from '../account-status.js';
import { BulkParamsDto, BulkSelectionDto } from './bulk.dto.js';

const SAMPLE_SELECT = { id: true, username: true, firstName: true, lastName: true, role: true, accountStatus: true } as const;
export const EXPORT_HEADERS = ['firstName', 'lastName', 'username', 'email', 'role', 'accountStatus', 'school', 'gradeLevel', 'createdAt'] as const;

type P = BulkParams & { stepUpVerified?: boolean };

@Injectable()
export class UserBulkHandler implements BulkEntityHandler, OnModuleInit {
  readonly entityType = 'USER';
  readonly noun = 'accounts';
  readonly actions = ACTION_RULES;
  readonly maxIds = MAX_IDS;
  readonly maxSelection = MAX_SELECTION;
  readonly selectionDto = BulkSelectionDto;
  readonly paramsDto = BulkParamsDto;
  readonly membership = { kind: 'advisory', key: BULK_MEMBERSHIP_KEY } as const;
  readonly itemKey = 'user';
  readonly skipCodes = SKIP_CODES;

  constructor(
    private readonly registry: BulkRegistry,
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly accountStatus: AccountStatusService,
    private readonly audit: AuditService,
    private readonly notices: DecisionNotificationsService,
    private readonly levels: OlympiadLevelService,
    private readonly roles: RoleAssignmentPolicy,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  // ─── Selection ──────────────────────────────────────────────────────────────

  normaliseSelection(s: EngineSelection): EngineSelection {
    return normaliseSelection(s as BulkSelection) as EngineSelection;
  }

  normaliseParams(action: string, p: Record<string, unknown>) {
    return normaliseParams(action as BulkAction, p as BulkParams) as Record<string, unknown>;
  }

  private whereOf(s: EngineSelection): Prisma.UserWhereInput {
    // The banking status is computed, not a column: a bulk action never acts on "every account with this status" (it
    // would be re-evaluated later); the administrator ticks the accounts instead (owner 2026-11-25).
    if (s.mode !== 'ids' && (s.filter as { banking?: unknown } | undefined)?.banking) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BULK_BANKING_FILTER', 'Bulk actions cannot use the banking filter. Tick the accounts you want instead.');
    }
    return s.mode === 'ids' ? { id: { in: s.ids } } : userListWhere(s.filter as never);
  }

  count(db: Db, s: EngineSelection) {
    return db.user.count({ where: this.whereOf(s) });
  }

  async scanIds(db: Db, s: EngineSelection) {
    return (await db.user.findMany({ where: this.whereOf(s), select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
  }

  isSelf(entityId: string, actor: AuthUser) {
    return entityId === actor.id;
  }

  describe(db: Db, ids: string[]) {
    return db.user.findMany({ where: { id: { in: ids } }, select: SAMPLE_SELECT }).then((rows) => new Map<string, unknown>(rows.map((u) => [u.id, u])));
  }

  // ─── Validation and preview ─────────────────────────────────────────────────

  async validate(actionName: string, params: Record<string, unknown>) {
    const action = actionName as BulkAction;
    const p = params as P;
    if (action === 'assignRole') {
      if (!p.role) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Choose the role to give the selected accounts.');
      if (p.role === 'SUPER_ADMIN') {
        throw new AppError(HttpStatus.BAD_REQUEST, 'ROLE_NOT_ALLOWED_IN_BULK', 'The Super Administrator role is never assigned in bulk.');
      }
    }
    if (action === 'changeClassification' && !p.gradeLevel) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Choose the new grade.');
    }
    if (action === 'setOlympiadLevel') {
      if (!p.olympiadLevel) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Choose the new Olympiad level.');
      if (p.olympiadLevel !== 'AUTOMATIC') {
        const d = await this.prisma.division.findUnique({ where: { code: p.olympiadLevel }, select: { isActive: true } });
        if (!d?.isActive) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_DIVISION', 'Choose an active division or AUTOMATIC.', { olympiadLevel: p.olympiadLevel });
      }
    }
    if (action === 'message' && (!p.subject || !p.body)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Write the e-mail subject and the message before sending.');
    }
    if (TEACHER_STUDENT_ACTIONS.includes(action)) {
      if (!p.teacherId) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Choose the teacher.');
      if ((action === 'grantDelegation' || action === 'revokeDelegation') && !p.permission) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Choose the permission to change for the selected accounts.');
      }
      const teacher = await this.prisma.user.findUnique({ where: { id: p.teacherId }, select: { role: true } });
      if (!teacher) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Teacher not found.');
      if (teacher.role !== 'TEACHER' && action !== 'unassignTeacher' && action !== 'revokeDelegation') {
        throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_TEACHER', 'Only users with the TEACHER role can be given students.', { role: teacher.role });
      }
    }
    if (action === 'reassignTeacher') {
      // The same checks as POST /admin/teacher-students/reassign (TeacherStudentAssignmentsService.reassign).
      if (!p.fromTeacherId || !p.toTeacherId) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Choose both the current teacher and the new teacher.');
      if (p.fromTeacherId === p.toTeacherId) throw new AppError(HttpStatus.BAD_REQUEST, 'SAME_TEACHER', 'Choose a different teacher to move the students to.');
      const [from, to] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: p.fromTeacherId }, select: { role: true } }),
        this.prisma.user.findUnique({ where: { id: p.toTeacherId }, select: { role: true } }),
      ]);
      if (!from || !to) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Teacher not found.');
      if (to.role !== 'TEACHER') {
        throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_TEACHER', 'Only users with the TEACHER role can be given students.', { role: to.role });
      }
    }
  }

  async preview(ids: string[], actionName: string, params: Record<string, unknown>, caller: AuthUser) {
    const action = actionName as BulkAction;
    const p = params as P;
    const [sample, groups] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids.slice(0, 10) } }, select: SAMPLE_SELECT, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] }),
      ids.length ? this.groupByRoleAndStatus(ids) : Promise.resolve([]),
    ]);
    const count = (pred: (g: { role: string; accountStatus: string }) => boolean) => groups.filter(pred).reduce((n, g) => n + g.n, 0);
    const warnings: PreviewWarning[] = [];
    const warn = (code: string, n: number, message: string) => { if (n > 0) warnings.push({ code, count: n, message }); };

    warn('INCLUDES_YOURSELF', ids.includes(caller.id) ? 1 : 0, 'Your own account is in the selection; it will be skipped.');
    const privileged = count((g) => g.role === 'ADMIN' || g.role === 'SUPER_ADMIN');
    warn('INCLUDES_ADMINISTRATORS', privileged, 'Administrator or Super Administrator accounts are selected: only actions your role allows on them will be applied; the others fail and are reported.');
    const rule = ACTION_RULES[action];
    if (rule.toStatus) {
      warn('ALREADY_IN_STATE', count((g) => g.accountStatus === rule.toStatus), `Accounts already ${rule.toStatus.toLowerCase()} will be skipped.`);
      warn('NOT_APPLICABLE', count((g) => g.accountStatus !== rule.toStatus && !rule.from!.includes(g.accountStatus as never)),
        'Accounts in a state this action does not apply to will be skipped.');
    }
    if (action === 'assignRole') warn('ALREADY_IN_ROLE', count((g) => g.role === p.role), 'Accounts that already have this role will be skipped.');
    if (action === 'changeClassification') warn('NOT_STUDENTS', count((g) => g.role !== 'STUDENT'), 'Only students have a grade; other accounts will be skipped.');
    if (action === 'setOlympiadLevel') warn('NOT_STUDENTS', count((g) => g.role !== 'STUDENT'), 'Only students have an Olympiad level; other accounts will be skipped.');
    if (action === 'message') warn('BLOCKED_ACCOUNTS', count((g) => g.accountStatus !== 'ACTIVE'), 'Accounts that are not active will not be e-mailed.');
    if (TEACHER_LINK_ACTIONS.includes(action)) warn('NOT_STUDENTS', count((g) => g.role !== 'STUDENT'), 'Only students are linked to a teacher; other accounts will be skipped.');
    if (action === 'activateNow') return this.activateNowPreview(ids, caller, sample);
    if (action === 'reassignTeacher' && ids.length) {
      const assigned = await this.prisma.teacherStudentAssignment.count({ where: { teacherId: p.fromTeacherId, isActive: true, studentId: { in: ids } } });
      warn('NOT_ASSIGNED_TO_SOURCE', count((g) => g.role === 'STUDENT') - assigned, 'Students not assigned to the first teacher will be skipped.');
    }
    return { sample, warnings, requiresStepUp: this.stepUp(action, p, privileged) };
  }

  /**
   * activateNow: exactly how many accounts will be activated, and each skip reason with its count (the same order of
   * checks as the item: own account, rank, state, already activated, no password yet).
   */
  private async activateNowPreview(ids: string[], caller: AuthUser, sample: unknown[]) {
    const groups: ActivateNowGroup[] = [];
    for (let i = 0; i < ids.length; i += 5000) {
      const rows = await this.prisma.$queryRaw<Array<{ role: string; accountStatus: string; activated: boolean; hasPassword: boolean; n: bigint }>>`
        SELECT "role"::text AS "role", "accountStatus"::text AS "accountStatus", ("activatedAt" IS NOT NULL) AS "activated",
               ("passwordHash" IS NOT NULL) AS "hasPassword", count(*) AS "n"
          FROM "User" WHERE "id" = ANY(${ids.slice(i, i + 5000)}::text[]) GROUP BY 1, 2, 3, 4`;
      for (const r of rows) groups.push({ role: r.role, accountStatus: r.accountStatus as never, activated: r.activated, hasPassword: r.hasPassword, n: Number(r.n) });
    }
    const roles = [...new Set(groups.map((g) => g.role))];
    const may = new Map(await Promise.all(roles.map(async (r) => [r, await this.roles.canManage(caller, r)] as const)));
    const { willActivate, skipped } = activateNowBreakdown(groups, (r) => may.get(r) === true, ids.includes(caller.id));
    const warnings: PreviewWarning[] = [];
    const warn = (code: string, n: number, message: string) => { if (n > 0) warnings.push({ code, count: n, message }); };
    warn('INCLUDES_YOURSELF', skipped.SELF, 'Your own account is in the selection; it will be skipped.');
    warn('ROLE_NOT_MANAGEABLE', skipped.ROLE_NOT_MANAGEABLE, 'Accounts whose role you cannot manage will be skipped.');
    warn('ACCOUNT_NOT_ACTIVE', skipped.ACCOUNT_NOT_ACTIVE, 'Accounts that are deactivated, suspended or archived will be skipped: reactivate, lift or restore them first.');
    warn('ALREADY_ACTIVATED', skipped.ALREADY_ACTIVATED, 'Accounts that are already active will be skipped; those people can already sign in.');
    warn('NO_PASSWORD_YET', skipped.NO_PASSWORD_YET, 'People who have not set a password yet will be skipped: resend their invitation instead.');
    return { sample, warnings, requiresStepUp: false, willApply: willActivate };
  }

  /** Step-up (the administrator's current password) when a role change involves Administrator-level roles. */
  private stepUp(action: BulkAction, p: P, privilegedSelected: number) {
    return action === 'assignRole' && (p.role === 'ADMIN' || privilegedSelected > 0);
  }

  async stepUpRequired(action: string, params: Record<string, unknown>, s: EngineSelection) {
    // The selected Administrators are counted again under the guard by the token check; a different set fails it.
    const privilegedNow = action === 'assignRole'
      ? await this.prisma.user.count({ where: { AND: [this.whereOf(s), { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }] } }) : 0;
    return this.stepUp(action as BulkAction, params as P, privilegedNow);
  }

  assertStepUp(caller: AuthUser, currentPassword: string | undefined) {
    return this.users.assertStepUp(caller, currentPassword);
  }

  async onCreate(tx: Prisma.TransactionClient, operationId: string, action: string, params: Record<string, unknown>, caller: AuthUser) {
    if (action !== 'message') return;
    // One bulk e-mail job; each delivery is created with its account's item (processItem), so an account is e-mailed at
    // most once per operation, whatever retries or workers do.
    const job = await tx.emailJob.create({
      data: { idempotencyKey: `bulk-operation/${operationId}`, subject: String(params.subject), body: String(params.body), status: 'PENDING', totalRecipients: 0, createdById: caller.id },
      select: { id: true },
    });
    await tx.bulkOperation.update({ where: { id: operationId }, data: { emailJobId: job.id } });
  }

  /** Audit metadata never holds a message body (only its subject). */
  auditParams(action: string, params: Record<string, unknown>) {
    return action === 'message' ? { subject: params.subject } : params;
  }

  // ─── One account ────────────────────────────────────────────────────────────

  async processItem(ctx: ItemContext, actionName: string): Promise<ItemResult> {
    const { tx, op, actor, afterCommit } = ctx;
    const action = actionName as BulkAction;
    const params = ctx.params as P;
    const user = await tx.user.findUnique({
      where: { id: ctx.entityId }, select: { id: true, role: true, accountStatus: true, gradeLevel: true, email: true },
    });
    if (!user) return { outcome: 'SKIPPED', code: 'NOT_FOUND', message: 'The account no longer exists.' };
    if (ACTION_RULES[action].toStatus) {
      const d = statusDecision(action, user.accountStatus);
      if ('skip' in d) return { outcome: 'SKIPPED', code: d.skip };
      const r = await this.accountStatus.change(user.id, { toStatus: d.toStatus, reason: op.reason, confirm: action === 'restore' }, actor,
        { operationId: op.id, tx });
      return { outcome: 'SUCCEEDED', stillBlockedBy: r.stillBlockedBy };
    }
    if (action === 'assignRole') {
      if (user.role === params.role) return { outcome: 'SKIPPED', code: 'ALREADY_SET' };
      await this.users.update(user.id, { role: params.role } as never, actor, { stepUpVerified: params.stepUpVerified === true, tx, afterCommit });
      return { outcome: 'SUCCEEDED' };
    }
    if (action === 'changeClassification') {
      if (user.role !== 'STUDENT') return { outcome: 'SKIPPED', code: 'NOT_APPLICABLE', message: 'Only students have a grade.' };
      if (user.gradeLevel === params.gradeLevel) return { outcome: 'SKIPPED', code: 'ALREADY_SET' };
      await this.users.update(user.id, { gradeLevel: params.gradeLevel } as never, actor, { tx, afterCommit });
      return { outcome: 'SUCCEEDED' };
    }
    if (action === 'message') {
      if (user.accountStatus !== 'ACTIVE' || !user.email) return { outcome: 'SKIPPED', code: 'ACCOUNT_NOT_ACTIVE', message: 'Only active accounts are e-mailed.' };
      // The outbox row is written in this transaction: a cancelled or rolled-back item never sends anything.
      await tx.emailDelivery.create({ data: { jobId: op.emailJobId!, recipientEmail: user.email, recipientId: user.id } });
      return { outcome: 'SUCCEEDED' };
    }
    if (action === 'activateNow') {
      // The rank and the account's own state are checked here first so that they are SKIPPED with a reason; the service
      // then checks everything again under the account's row lock (its refusals are skip codes too).
      if (!(await this.roles.canManage(actor, user.role))) {
        return { outcome: 'SKIPPED', code: 'ROLE_NOT_MANAGEABLE', message: 'You cannot manage accounts with this role.' };
      }
      const state = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { activatedAt: true, passwordHash: true } });
      const refusal = activateNowRefusal({ accountStatus: user.accountStatus, activatedAt: state.activatedAt, hasPassword: state.passwordHash !== null });
      if (refusal) return { outcome: 'SKIPPED', code: refusal.code, message: refusal.message };
      const r = await this.accountStatus.activateNow(user.id, actor, { operationId: op.id, tx });
      return { outcome: 'SUCCEEDED', stillBlockedBy: r.stillBlockedBy };
    }
    if (action === 'setOlympiadLevel') {
      if (user.role !== 'STUDENT') return { outcome: 'SKIPPED', code: 'NOT_A_STUDENT', message: 'Only students have an Olympiad level.' };
      // The body of PUT /admin/students/:id/olympiad-level for this student (lock, history, audit), in the item's transaction.
      const automatic = params.olympiadLevel === 'AUTOMATIC';
      const r = await this.levels.setInTx(tx, user.id, {
        ...(automatic ? { automatic: true } : { divisionCode: params.olympiadLevel }), reason: op.reason ?? '',
      }, actor, { operationId: op.id });
      return r.changed ? { outcome: 'SUCCEEDED' } : { outcome: 'SKIPPED', code: 'ALREADY_SET', message: 'The student already has this level.' };
    }
    if (TEACHER_LINK_ACTIONS.includes(action)) return this.teacherStudentItem(ctx, action, params, user);
    return { outcome: 'FAILED', code: 'UNKNOWN_ACTION' };
  }

  /**
   * One student of a teacher–student action (TS approvals 2026-11-18), in the item's transaction. Non-students are
   * SKIPPED. The teacher's notices are deduplicated per OPERATION: one "students assigned" notice, one "permission
   * given" notice, however many items succeed or are retried.
   */
  private async teacherStudentItem(ctx: ItemContext, action: BulkAction, params: P, user: { id: string; role: string }): Promise<ItemResult> {
    const { tx, op, actor, noticeIds } = ctx;
    if (user.role !== 'STUDENT') return { outcome: 'SKIPPED', code: 'NOT_A_STUDENT', message: 'Only students are linked to a teacher.' };
    const by = { actorId: actor.id, actorRole: actor.role };
    const toOutcome = (r: TsResult): ItemResult => ({
      outcome: r.outcome === 'SKIPPED' || r.outcome === 'FAILED' ? r.outcome : 'SUCCEEDED', code: r.code, message: r.message,
    });
    if (action === 'reassignTeacher') return this.reassignItem(ctx, params, user.id);
    const teacher = await tx.user.findUnique({
      where: { id: params.teacherId! }, select: { id: true, role: true, email: true, firstName: true, isActive: true, activatedAt: true },
    });
    if (!teacher) return { outcome: 'FAILED', code: 'TEACHER_NOT_FOUND', message: 'The teacher no longer exists.' };
    if (action === 'unassignTeacher') {
      const r = await endAssignmentInTx(tx, this.audit, { where: { teacherId: teacher.id, studentId: user.id }, actor: by, reason: 'BULK', operationId: op.id });
      return toOutcome(r.code === 'NOT_ASSIGNED' ? { ...r, outcome: 'SKIPPED' } : r);
    }
    if (teacher.role !== 'TEACHER' && action !== 'revokeDelegation') {
      return { outcome: 'FAILED', code: 'NOT_A_TEACHER', message: 'The account is no longer a Teacher.' };
    }
    if (action === 'assignTeacher') {
      const r = await assignStudentInTx(tx, this.audit, { teacherId: teacher.id, studentId: user.id, actor: by, source: 'BULK', reason: op.reason, operationId: op.id });
      if (r.outcome === 'ASSIGNED' || r.outcome === 'REACTIVATED') {
        noticeIds.push(await this.notices.enqueueStudentsAssigned(tx, teacher, `operation:${op.id}`));
      }
      return toOutcome(r);
    }
    if (action === 'grantDelegation') {
      // Locks, then visibility, then the delegation: a student the teacher does not see creates nothing and tells the
      // teacher nothing, and no sweep can interleave between this check and the insert (lock order: selection, teacher).
      await lockSelections(tx);
      await lockTeacher(tx, teacher.id);
      const seen = await visibilityOf(tx, teacher.id, await activeSchoolsOf(tx, teacher.id), [user.id]);
      if (!seen.has(user.id)) {
        return { outcome: 'FAILED', code: 'STUDENT_NOT_IN_TEACHER_SCOPE', message: 'The teacher does not see this student (not a verified student of their schools, and not assigned to them).' };
      }
      const { override, created } = await ensureSelectedOverrideInTx(tx, this.audit, {
        teacher, permission: params.permission!, reason: op.reason ?? 'Bulk operation', actor: by, operationId: op.id,
      });
      if (created) noticeIds.push(await this.notices.enqueuePermissionsGranted(tx, teacher, [{ id: override.id, permission: override.permission, effect: 'GRANT' }]));
      return toOutcome(await addSelectionInTx(tx, this.audit, { override, studentId: user.id, actor: by, operationId: op.id }));
    }
    // revokeDelegation
    const override = await activeSelectedOverride(tx, teacher.id, params.permission!);
    if (!override) return { outcome: 'SKIPPED', code: 'NOT_APPLICABLE', message: 'The teacher has no delegation for selected students of this permission.' };
    return toOutcome(await removeSelectionInTx(tx, this.audit, { override, studentId: user.id, actor: by, operationId: op.id }));
  }

  /**
   * reassignTeacher for one student — the body of POST /admin/teacher-students/reassign for that student: the new
   * assignment first (a refusal changes nothing), then the old one ends, in the same transaction. Only a student
   * actively assigned to the first teacher moves (others SKIPPED NOT_ASSIGNED_TO_SOURCE). School links and student
   * ownership are never touched. The new teacher's notice is deduplicated per operation.
   */
  private async reassignItem(ctx: ItemContext, params: P, studentId: string): Promise<ItemResult> {
    const { tx, op, actor, noticeIds } = ctx;
    const by = { actorId: actor.id, actorRole: actor.role };
    const to = await tx.user.findUnique({
      where: { id: params.toTeacherId! }, select: { id: true, role: true, email: true, firstName: true, isActive: true, activatedAt: true },
    });
    if (!to) return { outcome: 'FAILED', code: 'TEACHER_NOT_FOUND', message: 'The teacher no longer exists.' };
    if (to.role !== 'TEACHER') return { outcome: 'FAILED', code: 'NOT_A_TEACHER', message: 'The account is no longer a Teacher.' };
    const current = await tx.teacherStudentAssignment.findUnique({
      where: { teacherId_studentId: { teacherId: params.fromTeacherId!, studentId } }, select: { isActive: true },
    });
    if (!current?.isActive) return { outcome: 'SKIPPED', code: 'NOT_ASSIGNED_TO_SOURCE', message: 'This student is not assigned to the first teacher.' };
    const added = await assignStudentInTx(tx, this.audit, {
      teacherId: to.id, studentId, actor: by, source: 'BULK', reason: op.reason, reassignedFrom: params.fromTeacherId, operationId: op.id,
    });
    if (added.outcome === 'FAILED') return { outcome: 'FAILED', code: added.code, message: added.message };
    await endAssignmentInTx(tx, this.audit, { where: { teacherId: params.fromTeacherId!, studentId }, actor: by, reason: 'REASSIGNED', operationId: op.id });
    if (added.outcome === 'ASSIGNED' || added.outcome === 'REACTIVATED') {
      noticeIds.push(await this.notices.enqueueStudentsAssigned(tx, to, `operation:${op.id}`));
      return { outcome: 'SUCCEEDED' };
    }
    return { outcome: 'SUCCEEDED', code: 'ALREADY_ASSIGNED_TO_NEW_TEACHER', message: 'The student was already assigned to the new teacher; the old assignment ended.' };
  }

  // ─── Export ─────────────────────────────────────────────────────────────────

  readonly export = {
    permission: 'users.export' as const,
    /** CSV of the selected accounts: name, username, e-mail, role, state, school, grade, created — never dates of birth or phone numbers. */
    run: async (ids: string[], selection: EngineSelection, caller: AuthUser, res: Response, requestId: string | null) => {
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'USERS_EXPORTED', entity: 'User', entityId: null,
        metadata: { selection: auditSelection(selection), total: ids.length, requestId, fields: [...EXPORT_HEADERS] },
      });
      const batches = mapBatches(
        idBatches(ids, (chunk) => this.prisma.user.findMany({
          where: { id: { in: chunk } },
          select: {
            id: true, firstName: true, lastName: true, username: true, email: true, role: true, accountStatus: true,
            gradeLevel: true, createdAt: true, school: { select: { name: true } },
          },
          orderBy: { id: 'asc' },
        })),
        (users) => users.map((u) => [u.firstName, u.lastName, u.username, u.email, u.role, u.accountStatus, u.school?.name ?? '', u.gradeLevel ?? '', u.createdAt]),
      );
      await sendCsvExport(res as never, `users-${new Date().toISOString().slice(0, 10)}.csv`, { headers: [...EXPORT_HEADERS], batches });
    },
  };

  private async groupByRoleAndStatus(ids: string[]) {
    const out = new Map<string, { role: string; accountStatus: string; n: number }>();
    for (let i = 0; i < ids.length; i += 5000) {
      const g = await this.prisma.user.groupBy({ by: ['role', 'accountStatus'], where: { id: { in: ids.slice(i, i + 5000) } }, _count: { _all: true } });
      for (const r of g) {
        const k = `${r.role}|${r.accountStatus}`;
        const cur = out.get(k) ?? { role: r.role, accountStatus: r.accountStatus, n: 0 };
        cur.n += r._count._all;
        out.set(k, cur);
      }
    }
    return [...out.values()];
  }
}
