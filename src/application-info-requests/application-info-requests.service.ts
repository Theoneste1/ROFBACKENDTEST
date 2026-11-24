/**
 * "Request more information" on Teacher and Coach applications (ADR-009, REG-10; 2026-11-17).
 *
 * An Administrator asks a question; the application stays PENDING. The applicant (who has no account yet) gets an
 * e-mail with a one-time link valid 14 days; only the SHA-256 of its token is stored. Answering records the answer,
 * may update the details the applicant is allowed to correct, consumes the link and tells the Administrators. A
 * decision on the application (approve / reject) cancels an open request. At most one open request per application
 * (database partial unique index); a new request replaces an unanswered one.
 */
import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { CallerCtx } from '../common/auth-user.js';
import { normalisePhone } from '../schools/directory/school-contacts.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AnswerInfoRequestDto } from './application-info-requests.dto.js';

export type ApplicationKind = 'TEACHER' | 'COACH';

export const INFO_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The latest requests of an application, for the administrators' views (never the token hash). */
export const INFO_REQUEST_SELECT = {
  id: true, question: true, requestedAt: true, expiresAt: true, answer: true, answeredAt: true, cancelledAt: true,
  requestedBy: { select: { id: true, firstName: true, lastName: true } },
} as const satisfies Prisma.ApplicationInfoRequestSelect;

/** The details an applicant may correct when answering (by application kind). */
export const CORRECTABLE: Readonly<Record<ApplicationKind, readonly (keyof AnswerInfoRequestDto)[]>> = {
  TEACHER: ['phone', 'position', 'yearsOfExperience'],
  COACH: ['phone', 'affiliation', 'expertise', 'relevantExperience', 'yearsOfExperience', 'occupation'],
};

const LABEL: Record<ApplicationKind, string> = { TEACHER: 'Teacher', COACH: 'Coach' };

const linkGone = () =>
  new AppError(HttpStatus.GONE, 'INFO_REQUEST_LINK_INVALID',
    'This link is no longer valid: it was used, it expired, or the application has already been decided.');

