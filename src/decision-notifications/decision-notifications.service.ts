/**
 * Decision notifications (owner-approved): ONE mechanism for every "an Administrator decided in your
 * favour" notice — school.request.verified, teacher.application.approved, coach.application.approved and
 * permissions.granted.
 *
 *   enqueue(tx, event)   INSIDE the Administrator's transaction: the NotificationOutbox row and, when the
 *                        recipient has an account, the in-app Notification (NotificationsService format).
 *                        Both exist if and only if the action commits. Idempotent on dedupeKey
 *                        (INSERT … ON CONFLICT DO NOTHING): a repeat is a no-op and returns null.
 *   dispatchAfterCommit(ids)
 *                        called by the action AFTER its transaction: each row is sent asynchronously
 *                        (an event handled after the response), so neither a slow nor a failing e-mail
 *                        provider can change the action's response.
 *   dispatch(id)         claims the row (PENDING/FAILED → SENDING, one conditional update, so concurrent
 *                        dispatches send once), renders the branded template, sends through MailerService
 *                        and marks it SENT, or FAILED with a sanitised lastError and a backoff. Never throws.
 *   sweep()              the retry worker (WORKERS_ENABLED pattern, every 30 s): recovers rows left SENDING
 *                        past their lease (a crashed sender) and sends due PENDING / FAILED rows, at most
 *                        MAX_ATTEMPTS automatic attempts each. An Administrator can retry any FAILED row.
 *
 * Teacher-registration notices (owner decision 10): every notice about a teacher application (entity
 * TeacherApplication: teacher.application.approved, and school.request.verified for an applicant's missing
 * school) is sent only while teacher self-registration is enabled (TEACHERS_ENABLED and the
 * registration.teacherSelfSignup setting, the same check as POST /auth/register/teacher). While it is off,
 * enqueue writes nothing (no outbox row, no in-app notification) and a row queued earlier is not e-mailed
 * (marked FAILED with SELF_REGISTRATION_OFF, no automatic retry). Coach approval, student school
 * verification and permission grants are not teacher-registration notices and are unaffected.
 *
 * Opt-outs: these are account-status notices (category ACCOUNT), like activation, approval and password
 * e-mails — they are not configurable types and ignore the per-category e-mail preferences and the
 * notifications.emailEnabled switch, exactly as NotificationsService treats ACCOUNT e-mails.
 */
