import jwt from 'jsonwebtoken';
import { ipTracker, refreshTracker, userOrIpTracker } from './rate-limit.js';

const SECRET = 'unit-test-secret-that-is-long-enough-0123456789';
const tracker = userOrIpTracker(SECRET);
const bearer = (token: string) => ({ ip: '10.0.0.7', headers: { authorization: `Bearer ${token}` } });

describe('rate-limit trackers (school labs share one address)', () => {
  it('a valid access token counts against its user, whatever the address', () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET, { algorithm: 'HS256', expiresIn: 60 });
    expect(tracker(bearer(token))).toBe('user:user-1');
    expect(tracker({ ...bearer(token), ip: '10.0.0.8' })).toBe('user:user-1');
  });

  it('a forged, expired, wrongly signed or malformed token counts against the address (no fresh budget by inventing tokens)', () => {
    const forged = jwt.sign({ sub: 'user-1' }, 'another-secret-another-secret-0123', { algorithm: 'HS256' });
    const expired = jwt.sign({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { algorithm: 'HS256' });
    const none = jwt.sign({ sub: 'user-1' }, '', { algorithm: 'none' as jwt.Algorithm });
    const noSub = jwt.sign({ role: 'ADMIN' }, SECRET, { algorithm: 'HS256' });
    for (const token of [forged, expired, none, noSub, 'garbage', 'a'.repeat(5000)]) expect(tracker(bearer(token))).toBe('ip:10.0.0.7');
    expect(tracker({ ip: '10.0.0.7', headers: {} })).toBe('ip:10.0.0.7');
    expect(tracker({ ip: '10.0.0.7', headers: { authorization: 'Basic abc' } })).toBe('ip:10.0.0.7');
  });

  it('refresh: the presented refresh token (hashed, never the token itself), else the address', () => {
    const fromCookie = refreshTracker({ ip: '10.0.0.7', cookies: { rof_refresh: 'secret-refresh-token-value' } });
    const fromBody = refreshTracker({ ip: '10.0.0.7', body: { refreshToken: 'secret-refresh-token-value' } });
    expect(fromCookie).toMatch(/^rt:[0-9a-f]{64}$/);
    expect(fromBody).toBe(fromCookie);
    expect(fromCookie).not.toContain('secret-refresh-token-value');
    expect(refreshTracker({ ip: '10.0.0.7', cookies: { rof_refresh: 'another' } })).not.toBe(fromCookie);
    expect(refreshTracker({ ip: '10.0.0.7' })).toBe('ip:10.0.0.7');
    expect(refreshTracker({ ip: '10.0.0.7', body: { refreshToken: '' }, cookies: {} })).toBe('ip:10.0.0.7');
  });

  it('the ceiling counts per address', () => {
    expect(ipTracker({ ip: '10.0.0.7', headers: { authorization: 'Bearer x' } })).toBe('ip:10.0.0.7');
  });
});
