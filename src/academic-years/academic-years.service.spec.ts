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

    /** The SQL steps of a start: [lock, rollOver, enrollUnenrolled] answers, and the calls made. */
    const sqlSteps = (prisma: ReturnType<typeof makeMocks>['prisma'], rolled = { moved: 2, graduated: 1 }, enrolled = 0) => {
      prisma.$queryRaw.mockReset();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([{ ...rolled, deactivated: rolled.graduated, placed: rolled.moved }])
        .mockResolvedValueOnce([{ enrolled, placed: enrolled }]);
      /** The SQL text and parameters of the n-th $queryRaw call (tagged template). */
      return (n: number) => {
        const [strings, ...values] = prisma.$queryRaw.mock.calls[n] as [TemplateStringsArray, ...unknown[]];
        return { text: strings.join('?'), values: JSON.stringify(values) };
      };
    };

    it('closes the previous year, archives its assignments, then rolls students over in set-based SQL', async () => {
      const { service, prisma, divisions, audit } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      const call = sqlSteps(prisma, { moved: 2, graduated: 1 }, 3);

      const result = await service.activate('y2', { promoteStudents: true, expectedCurrentYearId: 'y1' } as any, ADMIN);

      // Administrator-managed divisions (2026-11-21/22): the SQL asks the database for the grade's division, and keeps a
      // division set by hand; no fixed JUNIOR / SENIOR lookup.
      expect(divisions.idForCode).not.toHaveBeenCalled();

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

      // No per-student statements: one rollover statement, one statement for the unenrolled.
      expect(prisma.studentEnrollment.update).not.toHaveBeenCalled();
      expect(prisma.studentEnrollment.upsert).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      const roll = call(1);
      expect(roll.text).toMatch(/UPDATE "StudentEnrollment"/);
      expect(roll.text).toMatch(/INSERT INTO "StudentEnrollment"/);
      expect(roll.values).toContain('"y1"');           // previous year's enrolments
      expect(roll.values).toContain('"y2"');           // new year's enrolments
      expect(roll.values).toContain('division_for_grade(');   // the grade's division, from the database (nested SQL: in the values)
      expect(roll.values).toContain('divisionManual');         // a division set by hand is kept
      const sweep = call(2);
      expect(sweep.text).toMatch(/IS DISTINCT FROM 'GRADUATED'/);   // graduates are never swept in again
      expect(sweep.values).toContain('"y2"');

      // The counts come from the statements, and are recorded for replays.
      expect(result).toMatchObject({ promoted: 2, graduated: 1, carriedOver: 0, newlyEnrolled: 3, assignmentsArchived: 2 });
      expect(audit.log.mock.calls[0][0].metadata).toMatchObject({
        previousYearId: 'y1', promoteStudents: true, deactivateGraduates: true,
        counts: { promoted: 2, graduated: 1, carriedOver: 0, newlyEnrolled: 3, assignmentsArchived: 2 },
      });
    });

    it.each([
      [{ promoteStudents: true }, [true, true]],
      [{ promoteStudents: true, deactivateGraduates: false }, [true, false]],
      [{ promoteStudents: false }, [false, true]],
    ])('passes the choices %j to the rollover statement as [promote, deactivateGraduates] = %j', async (choices, [promote, deactivate]) => {
      const { service, prisma } = makeMocks();
      prisma.academicYear.findFirst.mockResolvedValue(year({ id: 'y1', status: 'ACTIVE', isCurrent: true }));
      sqlSteps(prisma, { moved: 1, graduated: 0 });
      const result = await service.activate('y2', { ...choices, expectedCurrentYearId: 'y1' } as any, ADMIN);
      const values = (prisma.$queryRaw.mock.calls[1] as unknown[]).slice(1);
      const flags = values.filter((v) => typeof v === 'boolean');
      expect(flags).toContain(promote);
      expect(flags.includes(deactivate) || !promote).toBe(true);
      expect(result).toMatchObject(promote ? { promoted: 1, carriedOver: 0 } : { promoted: 0, carriedOver: 1 });
    });

    it('with no previous year, only enrols the unenrolled students', async () => {
      const { service, prisma } = makeMocks();
      prisma.$queryRaw.mockReset();
      prisma.$queryRaw.mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([{ enrolled: 4, placed: 4 }]);
      const result = await service.activate('y2', { promoteStudents: true, expectedCurrentYearId: null } as any, ADMIN);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ promoted: 0, graduated: 0, newlyEnrolled: 4, assignmentsArchived: 0 });
    });
  });
});
