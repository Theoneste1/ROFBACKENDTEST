import { JwtService } from '@nestjs/jwt';
import { TokenService, hashToken } from './token.service.js';

const SECRET = 'unit-test-secret-that-is-long-enough-0123456789';

/**
 * An in-memory stand-in for the refreshToken table, enough to show which rows
 * a logout revokes (updateMany with `{ familyId, revokedAt: null }`).
 */
function makeService() {
  type Row = { id: string; userId: string; familyId: string; tokenHash: string; rotatedAt: Date | null; revokedAt: Date | null };
  const rows: Row[] = [];
  const prisma = {
    refreshToken: {
      findUnique: vi.fn(async ({ where, select }: { where: { tokenHash: string }; select?: Record<string, boolean> }) => {
        const row = rows.find((r) => r.tokenHash === where.tokenHash);
        if (!row) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k as keyof Row]])) : row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { familyId: string; revokedAt: null }; data: { revokedAt: Date } }) => {
        const hit = rows.filter((r) => r.familyId === where.familyId && r.revokedAt === null);
        hit.forEach((r) => { r.revokedAt = data.revokedAt; });
        return { count: hit.length };
      }),
    },
  };
  const config = { get: vi.fn().mockReturnValue(undefined) };
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } });
  const service = new TokenService(jwt, prisma as never, config as never);
  const add = (raw: string, userId: string, familyId: string, state: Partial<Row> = {}) =>
    rows.push({ id: raw, userId, familyId, tokenHash: hashToken(raw), rotatedAt: null, revokedAt: null, ...state });
  return { service, prisma, rows, add, jwt };
}

describe('TokenService.revoke (logout by refresh token, H1)', () => {
  it('revokes the whole family of the current token and returns its owner', async () => {
    const { service, rows, add } = makeService();
    add('current', 'u1', 'fam-1');
    add('other-device', 'u1', 'fam-2');
    await expect(service.revoke('current')).resolves.toEqual({ userId: 'u1' });
    expect(rows.find((r) => r.id === 'current')!.revokedAt).toBeInstanceOf(Date);
    // Only that session ends: the other device keeps its session.
    expect(rows.find((r) => r.id === 'other-device')!.revokedAt).toBeNull();
  });

  it('a stale (already rotated) token still ends its session, including the newer token', async () => {
    const { service, rows, add } = makeService();
    add('old', 'u1', 'fam-1', { rotatedAt: new Date(Date.now() - 1000) });
    add('new', 'u1', 'fam-1');
    await expect(service.revoke('old')).resolves.toEqual({ userId: 'u1' });
    expect(rows.every((r) => r.revokedAt instanceof Date)).toBe(true);
  });

  it('an unknown token revokes nothing and returns null', async () => {
    const { service, prisma, rows, add } = makeService();
    add('known', 'u1', 'fam-1');
    await expect(service.revoke('unknown')).resolves.toBeNull();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(rows[0].revokedAt).toBeNull();
  });

  it('looks the token up by its SHA-256 hash, never by the raw value', async () => {
    const { service, prisma } = makeService();
    await service.revoke('raw-token');
    expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: hashToken('raw-token') } }));
  });
});

describe('TokenService.verifyAccessToken', () => {
  it('returns the claims of a valid access token', async () => {
    const { service, jwt } = makeService();
    const token = await jwt.signAsync({ sub: 'u1', jti: 'j1' }, { expiresIn: 60 });
    await expect(service.verifyAccessToken(token)).resolves.toMatchObject({ sub: 'u1', jti: 'j1', exp: expect.any(Number) });
  });

  it('returns null for an expired token', async () => {
    const { service, jwt } = makeService();
    const token = await jwt.signAsync({ sub: 'u1', jti: 'j1', exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(service.verifyAccessToken(token)).resolves.toBeNull();
  });

  it('returns null for a token signed with another secret, for garbage, and for alg "none"', async () => {
    const { service } = makeService();
    const forged = await new JwtService({ secret: 'another-secret-another-secret-another-secret' }).signAsync({ sub: 'u1', jti: 'j1' });
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', jti: 'j1' })}.`;
    await expect(service.verifyAccessToken(forged)).resolves.toBeNull();
    await expect(service.verifyAccessToken('not.a.jwt')).resolves.toBeNull();
    await expect(service.verifyAccessToken(none)).resolves.toBeNull();
  });

  it('returns null for a valid signature without a subject', async () => {
    const { service, jwt } = makeService();
    const token = await jwt.signAsync({ jti: 'j1' }, { expiresIn: 60 });
    await expect(service.verifyAccessToken(token)).resolves.toBeNull();
  });
});
