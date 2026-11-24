/**
 * "Never send a dead link" (Resend Free plan, docs/EMAIL.md §10). An account e-mail with a one-time link may wait in the
 * queue for budget; just before it is sent — and in the worker's periodic sweep — its link is checked. When the link
 * is provably dead the e-mail is DISCARDED (never sent; body and html, which hold the link, are cleared) with a plain
 * reason. Nothing that cannot be proved dead is discarded.
 *
 * Rows queued before kinds existed are classified first (classifyRow): kind from the subject, link expiry from
 * createdAt + the template's lifetime, and the token the e-mail carries matched by account and time (the token is
 * created just before its e-mail is queued).
 */
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LINK_KINDS, LINK_TTL_MS, classifyLegacy, priorityOf, type EmailKind } from './email-kinds.js';

type Db = Prisma.TransactionClient | PrismaService;

export const DiscardReasons = {
  resetExpired:   'Not sent: the password-reset link expired before it could be sent (daily e-mail limit). The person can request a new link.',
  resetReplaced:  'Not sent: a newer password-reset link was requested, so this one no longer works. Only the newest link is sent.',
  resetUsed:      'Not sent: the password-reset link was already used.',
  activated:      'Not sent: the account is already activated (for example by an administrator), so the link is no longer needed.',
  linkExpired:    'Not sent: the activation link expired before it could be sent (daily e-mail limit). The person can use "Forgot password" to get a new link, or an administrator can send a new invitation.',
  linkReplaced:   'Not sent: a newer activation link was sent, so this one no longer works.',
  linkUsed:       'Not sent: the activation link was already used.',
  accountGone:    'Not sent: the account no longer exists.',
} as const;

/** How long a matched token may predate its e-mail row (the token is written just before the e-mail is queued). */
const MATCH_WINDOW_MS = 60_000;

export interface LinkRow {
  id:            string;
  kind:          string | null;
  recipientId:   string | null;
  linkExpiresAt: Date | null;
  linkTokenId:   string | null;
  createdAt:     Date;
}

export const isLinkKind = (kind: string | null | undefined) => !!kind && (LINK_KINDS as readonly string[]).includes(kind);

