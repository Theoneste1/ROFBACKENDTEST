import { DecisionNotificationsService, MAX_ATTEMPTS, SELF_REGISTRATION_OFF, backoffMs } from './decision-notifications.service.js';

const ROW = {
  id: 'o1', type: 'teacher.application.approved', firstName: 'Eric', recipientEmail: 'eric@x.rw',
  payload: { activated: true }, attempts: 1, status: 'SENDING',
};

/** Teacher self-registration (decision 10): TEACHERS_ENABLED and registration.teacherSelfSignup, both on by default here. */
function make(selfRegistration: { teachers?: boolean; selfSignup?: boolean } = {}) {
  const { teachers = true, selfSignup = true } = selfRegistration;
  const prisma = {
    notificationOutbox: {
      createManyAndReturn: vi.fn().mockResolvedValue([{ id: 'o1' }]),
      update:              vi.fn().mockResolvedValue({}),
      updateMany:          vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow:   vi.fn().mockResolvedValue({ ...ROW }),
      findMany:            vi.fn().mockResolvedValue([]),
    },
  };
  const notifications = { createInApp: vi.fn().mockResolvedValue({ id: 'n1' }) };
  const mailer = { sendOne: vi.fn().mockResolvedValue({ accepted: true, messageId: 'm', error: null, permanent: false }) };
  const settings = { get: vi.fn(async (k: string) => (k === 'registration.teacherSelfSignup' ? selfSignup : '')) };
  const config = { get: vi.fn((k: string) => (k === 'APP_URL' ? 'https://app.example.org' : k === 'TEACHERS_ENABLED' ? String(teachers) : undefined)) };
  const events = { emit: vi.fn() };
  const audit = { log: vi.fn() };
  const service = new DecisionNotificationsService(prisma as any, notifications as any, mailer as any, settings as any, config as any, events as any, audit as any);
  return { service, prisma, notifications, mailer, events };
}

const EVENT = {
  type: 'teacher.application.approved' as const, dedupeKey: 'teacher.application.approved:a1',
  recipient: { userId: 'u1', email: 'eric@x.rw', firstName: 'Eric' },
  entity: { type: 'TeacherApplication', id: 'a1' }, payload: { activated: true },
};

