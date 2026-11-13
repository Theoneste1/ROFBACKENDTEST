import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { SESSION_LOCK_NAMESPACE, TokenService, hashToken } from './token.service.js';

/**
 * TokenService against a small in-memory stand-in for Prisma. Every call yields
 * to the event loop, so concurrent operations interleave the way separate
 * database requests can. `pg_advisory_xact_lock` is modelled as a per-key mutex
 * held until the transaction callback finishes (switchable off, to prove that
 * the race tests detect the bug the lock prevents).
 */
interface Row {
  id: string; userId: string; familyId: string; tokenHash: string;
  rotatedAt: Date | null; revokedAt: Date | null; expiresAt: Date;
}
interface UserRow { id: string; isActive: boolean; isApproved: boolean; tokensValidAfter: Date | null }

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeDb({ useLocks = true } = {}) {
  const tokens = new Map<string, Row>();
  const users = new Map<string, UserRow>();
  const locks = new Map<string, Promise<void>>();
  const events: string[] = [];
  /** Hold the next refreshToken.create until released (deterministic interleaving). */
  let createGate: { reached: () => void; wait: Promise<void> } | null = null;
  const holdNextCreate = () => {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    createGate = { reached, wait: new Promise<void>((r) => { release = r; }) };
    return { reached: reachedP, release };
  };

  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);

  const client = (held: Array<() => void>) => ({
    $queryRaw: async (_s: TemplateStringsArray, ns: number, key: string) => {
      events.push(`lock:${ns}:${key}`);
      if (!useLocks) return [];
      const name = `${ns}:${key}`;
      while (locks.has(name)) await locks.get(name);
      let release!: () => void;
      locks.set(name, new Promise<void>((r) => { release = r; }));
      held.push(() => { locks.delete(name); release(); });
      return [];
    },
    refreshToken: {
      findUnique: async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
        await tick();
        events.push('token:read');
        const row = [...tokens.values()].find((t) => (where.id ? t.id === where.id : t.tokenHash === where.tokenHash));
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        await tick();
        let count = 0;
        for (const row of tokens.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
        events.push(`token:update(${count})`);
        return { count };
      },
      create: async ({ data }: { data: Omit<Row, 'id' | 'rotatedAt' | 'revokedAt'> }) => {
        const gate = createGate;
        if (gate) { createGate = null; gate.reached(); await gate.wait; }
        await tick();
        const row: Row = { id: randomUUID(), rotatedAt: null, revokedAt: null, ...data };
        tokens.set(row.id, row);
        events.push('token:create');
        return row;
      },
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => { await tick(); return users.get(where.id) ?? null; },
      update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        await tick();
        Object.assign(users.get(where.id)!, data);
        events.push('user:update');
        return users.get(where.id);
      },
    },
  });

  const prisma = {
    ...client([]),
    $transaction: async <T>(fn: (tx: ReturnType<typeof client>) => Promise<T>): Promise<T> => {
      const held: Array<() => void> = [];
      try {
        return await fn(client(held));
      } finally {
        held.forEach((release) => release());
      }
    },
  };
  return { prisma, tokens, users, events, holdNextCreate };
}

const SECRET = 'test-secret-test-secret-test-secret';
const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } });
const config = { get: () => undefined };
const CLIENT = { userAgent: 'vitest', ip: '127.0.0.1' };

function setup(opts?: { useLocks?: boolean }) {
  const db = makeDb(opts);
  db.users.set('u1', { id: 'u1', isActive: true, isApproved: true, tokensValidAfter: null });
  const service = new TokenService(jwt, db.prisma as never, config as never);
  return { ...db, service };
}

const liveTokens = (tokens: Map<string, Row>, userId = 'u1') =>
  [...tokens.values()].filter((t) => t.userId === userId && !t.revokedAt && !t.rotatedAt);