import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service.js';
import type { CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { loadEmailBrand } from '../email/email-brand.js';
import { MailerService, type SendResult } from '../email/mailer.service.js';
import { renderEmail } from '../email/templates.js';
import type { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { roleFlagOn } from '../auth/role-assignment.policy.js';
import { teacherRegistrationOpen } from '../teacher-applications/teacher-application.rules.js';
import { describeGrantedPermission } from '../auth/permission-descriptions.js';
import {
  DecisionEvents, decisionEmail, decisionInApp, sanitiseError, type DecisionEventType, type DecisionPayload,
} from './decision-content.js';
import type { ListDeliveriesDto } from './dto/list-deliveries.dto.js';

/** Automatic attempts per row (the retry sweep stops after this; an Administrator can still retry). */
export const MAX_ATTEMPTS = 5;
/** How long a SENDING claim lasts before the sweep treats the sender as crashed. */
export const SENDING_LEASE_MS = 5 * 60_000;
/** 1, 2, 4, 8 … minutes after the n-th failed attempt (capped at 1 hour). */
export const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 3_600_000);

const DISPATCH_EVENT = 'decision-notification.dispatch';

/** The entity of every teacher-registration notice (owner decision 10). */
export const TEACHER_REGISTRATION_ENTITY = 'TeacherApplication';
/** lastError of a teacher-registration notice not sent because self-registration is off. */
export const SELF_REGISTRATION_OFF = 'Not sent: teacher self-registration is turned off.';
const SWEEP_BATCH = 50;

export interface DecisionEvent {
  type:      DecisionEventType;
  dedupeKey: string;
  recipient: { userId: string | null; email: string; firstName: string };
  entity:    { type: string; id: string };
  payload:   DecisionPayload;
}

/** What the delivery log shows (never the payload). */
export const DELIVERY_SELECT = {
  id: true, type: true, recipientEmail: true, recipientUserId: true, entityType: true, entityId: true,
  status: true, attempts: true, lastError: true, createdAt: true, sentAt: true, nextAttemptAt: true,
} as const satisfies Prisma.NotificationOutboxSelect;

@Injectable()
export class DecisionNotificationsService {
  private readonly logger = new Logger(DecisionNotificationsService.name);
  private sweeping = false;

  constructor(
    private readonly prisma:        PrismaService,
    private readonly notifications: NotificationsService,
    private readonly mailer:        MailerService,
    private readonly settings:      SettingsService,
    private readonly config:        ConfigService,
    private readonly events:        EventEmitter2,
    private readonly audit:         AuditService,
  ) {}

  // ─── Inside the Administrator's transaction ────────────────────────────────

  /** Outbox row (+ in-app notification for an account). Returns its id, or null when dedupeKey already exists. */
  async enqueue(tx: Prisma.TransactionClient, event: DecisionEvent): Promise<string | null> {
    // Decision 10: no teacher-registration notice while teacher self-registration is off.
    if (event.entity.type === TEACHER_REGISTRATION_ENTITY && !(await this.teacherSelfRegistrationOn())) return null;
    const id = randomUUID();
    const inserted = await tx.notificationOutbox.createManyAndReturn({
      data: [{
        id, type: event.type, dedupeKey: event.dedupeKey,
        recipientUserId: event.recipient.userId, recipientEmail: event.recipient.email, firstName: event.recipient.firstName,
        entityType: event.entity.type, entityId: event.entity.id,
        payload: event.payload as unknown as Prisma.InputJsonValue,
      }],
      // A concurrent or repeated enqueue with the same key waits for the first, then inserts nothing.
      skipDuplicates: true,
      select: { id: true },
    });
    if (inserted.length === 0) return null;
    const rowId = inserted[0].id;

    if (event.recipient.userId) {
      const inApp = decisionInApp(event.type, event.payload);
      const notification = await this.notifications.createInApp(tx, event.recipient.userId, {
        category: 'ACCOUNT', type: event.type, title: inApp.title, body: inApp.body, ...(inApp.link && { link: inApp.link }),
      });
      await tx.notificationOutbox.update({ where: { id: rowId }, data: { inAppNotificationId: notification.id } });
    }
    return rowId;
  }

  /** Teacher self-registration is enabled: TEACHERS_ENABLED and registration.teacherSelfSignup (decision 10). */
  async teacherSelfRegistrationOn(): Promise<boolean> {
    return teacherRegistrationOpen(roleFlagOn('TEACHER', this.config), (await this.settings.get('registration.teacherSelfSignup')) === true);
  }

  /** Roles told about permissions granted to them (owner-approved): Teachers, Coaches and Head Coaches. */
  static readonly PERMISSION_NOTICE_ROLES: readonly string[] = ['TEACHER', 'MENTOR', 'HEAD_COACH'];

  /**
   * permissions.granted for the GRANT overrides saved by ONE action (one notice listing all of them).
   * Nothing for other roles, inactive accounts, DENY overrides or an empty list.
   */
  async enqueuePermissionsGranted(
    tx: Prisma.TransactionClient,
    user: { id: string; role: string; email: string; firstName: string; isActive: boolean; activatedAt: Date | null },
    overrides: Array<{ id: string; permission: string; effect: string }>,
  ): Promise<string | null> {
    const grants = overrides.filter((o) => o.effect === 'GRANT');
    if (grants.length === 0 || !user.isActive || !DecisionNotificationsService.PERMISSION_NOTICE_ROLES.includes(user.role)) return null;
    const ids = grants.map((g) => g.id).sort();
    const permissions = [...new Set(grants.map((g) => g.permission))].sort()
      .map((permission) => ({ permission, ...describeGrantedPermission(permission) }));
    return this.enqueue(tx, {
      type: DecisionEvents.PermissionsGranted, dedupeKey: `${DecisionEvents.PermissionsGranted}:${ids.join(',')}`,
      recipient: { userId: user.id, email: user.email, firstName: user.firstName },
      entity: { type: 'UserPermissionOverride', id: ids[0] },
      payload: { activated: user.activatedAt !== null, permissions },
    });
  }

  /**
   * teacher.students.assigned (TS-6): the Teacher is told that students were assigned to them — once per action
   * (`dedupeKey`: one request, or one bulk operation, so a retried item adds nothing). Students are never notified,
   * and the notice never names them. Nothing for non-Teachers, inactive accounts or a zero count.
   */
  async enqueueStudentsAssigned(
    tx: Prisma.TransactionClient,
    teacher: { id: string; role: string; email: string; firstName: string; isActive: boolean; activatedAt: Date | null },
    dedupeKey: string,
    count?: number,
  ): Promise<string | null> {
    if (teacher.role !== 'TEACHER' || !teacher.isActive || count === 0) return null;
    return this.enqueue(tx, {
      type: DecisionEvents.TeacherStudentsAssigned, dedupeKey: `${DecisionEvents.TeacherStudentsAssigned}:${dedupeKey}`,
      recipient: { userId: teacher.id, email: teacher.email, firstName: teacher.firstName },
      entity: { type: 'User', id: teacher.id },
      payload: { activated: teacher.activatedAt !== null, ...(count !== undefined && { count }) },
    });
  }

  // ─── After commit ──────────────────────────────────────────────────────────

  /** Send the given rows in the background (after the response); null ids (duplicates) are skipped. */
  dispatchAfterCommit(ids: Array<string | null | undefined>): void {
    for (const id of ids) if (id) this.events.emit(DISPATCH_EVENT, { id });
  }

  @OnEvent(DISPATCH_EVENT, { async: true, suppressErrors: false })
  async onDispatch(e: { id: string }) {
    await this.dispatch(e.id);
  }

  /** Claim, render, send and record one row. Never throws. */
  async dispatch(id: string): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
    try {
      // The claim: only one dispatcher can move the row to SENDING; SENT rows are never sent again.
      const { count } = await this.prisma.notificationOutbox.updateMany({
        where: { id, status: { in: ['PENDING', 'FAILED'] } },
        data:  { status: 'SENDING', attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + SENDING_LEASE_MS) },
      });
      if (count === 0) return 'SKIPPED';
      const row = await this.prisma.notificationOutbox.findUniqueOrThrow({ where: { id } });

      // Decision 10: a teacher-registration notice queued while self-registration was on is not e-mailed
      // once it is off (retry, sweep or a late dispatch). No automatic retry; an Administrator may retry it
      // after turning self-registration on again.
      if (row.entityType === TEACHER_REGISTRATION_ENTITY && !(await this.teacherSelfRegistrationOn())) {
        await this.prisma.notificationOutbox.updateMany({
          where: { id, status: 'SENDING', attempts: row.attempts },
          data:  { status: 'FAILED', lastError: SELF_REGISTRATION_OFF, nextAttemptAt: null },
        });
        return 'FAILED';
      }

      let result: SendResult;
      try {
        const brand = await loadEmailBrand(this.settings, this.config);
        const mail = decisionEmail(row.type, row.firstName, row.payload, brand.appUrl);
        const rendered = renderEmail({ greeting: mail.greeting, heading: mail.heading, body: mail.body, action: mail.action }, brand);
        result = await this.mailer.sendOne({
          to: row.recipientEmail, subject: mail.subject, text: rendered.text, html: rendered.html,
          idempotencyKey: `notification-outbox/${row.id}`,
        });
      } catch (err) {
        result = { accepted: false, messageId: null, error: (err as Error)?.message ?? String(err), permanent: false };
      }

      // The outcome is recorded only while this claim is still the current one (L3): a sender slower than
      // SENDING_LEASE_MS may have been recovered by the sweep and claimed again (attempts incremented), and
      // must not overwrite that newer attempt's state. A duplicate e-mail is prevented by the idempotency key.
      const ours = { id, status: 'SENDING' as const, attempts: row.attempts };
      if (result.accepted) {
        await this.prisma.notificationOutbox.updateMany({
          where: ours,
          data:  { status: 'SENT', sentAt: new Date(), lastError: null, nextAttemptAt: null },
        });
        return 'SENT';
      }
      const giveUp = result.permanent || row.attempts >= MAX_ATTEMPTS;
      await this.prisma.notificationOutbox.updateMany({
        where: ours,
        data:  {
          status: 'FAILED', lastError: sanitiseError(result.error ?? 'The e-mail was not accepted.'),
          nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs(row.attempts)),
        },
      });
      this.logger.warn(`Decision notification ${row.type} not sent (attempt ${row.attempts}${giveUp ? ', no automatic retry' : ''}).`);
      return 'FAILED';
    } catch (err) {
      this.logger.error(`Decision notification dispatch failed: ${sanitiseError(err)}`);
      return 'FAILED';
    }
  }

  // ─── Retry worker ──────────────────────────────────────────────────────────

  @Interval('decision-notifications', 30_000)
  async tick() {
    if (this.config.get('WORKERS_ENABLED') === 'false' || this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(`Decision notification sweep failed: ${sanitiseError(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Recover expired SENDING claims, then send due PENDING / FAILED rows (bounded attempts). */
  async sweep(now = new Date()): Promise<{ recovered: number; processed: number; sent: number }> {
    const interrupted = 'Interrupted while sending; retried automatically.';
    const recoveredRetry = await this.prisma.notificationOutbox.updateMany({
      where: { status: 'SENDING', nextAttemptAt: { lt: now }, attempts: { lt: MAX_ATTEMPTS } },
      data:  { status: 'FAILED', lastError: interrupted, nextAttemptAt: now },
    });
    const recoveredFinal = await this.prisma.notificationOutbox.updateMany({
      where: { status: 'SENDING', nextAttemptAt: { lt: now }, attempts: { gte: MAX_ATTEMPTS } },
      data:  { status: 'FAILED', lastError: 'Interrupted while sending.', nextAttemptAt: null },
    });

    const due = await this.prisma.notificationOutbox.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now }, attempts: { lt: MAX_ATTEMPTS } },
        ],
      },
      orderBy: { createdAt: 'asc' }, take: SWEEP_BATCH, select: { id: true },
    });
    let sent = 0;
    for (const { id } of due) if ((await this.dispatch(id)) === 'SENT') sent++;
    return { recovered: recoveredRetry.count + recoveredFinal.count, processed: due.length, sent };
  }

  // ─── Administrators: the delivery log (email.bulkSend) ────────────────────

  async list(q: ListDeliveriesDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.NotificationOutboxWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.type && { type: q.type }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notificationOutbox.findMany({ where, select: DELIVERY_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take }),
      this.prisma.notificationOutbox.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Re-queue a FAILED (or still PENDING) row and send it now; 409 for SENT or SENDING. */
  async retry(id: string, caller: CallerCtx) {
    const row = await this.prisma.notificationOutbox.findUnique({ where: { id }, select: { id: true, status: true, type: true } });
    if (!row) throw new NotFoundException('Notification delivery not found.');
    if (row.status === 'SENT') throw new AppError(HttpStatus.CONFLICT, 'NOTIFICATION_ALREADY_SENT', 'This notification has already been sent.');
    if (row.status === 'SENDING') throw new AppError(HttpStatus.CONFLICT, 'NOTIFICATION_SENDING', 'This notification is being sent right now.');

    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.notificationOutbox.updateMany({
        where: { id, status: { in: ['FAILED', 'PENDING'] } },
        data:  { status: 'PENDING', nextAttemptAt: new Date() },
      });
      if (count === 0) throw new AppError(HttpStatus.CONFLICT, 'NOTIFICATION_SENDING', 'This notification changed meanwhile; refresh and try again.');
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'RETRY_NOTIFICATION_DELIVERY', entity: 'NotificationOutbox', entityId: id,
        metadata: { type: row.type, previous: { status: row.status }, next: { status: 'PENDING' } },
      }, tx);
      return tx.notificationOutbox.findUniqueOrThrow({ where: { id }, select: DELIVERY_SELECT });
    });
    this.dispatchAfterCommit([id]);
    return updated;
  }
}
