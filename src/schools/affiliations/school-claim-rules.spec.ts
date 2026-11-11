import {
  classifyClaimRequest, CLAIM_COOLDOWN_MS, CLAIM_WINDOW_MS, cooldownUntil, limitRetryAfter, sameSchool, type ClaimIdentity,
} from './school-claim-rules.js';

const PLACE = { schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Ngoma' };
const code = (b: object) => { try { classifyClaimRequest(b); return null; } catch (e: any) { return e.code ?? e.message; } };

describe('school claim rules (PR C)', () => {
  describe('classifyClaimRequest — exactly one kind, checked in order', () => {
    it('1. schoolCode: a code request; another country → SCHOOL_CODE_RWANDA_ONLY first; any name / place field too → VALIDATION_FAILED', () => {
      expect(classifyClaimRequest({ schoolCode: '220001' })).toEqual({ kind: 'CODE', schoolCode: '220001' });
      expect(classifyClaimRequest({ schoolCode: '220001', country: 'RW' })).toEqual({ kind: 'CODE', schoolCode: '220001' });
      expect(code({ schoolCode: '220001', country: 'KE' })).toBe('SCHOOL_CODE_RWANDA_ONLY');
      expect(code({ schoolCode: '220001', country: 'KE', schoolName: 'X' })).toBe('SCHOOL_CODE_RWANDA_ONLY');   // the specific mistake wins
      expect(code({ schoolCode: '220001', schoolName: 'X' })).toBe('VALIDATION_FAILED');
      expect(code({ schoolCode: '220001', schoolSector: 'Ngoma' })).toBe('VALIDATION_FAILED');
    });

    it('2. Rwanda without a code: "not listed" needs the name and all three place fields', () => {
      expect(classifyClaimRequest({ schoolName: 'Lycée X', ...PLACE })).toEqual({
        kind: 'NOT_LISTED', schoolName: 'Lycée X', province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
      });
      expect(classifyClaimRequest({ schoolName: 'Lycée X', country: 'RW', ...PLACE }).kind).toBe('NOT_LISTED');
      expect(code({ schoolName: 'Lycée X' })).toBe('VALIDATION_FAILED');   // no legacy name-only path here
      expect(code({ schoolName: 'Lycée X', schoolProvince: 'Southern Province', schoolDistrict: 'Huye' })).toBe('VALIDATION_FAILED');
      expect(code({ ...PLACE })).toBe('VALIDATION_FAILED');
      expect(code({})).toBe('VALIDATION_FAILED');
    });

    it('3. another country: the name only; a Rwandan place field → SCHOOL_DIRECTORY_RWANDA_ONLY', () => {
      expect(classifyClaimRequest({ country: 'KE', schoolName: 'Nairobi School' })).toEqual({ kind: 'INTERNATIONAL', schoolName: 'Nairobi School', country: 'KE' });
      expect(code({ country: 'KE', schoolName: 'Nairobi School', schoolDistrict: 'Huye' })).toBe('SCHOOL_DIRECTORY_RWANDA_ONLY');
      expect(code({ country: 'KE' })).toBe('VALIDATION_FAILED');
    });
  });

  describe('sameSchool', () => {
    const id = (o: Partial<ClaimIdentity>): ClaimIdentity => ({ schoolId: null, name: null, country: null, province: null, district: null, sector: null, ...o });
    it('linked claims: the same school id (names do not matter)', () => {
      expect(sameSchool(id({ schoolId: 'a' }), id({ schoolId: 'a', name: 'Other' }))).toBe(true);
      expect(sameSchool(id({ schoolId: 'a', name: 'X' }), id({ schoolId: 'b', name: 'X' }))).toBe(false);
    });
    it('name-only: same normalised name and country; each place field compared where BOTH have it', () => {
      const a = id({ name: 'Lycée de Huye', country: 'RW', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' });
      expect(sameSchool(a, id({ name: 'LYCEE DE HUYE!', country: 'RW', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }))).toBe(true);
      expect(sameSchool(a, id({ name: 'Lycée de Huye' }))).toBe(true);                                   // missing country = RW; no place: ignored
      expect(sameSchool(a, id({ name: 'Lycée de Huye', country: 'RW', sector: 'Ngoma' }))).toBe(true);    // only the sector to compare
      expect(sameSchool(a, id({ name: 'Lycée de Huye', country: 'RW', sector: 'Tumba' }))).toBe(false);   // a different sector
      expect(sameSchool(a, id({ name: 'Lycée de Huye', country: 'RW', province: 'Kigali City' }))).toBe(false);
      expect(sameSchool(a, id({ name: 'Lycée de Huye', country: 'KE' }))).toBe(false);
      expect(sameSchool(a, id({ name: 'Lycée de Butare', country: 'RW' }))).toBe(false);
    });
    it('a "not listed" claim later linked to a school still matches the name-only claim it came from', () => {
      const linked = id({ schoolId: 's', name: 'Lycée de Huye', country: 'RW', sector: 'Ngoma' });
      expect(sameSchool(linked, id({ name: 'lycee de huye', country: 'RW', sector: 'Ngoma' }))).toBe(true);
      expect(sameSchool(linked, id({ schoolId: 't' }))).toBe(false);
      expect(sameSchool(id({ schoolId: 's' }), id({ name: 'Lycée de Huye' }))).toBe(false);   // nothing to compare
    });
  });

  describe('limit: 3 student requests in any rolling 24 hours', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    it('allowed below 3; the 4th waits until the oldest of the last 3 is 24 hours old', () => {
      expect(limitRetryAfter([], now)).toBeNull();
      expect(limitRetryAfter([ago(1000), ago(2000)], now)).toBeNull();
      const three = [ago(3 * 3600_000), ago(1000), ago(2 * 3600_000)];
      expect(limitRetryAfter(three, now)).toEqual(new Date(ago(3 * 3600_000).getTime() + CLAIM_WINDOW_MS));
    });
    it('the window boundary: exactly 24 hours old no longer counts; 1 ms less still does', () => {
      expect(limitRetryAfter([ago(CLAIM_WINDOW_MS), ago(1000), ago(2000)], now)).toBeNull();
      expect(limitRetryAfter([ago(CLAIM_WINDOW_MS - 1), ago(1000), ago(2000)], now)).not.toBeNull();
    });
  });

  describe('cooldown: 7 days after the latest rejection / revocation of the same school', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    it('none without decisions; until the latest decision + 7 days; over at exactly 7 days', () => {
      expect(cooldownUntil([], now)).toBeNull();
      expect(cooldownUntil([ago(CLAIM_COOLDOWN_MS + 1000), ago(3600_000)], now)).toEqual(new Date(ago(3600_000).getTime() + CLAIM_COOLDOWN_MS));
      expect(cooldownUntil([ago(CLAIM_COOLDOWN_MS)], now)).toBeNull();
      expect(cooldownUntil([ago(CLAIM_COOLDOWN_MS - 1)], now)).not.toBeNull();
    });
  });
});