describe('TokenService', () => {
  describe('rotate', () => {
    it('takes the user session lock before reading the token, and writes the new token in the same transaction', async () => {
      const { service, events } = setup();
      const first = await service.issue('u1', CLIENT);
      events.length = 0;
      const { tokens } = await service.rotate(first.refresh_token, CLIENT);
      expect(tokens.refresh_token).not.toBe(first.refresh_token);
      expect(events[0]).toBe('token:read');                          // find the owner
      expect(events[1]).toBe(`lock:${SESSION_LOCK_NAMESPACE}:u1`);   // then lock that user
      expect(events.slice(2)).toEqual(['token:read', 'token:update(1)', 'token:create']);
    });

    it('a rotated (reused) refresh token revokes the whole family and the revocation is kept', async () => {
      const { service, tokens } = setup();
      const first = await service.issue('u1', CLIENT);
      const second = (await service.rotate(first.refresh_token, CLIENT)).tokens;
      await expect(service.rotate(first.refresh_token, CLIENT)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
      expect(liveTokens(tokens)).toEqual([]);
      await expect(service.rotate(second.refresh_token, CLIENT)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
    });

    it('unknown, expired and inactive-user tokens are refused', async () => {
      const { service, tokens, users } = setup();
      await expect(service.rotate('not-a-token', CLIENT)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });

      const a = await service.issue('u1', CLIENT);
      [...tokens.values()].find((t) => t.tokenHash === hashToken(a.refresh_token))!.expiresAt = new Date(Date.now() - 1000);
      await expect(service.rotate(a.refresh_token, CLIENT)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });

      const b = await service.issue('u1', CLIENT);
      users.get('u1')!.isActive = false;
      await expect(service.rotate(b.refresh_token, CLIENT)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
      expect(liveTokens(tokens).filter((t) => t.tokenHash === hashToken(b.refresh_token))).toEqual([]);
    });
  });

  describe('revoke (logout)', () => {
    it('ends the session of any token of the family, also a stale (already rotated) one, and reports the owner', async () => {
      const { service, tokens } = setup();
      const first = await service.issue('u1', CLIENT);
      await service.rotate(first.refresh_token, CLIENT);
      expect(liveTokens(tokens)).toHaveLength(1);
      await expect(service.revoke(first.refresh_token)).resolves.toEqual({ userId: 'u1' });
      expect(liveTokens(tokens)).toEqual([]);
    });

    it('leaves the user\'s other sessions alone', async () => {
      const { service, tokens } = setup();
      const here = await service.issue('u1', CLIENT);
      await service.issue('u1', CLIENT);
      await service.revoke(here.refresh_token);
      expect(liveTokens(tokens)).toHaveLength(1);
    });

    it('an unknown token changes nothing and returns null', async () => {
      const { service, events } = setup();
      await expect(service.revoke('unknown-token')).resolves.toBeNull();
      expect(events.some((e) => e.startsWith('lock:'))).toBe(false);
    });
  });

  describe('races (H1 review): a refresh in progress cannot survive a logout or "end every session"', () => {
    /**
     * The worst interleaving: the refresh has passed its checks and marked the old
     * token rotated, and is about to write the new token, when the other request
     * runs. `other` gets 50 ms; with the lock it is blocked until the refresh
     * commits, without it it completes before the new token exists.
     */
    const interleave = async (db: ReturnType<typeof setup>, rotateWith: string, other: () => Promise<unknown>) => {
      const gate = db.holdNextCreate();
      const rotating = db.service.rotate(rotateWith, CLIENT);
      await gate.reached;
      const running = other();
      await new Promise((r) => setTimeout(r, 50));
      gate.release();
      return Promise.allSettled([rotating, running]);
    };

    const raceLogout = async (useLocks: boolean) => {
      const db = setup({ useLocks });
      const first = await db.service.issue('u1', CLIENT);
      // Another tab refreshes while this tab signs out, both with the same cookie.
      await interleave(db, first.refresh_token, () => db.service.revoke(first.refresh_token));
      return liveTokens(db.tokens);
    };

    it('logout racing a refresh: no token of the session is left valid', async () => {
      expect(await raceLogout(true)).toEqual([]);
    });

    it('control: without the lock the same interleaving leaves the new token alive (the bug the lock prevents)', async () => {
      expect(await raceLogout(false)).toHaveLength(1);
    });

    const raceRevokeAll = async (useLocks: boolean) => {
      const db = setup({ useLocks });
      const first = await db.service.issue('u1', CLIENT);
      const [rotated] = await interleave(db, first.refresh_token, () => db.service.revokeAllForUser('u1'));
      const accessIat = rotated.status === 'fulfilled'
        ? (jwt.decode((rotated.value as { tokens: { access_token: string } }).tokens.access_token) as { iatMs: number }).iatMs
        : null;
      return { live: liveTokens(db.tokens), accessIat, validAfter: db.users.get('u1')!.tokensValidAfter!.getTime() };
    };

    it('"end every session" racing a refresh: the new refresh token is revoked and the new access token is older than the cut-off', async () => {
      const { live, accessIat, validAfter } = await raceRevokeAll(true);
      expect(live).toEqual([]);
      if (accessIat !== null) expect(accessIat).toBeLessThanOrEqual(validAfter);   // JwtStrategy refuses iatMs <= tokensValidAfter
    });

    it('control: without the lock a refresh token survives "end every session"', async () => {
      expect((await raceRevokeAll(false)).live).toHaveLength(1);
    });
  });

  describe('revokeAllForUser', () => {
    it('takes the lock first and only then picks the cut-off time; uses the caller\'s transaction when given', async () => {
      const { service, prisma, events, users } = setup();
      await service.issue('u1', CLIENT);
      events.length = 0;
      let lockedAt = 0;
      const tx = {
        ...prisma,
        $queryRaw: async (...args: Parameters<typeof prisma.$queryRaw>) => {
          await new Promise((r) => setTimeout(r, 25));   // the lock is busy for a while
          lockedAt = Date.now();
          return prisma.$queryRaw(...args);
        },
        $transaction: () => { throw new Error('must use the given transaction'); },
      };
      await service.revokeAllForUser('u1', tx as never);
      expect(users.get('u1')!.tokensValidAfter!.getTime()).toBeGreaterThanOrEqual(lockedAt);
      expect(events).toEqual([`lock:${SESSION_LOCK_NAMESPACE}:u1`, 'token:update(1)', 'user:update']);
      expect(Date.now()).toBeGreaterThan(users.get('u1')!.tokensValidAfter!.getTime());
    });
  });

  describe('verifyAccessToken', () => {
    it('returns the claims of a valid token and null for an expired, forged or malformed one', async () => {
      const { service } = setup();
      const valid = await jwt.signAsync({ sub: 'u1', jti: 'j1' }, { expiresIn: 60 });
      await expect(service.verifyAccessToken(valid)).resolves.toMatchObject({ sub: 'u1', jti: 'j1' });

      const expired = await jwt.signAsync({ sub: 'u1', jti: 'j2', exp: Math.floor(Date.now() / 1000) - 10 });
      await expect(service.verifyAccessToken(expired)).resolves.toBeNull();

      const forged = await new JwtService({ secret: 'another-secret-another-secret' }).signAsync({ sub: 'u1' });
      await expect(service.verifyAccessToken(forged)).resolves.toBeNull();

      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"u1"}').toString('base64url')}.`;
      await expect(service.verifyAccessToken(none)).resolves.toBeNull();
      await expect(service.verifyAccessToken('garbage')).resolves.toBeNull();
    });
  });
});
