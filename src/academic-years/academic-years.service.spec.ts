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
      findUniqueOrThrow: vi.fn().mockResolvedValue(year()),
    },
    auditLog: { findFirst: vi.fn().mockResolvedValue(null) },
    assignment:        {
      findMany:   vi.fn().mockResolvedValue([{ id: 'as1', status: 'PUBLISHED' }, { id: 'as2', status: 'CLOSED' }]),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    assignmentEvent:   { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
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
    // pg_try_advisory_xact_lock: acquired unless a test says otherwise.
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
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
    it.each(['ACTIVE', 'CLOSED'])('refuses a %s year without a matching recorded start (INVALID_STATE_TRANSITION), changing nothing', async (status) => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findUnique.mockResolvedValue(year({ status }));
      prisma.academicYear.findUniqueOrThrow.mockResolvedValue(year({ status }));
      const err = await service.activate('y2', { promoteStudents: true, expectedCurrentYearId: null } as any, ADMIN).catch((e) => e);
      expect(err.getResponse().code).toBe('INVALID_STATE_TRANSITION');
      expect(prisma.academicYear.update).not.toHaveBeenCalled();
    });

    it('refuses at once while another start holds the lock (ACTIVATION_IN_PROGRESS), reading nothing else', async () => {
      const { service, prisma } = makeMocks();
      prisma.$queryRaw.mockResolvedValue([{ locked: false }]);
      const err = await service.activate('y2', { promoteStudents: true, expectedCurrentYearId: null } as any, ADMIN).catch((e) => e);
      expect(err.getResponse().code).toBe('ACTIVATION_IN_PROGRESS');
      expect(prisma.academicYear.findFirst).not.toHaveBeenCalled();
      expect(prisma.academicYear.update).not.toHaveBeenCalled();
    });

    it('refuses when the current year is not the one the caller saw (CURRENT_YEAR_CHANGED)', async () => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      const err = await service.activate('y2', { promoteStudents: true, expectedCurrentYearId: 'y0' } as any, ADMIN).catch((e) => e);
      expect(err.getResponse()).toMatchObject({ code: 'CURRENT_YEAR_CHANGED', details: { currentYearId: 'y1' } });
      expect(prisma.academicYear.update).not.toHaveBeenCalled();
    });

    it('answers a repeat of a recorded start from its audit entry (replayed) and refuses other choices', async () => {
      const { service, prisma, audit } = makeMocks();
      prisma.academicYear.findUnique.mockResolvedValue(year({ status: 'ACTIVE', isCurrent: true }));
      prisma.academicYear.findUniqueOrThrow.mockResolvedValue(year({ status: 'ACTIVE', isCurrent: true }));
      const counts = { promoted: 5, carriedOver: 0, graduated: 1, newlyEnrolled: 0, assignmentsArchived: 2 };
      prisma.auditLog.findFirst.mockResolvedValue({ metadata: { previousYearId: 'y1', promoteStudents: true, deactivateGraduates: true, counts } });

      const r = await service.activate('y2', { promoteStudents: true, expectedCurrentYearId: 'y1' } as any, ADMIN);
      expect(r).toMatchObject({ replayed: true, ...counts });
      expect(prisma.academicYear.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();

      const other = await service.activate('y2', { promoteStudents: false, expectedCurrentYearId: 'y1' } as any, ADMIN).catch((e) => e);
      expect(other.getResponse().code).toBe('ACTIVATION_OPTIONS_DIFFER');
      const from = await service.activate('y2', { promoteStudents: true, expectedCurrentYearId: 'y0' } as any, ADMIN).catch((e) => e);
      expect(from.getResponse().code).toBe('CURRENT_YEAR_CHANGED');
    });

    it('closes the previous year, archives its assignments and promotes / graduates students', async () => {
      const { service, prisma, divisions } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      prisma.studentEnrollment.findMany.mockResolvedValue([
        { id: 'e-s2', studentId: 'st-s2', gradeLevel: 'S2', schoolId: 'sch1' },
        { id: 'e-s3', studentId: 'st-s3', gradeLevel: 'S3', schoolId: null },
        { id: 'e-s6', studentId: 'st-s6', gradeLevel: 'S6', schoolId: 'sch1' },
      ]);

      const result = await service.activate('y2', { promoteStudents: true, expectedCurrentYearId: 'y1' } as any, ADMIN);

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
      // ...and each one gets an ARCHIVED history entry.
      expect(prisma.assignmentEvent.createMany.mock.calls[0][0].data).toEqual([
        expect.objectContaining({ assignmentId: 'as1', type: 'ARCHIVED', fromStatus: 'PUBLISHED', toStatus: 'ARCHIVED' }),
        expect.objectContaining({ assignmentId: 'as2', type: 'ARCHIVED', fromStatus: 'CLOSED', toStatus: 'ARCHIVED' }),
      ]);

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

      expect(result).toMatchObject({ promoted: 2, graduated: 1, carriedOver: 0, assignmentsArchived: 2 });
    });

    it('keeps graduates active when deactivateGraduates=false', async () => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      prisma.studentEnrollment.findMany.mockResolvedValue([
        { id: 'e-s6', studentId: 'st-s6', gradeLevel: 'S6', schoolId: null },
      ]);
      await service.activate('y2', { promoteStudents: true, deactivateGraduates: false, expectedCurrentYearId: 'y1' } as any, ADMIN);
      expect(prisma.user.update).not.toHaveBeenCalledWith({ where: { id: 'st-s6' }, data: { isActive: false } });
    });

    it('carries students over at the same grade when promoteStudents=false', async () => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      prisma.studentEnrollment.findMany.mockResolvedValue([
        { id: 'e-s6', studentId: 'st-s6', gradeLevel: 'S6', schoolId: null },
      ]);
      const result = await service.activate('y2', { promoteStudents: false, expectedCurrentYearId: 'y1' } as any, ADMIN);
      expect(prisma.studentEnrollment.update.mock.calls[0][0].data).toMatchObject({ status: 'ACTIVE' });
      expect(prisma.studentEnrollment.upsert.mock.calls[0][0].create).toMatchObject({ gradeLevel: 'S6', divisionId: 'div-senior' });
      expect(result).toMatchObject({ carriedOver: 1, promoted: 0, graduated: 0 });
    });
  });
});
