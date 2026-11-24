import { KIND_PRIORITY, LINK_KINDS, LINK_TTL_MS, classifyLegacy, decisionPriority, priorityOf, subjectTitle } from './email-kinds.js';
import { ACTIVATION_TTL_MS } from '../auth/activation.service.js';

const row = (subject: string | null, extra: { jobId?: string; subscriberId?: string } = {}) =>
  ({ subject, jobId: extra.jobId ?? null, subscriberId: extra.subscriberId ?? null });

describe('e-mail kinds and priorities (Resend Free plan)', () => {
  it('CRITICAL: resets, invitations, confirmations, security notices, approvals; BULK: bulk e-mails and mailings', () => {
    for (const k of ['PASSWORD_RESET', 'INVITATION', 'EMAIL_VERIFICATION', 'PASSWORD_CHANGED', 'SECURITY_NOTICE', 'APPLICATION_APPROVED'] as const) {
      expect(KIND_PRIORITY[k]).toBe('CRITICAL');
    }
    for (const k of ['WELCOME', 'SUBSCRIBER_WELCOME', 'NOTIFICATION', 'APPLICATION_DECISION', 'ACCOUNT_APPROVED'] as const) expect(KIND_PRIORITY[k]).toBe('NORMAL');
    expect(KIND_PRIORITY.BULK_EMAIL).toBe('BULK');
    expect(KIND_PRIORITY.MAILING).toBe('BULK');
    expect(priorityOf(null)).toBe('NORMAL');
    expect(priorityOf('SOMETHING_NEW')).toBe('NORMAL');
  });

  it('link lifetimes match the auth code (reset 30 min, verification 48 h, invitation 7 days)', () => {
    expect(LINK_TTL_MS.PASSWORD_RESET).toBe(30 * 60_000);
    expect(LINK_TTL_MS.INVITATION).toBe(ACTIVATION_TTL_MS.INVITATION);
    expect(LINK_TTL_MS.EMAIL_VERIFICATION).toBe(ACTIVATION_TTL_MS.EMAIL_VERIFICATION);
    expect([...LINK_KINDS].sort()).toEqual(['EMAIL_VERIFICATION', 'INVITATION', 'PASSWORD_RESET']);
  });

  it('legacy rows are classified from the exact subjects the code writes (platform prefix ignored)', () => {
    expect(subjectTitle('[ROF LMS] Reset your password')).toBe('Reset your password');
    expect(classifyLegacy(row('[ROF LMS] Reset your password'))).toBe('PASSWORD_RESET');
    expect(classifyLegacy(row('[ROF LMS] Confirm your e-mail address'))).toBe('EMAIL_VERIFICATION');
    expect(classifyLegacy(row('[ROF LMS] Activate your account'))).toBe('INVITATION');
    expect(classifyLegacy(row('[ROF LMS] Welcome to ROF LMS'))).toBe('WELCOME');
    expect(classifyLegacy(row('[ROF LMS] Your teacher application'))).toBe('APPLICATION_DECISION');
    expect(classifyLegacy(row('[ROF LMS] Your password was changed'))).toBe('PASSWORD_CHANGED');
    expect(classifyLegacy(row('[ROF LMS] Your coach application was approved'))).toBe('APPLICATION_APPROVED');
    expect(classifyLegacy(row('You are subscribed to Rwanda Olympiad Foundation news', { subscriberId: 's1' }))).toBe('SUBSCRIBER_WELCOME');
    expect(classifyLegacy(row('You are subscribed to Rwanda Olympiad Foundation news'))).toBe('SUBSCRIBER_WELCOME');
    expect(classifyLegacy(row(null, { jobId: 'j1' }))).toBe('BULK_EMAIL');
    expect(classifyLegacy(row(null, { jobId: 'j1', subscriberId: 's1' }))).toBe('MAILING');
    expect(classifyLegacy(row('[Test] Our news'))).toBe('MAILING_TEST');
    // Anything unrecognised is an ordinary notice — never guessed to be a link e-mail (which could be discarded).
    expect(classifyLegacy(row('[ROF LMS] New assignment: Algebra'))).toBe('NOTIFICATION');
    expect(classifyLegacy(row('Reset your password soon'))).toBe('NOTIFICATION');
  });

  it('decision notices: approvals and grants CRITICAL, results publications BULK, others NORMAL', () => {
    expect(decisionPriority('teacher.application.approved')).toBe('CRITICAL');
    expect(decisionPriority('coach.application.approved')).toBe('CRITICAL');
    expect(decisionPriority('school.request.verified')).toBe('CRITICAL');
    expect(decisionPriority('permissions.granted')).toBe('CRITICAL');
    expect(decisionPriority('test.results.published')).toBe('BULK');
    expect(decisionPriority('teacher.students.assigned')).toBe('NORMAL');
  });
});
