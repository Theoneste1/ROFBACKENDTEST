/**
 * Form availability (docs/operations/forms.md): whether each registration or website form accepts submissions,
 * its schedule, and what people see while it is closed. The FormAvailability table is the single source of truth;
 * the old switches registration.studentSelfSignup / registration.teacherSelfSignup read and write it
 * (SettingsService delegates to setOpenSwitch / openSwitch).
 *
 * The state is computed on every call from the row and the current time (form-availability.rules.ts). Rows are
 * cached for at most CACHE_TTL_MS per instance and the cache is dropped on every change made here, so a change
 * is effective at once on this instance and within 15 seconds anywhere.
 *
 * TEACHER_REGISTRATION is open only while the Teacher role is enabled too (TEACHERS_ENABLED); otherwise it is
 * reported CLOSED whatever its row says (the row is kept, and applies when the role is enabled).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../audit/audit.service.js';
import { PermissionService } from '../auth/permission.service.js';
import { roleFlagOn } from '../auth/role-assignment.policy.js';
import type { AuthUser, CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import type { FormAvailability, FormKey, FormMode } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FORM_DEFAULTS, FORM_KEYS, FORM_TIMEZONE, formState, kigaliTime, scheduleProblems, type FormState } from './form-availability.rules.js';

const CACHE_TTL_MS = 15_000;

/** The state of each form before any administrator changed it (also used if a row were ever missing). */
const INITIAL_MODE: Readonly<Record<FormKey, FormMode>> = {
  STUDENT_REGISTRATION: 'OPEN', TEACHER_REGISTRATION: 'CLOSED', COACH_APPLICATION: 'OPEN', CONTACT: 'OPEN',
};

/** The error code a closed form answers with. Student and teacher registration keep REGISTRATION_CLOSED (existing clients). */
const CLOSED_CODE: Readonly<Record<FormKey, string>> = {
  STUDENT_REGISTRATION: 'REGISTRATION_CLOSED', TEACHER_REGISTRATION: 'REGISTRATION_CLOSED',
  COACH_APPLICATION: 'FORM_CLOSED', CONTACT: 'FORM_CLOSED',
};

const SCHEDULE_FIELDS = ['mode', 'opensAt', 'closesAt'] as const;
const MESSAGE_FIELDS = ['closedMessage', 'instructions', 'contactEmail', 'supportUrl'] as const;

export interface AvailabilityChange { mode?: FormMode; opensAt?: string | null; closesAt?: string | null }
export interface MessagesChange { closedMessage?: string | null; instructions?: string | null; contactEmail?: string | null; supportUrl?: string | null }

type Row = Pick<FormAvailability, 'key' | 'mode' | 'opensAt' | 'closesAt' | 'closedMessage' | 'instructions' | 'contactEmail' | 'supportUrl' | 'updatedAt'>
  & { updatedBy?: { id: string; username: string; firstName: string; lastName: string } | null };

/** The acting administrator, with the request id when the change came through the API (recorded in the audit row). */
export type FormCaller = CallerCtx & { requestId?: string | null };

export const isFormKey = (v: string): v is FormKey => (FORM_KEYS as readonly string[]).includes(v);

