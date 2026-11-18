import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { AppError } from '../common/errors/app-error.js';
import { CreateMentorRequestDto } from '../mentor-requests/dto/create-mentor-request.dto.js';
import { RegisterStudentDto } from './dto/register-student.dto.js';
import { ageOn, dateOfBirthProblem, isCalendarDate } from './dto/registration-details.rules.js';
import { homePlaceOf, studentDetailAudit, studentDetailColumns } from './student-details.js';

const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(AppError); return [(e as AppError).getStatus(), (e as AppError).code]; }
  return null;
};

/** The validation messages of a body, grouped by property. */
const problems = <T extends object>(cls: new () => T, body: object) => {
  const errors = validateSync(plainToInstance(cls, body) as object, { whitelist: true, forbidNonWhitelisted: true });
  return Object.fromEntries(errors.map((e) => [e.property, Object.values(e.constraints ?? {})]));
};

const STUDENT = {
  firstName: 'Aline', lastName: 'Uwase', username: 'aline.u', email: 'aline@example.rw', password: 'Secret123',
  gradeLevel: 'S2', schoolCode: '110123', homeLocation: 'Kigali', dateOfBirth: '2012-05-01', guardianPhone: '0722 123 456',
};

describe('student registration details (studentRegistrationDetails)', () => {
  describe('date of birth', () => {
    it('counts whole years; the birthday itself counts', () => {
      expect(ageOn('2010-11-15', '2026-11-15')).toBe(16);
      expect(ageOn('2010-11-16', '2026-11-15')).toBe(15);
      expect(ageOn('2010-12-01', '2026-11-15')).toBe(15);
      expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    });

    it('a real calendar date only', () => {
      expect(isCalendarDate('2012-02-29')).toBe(true);
      for (const bad of ['2013-02-29', '2012-13-01', '2012-1-01', '12-01-2012', '2012-01-01T00:00:00Z', '']) expect(isCalendarDate(bad)).toBe(false);
    });

    it('a past date with an age of 5 to 30 years on the day', () => {
      const today = '2026-11-15';
      expect(dateOfBirthProblem('2012-05-01', today)).toBeNull();
      expect(dateOfBirthProblem('2021-11-15', today)).toBeNull();          // exactly 5
      expect(dateOfBirthProblem('2021-11-16', today)).toMatch(/between 5 and 30/);
      expect(dateOfBirthProblem('1996-11-15', today)).toBeNull();          // exactly 30
      expect(dateOfBirthProblem('1995-11-15', today)).toMatch(/between 5 and 30/);
      expect(dateOfBirthProblem('2026-11-15', today)).toMatch(/past/);
      expect(dateOfBirthProblem('2030-01-01', today)).toMatch(/past/);
      expect(dateOfBirthProblem('2012-02-30', today)).toMatch(/YYYY-MM-DD/);
      expect(dateOfBirthProblem(20120501, today)).toMatch(/YYYY-MM-DD/);
    });
  });

  describe('RegisterStudentDto', () => {
    it('the date of birth (owner, 2026-11-17) and the guardian phone (decision 9.2, 2026-11-18) are required; the other new fields are optional', () => {
      expect(problems(RegisterStudentDto, STUDENT)).toEqual({});
      const { dateOfBirth: _dob, ...noDob } = STUDENT;
      expect(Object.keys(problems(RegisterStudentDto, noDob))).toEqual(['dateOfBirth']);
      const { guardianPhone: _gp, ...noGuardian } = STUDENT;
      expect(Object.keys(problems(RegisterStudentDto, noGuardian))).toEqual(['guardianPhone']);
      for (const empty of ['', '   ', null]) expect(Object.keys(problems(RegisterStudentDto, { ...STUDENT, guardianPhone: empty }))).toEqual(['guardianPhone']);
      expect(problems(RegisterStudentDto, { ...STUDENT, phone: undefined })).toEqual({});
    });

    it('all details given: valid', () => {
      expect(problems(RegisterStudentDto, {
        ...STUDENT, homeLocation: undefined, dateOfBirth: '2012-05-01', phone: '0788 123 456', guardianPhone: '+254 712 345678',
        homeCountry: 'rw', homeProvince: 'Kigali City', homeDistrict: 'Gasabo', homeSector: 'Remera',
      })).toEqual({});
    });

    it('each invalid value is reported on its own field, the message starting with the field name', () => {
      const p = problems(RegisterStudentDto, { ...STUDENT, dateOfBirth: '2012-02-30', phone: '12', guardianPhone: 'call me', homeCountry: 'Rwanda' });
      expect(Object.keys(p).sort()).toEqual(['dateOfBirth', 'guardianPhone', 'homeCountry', 'phone']);
      for (const [field, messages] of Object.entries(p)) for (const m of messages) expect(m.startsWith(`${field} `)).toBe(true);
      expect(p.dateOfBirth[0]).toMatch(/^dateOfBirth must be a real date/);
    });

    it('the home place: all three together; homeLocation is optional only with it', () => {
      expect(Object.keys(problems(RegisterStudentDto, { ...STUDENT, homeProvince: 'Kigali City' })).sort()).toEqual(['homeDistrict', 'homeSector']);
      expect(Object.keys(problems(RegisterStudentDto, { ...STUDENT, homeLocation: undefined }))).toEqual(['homeLocation']);
      expect(problems(RegisterStudentDto, { ...STUDENT, homeLocation: undefined, homeProvince: 'Kigali City', homeDistrict: 'Gasabo', homeSector: 'Remera' })).toEqual({});
    });
  });

  describe('columns and audit', () => {
    const dto = (body: object) => plainToInstance(RegisterStudentDto, { ...STUDENT, ...body });

    it('a home place with another country is refused', () => {
      expect(codeOf(() => homePlaceOf(dto({ homeCountry: 'KE', homeProvince: 'Kigali City', homeDistrict: 'Gasabo', homeSector: 'Remera' }))))
        .toEqual([400, 'HOME_LOCATION_RWANDA_ONLY']);
      expect(homePlaceOf(dto({ homeCountry: 'RW', homeProvince: 'Kigali City', homeDistrict: 'Gasabo', homeSector: 'Remera' })))
        .toEqual({ province: 'Kigali City', district: 'Gasabo', sector: 'Remera' });
      expect(homePlaceOf(dto({ homeProvince: 'Kigali City', homeDistrict: 'Gasabo', homeSector: 'Remera' }))).not.toBeNull();
      expect(homePlaceOf(dto({ homeCountry: 'KE' }))).toBeNull();
    });

    it('stores E.164 phones, the date at 00:00 UTC, the own country and "Sector, District"', () => {
      const d = dto({ homeLocation: undefined, dateOfBirth: '2012-05-01', phone: '0788 123 456', guardianPhone: '0722123456', homeCountry: 'RW', homeProvince: 'Kigali City', homeDistrict: 'Gasabo', homeSector: 'Remera' });
      expect(studentDetailColumns(d, homePlaceOf(d))).toEqual({
        dateOfBirth: new Date('2012-05-01T00:00:00Z'), phone: '+250788123456', guardianPhone: '+250722123456', country: 'RW',
        homeProvince: 'Kigali City', homeDistrict: 'Gasabo', homeSector: 'Remera', homeLocation: 'Remera, Gasabo',
      });
      // Older clients: only homeLocation.
      expect(studentDetailColumns(dto({ dateOfBirth: undefined, guardianPhone: undefined }), null)).toEqual({ homeLocation: 'Kigali' });
    });

    it('the audit log says only whether each detail was given — never a phone or a date', () => {
      const d = dto({ dateOfBirth: '2012-05-01', guardianPhone: '0722123456', homeCountry: 'KE' });
      const audit = studentDetailAudit(d, null);
      expect(audit).toEqual({ dateOfBirthGiven: true, phoneGiven: false, guardianPhoneGiven: true, homeCountry: 'KE', homePlaceGiven: false });
      expect(JSON.stringify(audit)).not.toMatch(/2012|0722|\+250/);
    });
  });
});

