import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { AppError } from '../common/errors/app-error.js';
import { RegisterTeacherDto } from './dto/teacher-application.dto.js';
import { approvalSchoolId, assertPasswordsMatch, schoolChoice, teacherRegistrationOpen } from './teacher-application.rules.js';

const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(AppError); return [(e as AppError).getStatus(), (e as AppError).code]; }
  return null;
};

describe('teacher self-registration rules', () => {
  it('open only when TEACHERS_ENABLED and the setting are both on', () => {
    expect(teacherRegistrationOpen(true, true)).toBe(true);
    expect(teacherRegistrationOpen(true, false)).toBe(false);
    expect(teacherRegistrationOpen(false, true)).toBe(false);
    expect(teacherRegistrationOpen(false, false)).toBe(false);
  });

  it('exactly one school choice: listed (schoolId, no sector) or missing (name + sector)', () => {
    expect(schoolChoice({ schoolId: 's1' })).toEqual({ kind: 'LISTED', schoolId: 's1' });
    expect(schoolChoice({ proposedSchoolName: 'GS New', schoolSector: 'Ngoma' }))
      .toEqual({ kind: 'MISSING', proposedSchoolName: 'GS New', schoolSector: 'Ngoma' });
    expect(codeOf(() => schoolChoice({}))).toEqual([400, 'SCHOOL_CHOICE_REQUIRED']);
    expect(codeOf(() => schoolChoice({ schoolId: 's1', proposedSchoolName: 'GS New', schoolSector: 'Ngoma' }))).toEqual([400, 'SCHOOL_CHOICE_REQUIRED']);
    expect(codeOf(() => schoolChoice({ schoolId: 's1', schoolSector: 'Ngoma' }))).toEqual([400, 'SCHOOL_CHOICE_REQUIRED']);
  });

  it('passwords must match', () => {
    expect(codeOf(() => assertPasswordsMatch('Secret123', 'Secret123'))).toBeNull();
    expect(codeOf(() => assertPasswordsMatch('Secret123', 'Secret124'))).toEqual([400, 'PASSWORD_MISMATCH']);
  });

  it('approval school: a listed application keeps its school; a missing-school one needs the chosen school', () => {
    expect(approvalSchoolId('s1', undefined)).toBe('s1');
    expect(approvalSchoolId('s1', 's1')).toBe('s1');
    expect(codeOf(() => approvalSchoolId('s1', 's2'))).toEqual([400, 'SCHOOL_MISMATCH']);
    expect(codeOf(() => approvalSchoolId(null, undefined))).toEqual([400, 'SCHOOL_REQUIRED']);
    expect(approvalSchoolId(null, 's9')).toBe('s9');
  });

  describe('RegisterTeacherDto', () => {
    const base = {
      firstName: ' Ada ', lastName: 'Teacher', username: ' Ada.T ', email: 'ADA@Example.com', password: 'Secret123', confirmPassword: 'Secret123',
      country: ' rw ', phone: '0788 123 456', olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye',
      schoolId: '7d9f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', homeDistrict: 'Huye', homeSector: 'Ngoma',
    };
    const errors = (body: object) => validateSync(plainToInstance(RegisterTeacherDto, body), { whitelist: true, forbidNonWhitelisted: true })
      .map((e) => e.property);

    it('normalises identifiers and country', () => {
      const dto = plainToInstance(RegisterTeacherDto, base);
      expect(validateSync(dto)).toEqual([]);
      expect([dto.firstName, dto.username, dto.email, dto.country]).toEqual(['Ada', 'ada.t', 'ada@example.com', 'RW']);
    });

    it('interests: non-empty, unique, known values only; all three accepted', () => {
      expect(errors({ ...base, olympiadInterests: ['MATHEMATICS', 'COMPUTING', 'PHYSICS'] })).toEqual([]);
      expect(errors({ ...base, olympiadInterests: [] })).toEqual(['olympiadInterests']);
      expect(errors({ ...base, olympiadInterests: ['PHYSICS', 'PHYSICS'] })).toEqual(['olympiadInterests']);
      expect(errors({ ...base, olympiadInterests: ['CHEMISTRY'] })).toEqual(['olympiadInterests']);
      expect(errors({ ...base, olympiadInterests: 'MATHEMATICS' })).toEqual(['olympiadInterests']);
    });

    it('required fields: country, phone, places; a missing school needs its sector; unknown fields refused', () => {
      const without = (k: keyof typeof base) => { const b: Record<string, unknown> = { ...base }; delete b[k]; return b; };
      for (const k of ['country', 'phone', 'schoolProvince', 'schoolDistrict', 'homeDistrict', 'homeSector', 'confirmPassword'] as const) {
        expect(errors(without(k))).toEqual([k]);
      }
      expect(errors({ ...base, country: 'Rwanda' })).toEqual(['country']);
      const missing = { ...without('schoolId'), proposedSchoolName: 'GS New' };
      expect(errors(missing)).toEqual(['schoolSector']);
      expect(errors({ ...missing, schoolSector: 'Ngoma' })).toEqual([]);
      expect(errors({ ...base, schoolCode: '220001' })).toEqual(['schoolCode']);
    });
  });
});

describe('school verification errors (decision notifications)', () => {
  it('SCHOOL_NOT_VERIFIED (400) and SCHOOL_ALREADY_VERIFIED (409)', async () => {
    const { schoolNotVerified, schoolAlreadyVerified } = await import('./teacher-application.rules.js');
    expect([schoolNotVerified().getStatus(), schoolNotVerified().code]).toEqual([400, 'SCHOOL_NOT_VERIFIED']);
    expect([schoolAlreadyVerified().getStatus(), schoolAlreadyVerified().code]).toEqual([409, 'SCHOOL_ALREADY_VERIFIED']);
  });
});
