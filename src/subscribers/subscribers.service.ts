/**
 * News subscribers (owner 2026-11-23): anyone — parents, schools, the public — leaves an e-mail address on the website
 * to receive ROF news and Olympiad announcements; Administrators see, export and maintain the list; every e-mail
 * carries a one-click unsubscribe link.
 *
 * Privacy:
 *  - the public answer is the same whether the address is new, already listed or unsubscribed (no enumeration);
 *  - unsubscribing keeps the row (UNSUBSCRIBED) so an import never adds the address back; only the person (by
 *    subscribing again) or an Administrator (with a reason) makes it active again; an Administrator can erase a row;
 *  - the unsubscribe token is an HMAC of the id (subscriber-rules.ts): nothing secret is stored;
 *  - a welcome e-mail (with the unsubscribe link) is sent only when an address becomes active from the website, so
 *    whoever owns the address learns about it and can leave at once.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isISO31661Alpha2 } from 'class-validator';

import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { parseCsv } from '../common/csv-parse.js';
import { keysetBatches, mapBatches, type CsvExport } from '../reports/csv.js';
import { loadEmailBrand } from '../email/email-brand.js';
import { renderEmail } from '../email/templates.js';
import { EmailWorker } from '../email/email.worker.js';
import type { AuthUser } from '../common/auth-user.js';
import { Prisma, type OlympiadSubject, type SubscriberKind } from '../generated/prisma/client.js';
import {
  IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, greetingFor, looksLikeEmail, normaliseEmail, unsubscribeLinks, verifyUnsubscribeToken,
} from './subscriber-rules.js';
import type {
  CreateSubscriberDto, ImportSubscribersQueryDto, ListSubscribersDto, SubscribeDto, UpdateSubscriberDto,
} from './subscribers.dto.js';

/** The one public answer to POST /public/subscribe. */
export const SUBSCRIBE_ANSWER = {
  received: true,
  message: 'Thank you. You will receive Rwanda Olympiad Foundation news at this address. Every e-mail has a link to unsubscribe.',
} as const;

export const SUBSCRIBER_SELECT = {
  id: true, email: true, fullName: true, kind: true, interests: true, country: true, source: true, status: true,
  subscribedAt: true, unsubscribedAt: true, unsubscribeReason: true, userId: true, createdAt: true, updatedAt: true,
} as const;

const SUBJECT_LABEL: Record<OlympiadSubject, string> = { MATHEMATICS: 'Mathematics', PHYSICS: 'Physics', COMPUTING: 'Computing' };
const SUBJECT_WORDS: Record<string, OlympiadSubject> = {
  MATHEMATICS: 'MATHEMATICS', MATHS: 'MATHEMATICS', MATH: 'MATHEMATICS',
  PHYSICS: 'PHYSICS',
  COMPUTING: 'COMPUTING', 'COMPUTER SCIENCE': 'COMPUTING', INFORMATICS: 'COMPUTING',
};
const KINDS: readonly SubscriberKind[] = ['PARENT', 'STUDENT', 'TEACHER', 'SCHOOL', 'OTHER'];

export interface ImportProblem { line: number; email: string; problem: string }

/** Interests on an ACTIVE row that subscribes again: none chosen on either side means every subject. */
export function mergeInterests(current: OlympiadSubject[], given: OlympiadSubject[] | undefined): OlympiadSubject[] {
  if (given === undefined) return current;
  if (current.length === 0 || given.length === 0) return [];
  return [...new Set([...current, ...given])].sort();
}

@Injectable()
export class SubscribersService {
  constructor(
    private readonly prisma:   PrismaService,
    private readonly settings: SettingsService,
    private readonly audit:    AuditService,
    private readonly config:   ConfigService,
    private readonly worker:   EmailWorker,
  ) {}

  private get secret() {
    return this.config.get<string>('JWT_SECRET') ?? '';
  }

  // ─── Public ─────────────────────────────────────────────────────────────────