describe('coach application details (coachApplicationDetails)', () => {
  const COACH = { firstName: 'Jean', lastName: 'Coach', username: 'jean.c', email: 'jean@example.rw', password: 'Secret123' };

  it('older clients: none of the new fields is needed', () => {
    expect(problems(CreateMentorRequestDto, COACH)).toEqual({});
  });

  it('country, occupation, education level and interests', () => {
    expect(problems(CreateMentorRequestDto, { ...COACH, country: 'ke', occupation: ' Teacher ', educationLevel: 'MASTER', olympiadInterests: ['PHYSICS', 'MATHEMATICS'] })).toEqual({});
    const p = problems(CreateMentorRequestDto, { ...COACH, country: 'Kenya', occupation: 'x', educationLevel: 'PHD', olympiadInterests: [] });
    expect(Object.keys(p).sort()).toEqual(['country', 'educationLevel', 'occupation', 'olympiadInterests']);
    expect(Object.keys(problems(CreateMentorRequestDto, { ...COACH, olympiadInterests: ['MATHEMATICS', 'MATHEMATICS'] }))).toEqual(['olympiadInterests']);
    expect(Object.keys(problems(CreateMentorRequestDto, { ...COACH, olympiadInterests: ['CHEMISTRY'] }))).toEqual(['olympiadInterests']);
  });

  it('no passport or national ID field', () => {
    expect(Object.keys(problems(CreateMentorRequestDto, { ...COACH, nationalId: '1199880012345678' }))).toEqual(['nationalId']);
  });
});
