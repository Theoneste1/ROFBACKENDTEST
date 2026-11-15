import { UnauthorizedException } from '@nestjs/common';

import { JwtStrategy, issuedBeforeRevocation } from './jwt.strategy.js';

describe('issuedBeforeRevocation (session revocation)', () => {
  const revokedAt = new Date('2026-11-09T12:00:00.500Z');
  const ms = revokedAt.getTime();
  const sec = Math.floor(ms / 1000);

  it('refuses a token issued before, or in the same millisecond as, the revocation', () => {
    expect(issuedBeforeRevocation({ iatMs: ms - 1, iat: sec }, revokedAt)).toBe(true);
    expect(issuedBeforeRevocation({ iatMs: ms, iat: sec }, revokedAt)).toBe(true);
  });

  it('refuses a token issued earlier in the SAME SECOND as the revocation (the whole-second gap)', () => {
    expect(issuedBeforeRevocation({ iatMs: ms - 400, iat: sec }, revokedAt)).toBe(true);
  });

  it('accepts a token issued after the revocation, even within the same second', () => {
    expect(issuedBeforeRevocation({ iatMs: ms + 1, iat: sec }, revokedAt)).toBe(false);
    expect(issuedBeforeRevocation({ iatMs: ms + 2000, iat: sec + 2 }, revokedAt)).toBe(false);
  });

  it('a token without iatMs (issued before this check) is refused in or before the revocation second', () => {
    expect(issuedBeforeRevocation({ iat: sec - 1 }, revokedAt)).toBe(true);
    expect(issuedBeforeRevocation({ iat: sec }, revokedAt)).toBe(true);
    expect(issuedBeforeRevocation({ iat: sec + 1 }, revokedAt)).toBe(false);
  });

  it('a token with no usable issue time is refused (fails closed)', () => {
    expect(issuedBeforeRevocation({}, revokedAt)).toBe(true);
    expect(issuedBeforeRevocation({ iatMs: Number.NaN }, revokedAt)).toBe(true);
    expect(issuedBeforeRevocation({ iatMs: 'x' as never }, revokedAt)).toBe(true);
  });
});

describe('JwtStrategy.validate — revoked sessions', () => {
  const revokedAt = new Date('2026-11-09T12:00:00.500Z');
  const user = {
    id: 'u1', username: 'coach', role: 'ADMIN', isActive: true, isApproved: true, activatedAt: new Date(),
    divisionId: null, gradeLevel: null, tokensValidAfter: revokedAt,
  };
  const prisma = {
    tokenBlacklist: { findUnique: async () => null },
    user:           { findUnique: async () => user },
  };
  const strategy = new JwtStrategy({ getOrThrow: () => 'x'.repeat(40) } as never, prisma as never);

  it('rejects (401) a same-second token issued before the role change', async () => {
    await expect(strategy.validate({ sub: 'u1', jti: 'j', iat: Math.floor(revokedAt.getTime() / 1000), iatMs: revokedAt.getTime() - 100 }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a token issued after it', async () => {
    await expect(strategy.validate({ sub: 'u1', jti: 'j', iat: Math.floor(revokedAt.getTime() / 1000), iatMs: revokedAt.getTime() + 1 }))
      .resolves.toMatchObject({ id: 'u1', role: 'ADMIN' });
  });
});