@Injectable()
export class ApplicationInfoRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Administrators: ask the applicant a question (the application must be PENDING). */
  async request(kind: ApplicationKind, applicationId: string, question: string, caller: CallerCtx) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const app = await this.prisma.$transaction(async (tx) => {
      const row = await this.lockPending(tx, kind, applicationId);
      // A new question replaces an unanswered one (its link stops working).
      await tx.applicationInfoRequest.updateMany({ where: { ...this.owner(kind, applicationId), answeredAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      const created = await tx.applicationInfoRequest.create({
        data: {
          ...this.owner(kind, applicationId), question, requestedById: caller.id, requestedAt: now,
          tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + INFO_REQUEST_TTL_MS),
        },
        select: INFO_REQUEST_SELECT,
      });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'APPLICATION_INFO_REQUESTED',
        entity: kind === 'TEACHER' ? 'TeacherApplication' : 'MentorRequest', entityId: applicationId,
        metadata: { infoRequestId: created.id, question },
      }, tx);
      return { row, created };
    });
    await this.notifications.queueEmail(
      app.row.email,
      `More information needed for your ${LABEL[kind].toLowerCase()} application`,
      `Thank you for applying to join the Rwanda Olympiad Foundation platform as a ${LABEL[kind]}.\n\n` +
        `Before we can decide on your application, an administrator needs some more information:\n\n` +
        `"${question}"\n\nPlease answer through the link below within 14 days. Your application stays open until then.`,
      { firstName: app.row.firstName, link: `/applications/respond?token=${encodeURIComponent(token)}`, actionLabel: 'Answer the question', kind: 'APPLICATION_INFO_REQUEST' },
    );
    return app.created;
  }

  /** Public: what the link asks, and the details the applicant may correct. */
  async view(token: string) {
    const r = await this.openByToken(this.prisma, token);
    const kind: ApplicationKind = r.teacherApplicationId ? 'TEACHER' : 'COACH';
    const a = kind === 'TEACHER'
      ? await this.prisma.teacherApplication.findUniqueOrThrow({ where: { id: r.teacherApplicationId! }, select: { firstName: true, phone: true, position: true, yearsOfExperience: true } })
      : await this.prisma.mentorRequest.findUniqueOrThrow({ where: { id: r.mentorRequestId! }, select: { firstName: true, phone: true, affiliation: true, expertise: true, relevantExperience: true, yearsOfExperience: true, occupation: true } });
    const { firstName, ...details } = a as Record<string, unknown> & { firstName: string };
    return { kind, firstName, question: r.question, requestedAt: r.requestedAt.toISOString(), expiresAt: r.expiresAt.toISOString(), correctable: CORRECTABLE[kind], details };
  }

  /** Public: answer once; corrections apply to the application. Administrators are told. */
  async answer(token: string, dto: AnswerInfoRequestDto) {
    const now = new Date();
    const done = await this.prisma.$transaction(async (tx) => {
      // Lock order everywhere: the application row, then its requests (decisions and new questions do the same).
      const found = await this.openByToken(tx, token);
      const kind: ApplicationKind = found.teacherApplicationId ? 'TEACHER' : 'COACH';
      const appId = (found.teacherApplicationId ?? found.mentorRequestId)!;
      await this.lockPending(tx, kind, appId).catch(() => { throw linkGone(); });
      const r = await this.openByToken(tx, token, true);   // re-checked under the lock
      const changes = this.corrections(kind, dto);
      if (Object.keys(changes).length) {
        if (kind === 'TEACHER') await tx.teacherApplication.update({ where: { id: appId }, data: changes });
        else await tx.mentorRequest.update({ where: { id: appId }, data: changes });
      }
      const { count } = await tx.applicationInfoRequest.updateMany({ where: { id: r.id, answeredAt: null, cancelledAt: null }, data: { answer: dto.answer, answeredAt: now } });
      if (count === 0) throw linkGone();
      await this.audit.log({
        actorId: null, actorRole: 'ANONYMOUS', action: 'APPLICATION_INFO_ANSWERED',
        entity: kind === 'TEACHER' ? 'TeacherApplication' : 'MentorRequest', entityId: appId,
        metadata: { infoRequestId: r.id, corrected: Object.keys(changes) },
      }, tx);
      return { kind, appId };
    });
    const adminIds = await this.notifications.adminIds();
    await this.notifications.notify(adminIds, {
      category: 'ACCOUNT', type: 'application.info_answered',
      title: `${LABEL[done.kind]} applicant answered`,
      body: 'An applicant answered your request for more information. The application is ready for review again.',
      data: { kind: done.kind, applicationId: done.appId },
      link: done.kind === 'TEACHER' ? '/admin/teacher-applications' : '/admin/mentors',
    }, { email: false });
    return { answered: true as const, kind: done.kind };
  }

  /** Inside a decision's transaction: an open request stops working. */
  async cancelOpen(tx: Prisma.TransactionClient, kind: ApplicationKind, applicationId: string) {
    await tx.applicationInfoRequest.updateMany({ where: { ...this.owner(kind, applicationId), answeredAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
  }

  /** An application's requests, newest first (administrators' views). */
  history(kind: ApplicationKind, applicationId: string) {
    return this.prisma.applicationInfoRequest.findMany({ where: this.owner(kind, applicationId), select: INFO_REQUEST_SELECT, orderBy: { requestedAt: 'desc' } });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private owner(kind: ApplicationKind, id: string) {
    return kind === 'TEACHER' ? { teacherApplicationId: id } : { mentorRequestId: id };
  }

  /** The PENDING application, locked for the rest of the transaction (404 unknown, 409 already decided). */
  private async lockPending(tx: Prisma.TransactionClient, kind: ApplicationKind, id: string) {
    const rows = kind === 'TEACHER'
      ? await tx.$queryRaw<Array<{ status: string; email: string; firstName: string }>>`SELECT "status"::text, "email", "firstName" FROM "TeacherApplication" WHERE "id" = ${id} FOR UPDATE`
      : await tx.$queryRaw<Array<{ status: string; email: string; firstName: string }>>`SELECT "status"::text, "email", "firstName" FROM "MentorRequest" WHERE "id" = ${id} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException(`${LABEL[kind]} application not found.`);
    if (rows[0].status !== 'PENDING') {
      throw new AppError(HttpStatus.CONFLICT, 'APPLICATION_ALREADY_DECIDED', 'This application has already been decided.');
    }
    return rows[0];
  }

  private async openByToken(db: Prisma.TransactionClient | PrismaService, token: string, lock = false) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw linkGone();
    const h = hashToken(token);
    if (lock) await db.$queryRaw`SELECT 1 FROM "ApplicationInfoRequest" WHERE "tokenHash" = ${h} FOR UPDATE`;
    const r = await db.applicationInfoRequest.findUnique({ where: { tokenHash: h } });
    if (!r || r.answeredAt || r.cancelledAt || r.expiresAt.getTime() <= Date.now()) throw linkGone();
    return r;
  }

  /** Only the fields this kind of application may correct; a phone must be valid (400 INVALID_PHONE). */
  private corrections(kind: ApplicationKind, dto: AnswerInfoRequestDto) {
    const out: Record<string, string | number> = {};
    for (const k of CORRECTABLE[kind]) {
      const v = dto[k];
      if (v === undefined || v === null || k === 'answer') continue;
      if (k === 'phone') {
        const phone = normalisePhone(String(v));
        if (!phone) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_PHONE', 'Enter a valid phone number (Rwanda: 07XXXXXXXX or +2507XXXXXXXX; elsewhere: +country number).');
        out.phone = phone;
      } else {
        out[k] = v as string | number;
      }
    }
    return out;
  }
}
