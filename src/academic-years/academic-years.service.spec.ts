import { AcademicYearsService } from './academic-years.service.js';

const ADMIN = { id: 'a1', role: 'ADMIN' } as const;

const year = (overrides: Record<string, unknown> = {}) => ({
  id: 'y2', name: '2027-2028', status: 'PLANNED', isCurrent: null,
  startsOn: new Date('2027-09-01'), endsOn: new Date('2028-07-01'), ...overrides,
});

function makeMocks() {
  const prisma = {
    academicYear: {
      findFirst:  vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(year()),
      findMany:   vi.fn().mockResolvedValue([]),
      create:     vi.fn().mockResolvedValue(year()),
      update:     vi.fn().mockResolvedValue({}),
    },
    assignment:        { updateMany: vi.fn().mockResolvedValue({ count: 4 }) },
    studentEnrollment: {
      findMany: vi.fn().mockResolvedValue([]),
      update:   vi.fn().mockResolvedValue({}),
      upsert:   vi.fn().mockResolvedValue({ id: 'enr-new' }),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      update:   vi.fn().mockResolvedValue({}),
    },
    division: { findUniqueOrThrow: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]));

  const audit     = { log: vi.fn() };
  const divisions = { idForCode: vi.fn((code: string) => Promise.resolve(`div-${code.toLowerCase()}`)) };

  const service = new AcademicYearsService(prisma as any, audit as any, divisions as any);
  return { service, prisma, audit, divisions };
}

