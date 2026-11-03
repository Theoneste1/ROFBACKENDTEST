/**
 * Live sessions: mentors schedule external meetings (Zoom, Meet …) for the
 * courses and divisions they teach, update or cancel them; students see their
 * division's sessions. Dates, times, links and conflicts are validated. The
 * platform stores the link only — it hosts no video.
 */
import { LiveSessionsService } from '../src/live-sessions/live-sessions.service.js';
import { fromZoned, toZoned } from '../src/common/time/zoned-time.js';
import { createTestApp, login, bearer, type TestContext, waitForEvents } from './helpers.js';

const TZ = 'Africa/Kigali';
const localDay = (days: number) => toZoned(new Date(Date.now() + days * 86_400_000), TZ).date;

describe('Live sessions (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorJ2: string, mentorS: string, studentJ: string, studentS: string;
  let sessionId: string;
  const day = localDay(3);

  const schedule = (token: string, body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/live-sessions').set(bearer(token)).send({
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, title: 'Revision',
      meetingUrl: 'https://us02web.zoom.us/j/123456789', ...body,
    });
  const notes = (userId: string, type: string) => ctx.prisma.notification.findMany({ where: { userId, type } });

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorJ2, mentorS, studentJ, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.j2', 'mentor.s', 'student.j', 'student.s'].map((u) => login(ctx, u)),
    );
    // mentor.j also teaches Algebra to Seniors (for the double-booking check).
    await ctx.prisma.mentorAssignment.create({
      data: { mentorId: ctx.ids.mentorJunior, courseId: ctx.ids.algebra, divisionId: ctx.ids.senior },
    });
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('scheduling', () => {
    it('a mentor schedules a session by date and start/end time for a course and division they teach', async () => {
      const res = await schedule(mentorJ, {
        title: 'Quadratics clinic', description: 'Bring your questions.', date: day, startTime: '14:00', endTime: '15:30',
      }).expect(201);
      expect(res.body).toMatchObject({
        title: 'Quadratics clinic', description: 'Bring your questions.', status: 'SCHEDULED',
        course: { id: ctx.ids.algebra }, division: { id: ctx.ids.junior },
        date: day, startTime: '14:00', endTime: '15:30', timeZone: TZ, isLive: false,
        provider: 'ZOOM', meetingUrl: 'https://us02web.zoom.us/j/123456789',
      });
      expect(res.body.startsAt).toBe(fromZoned(day, '14:00', TZ).toISOString());
      sessionId = res.body.id;

      await waitForEvents();
      expect(await notes(ctx.ids.studentJunior, 'live_session.scheduled')).toHaveLength(1);
      expect(await notes(ctx.ids.studentSenior, 'live_session.scheduled')).toHaveLength(0);
    });

    it('ISO start and end instants are accepted too, and Google Meet links are recognised', async () => {
      const res = await schedule(mentorJ, {
        startsAt: fromZoned(localDay(4), '09:00', TZ).toISOString(), endsAt: fromZoned(localDay(4), '10:00', TZ).toISOString(),
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      }).expect(201);
      expect(res.body).toMatchObject({ provider: 'GOOGLE_MEET', date: localDay(4), startTime: '09:00', endTime: '10:00' });
    });

    it('only mentors of that course and division (or admins) can schedule', async () => {
      const wrongScope = await schedule(mentorS, { date: localDay(5), startTime: '10:00', endTime: '11:00' }).expect(403);
      expect(wrongScope.body.code).toBe('NOT_ASSIGNED_TO_SCOPE');
      await schedule(studentJ, { date: localDay(5), startTime: '10:00', endTime: '11:00' }).expect(403);
    });

    it.each([
      ['a start in the past', { date: localDay(-1), startTime: '10:00', endTime: '11:00' }, 'START_IN_PAST'],
      ['an end before the start', { date: day, startTime: '11:00', endTime: '10:00' }, 'INVALID_TIME_RANGE'],
      ['a zero-length session', { date: day, startTime: '11:00', endTime: '11:00' }, 'INVALID_TIME_RANGE'],
      ['more than 8 hours', { date: day, startTime: '06:00', endTime: '15:00' }, 'INVALID_TIME_RANGE'],
      ['an impossible date', { date: '2027-02-30', startTime: '10:00', endTime: '11:00' }, 'INVALID_DATE'],
      ['a malformed time', { date: day, startTime: '25:00', endTime: '26:00' }, 'VALIDATION_FAILED'],
      ['a missing end time', { date: day, startTime: '10:00' }, 'TIMES_REQUIRED'],
      ['no time at all', {}, 'TIMES_REQUIRED'],
      ['both time forms', { date: day, startTime: '10:00', endTime: '11:00', startsAt: new Date().toISOString() }, 'AMBIGUOUS_TIMES'],
      ['a date after the academic year', { date: '2027-08-15', startTime: '10:00', endTime: '11:00' }, 'OUTSIDE_ACADEMIC_YEAR'],
      ['a non-https link', { date: localDay(6), startTime: '10:00', endTime: '11:00', meetingUrl: 'http://zoom.us/j/1' }, 'VALIDATION_FAILED'],
      ['a provider that does not match the link', {
        date: localDay(6), startTime: '10:00', endTime: '11:00', provider: 'ZOOM', meetingUrl: 'https://meet.google.com/abc-defg-hij',
      }, 'PROVIDER_MISMATCH'],
    ])('rejects %s', async (_label, body, code) => {
      const res = await schedule(mentorJ, body).expect(400);
      expect(res.body.code).toBe(code);
    });

    it('rejects double-booking the host or the division, but allows back-to-back sessions', async () => {
      // Another mentor, same division, overlapping.
      const division = await schedule(mentorJ2, { date: day, startTime: '15:00', endTime: '16:00' }).expect(409);
      expect(division.body).toMatchObject({ code: 'SCHEDULE_CONFLICT', details: { sessionId } });
      // Same host, other division, overlapping.
      const host = await ctx.http().post('/api/v1/live-sessions').set(bearer(mentorJ)).send({
        courseId: ctx.ids.algebra, divisionId: ctx.ids.senior, title: 'Senior clinic',
        date: day, startTime: '13:00', endTime: '14:30', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      }).expect(409);
      expect(host.body.code).toBe('SCHEDULE_CONFLICT');

      const after = await schedule(mentorJ2, { date: day, startTime: '15:30', endTime: '16:30' }).expect(201);
      // A cancelled session frees its slot.
      await ctx.http().post(`/api/v1/live-sessions/${after.body.id}/cancel`).set(bearer(mentorJ2)).send({}).expect(200);
      await schedule(mentorJ2, { date: day, startTime: '15:30', endTime: '16:30' }).expect(201);
    });
  });

  describe('viewing', () => {
    it('students see their own division\'s sessions only, with dates, times and links', async () => {
      const list = await ctx.http().get('/api/v1/live-sessions').set(bearer(studentJ)).expect(200);
      expect(list.body.data.map((s: any) => s.id)).toContain(sessionId);
      expect(list.body.data[0]).toHaveProperty('meetingUrl');
      const senior = await ctx.http().get('/api/v1/live-sessions').set(bearer(studentS)).expect(200);
      expect(senior.body.data).toHaveLength(0);
      // Another division's session is indistinguishable from a missing one.
      await ctx.http().get(`/api/v1/live-sessions/${sessionId}`).set(bearer(studentS)).expect(404);
    });

    it('filters by calendar day', async () => {
      const onDay = await ctx.http().get('/api/v1/live-sessions').query({ from: day, to: day }).set(bearer(studentJ)).expect(200);
      expect(onDay.body.data.every((s: any) => s.date === day)).toBe(true);
      // Cancelled sessions stay on the calendar, marked as such.
      expect(onDay.body.data.map((s: any) => [s.startTime, s.status])).toEqual([
        ['14:00', 'SCHEDULED'], ['15:30', 'CANCELLED'], ['15:30', 'SCHEDULED'],
      ]);
      const nextDay = await ctx.http().get('/api/v1/live-sessions').query({ from: localDay(4), to: localDay(4) }).set(bearer(studentJ)).expect(200);
      expect(nextDay.body.data.map((s: any) => s.startTime)).toEqual(['09:00']);
      const reversed = await ctx.http().get('/api/v1/live-sessions').query({ from: localDay(4), to: day }).set(bearer(studentJ)).expect(400);
      expect(reversed.body.code).toBe('INVALID_TIME_RANGE');
    });

    it('a session in an unpublished course is hidden from students', async () => {
      await ctx.prisma.course.update({ where: { id: ctx.ids.algebra }, data: { status: 'DRAFT' } });
      try {
        await ctx.http().get(`/api/v1/live-sessions/${sessionId}`).set(bearer(studentJ)).expect(404);
        await ctx.http().get(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorJ)).expect(200);
      } finally {
        await ctx.prisma.course.update({ where: { id: ctx.ids.algebra }, data: { status: 'PUBLISHED' } });
      }
    });
  });

  describe('updating and cancelling', () => {
    it('mentors of the scope reschedule; students hear about changes that affect attending', async () => {
      const res = await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorJ2))
        .send({ startTime: '13:00', endTime: '14:00' }).expect(200);
      expect(res.body).toMatchObject({ date: day, startTime: '13:00', endTime: '14:00' });

      // A title change alone is not announced.
      await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorJ)).send({ title: 'Quadratics clinic (2)' }).expect(200);
      const link = await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorJ))
        .send({ meetingUrl: 'https://meet.google.com/xyz-abcd-efg' }).expect(200);
      expect(link.body.provider).toBe('GOOGLE_MEET');

      await waitForEvents();
      const updates = await notes(ctx.ids.studentJunior, 'live_session.updated');
      expect(updates).toHaveLength(2);
      expect(updates[0].title).toBe('Updated: Quadratics clinic');
    });

    it('updates are validated like new sessions and restricted to the scope', async () => {
      await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorS)).send({ title: 'Mine now' }).expect(403);
      await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(studentJ)).send({ title: 'x' }).expect(403);
      const range = await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorJ)).send({ endTime: '12:00' }).expect(400);
      expect(range.body.code).toBe('INVALID_TIME_RANGE');
      const provider = await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorJ)).send({ provider: 'ZOOM' }).expect(400);
      expect(provider.body.code).toBe('PROVIDER_MISMATCH');
      const empty = await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorJ)).send({}).expect(400);
      expect(empty.body.code).toBe('NO_CHANGES');
    });

    it('a session in progress keeps its time but its link can be fixed', async () => {
      const live = await ctx.prisma.liveSession.create({
        data: {
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year, hostId: ctx.ids.mentorJunior,
          title: 'Happening now', startsAt: new Date(Date.now() - 10 * 60_000), endsAt: new Date(Date.now() + 50 * 60_000),
          provider: 'ZOOM', meetingUrl: 'https://zoom.us/j/1',
        },
      });
      const view = await ctx.http().get(`/api/v1/live-sessions/${live.id}`).set(bearer(studentJ)).expect(200);
      expect(view.body.isLive).toBe(true);

      await ctx.http().patch(`/api/v1/live-sessions/${live.id}`).set(bearer(mentorJ)).send({ endTime: '23:00' }).expect(409);
      await ctx.http().patch(`/api/v1/live-sessions/${live.id}`).set(bearer(mentorJ)).send({ meetingUrl: 'https://zoom.us/j/2' }).expect(200);
    });

    it('cancelling records the reason, withholds the link from students and notifies them', async () => {
      const res = await ctx.http().post(`/api/v1/live-sessions/${sessionId}/cancel`).set(bearer(mentorJ))
        .send({ reason: 'Public holiday' }).expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Public holiday' });

      const forStudent = await ctx.http().get(`/api/v1/live-sessions/${sessionId}`).set(bearer(studentJ)).expect(200);
      expect(forStudent.body.meetingUrl).toBeNull();
      await ctx.http().post(`/api/v1/live-sessions/${sessionId}/cancel`).set(bearer(mentorJ)).send({}).expect(409);
      await ctx.http().patch(`/api/v1/live-sessions/${sessionId}`).set(bearer(mentorJ)).send({ title: 'Back on' }).expect(409);

      await waitForEvents();
      const cancelled = (await notes(ctx.ids.studentJunior, 'live_session.cancelled'))
        .find((n) => (n.data as { sessionId?: string }).sessionId === sessionId);
      expect(cancelled?.body).toContain('Public holiday');
    });

    it('finished sessions are completed by the worker and cannot be cancelled', async () => {
      const past = await ctx.prisma.liveSession.create({
        data: {
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year, hostId: ctx.ids.mentorJunior,
          title: 'Last week', startsAt: new Date(Date.now() - 7 * 86_400_000), endsAt: new Date(Date.now() - 7 * 86_400_000 + 3_600_000),
          provider: 'ZOOM', meetingUrl: 'https://zoom.us/j/3',
        },
      });
      const ended = await ctx.http().post(`/api/v1/live-sessions/${past.id}/cancel`).set(bearer(admin)).send({}).expect(409);
      expect(ended.body.code).toBe('INVALID_STATE_TRANSITION');

      expect(await ctx.app.get(LiveSessionsService).completeEnded()).toBeGreaterThanOrEqual(1);
      const history = await ctx.http().get('/api/v1/live-sessions').query({ upcoming: 'false' }).set(bearer(studentJ)).expect(200);
      expect(history.body.data.find((s: any) => s.id === past.id).status).toBe('COMPLETED');
    });
  });

  it('the platform hosts no video: there is nothing to join or stream', async () => {
    for (const path of ['join', 'stream', 'room']) {
      await ctx.http().get(`/api/v1/live-sessions/${sessionId}/${path}`).set(bearer(studentJ)).expect(404);
      await ctx.http().post(`/api/v1/live-sessions/${sessionId}/${path}`).set(bearer(studentJ)).send({}).expect(404);
    }
  });
});
