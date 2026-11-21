import { issueRegistrationAvatarToken, REGISTRATION_AVATAR_TTL_MS, verifyRegistrationAvatarToken } from './registration-avatar-token.js';

const SECRET = 'test-secret-that-is-long-enough-0123456789';

describe('registration avatar token (REG-02)', () => {
  it('round trip for each kind', () => {
    for (const kind of ['STUDENT', 'TEACHER_APPLICATION', 'COACH_APPLICATION'] as const) {
      const t = issueRegistrationAvatarToken(SECRET, kind, 'id-1', 1_000);
      expect(verifyRegistrationAvatarToken(SECRET, t, 2_000)).toEqual({ kind, id: 'id-1' });
    }
  });
  it('expires after 30 minutes', () => {
    const t = issueRegistrationAvatarToken(SECRET, 'STUDENT', 'id-1', 0);
    expect(verifyRegistrationAvatarToken(SECRET, t, REGISTRATION_AVATAR_TTL_MS - 1)).not.toBeNull();
    expect(verifyRegistrationAvatarToken(SECRET, t, REGISTRATION_AVATAR_TTL_MS)).toBeNull();
  });
  it('refuses a wrong secret, a tampered body or signature, garbage', () => {
    const t = issueRegistrationAvatarToken(SECRET, 'STUDENT', 'id-1', 0);
    expect(verifyRegistrationAvatarToken('another-secret-that-is-long-enough-01234', t, 1)).toBeNull();
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ k: 'STUDENT', i: 'someone-else', e: 9e15 })).toString('base64url');
    expect(verifyRegistrationAvatarToken(SECRET, `${forged}.${sig}`, 1)).toBeNull();
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);   // always a different signature
    expect(verifyRegistrationAvatarToken(SECRET, `${body}.${flipped}`, 1)).toBeNull();
    for (const g of [undefined, '', 'a', 'a.b.c', 42, 'x'.repeat(700)]) expect(verifyRegistrationAvatarToken(SECRET, g, 1)).toBeNull();
  });
});
