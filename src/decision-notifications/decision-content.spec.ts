import { renderEmail } from '../email/templates.js';
import { DecisionEvents, SCHOOL_VERIFIED_SUBJECT, decisionEmail, decisionInApp, sanitiseError } from './decision-content.js';

const text = (mail: ReturnType<typeof decisionEmail>, brand = { organization: 'Rwanda Olympiad Foundation', contactEmail: 'info@rof.rw', appUrl: 'https://app.example.org/' }) =>
  renderEmail({ greeting: mail.greeting, heading: mail.heading, body: mail.body, action: mail.action }, brand).text;
const A_FIRST = 'We are pleased to inform you that your school, GS Remera, has been successfully verified and added to the Rwanda Olympiad Foundation\'s official school directory.';
const B_FIRST = 'We are pleased to inform you that your school, GS New Hill, has been successfully verified by the Rwanda Olympiad Foundation.';
const COMMON = 'Your school is now recognised as part of our growing Olympiad community.\n\nThank you for helping us expand opportunities for students across Rwanda!';
const SIGN_IN = 'You can sign in to your ROF LMS account to continue your Olympiad journey:';

const APP = 'https://app.example.org/';
const BRAND = { organization: 'Rwanda Olympiad Foundation', contactEmail: null, appUrl: APP };