@Injectable()
export class FormAvailabilityService {
  private cache: { at: number; rows: Map<FormKey, Row> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * THE authorization rule for changing a form's availability (open, close, schedule), whatever the path: the
   * forms endpoint (whose route also declares forms.manageAvailability) and the old switches written through
   * PATCH /admin/settings. Same refusal as the permission guard: 403 PERMISSION_REQUIRED { permission }.
   * Checked against the caller's effective permissions, so an individual DENY override applies.
   */
  assertMayManageAvailability(user: AuthUser): void {
    if (!this.permissions.has(user, 'forms.manageAvailability')) {
      throw new AppError(HttpStatus.FORBIDDEN, 'PERMISSION_REQUIRED', 'You do not have permission to do this.', { permission: 'forms.manageAvailability' });
    }
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  /** The computed state now. TEACHER_REGISTRATION is CLOSED while the Teacher role is disabled. */
  async state(key: FormKey, now = new Date()): Promise<FormState> {
    return this.stateOf(await this.row(key), now);
  }

  async isOpen(key: FormKey, now = new Date()): Promise<boolean> {
    return (await this.state(key, now)) === 'OPEN';
  }

  /** What anyone may see about a form (no administrator details). */
  async publicView(key: FormKey, now = new Date()) {
    const r = await this.row(key);
    const state = this.stateOf(r, now);
    return {
      key,
      label:         FORM_DEFAULTS[key].label,
      open:          state === 'OPEN',
      state,
      opensAt:       r.opensAt?.toISOString() ?? null,
      closesAt:      r.closesAt?.toISOString() ?? null,
      closedMessage: r.closedMessage ?? FORM_DEFAULTS[key].closedMessage,
      instructions:  r.instructions,
      contactEmail:  r.contactEmail,
      supportUrl:    r.supportUrl,
      timezone:      FORM_TIMEZONE,
      serverTime:    now.toISOString(),
    };
  }

  async publicList(now = new Date()) {
    return Promise.all(FORM_KEYS.map((k) => this.publicView(k, now)));
  }

  /** The administrators' view: the stored configuration, the defaults and the computed state. */
  async adminView(key: FormKey, now = new Date()) {
    const r = await this.row(key, true);
    return {
      ...(await this.publicView(key, now)),
      mode:                 r.mode,
      closedMessageCustom:  r.closedMessage,
      closedMessageDefault: FORM_DEFAULTS[key].closedMessage,
      ...(key === 'TEACHER_REGISTRATION' && { requiresTeacherRole: true, teacherRoleEnabled: roleFlagOn('TEACHER', this.config) }),
      updatedAt:            r.updatedAt.toISOString(),
      updatedBy:            r.updatedBy ?? null,
    };
  }

  async adminList(now = new Date()) {
    return Promise.all(FORM_KEYS.map((k) => this.adminView(k, now)));
  }

  /** Changes to one form, newest first (the FORM_AVAILABILITY_CHANGED / FORM_MESSAGES_CHANGED audit rows). */
  async history(key: FormKey, limit = 50) {
    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'FormAvailability', entityId: key, action: { in: ['FORM_AVAILABILITY_CHANGED', 'FORM_MESSAGES_CHANGED'] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: { id: true, action: true, actorId: true, actorUsername: true, actorRole: true, metadata: true, createdAt: true },
    });
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /**
   * Refuse a submission while the form is not open: 403 with the form's closed message and details
   * ({ form, state, opensAt, closesAt, closedMessage, contactEmail, supportUrl }). Code REGISTRATION_CLOSED for
   * student and teacher registration (the code existing clients know), FORM_CLOSED for the other forms.
   */
  async assertOpen(key: FormKey, now = new Date()): Promise<void> {
    const v = await this.publicView(key, now);
    if (v.open) return;
    const opening = v.state === 'NOT_YET_OPEN' && v.opensAt ? ` It opens on ${kigaliTime(new Date(v.opensAt))}.` : '';
    throw new AppError(HttpStatus.FORBIDDEN, CLOSED_CODE[key], `${v.closedMessage}${opening}`, {
      form: key, state: v.state, opensAt: v.opensAt, closesAt: v.closesAt,
      closedMessage: v.closedMessage, contactEmail: v.contactEmail, supportUrl: v.supportUrl,
    });
  }

  // ─── The old switches (registration.studentSelfSignup, registration.teacherSelfSignup) ─────────────────

  /**
   * The value the old boolean setting reports: the form is open right now. For TEACHER_REGISTRATION this is the
   * form alone; callers still combine it with TEACHERS_ENABLED, as they did with the setting.
   */
  async openSwitch(key: FormKey, now = new Date()): Promise<boolean> {
    return formState(await this.row(key), now) === 'OPEN';
  }

  /**
   * Writing the old boolean setting (PATCH /admin/settings): true → OPEN now (no closing date), false → CLOSED.
   * The opening date and the messages are kept. Needs forms.manageAvailability (assertMayManageAvailability), and
   * is audited exactly like the forms endpoint (FORM_AVAILABILITY_CHANGED, with via "setting" and the request id).
   */
  async setOpenSwitch(key: FormKey, open: boolean, user: AuthUser, tx = this.prisma as unknown as PrismaTx, requestId?: string | null): Promise<void> {
    this.assertMayManageAvailability(user);
    const caller: FormCaller = Object.assign({}, user, { requestId });
    await this.applyAvailability(key, open ? { mode: 'OPEN', closesAt: null } : { mode: 'CLOSED' }, caller, tx, 'setting');
  }

  // ─── Changing ──────────────────────────────────────────────────────────────

  /** Mode and schedule (forms.manageAvailability). Partial: an omitted field is unchanged, null removes a date. */
  async updateAvailability(key: FormKey, change: AvailabilityChange, actor: CallerCtx, requestId?: string | null) {
    const caller: FormCaller = Object.assign({}, actor, { requestId });
    await this.prisma.$transaction((tx) => this.applyAvailability(key, change, caller, tx as unknown as PrismaTx, 'admin'));
    this.invalidate();
    return this.adminView(key);
  }

  /** Closed message, instructions, contact e-mail, support link (forms.editMessages). null restores the default / removes. */
  async updateMessages(key: FormKey, change: MessagesChange, actor: CallerCtx, requestId?: string | null) {
    const caller: FormCaller = Object.assign({}, actor, { requestId });
    const fields = MESSAGE_FIELDS.filter((f) => change[f] !== undefined);
    if (fields.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Provide at least one field to change.');
    const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v ?? null);
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lockedRow(tx as unknown as PrismaTx, key);
      const next: Record<string, string | null> = {};
      for (const f of fields) next[f] = clean(change[f]);
      const changed = fields.filter((f) => (before[f] ?? null) !== next[f]);
      if (changed.length === 0) return;
      await tx.formAvailability.update({ where: { key }, data: { ...Object.fromEntries(changed.map((f) => [f, next[f]])), updatedById: caller.id } });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'FORM_MESSAGES_CHANGED', entity: 'FormAvailability', entityId: key,
        metadata: {
          form: key,
          changes: Object.fromEntries(changed.map((f) => [f, { from: before[f] ?? null, to: next[f] }])),
          ...(caller.requestId && { requestId: caller.requestId }),
        },
      }, tx);
    });
    this.cache = null;
    return this.adminView(key);
  }

  private async applyAvailability(key: FormKey, change: AvailabilityChange, caller: FormCaller, tx: PrismaTx, via: 'admin' | 'setting') {
    const fields = SCHEDULE_FIELDS.filter((f) => change[f] !== undefined);
    if (fields.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Provide at least one field to change.');
    const before = await this.lockedRow(tx, key);
    const date = (v: string | null | undefined, cur: Date | null) => (v === undefined ? cur : v === null ? null : new Date(v));
    const next = {
      mode:     change.mode ?? before.mode,
      opensAt:  date(change.opensAt, before.opensAt),
      closesAt: date(change.closesAt, before.closesAt),
    };
    const problems = scheduleProblems(next);
    if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_FORM_SCHEDULE', problems.join(' '), problems);

    const iso = (d: Date | null) => d?.toISOString() ?? null;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (next.mode !== before.mode) changes.mode = { from: before.mode, to: next.mode };
    if (iso(next.opensAt) !== iso(before.opensAt)) changes.opensAt = { from: iso(before.opensAt), to: iso(next.opensAt) };
    if (iso(next.closesAt) !== iso(before.closesAt)) changes.closesAt = { from: iso(before.closesAt), to: iso(next.closesAt) };
    if (Object.keys(changes).length === 0) return;

    const now = new Date();
    await tx.formAvailability.update({ where: { key }, data: { ...next, updatedById: caller.id } });
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role, action: 'FORM_AVAILABILITY_CHANGED', entity: 'FormAvailability', entityId: key,
      metadata: {
        form: key, via, changes,
        stateBefore: formState(before, now), stateAfter: formState(next, now),
        ...(caller.requestId && { requestId: caller.requestId }),
      },
    }, tx);
    this.cache = null;
  }

  /** Drop the cached rows (after a committed change; also called by SettingsService after a switch write). */
  invalidate(): void {
    this.cache = null;
  }

  // ─── Rows ──────────────────────────────────────────────────────────────────

  private stateOf(r: Row, now: Date): FormState {
    if (r.key === 'TEACHER_REGISTRATION' && !roleFlagOn('TEACHER', this.config)) return 'CLOSED';
    return formState(r, now);
  }

  private async row(key: FormKey, fresh = false): Promise<Row> {
    if (fresh || !this.cache || Date.now() - this.cache.at >= CACHE_TTL_MS) {
      const rows = await this.prisma.formAvailability.findMany({
        include: { updatedBy: { select: { id: true, username: true, firstName: true, lastName: true } } },
      });
      this.cache = { at: Date.now(), rows: new Map(rows.map((r) => [r.key, r])) };
    }
    return this.cache.rows.get(key) ?? this.initialRow(key);
  }

  /** The row under a lock for the rest of the transaction (created with its initial mode if it were missing). */
  private async lockedRow(tx: PrismaTx, key: FormKey) {
    await tx.formAvailability.upsert({ where: { key }, create: { key, mode: INITIAL_MODE[key] }, update: {} });
    const [r] = await tx.$queryRaw<Row[]>`SELECT "key", "mode", "opensAt", "closesAt", "closedMessage", "instructions", "contactEmail", "supportUrl", "updatedAt"
      FROM "FormAvailability" WHERE "key" = ${key}::"FormKey" FOR UPDATE`;
    return r;
  }

  private initialRow(key: FormKey): Row {
    return { key, mode: INITIAL_MODE[key], opensAt: null, closesAt: null, closedMessage: null, instructions: null, contactEmail: null, supportUrl: null, updatedAt: new Date(0), updatedBy: null };
  }
}

type PrismaTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