/** The token an older e-mail carries: the newest one of the account created within a minute before the row. */
async function matchToken(db: Db, kind: EmailKind, userId: string, createdAt: Date): Promise<string | null> {
  const window = { gte: new Date(createdAt.getTime() - MATCH_WINDOW_MS), lte: new Date(createdAt.getTime() + 5_000) };
  if (kind === 'PASSWORD_RESET') {
    const t = await db.passwordResetToken.findFirst({ where: { userId, createdAt: window }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return t?.id ?? null;
  }
  const t = await db.accountActivationToken.findFirst({
    where: { userId, purpose: kind === 'INVITATION' ? 'INVITATION' : 'EMAIL_VERIFICATION', createdAt: window },
    orderBy: { createdAt: 'desc' }, select: { id: true },
  });
  return t?.id ?? null;
}

/** Classify the PENDING rows queued before kinds existed (priority NULL). Returns how many were classified. */
export async function classifyLegacyRows(db: Db, limit = 500): Promise<number> {
  const rows = await db.emailDelivery.findMany({
    where:  { status: 'PENDING', priority: null },
    select: { id: true, subject: true, jobId: true, subscriberId: true, recipientId: true, createdAt: true },
    orderBy: { createdAt: 'asc' }, take: limit,
  });
  for (const r of rows) {
    const kind = classifyLegacy(r);
    const ttl = LINK_TTL_MS[kind];
    const linkTokenId = ttl && r.recipientId ? await matchToken(db, kind, r.recipientId, r.createdAt) : null;
    await db.emailDelivery.updateMany({
      where: { id: r.id, priority: null },
      data:  {
        kind, priority: priorityOf(kind),
        ...(ttl && { linkExpiresAt: new Date(r.createdAt.getTime() + ttl) }),
        ...(linkTokenId && { linkTokenId }),
      },
    });
  }
  return rows.length;
}

/** Why this e-mail's link is dead, or null when it may still work (or cannot be proved dead). */
export async function deadLinkReason(db: Db, row: LinkRow, now = new Date()): Promise<string | null> {
  if (!isLinkKind(row.kind)) return null;
  const kind = row.kind as EmailKind;
  const expiry = row.linkExpiresAt ?? new Date(row.createdAt.getTime() + (LINK_TTL_MS[kind] ?? Infinity));

  if (kind === 'PASSWORD_RESET') {
    if (row.linkTokenId) {
      const token = await db.passwordResetToken.findUnique({ where: { id: row.linkTokenId }, select: { userId: true, usedAt: true, expiresAt: true, createdAt: true } });
      if (!token) return DiscardReasons.accountGone;
      if (token.usedAt) {
        // A newer request retires the older links by marking them used (AuthService.sendPasswordResetLink).
        const newer = await db.passwordResetToken.count({ where: { userId: token.userId, createdAt: { gt: token.createdAt } } });
        return newer > 0 ? DiscardReasons.resetReplaced : DiscardReasons.resetUsed;
      }
      if (token.expiresAt <= now) return DiscardReasons.resetExpired;
      return null;
    }
    if (expiry <= now) return DiscardReasons.resetExpired;
    if (row.recipientId) {
      const newer = await db.emailDelivery.count({ where: { recipientId: row.recipientId, kind: 'PASSWORD_RESET', createdAt: { gt: row.createdAt }, id: { not: row.id } } });
      if (newer > 0) return DiscardReasons.resetReplaced;
    }
    return null;
  }

  // INVITATION / EMAIL_VERIFICATION
  if (row.recipientId) {
    const user = await db.user.findUnique({ where: { id: row.recipientId }, select: { activatedAt: true } });
    if (!user) return DiscardReasons.accountGone;
    if (user.activatedAt) return DiscardReasons.activated;
  }
  if (row.linkTokenId) {
    const token = await db.accountActivationToken.findUnique({ where: { id: row.linkTokenId }, select: { usedAt: true, revokedAt: true, expiresAt: true } });
    if (!token) return DiscardReasons.accountGone;
    if (token.usedAt) return DiscardReasons.linkUsed;
    if (token.revokedAt) return DiscardReasons.linkReplaced;
    if (token.expiresAt <= now) return DiscardReasons.linkExpired;
    return null;
  }
  return expiry <= now ? DiscardReasons.linkExpired : null;
}

/** Mark a PENDING row DISCARDED (never sent) and clear the text that holds its link. */
export async function discardDelivery(db: Db, id: string, reason: string, now = new Date()): Promise<boolean> {
  const { count } = await db.emailDelivery.updateMany({
    where: { id, status: 'PENDING' },
    data:  { status: 'DISCARDED', errorMessage: reason, body: null, html: null, lockedAt: null, attemptedAt: now },
  });
  return count > 0;
}

/**
 * The 30 minutes of a password-reset link count from when its e-mail is sent, not from the request: just before sending,
 * the token's expiry is moved to now + 30 minutes (only ever later, and only while it is unused and unexpired — the
 * e-mail itself was never sent with a different token). Returns false when the token can no longer be used.
 */
export async function refreshResetLink(db: Db, row: LinkRow, ttlMs: number, now = new Date()): Promise<boolean> {
  if (row.kind !== 'PASSWORD_RESET' || !row.linkTokenId) return true;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const { count } = await db.passwordResetToken.updateMany({
    where: { id: row.linkTokenId, usedAt: null, expiresAt: { gt: now, lt: expiresAt } },
    data:  { expiresAt },
  });
  if (count > 0) {
    await db.emailDelivery.update({ where: { id: row.id }, data: { linkExpiresAt: expiresAt } });
    return true;
  }
  // Nothing changed: either it is already valid that long (fine) or it is used / expired (dead).
  return (await db.passwordResetToken.count({ where: { id: row.linkTokenId, usedAt: null, expiresAt: { gt: now } } })) > 0;
}