  async subscribe(dto: SubscribeDto) {
    // Honeypot filled in: look like success, store and send nothing.
    if (dto.website && dto.website.trim() !== '') return SUBSCRIBE_ANSWER;
    const email = normaliseEmail(dto.email);
    const interests = dto.interests ? [...new Set(dto.interests)].sort() : undefined;

    const existing = await this.prisma.subscriber.findUnique({ where: { email }, select: SUBSCRIBER_SELECT });
    if (existing?.status === 'ACTIVE') {
      // Already listed: fill what was missing, never overwrite what the person (or an Administrator) gave before.
      await this.prisma.subscriber.update({
        where: { id: existing.id },
        data: {
          interests: mergeInterests(existing.interests, interests),
          ...(!existing.fullName && dto.fullName && { fullName: dto.fullName }),
          ...(!existing.kind && dto.kind && { kind: dto.kind }),
          ...(!existing.country && dto.country && { country: dto.country }),
        },
      });
      return SUBSCRIBE_ANSWER;
    }

    let row: { id: string; fullName: string | null; interests: OlympiadSubject[] };
    if (existing) {
      // Unsubscribed before: the person subscribes again.
      row = await this.prisma.subscriber.update({
        where: { id: existing.id },
        data: {
          status: 'ACTIVE', subscribedAt: new Date(), unsubscribedAt: null, unsubscribeReason: null,
          interests: interests ?? existing.interests,
          fullName: dto.fullName ?? existing.fullName, kind: dto.kind ?? existing.kind, country: dto.country ?? existing.country,
        },
        select: { id: true, fullName: true, interests: true },
      });
    } else {
      try {
        row = await this.prisma.subscriber.create({
          data: {
            email, fullName: dto.fullName ?? null, kind: dto.kind ?? null, interests: interests ?? [], country: dto.country ?? null,
            source: 'WEBSITE', userId: await this.accountFor(email),
          },
          select: { id: true, fullName: true, interests: true },
        });
      } catch (err) {
        // The same address submitted twice at once: the other request created it.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return SUBSCRIBE_ANSWER;
        throw err;
      }
    }
    await this.audit.log({
      actorId: null, actorRole: null, action: 'SUBSCRIBER_SUBSCRIBED', entity: 'Subscriber', entityId: row.id,
      metadata: { source: 'WEBSITE', again: !!existing },
    });
    await this.queueWelcome(email, row);
    return SUBSCRIBE_ANSWER;
  }