describe('AcademicYearsService', () => {
  describe('current', () => {
    it('throws NO_CURRENT_ACADEMIC_YEAR when no year is current', async () => {
      const { service, prisma } = makeMocks();
      await expect(service.current()).rejects.toMatchObject({ code: 'NO_CURRENT_ACADEMIC_YEAR', status: 409 });
      expect(prisma.academicYear.findFirst).toHaveBeenCalledWith({ where: { isCurrent: true } });
    });

    it('returns the current year', async () => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', isCurrent: true }));
      await expect(service.current()).resolves.toMatchObject({ id: 'y1' });
    });
  });

  describe('create', () => {
    it.each([
      ['2027-09-01', '2027-09-01'],
      ['2027-09-01', '2027-08-31'],
    ])('rejects startsOn=%s endsOn=%s with INVALID_DATE_RANGE', async (startsOn, endsOn) => {
      const { service, prisma } = makeMocks();
      const err = await service.create({ name: 'Y', startsOn, endsOn } as any, ADMIN).catch((e) => e);
      expect(err.getResponse().code).toBe('INVALID_DATE_RANGE');
      expect(err.getStatus()).toBe(400);
      expect(prisma.academicYear.create).not.toHaveBeenCalled();
    });

    it('creates a year with valid dates and audits it', async () => {
      const { service, prisma, audit } = makeMocks();
      await service.create({ name: '2027-2028', startsOn: '2027-09-01', endsOn: '2028-07-01' } as any, ADMIN);
      expect(prisma.academicYear.create.mock.calls[0][0].data).toEqual({
        name: '2027-2028', startsOn: new Date('2027-09-01'), endsOn: new Date('2028-07-01'),
      });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE_ACADEMIC_YEAR' }));
    });
  });

  describe('activate', () => {
    it.each(['ACTIVE', 'CLOSED'])('refuses a %s year with INVALID_STATE_TRANSITION', async (status) => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findUnique.mockResolvedValue(year({ status }));
      const err = await service.activate('y2', { promoteStudents: true } as any, ADMIN).catch((e) => e);
      expect(err.getResponse().code).toBe('INVALID_STATE_TRANSITION');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('closes the previous year, archives its assignments and promotes / graduates students', async () => {
      const { service, prisma, divisions } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      prisma.studentEnrollment.findMany.mockResolvedValue([
        { id: 'e-s2', studentId: 'st-s2', gradeLevel: 'S2', schoolId: 'sch1' },
        { id: 'e-s3', studentId: 'st-s3', gradeLevel: 'S3', schoolId: null },
        { id: 'e-s6', studentId: 'st-s6', gradeLevel: 'S6', schoolId: 'sch1' },
      ]);

      const result = await service.activate('y2', { promoteStudents: true } as any, ADMIN);

      expect(divisions.idForCode).toHaveBeenCalledWith('JUNIOR');
      expect(divisions.idForCode).toHaveBeenCalledWith('SENIOR');

      // Previous year closed, new year current.
      const yearUpdates = prisma.academicYear.update.mock.calls.map((c) => c[0]);
      expect(yearUpdates[0]).toMatchObject({ where: { id: 'y1' }, data: { isCurrent: null, status: 'CLOSED' } });
      expect(yearUpdates[0].data.closedAt).toBeInstanceOf(Date);
      expect(yearUpdates[1]).toEqual({ where: { id: 'y2' }, data: { isCurrent: true, status: 'ACTIVE' } });

      // Assignments of the previous year archived.
      expect(prisma.assignment.updateMany.mock.calls[0][0]).toMatchObject({
        where: { academicYearId: 'y1', status: { not: 'ARCHIVED' } },
        data:  { status: 'ARCHIVED' },
      });

      const enrollmentUpdates = prisma.studentEnrollment.update.mock.calls.map((c) => c[0]);
      const upserts = prisma.studentEnrollment.upsert.mock.calls.map((c) => c[0]);
      const userUpdates = prisma.user.update.mock.calls.map((c) => c[0]);

      // S2 → S3: old enrolment PROMOTED, new ACTIVE enrolment in the junior division.
      expect(enrollmentUpdates.find((u) => u.where.id === 'e-s2')!.data).toMatchObject({ status: 'PROMOTED' });
      const s2 = upserts.find((u) => u.create.studentId === 'st-s2')!;
      expect(s2.where).toEqual({ studentId_academicYearId: { studentId: 'st-s2', academicYearId: 'y2' } });
      expect(s2.create).toMatchObject({ gradeLevel: 'S3', divisionId: 'div-junior', schoolId: 'sch1', status: 'ACTIVE' });
      expect(userUpdates).toContainEqual({
        where: { id: 'st-s2' }, data: { gradeLevel: 'S3', divisionId: 'div-junior', schoolId: 'sch1' },
      });

      // S3 → S4 moves into the senior division.
      expect(enrollmentUpdates.find((u) => u.where.id === 'e-s3')!.data).toMatchObject({ status: 'PROMOTED' });
      expect(upserts.find((u) => u.create.studentId === 'st-s3')!.create)
        .toMatchObject({ gradeLevel: 'S4', divisionId: 'div-senior', status: 'ACTIVE' });
      expect(userUpdates).toContainEqual({
        where: { id: 'st-s3' }, data: { gradeLevel: 'S4', divisionId: 'div-senior', schoolId: null },
      });

      // S6 graduates and is deactivated by default; no new enrolment.
      expect(enrollmentUpdates.find((u) => u.where.id === 'e-s6')!.data).toMatchObject({ status: 'GRADUATED' });
      expect(upserts.find((u) => u.create.studentId === 'st-s6')).toBeUndefined();
      expect(userUpdates).toContainEqual({ where: { id: 'st-s6' }, data: { isActive: false } });

      expect(result).toMatchObject({ promoted: 2, graduated: 1, carriedOver: 0, assignmentsArchived: 4 });
    });

    it('keeps graduates active when deactivateGraduates=false', async () => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      prisma.studentEnrollment.findMany.mockResolvedValue([
        { id: 'e-s6', studentId: 'st-s6', gradeLevel: 'S6', schoolId: null },
      ]);
      await service.activate('y2', { promoteStudents: true, deactivateGraduates: false } as any, ADMIN);
      expect(prisma.user.update).not.toHaveBeenCalledWith({ where: { id: 'st-s6' }, data: { isActive: false } });
    });

    it('carries students over at the same grade when promoteStudents=false', async () => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      prisma.studentEnrollment.findMany.mockResolvedValue([
        { id: 'e-s6', studentId: 'st-s6', gradeLevel: 'S6', schoolId: null },
      ]);
      const result = await service.activate('y2', { promoteStudents: false } as any, ADMIN);
      expect(prisma.studentEnrollment.update.mock.calls[0][0].data).toMatchObject({ status: 'ACTIVE' });
      expect(prisma.studentEnrollment.upsert.mock.calls[0][0].create).toMatchObject({ gradeLevel: 'S6', divisionId: 'div-senior' });
      expect(result).toMatchObject({ carriedOver: 1, promoted: 0, graduated: 0 });
    });
  });
});
