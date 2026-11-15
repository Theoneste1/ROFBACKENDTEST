import { resolveSchoolReference } from './school-reference.js';

const A = { id: 'a', code: '220999', name: 'Lycée de Kigali', isActive: true };
const B = { id: 'b', code: '110101', name: 'Other School', isActive: true };
const OFF = { id: 'off', code: '330001', name: 'Closed School', isActive: false };
const ALL = [A, B, OFF];

/** A fake school reader; findFirst only matches Rwandan schools by code, as the real query does. */
function db() {
  return {
    school: {
      findUnique: vi.fn(async ({ where }: any) => ALL.find((s) => s.id === where.id) ?? null),
      findFirst:  vi.fn(async ({ where }: any) => (where.countryCode === 'RW' ? ALL.find((s) => s.code === where.code) ?? null : null)),
    },
  };
}
const resolve = (ref: object, requireActive = true) => resolveSchoolReference(db() as any, ref, { requireActive });

describe('resolveSchoolReference (PR B: invitations, CSV import, Administrator create / edit)', () => {
  it('nothing given → no school', async () => {
    expect(await resolve({})).toBeNull();
    expect(await resolve({ schoolName: '   ' })).toBeNull();
  });

  it('a name alone is refused — never matched, never created', async () => {
    await expect(resolve({ schoolName: 'Lycée de Kigali' })).rejects.toMatchObject({ code: 'SCHOOL_REFERENCE_REQUIRED' });
  });

  it('by id, by code, or both naming the same school', async () => {
    expect(await resolve({ schoolId: 'a' })).toEqual(A);
    expect(await resolve({ schoolCode: '220999' })).toEqual(A);
    expect(await resolve({ schoolId: 'a', schoolCode: '220999' })).toEqual(A);
  });

  it('unknown id 404, unknown code 400, id and code naming different schools 400', async () => {
    await expect(resolve({ schoolId: 'nope' })).rejects.toMatchObject({ status: 404 });
    await expect(resolve({ schoolCode: '999999' })).rejects.toMatchObject({ code: 'UNKNOWN_SCHOOL_CODE' });
    await expect(resolve({ schoolId: 'a', schoolCode: '110101' })).rejects.toMatchObject({ code: 'SCHOOL_REFERENCE_MISMATCH' });
  });

  it('a name with a code must be that school (normalised: case, accents, punctuation, spacing); otherwise refused, naming the real school', async () => {
    expect(await resolve({ schoolCode: '220999', schoolName: 'LYCEE DE  KIGALI.' })).toEqual(A);
    const err = await resolve({ schoolCode: '220999', schoolName: 'Lycée de Huye' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SCHOOL_NAME_MISMATCH' });
    expect(err.message).toContain('Lycée de Kigali');
    await expect(resolve({ schoolId: 'b', schoolName: 'Lycée de Kigali' })).rejects.toMatchObject({ code: 'SCHOOL_NAME_MISMATCH' });
  });

  it('an inactive school is refused when a new use needs it, and found otherwise', async () => {
    await expect(resolve({ schoolCode: '330001' })).rejects.toMatchObject({ code: 'SCHOOL_INACTIVE', status: 409 });
    expect(await resolve({ schoolCode: '330001' }, false)).toEqual(OFF);
  });
});