  /** The unsubscribe page's button and the RFC 8058 one-click POST. Idempotent; an erased subscriber is "done". */
  async unsubscribe(id: string, token: string, reason: string | undefined, via: 'PAGE' | 'ONE_CLICK') {
    if (!verifyUnsubscribeToken(this.secret, id, token)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_UNSUBSCRIBE_LINK',
        'This unsubscribe link is not valid. Use the link in the most recent e-mail you received from us, or write to us and we will remove your address.');
    }
    const sub = await this.prisma.subscriber.findUnique({ where: { id }, select: { id: true, status: true } });
    if (sub?.status === 'ACTIVE') {
      const { count } = await this.prisma.subscriber.updateMany({
        where: { id, status: 'ACTIVE' },
        data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date(), unsubscribeReason: reason ?? null },
      });
      if (count > 0) {
        await this.audit.log({
          actorId: null, actorRole: null, action: 'SUBSCRIBER_UNSUBSCRIBED', entity: 'Subscriber', entityId: id, metadata: { via },
        });
      }
    }
    return { unsubscribed: true };
  }

  private async accountFor(email: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
    return user?.id ?? null;
  }

  private async queueWelcome(email: string, row: { id: string; fullName: string | null; interests: OlympiadSubject[] }) {
    const links = unsubscribeLinks({ secret: this.secret, appUrl: this.config.get<string>('APP_URL') }, row.id);
    const subjects = row.interests.length ? ` (${row.interests.map((s) => SUBJECT_LABEL[s]).join(', ')})` : '';
    const subject = 'You are subscribed to Rwanda Olympiad Foundation news';
    const mail = renderEmail({
      heading: subject,
      greeting: greetingFor(row.fullName),
      body: [
        `Thank you for subscribing. We will send you news from the Rwanda Olympiad Foundation and announcements about the Olympiads${subjects}.`,
        'If you did not ask for this, or no longer want these e-mails, use the unsubscribe link below. One click is enough.',
      ].join('\n\n'),
      unsubscribeUrl: links.pageUrl,
    }, await loadEmailBrand(this.settings, this.config));
    await this.prisma.emailDelivery.create({
      data: { recipientEmail: email, subscriberId: row.id, subject, body: mail.text, html: mail.html, kind: 'SUBSCRIBER_WELCOME', priority: 'NORMAL' },
    });
  }

  // ─── Administrators ─────────────────────────────────────────────────────────

  private where(q: ListSubscribersDto): Prisma.SubscriberWhereInput {
    return {
      ...(q.status && { status: q.status }),
      ...(q.kind && { kind: q.kind }),
      ...(q.source && { source: q.source }),
      ...(q.country && { country: q.country }),
      ...(q.interest && { interests: { has: q.interest } }),
      ...(q.q && {
        OR: [
          { email: { contains: q.q, mode: 'insensitive' } },
          { fullName: { contains: q.q, mode: 'insensitive' } },
        ],
      }),
    };
  }

  private orderBy(q: ListSubscribersDto): Prisma.SubscriberOrderByWithRelationInput[] {
    switch (q.sort) {
      case 'oldest': return [{ createdAt: 'asc' }, { id: 'asc' }];
      case 'name':   return [{ fullName: { sort: 'asc', nulls: 'last' } }, { email: 'asc' }, { id: 'asc' }];
      case 'email':  return [{ email: 'asc' }, { id: 'asc' }];
      default:       return [{ createdAt: 'desc' }, { id: 'asc' }];
    }
  }

  async list(q: ListSubscribersDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where = this.where(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.subscriber.findMany({ where, orderBy: this.orderBy(q), skip, take, select: SUBSCRIBER_SELECT }),
      this.prisma.subscriber.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Counts for the list's header: by status, source and kind; active subscribers by interest. */
  async summary() {
    const ACTIVE = { status: 'ACTIVE' } as const;
    const [byStatus, bySource, byKind, maths, physics, computing, everything] = await this.prisma.$transaction([
      this.prisma.subscriber.groupBy({ by: ['status'], orderBy: { status: 'asc' }, _count: { _all: true } }),
      this.prisma.subscriber.groupBy({ by: ['source'], where: ACTIVE, orderBy: { source: 'asc' }, _count: { _all: true } }),
      this.prisma.subscriber.groupBy({ by: ['kind'], where: ACTIVE, orderBy: { kind: 'asc' }, _count: { _all: true } }),
      this.prisma.subscriber.count({ where: { ...ACTIVE, interests: { has: 'MATHEMATICS' } } }),
      this.prisma.subscriber.count({ where: { ...ACTIVE, interests: { has: 'PHYSICS' } } }),
      this.prisma.subscriber.count({ where: { ...ACTIVE, interests: { has: 'COMPUTING' } } }),
      this.prisma.subscriber.count({ where: { ...ACTIVE, interests: { isEmpty: true } } }),
    ]);
    const count = (g: { _count?: unknown }) => ((g._count as { _all?: number } | undefined)?._all ?? 0);
    const status = (s: string) => count(byStatus.find((g) => g.status === s) ?? {});
    return {
      active: status('ACTIVE'),
      unsubscribed: status('UNSUBSCRIBED'),
      bySource: Object.fromEntries(bySource.map((g) => [g.source, count(g)])),
      byKind: Object.fromEntries(byKind.map((g) => [g.kind ?? 'NOT_GIVEN', count(g)])),
      byInterest: { MATHEMATICS: maths, PHYSICS: physics, COMPUTING: computing, ALL_SUBJECTS: everything },
    };
  }

  /** The filtered list as CSV (streamed; every row, no paging). The export itself is audited. */
  async exportCsv(q: ListSubscribersDto, user: AuthUser): Promise<CsvExport> {
    const where = this.where(q);
    const orderBy = this.orderBy(q);
    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'SUBSCRIBERS_EXPORTED', entity: 'Subscriber',
      metadata: { filters: { q: q.q, status: q.status, interest: q.interest, kind: q.kind, source: q.source, country: q.country, sort: q.sort } },
    });
    return {
      headers: ['Email', 'Name', 'Kind', 'Interests', 'Country', 'Source', 'Status', 'Subscribed at', 'Unsubscribed at', 'Unsubscribe reason', 'Has an account'],
      batches: mapBatches(
        keysetBatches((page) => this.prisma.subscriber.findMany({ where, orderBy, ...page, select: SUBSCRIBER_SELECT })),
        (rows) => rows.map((r) => [
          r.email, r.fullName, r.kind, r.interests.length ? r.interests.join('; ') : 'All subjects', r.country, r.source, r.status,
          r.subscribedAt, r.unsubscribedAt, r.unsubscribeReason, r.userId ? 'Yes' : 'No',
        ]),
      ),
    };
  }

  async create(dto: CreateSubscriberDto, user: AuthUser) {
    const email = normaliseEmail(dto.email);
    const existing = await this.prisma.subscriber.findUnique({ where: { email }, select: { id: true, status: true, unsubscribedAt: true } });
    if (existing) throw this.alreadyListed(existing);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.subscriber.create({
          data: {
            email, fullName: dto.fullName ?? null, kind: dto.kind ?? null, interests: [...new Set(dto.interests ?? [])].sort(),
            country: dto.country ?? null, source: 'ADMIN', userId: await this.accountFor(email),
          },
          select: SUBSCRIBER_SELECT,
        });
        await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'SUBSCRIBER_ADDED', entity: 'Subscriber', entityId: row.id }, tx);
        return row;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(HttpStatus.CONFLICT, 'SUBSCRIBER_EXISTS', 'This e-mail address is already on the list. Search for it in the list instead.');
      }
      throw err;
    }
  }

  private alreadyListed(existing: { status: string; unsubscribedAt: Date | null }) {
    return existing.status === 'UNSUBSCRIBED'
      ? new AppError(HttpStatus.CONFLICT, 'SUBSCRIBER_UNSUBSCRIBED',
        `This person unsubscribed on ${existing.unsubscribedAt?.toISOString().slice(0, 10) ?? 'an earlier date'}. Find them in the list and subscribe them again only if they asked for it (a reason is required).`)
      : new AppError(HttpStatus.CONFLICT, 'SUBSCRIBER_EXISTS', 'This e-mail address is already on the list. Search for it in the list instead.');
  }

  async update(id: string, dto: UpdateSubscriberDto, user: AuthUser) {
    const existing = await this.prisma.subscriber.findUnique({ where: { id }, select: SUBSCRIBER_SELECT });
    if (!existing) throw new NotFoundException('This subscriber no longer exists. Reload the list.');

    const data: Prisma.SubscriberUpdateInput = {};
    const changed: string[] = [];
    if (dto.fullName !== undefined && dto.fullName !== existing.fullName) { data.fullName = dto.fullName; changed.push('fullName'); }
    if (dto.kind !== undefined && dto.kind !== existing.kind) { data.kind = dto.kind; changed.push('kind'); }
    if (dto.country !== undefined && dto.country !== existing.country) { data.country = dto.country; changed.push('country'); }
    if (dto.interests !== undefined) {
      const next = [...new Set(dto.interests)].sort();
      if (next.join() !== [...existing.interests].sort().join()) { data.interests = next; changed.push('interests'); }
    }

    let statusAction: 'SUBSCRIBER_UNSUBSCRIBED' | 'SUBSCRIBER_RESUBSCRIBED' | null = null;
    if (dto.status && dto.status !== existing.status) {
      if (dto.status === 'ACTIVE') {
        if (!dto.reason) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED',
            'This person chose to unsubscribe. Give the reason for subscribing them again (for example: "Asked by phone on 3 May").');
        }
        Object.assign(data, { status: 'ACTIVE', subscribedAt: new Date(), unsubscribedAt: null, unsubscribeReason: null });
        statusAction = 'SUBSCRIBER_RESUBSCRIBED';
      } else {
        Object.assign(data, { status: 'UNSUBSCRIBED', unsubscribedAt: new Date(), unsubscribeReason: dto.reason ?? 'Unsubscribed by an administrator.' });
        statusAction = 'SUBSCRIBER_UNSUBSCRIBED';
      }
    }
    if (!changed.length && !statusAction) return existing;

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.subscriber.update({ where: { id }, data, select: SUBSCRIBER_SELECT });
      if (changed.length) {
        await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'SUBSCRIBER_UPDATED', entity: 'Subscriber', entityId: id, metadata: { changed } }, tx);
      }
      if (statusAction === 'SUBSCRIBER_UNSUBSCRIBED') {
        await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'SUBSCRIBER_UNSUBSCRIBED', entity: 'Subscriber', entityId: id, metadata: { via: 'ADMIN', reason: dto.reason ?? null } }, tx);
      } else if (statusAction === 'SUBSCRIBER_RESUBSCRIBED') {
        await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'SUBSCRIBER_RESUBSCRIBED', entity: 'Subscriber', entityId: id, metadata: { reason: dto.reason } }, tx);
      }
      return row;
    });
  }

  /**
   * Erase a subscriber (a privacy request). Their e-mails still waiting in the outbox are withdrawn first, so nothing is
   * sent to them afterwards. The address can be added again later (it is no longer known).
   */
  async remove(id: string, user: AuthUser) {
    const existing = await this.prisma.subscriber.findUnique({ where: { id }, select: { id: true, status: true, source: true } });
    if (!existing) throw new NotFoundException('This subscriber no longer exists. Reload the list.');
    const jobIds = await this.prisma.$transaction(async (tx) => {
      const waiting = await tx.emailDelivery.findMany({ where: { subscriberId: id, status: 'PENDING' }, select: { id: true, jobId: true } });
      await tx.emailDelivery.deleteMany({ where: { id: { in: waiting.map((w) => w.id) } } });
      const jobs = [...new Set(waiting.map((w) => w.jobId).filter((j): j is string => !!j))];
      for (const jobId of jobs) {
        const n = waiting.filter((w) => w.jobId === jobId).length;
        await tx.emailJob.update({ where: { id: jobId }, data: { totalRecipients: { decrement: n } } });
        await tx.mailing.updateMany({ where: { emailJobId: jobId }, data: { cancelledCount: { increment: n } } });
      }
      await tx.subscriber.delete({ where: { id } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'SUBSCRIBER_DELETED', entity: 'Subscriber', entityId: id,
        metadata: { status: existing.status, source: existing.source, withdrawnEmails: waiting.length },
      }, tx);
      return jobs;
    });
    for (const jobId of jobIds) await this.worker.refreshJob(jobId);
    return { deleted: true };
  }

  /**
   * CSV import: columns email (required), name, kind, interests (separated by ; , or |), country. Valid new addresses are
   * added (source IMPORT); addresses already listed are left as they are; addresses that unsubscribed are NEVER added
   * again; every other row is reported with its line. dryRun reports without adding anybody.
   */
  async importCsv(file: Express.Multer.File | undefined, q: ImportSubscribersQueryDto, user: AuthUser) {
    if (!file?.buffer?.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Choose a CSV file with an "email" column to import.');
    }
    if (file.size > IMPORT_MAX_BYTES) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_TOO_LARGE', 'The file is larger than 1 MB. Split it into smaller files and import them one by one.');
    }
    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(file.buffer.toString('utf8'));
    } catch {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_CSV', 'The file could not be read as CSV. Save it as "CSV UTF-8" from your spreadsheet and try again.');
    }
    const header = (names: string[]) => parsed.headers.find((h) => names.includes(h.trim().toLowerCase().replace(/[\s_-]+/g, ' ')));
    const col = {
      email: header(['email', 'e mail', 'email address', 'e mail address']),
      name: header(['name', 'full name', 'fullname']),
      kind: header(['kind', 'type', 'category']),
      interests: header(['interests', 'subjects', 'interest', 'subject']),
      country: header(['country', 'country code']),
    };
    if (!col.email) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'EMAIL_COLUMN_REQUIRED', 'The file has no "email" column. Add a header row with at least the column "email".');
    }
    if (parsed.records.length > IMPORT_MAX_ROWS) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_ROWS', `The file has more than ${IMPORT_MAX_ROWS} rows. Split it into smaller files.`);
    }

    const problems: ImportProblem[] = [];
    const seen = new Map<string, number>();
    const candidates: Array<Prisma.SubscriberCreateManyInput & { line: number }> = [];
    for (const r of parsed.records) {
      const v = (c?: string) => (c ? (r.values[c] ?? '').trim() : '');
      const email = normaliseEmail(v(col.email));
      const report = (problem: string) => problems.push({ line: r.line, email, problem });
      if (!email) { report('The e-mail address is missing.'); continue; }
      if (!looksLikeEmail(email)) { report('This is not a valid e-mail address.'); continue; }
      if (seen.has(email)) { report(`Repeated: the same address is on line ${seen.get(email)}.`); continue; }
      seen.set(email, r.line);

      const name = v(col.name);
      if (name && (name.length < 2 || name.length > 100)) { report('The name must be 2 to 100 characters.'); continue; }
      const kindText = v(col.kind).toUpperCase();
      const kind = kindText ? KINDS.find((k) => k === kindText) : undefined;
      if (kindText && !kind) { report('Kind must be one of Parent, Student, Teacher, School or Other.'); continue; }
      const words = v(col.interests).split(/[;,|]/).map((w) => w.trim().toUpperCase()).filter(Boolean);
      const unknown = words.filter((w) => !SUBJECT_WORDS[w] && w !== 'ALL' && w !== 'ALL SUBJECTS');
      if (unknown.length) { report(`Unknown interest "${unknown[0].toLowerCase()}": use Mathematics, Physics or Computing.`); continue; }
      const interests = [...new Set(words.map((w) => SUBJECT_WORDS[w]).filter(Boolean))].sort();
      const country = v(col.country).toUpperCase();
      if (country && !isISO31661Alpha2(country)) { report('Country must be a two-letter code such as RW.'); continue; }
      candidates.push({ line: r.line, email, fullName: name || null, kind: kind ?? null, interests, country: country || null, source: 'IMPORT' });
    }

    const emails = candidates.map((c) => c.email);
    const listed = new Map((await this.prisma.subscriber.findMany({ where: { email: { in: emails } }, select: { email: true, status: true } })).map((s) => [s.email, s.status]));
    let existing = 0;
    let unsubscribed = 0;
    const toAdd = candidates.filter((c) => {
      const status = listed.get(c.email);
      if (status === 'UNSUBSCRIBED') {
        unsubscribed++;
        problems.push({ line: c.line, email: c.email, problem: 'This person unsubscribed earlier and is not added again.' });
        return false;
      }
      if (status) { existing++; return false; }
      return true;
    });

    let added = 0;
    if (!q.dryRun && toAdd.length) {
      const accounts = new Map((await this.prisma.user.findMany({ where: { email: { in: toAdd.map((c) => c.email) } }, select: { id: true, email: true } })).map((u) => [u.email.toLowerCase(), u.id]));
      added = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.subscriber.createMany({
          data: toAdd.map(({ line: _line, ...c }) => ({ ...c, userId: accounts.get(c.email) ?? null })),
          skipDuplicates: true,
        });
        await this.audit.log({
          actorId: user.id, actorRole: user.role, action: 'SUBSCRIBERS_IMPORTED', entity: 'Subscriber',
          metadata: { rows: parsed.records.length, added: count, alreadyListed: existing, unsubscribed, invalid: problems.length - unsubscribed },
        }, tx);
        return count;
      }, { timeout: 60_000 });
    }
    problems.sort((a, b) => a.line - b.line);
    return {
      dryRun: !!q.dryRun,
      rows: parsed.records.length,
      ...(q.dryRun ? { wouldAdd: toAdd.length } : { added }),
      alreadyListed: existing,
      unsubscribed,
      invalid: problems.length - unsubscribed,
      problems: problems.slice(0, 500),
      problemsTruncated: problems.length > 500,
    };
  }
}
