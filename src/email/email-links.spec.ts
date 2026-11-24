import { DiscardReasons, deadLinkReason, refreshResetLink, type LinkRow } from './email-links.js';

const MIN = 60_000;
const now = new Date('2026-11-24T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

function db(o: { reset?: any; newerResets?: number; activation?: any; user?: any; newerRows?: number } = {}) {
  return {
    passwordResetToken: {
      findUnique: vi.fn(async () => o.reset ?? null),
      count:      vi.fn(async ({ where }: any) => (where.createdAt ? o.newerResets ?? 0 : (o.reset && !o.reset.usedAt && o.reset.expiresAt > now ? 1 : 0))),
      updateMany: vi.fn(async () => ({ count: o.reset && !o.reset.usedAt && o.reset.expiresAt > now ? 1 : 0 })),
    },
    accountActivationToken: { findUnique: vi.fn(async () => o.activation ?? null) },
    user: { findUnique: vi.fn(async () => (o.user === undefined ? { activatedAt: null } : o.user)) },
    emailDelivery: { count: vi.fn(async () => o.newerRows ?? 0), update: vi.fn(async () => ({})) },
  };
}

const row = (r: Partial<LinkRow>): LinkRow => ({
  id: 'd1', kind: 'PASSWORD_RESET', recipientId: 'u1', linkExpiresAt: null, linkTokenId: null, createdAt: ago(5 * MIN), ...r,
});

describe('never send a dead link (Resend Free plan)', () => {
  describe('password reset', () => {
    it('expired before it could be sent → discarded with the plain reason', async () => {
      const token = { userId: 'u1', usedAt: null, expiresAt: ago(MIN), createdAt: ago(31 * MIN) };
      expect(await deadLinkReason(db({ reset: token }) as any, row({ linkTokenId: 't1' }), now)).toBe(DiscardReasons.resetExpired);
      expect(DiscardReasons.resetExpired).toBe('Not sent: the password-reset link expired before it could be sent (daily e-mail limit). The person can request a new link.');
    });

    it('replaced by a newer request → discarded; used → discarded; fresh → sent', async () => {
      const used = { userId: 'u1', usedAt: ago(MIN), expiresAt: new Date(now.getTime() + 20 * MIN), createdAt: ago(10 * MIN) };
      expect(await deadLinkReason(db({ reset: used, newerResets: 1 }) as any, row({ linkTokenId: 't1' }), now)).toBe(DiscardReasons.resetReplaced);
      expect(await deadLinkReason(db({ reset: used, newerResets: 0 }) as any, row({ linkTokenId: 't1' }), now)).toBe(DiscardReasons.resetUsed);
      const fresh = { userId: 'u1', usedAt: null, expiresAt: new Date(now.getTime() + 25 * MIN), createdAt: ago(5 * MIN) };
      expect(await deadLinkReason(db({ reset: fresh }) as any, row({ linkTokenId: 't1' }), now)).toBeNull();
    });

    it('a legacy row (no token, no expiry) expires 30 minutes after it was queued, or when a newer reset row exists', async () => {
      expect(await deadLinkReason(db() as any, row({ createdAt: ago(31 * MIN) }), now)).toBe(DiscardReasons.resetExpired);
      expect(await deadLinkReason(db() as any, row({ createdAt: ago(10 * MIN) }), now)).toBeNull();
      expect(await deadLinkReason(db({ newerRows: 1 }) as any, row({ createdAt: ago(10 * MIN) }), now)).toBe(DiscardReasons.resetReplaced);
    });

    it('the 30 minutes start when the e-mail is sent: the unused token is extended to now + 30 min, never shortened', async () => {
      const fresh = { userId: 'u1', usedAt: null, expiresAt: new Date(now.getTime() + 5 * MIN), createdAt: ago(25 * MIN) };
      const d = db({ reset: fresh });
      expect(await refreshResetLink(d as any, row({ linkTokenId: 't1' }), 30 * MIN, now)).toBe(true);
      expect(d.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', usedAt: null, expiresAt: { gt: now, lt: new Date(now.getTime() + 30 * MIN) } },
        data:  { expiresAt: new Date(now.getTime() + 30 * MIN) },
      });
      const dead = db({ reset: { ...fresh, usedAt: ago(MIN) } });
      expect(await refreshResetLink(dead as any, row({ linkTokenId: 't1' }), 30 * MIN, now)).toBe(false);
    });
  });

  describe('invitation and e-mail confirmation', () => {
    it('the account is already activated (e.g. by an administrator) → discarded', async () => {
      const r = row({ kind: 'EMAIL_VERIFICATION', createdAt: ago(60 * MIN) });
      expect(await deadLinkReason(db({ user: { activatedAt: ago(MIN) } }) as any, r, now)).toBe(DiscardReasons.activated);
    });

    it('the account no longer exists → discarded; revoked or used token → discarded; expired → discarded', async () => {
      const r = row({ kind: 'INVITATION', linkTokenId: 'a1' });
      expect(await deadLinkReason(db({ user: null }) as any, r, now)).toBe(DiscardReasons.accountGone);
      expect(await deadLinkReason(db({ activation: { usedAt: null, revokedAt: ago(MIN), expiresAt: new Date(now.getTime() + DAYS) } }) as any, r, now)).toBe(DiscardReasons.linkReplaced);
      expect(await deadLinkReason(db({ activation: { usedAt: ago(MIN), revokedAt: null, expiresAt: new Date(now.getTime() + DAYS) } }) as any, r, now)).toBe(DiscardReasons.linkUsed);
      expect(await deadLinkReason(db({ activation: { usedAt: null, revokedAt: null, expiresAt: ago(MIN) } }) as any, r, now)).toBe(DiscardReasons.linkExpired);
    });

    it('nothing that cannot be proved dead is discarded: a legacy confirmation within its 48 hours is kept', async () => {
      const r = row({ kind: 'EMAIL_VERIFICATION', createdAt: ago(47 * 60 * MIN) });
      expect(await deadLinkReason(db() as any, r, now)).toBeNull();
      expect(await deadLinkReason(db() as any, { ...r, createdAt: ago(49 * 60 * MIN) }, now)).toBe(DiscardReasons.linkExpired);
      // Other kinds are never checked.
      expect(await deadLinkReason(db({ user: null }) as any, row({ kind: 'WELCOME' }), now)).toBeNull();
    });
  });
});

const DAYS = 24 * 60 * MIN;