describe('decision notification content', () => {
  it('school.request.verified, version A (official code) × teacher applicant: owner text, same subject, no signature line, no sign-in link', () => {
    const mail = decisionEmail(DecisionEvents.SchoolRequestVerified, 'Aline', { schoolName: 'GS Remera', officialDirectory: true, audience: 'TEACHER_APPLICANT' }, APP);
    expect(mail.subject).toBe('Your school is now part of the ROF Olympiad Community!');
    expect(mail.subject).toBe(SCHOOL_VERIFIED_SUBJECT);
    expect(mail.body).toBe(`${A_FIRST}\n\n${COMMON}`);
    expect(mail.action).toBeUndefined();
    const t = text(mail);
    expect(t).toContain(`Dear Aline,\n\n${A_FIRST}\n\n${COMMON}\n\n—\nRwanda Olympiad Foundation`);
    expect(t.match(/Rwanda Olympiad Foundation$/gm)).toHaveLength(1);       // the organisation once, in the footer
    expect(t).not.toMatch(/sign in|Sign in|\/login/);
  });

  it('school.request.verified, version A × student: the sign-in sentence and a "Sign in to ROF LMS" button to APP_URL/login', () => {
    const mail = decisionEmail(DecisionEvents.SchoolRequestVerified, 'Aline', { schoolName: 'GS Remera', officialDirectory: true, audience: 'STUDENT' }, APP);
    expect(mail.subject).toBe(SCHOOL_VERIFIED_SUBJECT);
    expect(mail.body).toBe(`${A_FIRST}\n\n${COMMON}\n\n${SIGN_IN}`);
    expect(mail.action).toEqual({ label: 'Sign in to ROF LMS', url: 'https://app.example.org/login' });
    expect(text(mail)).toContain(`${SIGN_IN}\n\nSign in to ROF LMS: https://app.example.org/login`);
    // Without a public APP_URL there is no link and no dangling sentence.
    const noUrl = decisionEmail(DecisionEvents.SchoolRequestVerified, 'Aline', { schoolName: 'GS Remera', audience: 'STUDENT' }, null);
    expect([noUrl.body.includes(SIGN_IN), noUrl.action]).toEqual([false, undefined]);
  });

  it('school.request.verified, version B (no official code) × student and × teacher applicant: only "verified by the Foundation", never the directory', () => {
    const student = decisionEmail(DecisionEvents.SchoolRequestVerified, 'Aline', { schoolName: 'GS New Hill', officialDirectory: false, audience: 'STUDENT' }, APP);
    expect(student.subject).toBe(SCHOOL_VERIFIED_SUBJECT);
    expect(student.body).toBe(`${B_FIRST}\n\n${COMMON}\n\n${SIGN_IN}`);
    expect(student.action).toEqual({ label: 'Sign in to ROF LMS', url: 'https://app.example.org/login' });
    const teacher = decisionEmail(DecisionEvents.SchoolRequestVerified, 'Eric', { schoolName: 'GS New Hill', officialDirectory: false, audience: 'TEACHER_APPLICANT' }, APP);
    expect(teacher.body).toBe(`${B_FIRST}\n\n${COMMON}`);
    expect(teacher.action).toBeUndefined();
    for (const m of [student, teacher]) expect(m.body).not.toMatch(/official school directory|added to/);
    // A row queued before the audience field existed: no link (treated as a teacher applicant).
    expect(decisionEmail(DecisionEvents.SchoolRequestVerified, 'Aline', { schoolName: 'GS New Hill', officialDirectory: false }, APP).action).toBeUndefined();
  });

  it('teacher / coach approved: "ready to use" and the login link only when the account is activated', () => {
    for (const [type, role] of [[DecisionEvents.TeacherApplicationApproved, 'Teacher'], [DecisionEvents.CoachApplicationApproved, 'Coach']] as const) {
      const active = decisionEmail(type, 'Eric', { activated: true }, APP);
      expect(active.greeting).toBe('Dear Eric,');
      expect(active.body).toContain(`as a ${role} has been approved`);
      expect(active.body).toContain('ready to use');
      expect(active.action).toEqual({ label: 'Log in', url: 'https://app.example.org/login' });

      const waiting = decisionEmail(type, 'Eric', { activated: false }, APP);
      expect(waiting.body).toContain('has been approved');
      expect(waiting.body).toContain('confirm your e-mail address');
      expect(waiting.body).not.toContain('ready to use');
      expect(waiting.action).toBeUndefined();
      expect(renderEmail({ greeting: waiting.greeting, body: waiting.body }, BRAND).text).not.toContain('/login');
    }
  });

  it('no login link without APP_URL', () => {
    expect(decisionEmail(DecisionEvents.TeacherApplicationApproved, 'Eric', { activated: true }, null).action).toBeUndefined();
  });

  it('permissions.granted lists every granted permission with its label and explanation (never the technical name)', () => {
    const payload = {
      activated: true,
      permissions: [
        { permission: 'students.viewProfile', label: 'View student profiles', description: 'You can open profiles.' },
        { permission: 'students.viewProgress', label: 'View student progress', description: 'You can see progress.' },
      ],
    };
    const mail = decisionEmail(DecisionEvents.PermissionsGranted, 'Grace', payload, APP);
    expect(mail.greeting).toBe('Dear Grace,');
    expect(mail.body).toContain('• View student profiles: You can open profiles.');
    expect(mail.body).toContain('• View student progress: You can see progress.');
    expect(mail.body).not.toContain('students.view');
    expect(mail.subject).toBe('You have been given new permissions');
    const inApp = decisionInApp(DecisionEvents.PermissionsGranted, payload);
    expect(inApp.body).toContain('View student profiles');
    expect(inApp.body).toContain('View student progress');
  });

  it('school.request.verified for a school without an official code: no claim that it was added to the official directory (L4)', () => {
    const mail = decisionEmail(DecisionEvents.SchoolRequestVerified, 'Aline', { schoolName: 'GS New Hill', officialDirectory: false }, APP);
    expect(mail.subject).toBe(SCHOOL_VERIFIED_SUBJECT);
    expect(mail.body).toContain('your school, GS New Hill, has been successfully verified by the Rwanda Olympiad Foundation.');
    expect(mail.body).not.toMatch(/official school directory/);
    expect(mail.body).toContain('Your school is now recognised as part of our growing Olympiad community.');
    const inApp = decisionInApp(DecisionEvents.SchoolRequestVerified, { schoolName: 'GS New Hill', officialDirectory: false });
    expect(inApp.body).toBe('Your school, GS New Hill, has been verified by the Rwanda Olympiad Foundation.');
    // A coded school (and rows queued before the field existed) keep the owner's text.
    for (const p of [{ schoolName: 'GS Remera', officialDirectory: true }, { schoolName: 'GS Remera' }]) {
      expect(decisionEmail(DecisionEvents.SchoolRequestVerified, 'Aline', p, APP).body).toContain('added to the Rwanda Olympiad Foundation');
      expect(decisionInApp(DecisionEvents.SchoolRequestVerified, p).body).toContain('official school directory');
    }
  });

  it('in-app texts exist for the account recipients', () => {
    expect(decisionInApp(DecisionEvents.SchoolRequestVerified, { schoolName: 'GS Remera' }).body).toContain('GS Remera');
    expect(decisionInApp(DecisionEvents.TeacherApplicationApproved, { activated: true }).title).toMatch(/approved/);
    expect(decisionInApp(DecisionEvents.CoachApplicationApproved, { activated: true }).title).toMatch(/approved/);
    expect(() => decisionInApp('other', {})).toThrow();
    expect(() => decisionEmail('other', 'X', {}, APP)).toThrow();
  });

  it('test.extension.granted (Test Management Phase 2): the test, the new deadline in Kigali time, a link to the right portal; no other student', () => {
    const payload = { activated: true, testTitle: 'Round 2', subjectName: 'Physics', deadline: '2026-12-10T08:30:00.000Z', audience: 'STUDENT' as const };
    const mail = decisionEmail(DecisionEvents.TestExtensionGranted, 'Aline', payload, APP);
    expect(mail.subject).toBe('Deadline extended: Round 2');
    expect(mail.body).toContain('The deadline for your answers to the Physics test "Round 2" has been extended to');
    expect(mail.body).toContain('10:30 (Kigali time)');
    expect(mail.action).toEqual({ label: 'Open my tests', url: 'https://app.example.org/student/tests' });
    const teacher = decisionEmail(DecisionEvents.TestExtensionGranted, 'Eric', { ...payload, audience: 'TEACHER' }, APP);
    expect(teacher.body).toContain('the answers you submit for the students of your school');
    expect(teacher.action?.url).toBe('https://app.example.org/teacher/tests');
    expect(decisionEmail(DecisionEvents.TestExtensionGranted, 'Aline', { ...payload, activated: false }, APP).action).toBeUndefined();
    const inApp = decisionInApp(DecisionEvents.TestExtensionGranted, payload);
    expect([inApp.title, inApp.link]).toEqual(['Deadline extended', '/student/tests']);
    expect(inApp.body).toContain('Physics test "Round 2": your deadline is now');
  });

  it('test.marking.assigned / returned (Test Management Phase 3): the test and a count, a link to the marking queue — never a student', () => {
    const payload = { activated: true, testTitle: 'Round 2', subjectName: 'Mathematics', count: 3 };
    const mail = decisionEmail(DecisionEvents.TestMarkingAssigned, 'Jean', payload, APP);
    expect(mail.subject).toBe('Submissions to mark: Round 2');
    expect(mail.body).toContain('You have been given 3 submissions of the Mathematics test "Round 2" to mark.');
    expect(mail.action).toEqual({ label: 'Open my marking queue', url: 'https://app.example.org/mentor/marking' });
    expect(decisionEmail(DecisionEvents.TestMarkingAssigned, 'Jean', { ...payload, count: 1 }, APP).body).toContain('given a submission of');
    const back = decisionEmail(DecisionEvents.TestMarkingReturned, 'Jean', { ...payload, count: 1 }, APP);
    expect(back.subject).toBe('Marking returned for correction: Round 2');
    expect(back.body).toContain('returned your marking of a submission');
    expect(decisionInApp(DecisionEvents.TestMarkingAssigned, payload)).toEqual({
      title: 'Submissions to mark', body: '3 submissions of the Mathematics test "Round 2" are in your marking queue.', link: '/mentor/marking',
    });
    expect(decisionInApp(DecisionEvents.TestMarkingReturned, payload).link).toBe('/mentor/marking');
    expect(decisionEmail(DecisionEvents.TestMarkingAssigned, 'Jean', { ...payload, activated: false }, APP).action).toBeUndefined();
  });

  it('test.results.published / test.result.withdrawn (Test Management Phase 4): the test and a link to the results page — never a mark, a rank or another student', () => {
    const payload = { activated: true, testId: 't-1', testTitle: 'Round 2', subjectName: 'Physics', audience: 'STUDENT' as const };
    const mail = decisionEmail(DecisionEvents.TestResultsPublished, 'Aline', payload, APP);
    expect(mail.subject).toBe('Results published: Round 2');
    expect(mail.body).toContain('Your result for the Physics test "Round 2" has been published.');
    expect(mail.action).toEqual({ label: 'Open the results', url: 'https://app.example.org/student/results/t-1' });
    expect(decisionInApp(DecisionEvents.TestResultsPublished, payload)).toEqual({
      title: 'Results published', body: 'Your result for the Physics test "Round 2" is now available.', link: '/student/results/t-1',
    });
    const teacher = { ...payload, audience: 'TEACHER' as const, count: 12 };
    const tm = decisionEmail(DecisionEvents.TestResultsPublished, 'Jean', teacher, APP);
    expect(tm.body).toContain('have been published for students of your school');
    expect(tm.action?.url).toBe('https://app.example.org/teacher/results/t-1');
    expect(decisionInApp(DecisionEvents.TestResultsPublished, teacher).link).toBe('/teacher/results/t-1');
    const w = decisionEmail(DecisionEvents.TestResultWithdrawn, 'Aline', payload, APP);
    expect(w.subject).toBe('Result withdrawn for review: Round 2');
    expect(w.body).toContain('has been withdrawn for review');
    expect(decisionInApp(DecisionEvents.TestResultWithdrawn, teacher).body).toContain('a student of your school');
    // Nothing about any student: no number that could be a mark, no name, no rank — only the test and the recipient.
    for (const t of [mail, tm, w]) {
      const text = `${t.subject} ${t.heading} ${t.body}`;
      expect(text).not.toMatch(/(rank|ranked|position|marks? of|\d+ ?\/ ?\d+)/i);
      expect(text).not.toContain('12');
    }
    expect(decisionEmail(DecisionEvents.TestResultsPublished, 'Aline', { ...payload, activated: false }, APP).action).toBeUndefined();
  });

  it('sanitiseError strips addresses, keys, tokens and long ids, and bounds the length', () => {
    const out = sanitiseError('Resend 422 validation_error: jean@example.org with key re_abc123XYZ Bearer eyJhbGciOi.x.y ' +
      'https://x.test/a?token=SECRET123&b=1 id 3f2b8c1e-4d5a-4b6c-9d7e-112233445566');
    expect(out).not.toMatch(/jean@example\.org|re_abc123XYZ|eyJhbGciOi|SECRET123|3f2b8c1e-4d5a/);
    expect(out).toContain('[address]');
    expect(sanitiseError('x'.repeat(2000)).length).toBeLessThanOrEqual(500);
    expect(sanitiseError(new Error('boom'))).toBe('boom');
    expect(sanitiseError('')).toBe('Unknown error.');
  });
});
