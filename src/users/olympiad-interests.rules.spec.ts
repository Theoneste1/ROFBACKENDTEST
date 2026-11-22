import { plainToInstance, Transform } from 'class-transformer';
import { ArrayUnique, IsArray, IsEnum, IsOptional, validateSync, ValidateIf } from 'class-validator';

import { OlympiadSubject } from '../generated/prisma/client.js';
import { IsOtherInterest, NonEmptyUnlessOther, storedOtherInterest } from './olympiad-interests.rules.js';

/** The shape every interests request uses (as in the DTOs). */
class Interests {
  @IsOptional() @IsArray() @NonEmptyUnlessOther() @ArrayUnique() @IsEnum(OlympiadSubject, { each: true })
  olympiadInterests?: OlympiadSubject[];

  @ValidateIf((o: { olympiadInterestOther?: unknown }) => o.olympiadInterestOther !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOtherInterest()
  olympiadInterestOther?: string | null;
}

const errors = (body: object) =>
  validateSync(plainToInstance(Interests, body)).flatMap((e) => Object.values(e.constraints ?? {}));

describe('"Other" Olympiad interest rules', () => {
  it('subjects alone, other alone, or both are accepted', () => {
    expect(errors({ olympiadInterests: ['MATHEMATICS'] })).toEqual([]);
    expect(errors({ olympiadInterests: [], olympiadInterestOther: 'Chemistry' })).toEqual([]);
    expect(errors({ olympiadInterests: ['PHYSICS'], olympiadInterestOther: '  Biology ' })).toEqual([]);
    expect(errors({ olympiadInterestOther: 'Astronomy' })).toEqual([]);
  });

  it('no subject and no other: refused (nobody is left without an interest)', () => {
    expect(errors({ olympiadInterests: [] })[0]).toMatch(/at least one of MATHEMATICS, COMPUTING or PHYSICS, or give olympiadInterestOther/);
    expect(errors({ olympiadInterests: [], olympiadInterestOther: '   ' }).length).toBeGreaterThan(0);
  });

  it('other: 2–100 characters after trimming', () => {
    expect(errors({ olympiadInterestOther: 'C' })[0]).toMatch(/2–100 characters/);
    expect(errors({ olympiadInterestOther: 'x'.repeat(101) })[0]).toMatch(/2–100 characters/);
    expect(errors({ olympiadInterestOther: 'x'.repeat(100) })).toEqual([]);
    expect(errors({ olympiadInterestOther: 42 }).length).toBeGreaterThan(0);
  });

  it('null clears it, only beside at least one subject in the same request', () => {
    expect(errors({ olympiadInterests: ['COMPUTING'], olympiadInterestOther: null })).toEqual([]);
    expect(errors({ olympiadInterestOther: null })[0]).toMatch(/cleared only together with at least one/);
    expect(errors({ olympiadInterests: [], olympiadInterestOther: null }).length).toBeGreaterThan(0);
  });

  it('the subjects themselves are unchanged: only the three, no duplicates', () => {
    expect(errors({ olympiadInterests: ['CHEMISTRY'] }).length).toBeGreaterThan(0);
    expect(errors({ olympiadInterests: ['MATHEMATICS', 'MATHEMATICS'] }).length).toBeGreaterThan(0);
  });

  it('stored form: trimmed text; empty or null clears; undefined leaves it alone', () => {
    expect(storedOtherInterest('  Chemistry ')).toBe('Chemistry');
    expect(storedOtherInterest('   ')).toBeNull();
    expect(storedOtherInterest(null)).toBeNull();
    expect(storedOtherInterest(undefined)).toBeUndefined();
  });
});
