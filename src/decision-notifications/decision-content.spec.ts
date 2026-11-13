import { renderEmail } from '../email/templates.js';
import { DecisionEvents, SCHOOL_VERIFIED_SUBJECT, decisionEmail, decisionInApp, sanitiseError } from './decision-content.js';

const APP = 'https://app.example.org/';
const BRAND = { organization: 'Rwanda Olympiad Foundation', contactEmail: null, appUrl: APP };

describe('decision notification content', () => {
  it('school.request.verified: the owner text, word for word, with the stored first name and the official name', () => {
    const mail = decisionEmail(DecisionEvents.SchoolRequestVerified, 'Aline', { schoolName: 'GS Remera' }, APP);
    expect(mail.subject).toBe('Your school is now part of the ROF Olympiad Community!');
    expect(mail.subject).toBe(SCHOOL_VERIFIED_SUBJECT);
    const text = renderEmail({ greeting: mail.greeting, heading: mail.heading, body: mail.body, action: mail.action }, BRAND).text;
    expect(text).toContain(
      'Dear Aline,\n\nWe are pleased to inform you that your school, GS Remera, has been successfully verified and added to the ' +
      'Rwanda Olympiad Foundation\'s official school directory.\n\nYour school is now recognised as part of our growing Olympiad ' +
      'community.\n\nThank you for helping us expand opportunities for students across Rwanda!\n\nRwanda Olympiad Foundation');
    expect(text).not.toMatch(/Hello|Applicant|approved/i);
    expect(mail.action).toBeUndefined();
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

  it('in-app texts exist for the account recipients', () => {
    expect(decisionInApp(DecisionEvents.SchoolRequestVerified, { schoolName: 'GS Remera' }).body).toContain('GS Remera');
    expect(decisionInApp(DecisionEvents.TeacherApplicationApproved, { activated: true }).title).toMatch(/approved/);
    expect(decisionInApp(DecisionEvents.CoachApplicationApproved, { activated: true }).title).toMatch(/approved/);
    expect(() => decisionInApp('other', {})).toThrow();
    expect(() => decisionEmail('other', 'X', {}, APP)).toThrow();
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