describe('DecisionNotificationsService', () => {
  describe('enqueue (inside the action transaction)', () => {
    it('writes the outbox row with ON CONFLICT DO NOTHING and the in-app notification for an account', async () => {
      const { service, prisma, notifications } = make();
      const tx = prisma as any;
      const id = await service.enqueue(tx, EVENT);
      expect(id).toBe('o1');
      expect(prisma.notificationOutbox.createManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
      expect(notifications.createInApp).toHaveBeenCalledWith(tx, 'u1', expect.objectContaining({ category: 'ACCOUNT', type: 'teacher.application.approved' }));
      expect(prisma.notificationOutbox.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { inAppNotificationId: 'n1' } });
    });

    it('a duplicate dedupeKey is a no-op (null, no in-app row), not an error', async () => {
      const { service, prisma, notifications } = make();
      prisma.notificationOutbox.createManyAndReturn.mockResolvedValue([]);
      await expect(service.enqueue(prisma as any, EVENT)).resolves.toBeNull();
      expect(notifications.createInApp).not.toHaveBeenCalled();
    });

    it('no account → e-mail only (no in-app notification)', async () => {
      const { service, prisma, notifications } = make();
      await service.enqueue(prisma as any, { ...EVENT, type: 'school.request.verified', recipient: { userId: null, email: 'a@x.rw', firstName: 'A' }, payload: { schoolName: 'S' } });
      expect(notifications.createInApp).not.toHaveBeenCalled();
    });
  });

  describe('teacher-registration notices follow teacher self-registration (decision 10)', () => {
    const OFF = [{ teachers: false, selfSignup: true }, { teachers: true, selfSignup: false }, { teachers: false, selfSignup: false }];
    const SCHOOL_VERIFIED_APPLICANT = {
      ...EVENT, type: 'school.request.verified' as const, dedupeKey: 'school.request.verified:teacher-application:a1',
      recipient: { userId: null, email: 'eric@x.rw', firstName: 'Eric' }, payload: { schoolName: 'S', officialDirectory: true },
    };

    it('on (TEACHERS_ENABLED and teacherSelfSignup): the approval and the applicant school-verified notices are queued', async () => {
      for (const event of [EVENT, SCHOOL_VERIFIED_APPLICANT]) {
        const { service, prisma } = make();
        await expect(service.enqueue(prisma as any, event)).resolves.toBe('o1');
        expect(prisma.notificationOutbox.createManyAndReturn).toHaveBeenCalledOnce();
      }
    });

    it('off (either switch): nothing is queued for a TeacherApplication (no outbox row, no in-app notification)', async () => {
      for (const flags of OFF) {
        for (const event of [EVENT, SCHOOL_VERIFIED_APPLICANT]) {
          const { service, prisma, notifications } = make(flags);
          await expect(service.enqueue(prisma as any, event)).resolves.toBeNull();
          expect(prisma.notificationOutbox.createManyAndReturn).not.toHaveBeenCalled();
          expect(notifications.createInApp).not.toHaveBeenCalled();
        }
      }
    });

    it('off: coach approval, student school verification and permission grants are not teacher-registration notices', async () => {
      const others = [
        { ...EVENT, type: 'coach.application.approved' as const, dedupeKey: 'coach.application.approved:m1', entity: { type: 'MentorRequest', id: 'm1' } },
        { ...EVENT, type: 'school.request.verified' as const, dedupeKey: 'school.request.verified:student:s1:school:x', entity: { type: 'StudentSchoolAffiliation', id: 'c1' }, payload: { schoolName: 'S' } },
        { ...EVENT, type: 'permissions.granted' as const, dedupeKey: 'permissions.granted:ov1', entity: { type: 'UserPermissionOverride', id: 'ov1' }, payload: { activated: true, permissions: [] } },
      ];
      for (const flags of OFF) {
        for (const event of others) {
          const { service, prisma } = make(flags);
          await expect(service.enqueue(prisma as any, event)).resolves.toBe('o1');
        }
      }
    });

    it('a teacher-registration row queued earlier is not e-mailed once self-registration is off: FAILED, no automatic retry', async () => {
      const { service, prisma, mailer } = make({ selfSignup: false });
      prisma.notificationOutbox.findUniqueOrThrow.mockResolvedValue({ ...ROW, entityType: 'TeacherApplication', entityId: 'a1' });
      await expect(service.dispatch('o1')).resolves.toBe('FAILED');
      expect(mailer.sendOne).not.toHaveBeenCalled();
      expect(prisma.notificationOutbox.updateMany.mock.calls[1][0]).toEqual({
        where: { id: 'o1', status: 'SENDING', attempts: 1 },
        data:  { status: 'FAILED', lastError: SELF_REGISTRATION_OFF, nextAttemptAt: null },
      });
    });

    it('on: the same row is e-mailed; off: other rows are e-mailed as before', async () => {
      const on = make();
      on.prisma.notificationOutbox.findUniqueOrThrow.mockResolvedValue({ ...ROW, entityType: 'TeacherApplication', entityId: 'a1' });
      await expect(on.service.dispatch('o1')).resolves.toBe('SENT');
      const off = make({ teachers: false });
      off.prisma.notificationOutbox.findUniqueOrThrow.mockResolvedValue({ ...ROW, type: 'coach.application.approved', entityType: 'MentorRequest', entityId: 'm1' });
      await expect(off.service.dispatch('o1')).resolves.toBe('SENT');
      expect(off.mailer.sendOne).toHaveBeenCalledOnce();
    });
  });

  describe('enqueuePermissionsGranted', () => {
    const user = (role: string, extra: Record<string, unknown> = {}) =>
      ({ id: 'u1', role, email: 'u@x.rw', firstName: 'Grace', isActive: true, activatedAt: new Date(), ...extra });
    const grants = [
      { id: 'ov2', permission: 'students.viewProgress', effect: 'GRANT' },
      { id: 'ov1', permission: 'students.viewProfile', effect: 'GRANT' },
    ];

    it('Teachers, Coaches and Head Coaches: ONE notice listing every grant, keyed by the sorted override ids', async () => {
      for (const role of ['TEACHER', 'MENTOR', 'HEAD_COACH']) {
        const { service, prisma } = make();
        await expect(service.enqueuePermissionsGranted(prisma as any, user(role), grants)).resolves.toBe('o1');
        expect(prisma.notificationOutbox.createManyAndReturn).toHaveBeenCalledOnce();
        const data = prisma.notificationOutbox.createManyAndReturn.mock.calls[0][0].data[0];
        expect(data.dedupeKey).toBe('permissions.granted:ov1,ov2');
        expect(data.payload.permissions.map((p: { label: string }) => p.label)).toEqual(['View student profiles', 'View student progress']);
      }
    });

    it('nothing for students, administrators, inactive accounts, DENY overrides or an empty list', async () => {
      for (const [u, list] of [
        [user('STUDENT'), grants], [user('ADMIN'), grants], [user('SUPER_ADMIN'), grants],
        [user('TEACHER', { isActive: false }), grants],
        [user('TEACHER'), [{ id: 'd1', permission: 'courses.view', effect: 'DENY' }]],
        [user('MENTOR'), []],
      ] as const) {
        const { service, prisma } = make();
        await expect(service.enqueuePermissionsGranted(prisma as any, u as any, list as any)).resolves.toBeNull();
        expect(prisma.notificationOutbox.createManyAndReturn).not.toHaveBeenCalled();
      }
    });
  });

  describe('dispatch (after commit)', () => {
    it('claims PENDING/FAILED → SENDING, sends once with an idempotency key, then marks SENT', async () => {
      const { service, prisma, mailer } = make();
      await expect(service.dispatch('o1')).resolves.toBe('SENT');
      expect(prisma.notificationOutbox.updateMany.mock.calls[0][0].where).toEqual({ id: 'o1', status: { in: ['PENDING', 'FAILED'] } });
      expect(mailer.sendOne).toHaveBeenCalledOnce();
      const mail = mailer.sendOne.mock.calls[0][0];
      expect(mail).toMatchObject({ to: 'eric@x.rw', idempotencyKey: 'notification-outbox/o1' });
      expect(mail.text).toContain('Dear Eric,');
      expect(mail.text).toContain('https://app.example.org/login');
      expect(prisma.notificationOutbox.updateMany.mock.calls[1][0]).toMatchObject({ where: { id: 'o1', status: 'SENDING' }, data: { status: 'SENT' } });
    });

    it('records the outcome only for its own claim (L3): a claim recovered by the sweep and claimed again is not overwritten', async () => {
      const { service, prisma } = make();
      prisma.notificationOutbox.findUniqueOrThrow.mockResolvedValueOnce({ ...ROW, attempts: 2 });
      await service.dispatch('o1');
      expect(prisma.notificationOutbox.updateMany.mock.calls[1][0].where).toEqual({ id: 'o1', status: 'SENDING', attempts: 2 });
    });

    it('a lost claim (another dispatcher, or already SENT) sends nothing', async () => {
      const { service, prisma, mailer } = make();
      prisma.notificationOutbox.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.dispatch('o1')).resolves.toBe('SKIPPED');
      expect(mailer.sendOne).not.toHaveBeenCalled();
    });

    it('a throwing mailer → FAILED with a sanitised error and a backoff; never throws', async () => {
      const { service, prisma, mailer } = make();
      mailer.sendOne.mockRejectedValue(new Error('connect failed for eric@x.rw key re_secret123'));
      const before = Date.now();
      await expect(service.dispatch('o1')).resolves.toBe('FAILED');
      const update = prisma.notificationOutbox.updateMany.mock.calls[1][0];
      expect(update.data.status).toBe('FAILED');
      expect(update.data.lastError).not.toMatch(/eric@x\.rw|re_secret123/);
      expect(update.data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + backoffMs(1));
    });

    it('a permanent error or the last attempt → FAILED without an automatic retry', async () => {
      const { service, prisma, mailer } = make();
      prisma.notificationOutbox.findUniqueOrThrow.mockResolvedValue({ ...ROW, attempts: MAX_ATTEMPTS });
      mailer.sendOne.mockResolvedValue({ accepted: false, messageId: null, error: 'nope', permanent: false });
      await service.dispatch('o1');
      expect(prisma.notificationOutbox.updateMany.mock.calls[1][0].data).toMatchObject({ status: 'FAILED', nextAttemptAt: null });
    });

    it('a database error is logged, never thrown into the caller', async () => {
      const { service, prisma } = make();
      prisma.notificationOutbox.updateMany.mockRejectedValue(new Error('db down'));
      await expect(service.dispatch('o1')).resolves.toBe('FAILED');
    });

    it('dispatchAfterCommit emits one event per queued row and skips duplicates (null)', () => {
      const { service, events } = make();
      service.dispatchAfterCommit(['o1', null, undefined, 'o2']);
      expect(events.emit).toHaveBeenCalledTimes(2);
    });
  });

  describe('sweep (retry worker)', () => {
    it('recovers expired SENDING claims and sends due rows with bounded attempts', async () => {
      const { service, prisma } = make();
      prisma.notificationOutbox.findMany.mockResolvedValue([{ id: 'o1' }]);
      const res = await service.sweep(new Date());
      const recover = prisma.notificationOutbox.updateMany.mock.calls[0][0];
      expect(recover.where).toMatchObject({ status: 'SENDING', attempts: { lt: MAX_ATTEMPTS } });
      const due = prisma.notificationOutbox.findMany.mock.calls[0][0].where.OR;
      expect(due).toContainEqual(expect.objectContaining({ status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } }));
      expect(res.processed).toBe(1);
      expect(res.sent).toBe(1);
    });

    it('the interval does nothing while WORKERS_ENABLED=false', async () => {
      const { service, prisma } = make();
      (service as any).config.get = vi.fn((k: string) => (k === 'WORKERS_ENABLED' ? 'false' : undefined));
      await service.tick();
      expect(prisma.notificationOutbox.findMany).not.toHaveBeenCalled();
    });
  });
});
