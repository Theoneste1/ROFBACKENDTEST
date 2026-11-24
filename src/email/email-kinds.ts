/**
 * What a queued e-mail is, how urgent it is, and how long its one-time link lives (Resend Free plan, docs/EMAIL.md §10).
 *
 * Every e-mail the platform sends is one of these kinds. New rows carry `kind` and `priority`; rows queued before the
 * email-free-plan migration have neither, so `classifyLegacy` derives them from the subject (the titles below are the
 * exact titles the code uses) — never guessing a link-carrying kind it cannot recognise.
 */
import type { EmailPriority } from '../generated/prisma/client.js';
import { DecisionEvents, type DecisionEventType } from '../decision-notifications/decision-content.js';

export const EmailKinds = {
  PasswordReset:          'PASSWORD_RESET',
  Invitation:             'INVITATION',
  EmailVerification:      'EMAIL_VERIFICATION',
  PasswordChanged:        'PASSWORD_CHANGED',
  SecurityNotice:         'SECURITY_NOTICE',
  ApplicationApproved:    'APPLICATION_APPROVED',
  ApplicationDecision:    'APPLICATION_DECISION',
  ApplicationInfoRequest: 'APPLICATION_INFO_REQUEST',
  AccountApproved:        'ACCOUNT_APPROVED',
  Welcome:                'WELCOME',
  SubscriberWelcome:      'SUBSCRIBER_WELCOME',
  ContactForm:            'CONTACT_FORM',
  Notification:           'NOTIFICATION',
  MailingTest:            'MAILING_TEST',
  BulkEmail:              'BULK_EMAIL',
  Mailing:                'MAILING',
  Other:                  'OTHER',
} as const;

export type EmailKind = (typeof EmailKinds)[keyof typeof EmailKinds];

/** The priority of each kind. CRITICAL: the person cannot get in (or must know about a security change) without it. */
export const KIND_PRIORITY: Record<EmailKind, EmailPriority> = {
  PASSWORD_RESET:           'CRITICAL',
  INVITATION:               'CRITICAL',
  EMAIL_VERIFICATION:       'CRITICAL',
  PASSWORD_CHANGED:         'CRITICAL',
  SECURITY_NOTICE:          'CRITICAL',
  APPLICATION_APPROVED:     'CRITICAL',
  APPLICATION_DECISION:     'NORMAL',
  APPLICATION_INFO_REQUEST: 'NORMAL',
  ACCOUNT_APPROVED:         'NORMAL',
  WELCOME:                  'NORMAL',
  SUBSCRIBER_WELCOME:       'NORMAL',
  CONTACT_FORM:             'NORMAL',
  NOTIFICATION:             'NORMAL',
  MAILING_TEST:             'NORMAL',
  BULK_EMAIL:               'BULK',
  MAILING:                  'BULK',
  OTHER:                    'NORMAL',
};

/** Kinds whose e-mail carries a one-time account link: checked just before sending, discarded when the link is dead. */
export const LINK_KINDS: readonly EmailKind[] = ['PASSWORD_RESET', 'INVITATION', 'EMAIL_VERIFICATION'];

/** Link lifetimes (the same values as src/auth: RESET_TOKEN_TTL_MS and ACTIVATION_TTL_MS). */
export const LINK_TTL_MS: Partial<Record<EmailKind, number>> = {
  PASSWORD_RESET:     30 * 60 * 1000,
  INVITATION:         7 * 24 * 60 * 60 * 1000,
  EMAIL_VERIFICATION: 48 * 60 * 60 * 1000,
};

export const PRIORITIES: readonly EmailPriority[] = ['CRITICAL', 'NORMAL', 'BULK'];

/** Decision notifications (NotificationOutbox): approvals and grants are CRITICAL; a results publication is BULK. */
export function decisionPriority(type: string): EmailPriority {
  switch (type as DecisionEventType) {
    case DecisionEvents.SchoolRequestVerified:
    case DecisionEvents.TeacherApplicationApproved:
    case DecisionEvents.CoachApplicationApproved:
    case DecisionEvents.PermissionsGranted:
      return 'CRITICAL';
    case DecisionEvents.TestResultsPublished:
      return 'BULK';
    default:
      return 'NORMAL';
  }
}

/** "[ROF LMS] Reset your password" → "Reset your password" (the platform-name prefix added by NotificationsService). */
export function subjectTitle(subject: string | null): string {
  return (subject ?? '').replace(/^\[[^\]]*\]\s*/, '').trim();
}

/** The kind of a row queued before kinds existed, from its subject (exact titles), bulk job and subscriber. */
export function classifyLegacy(row: { subject: string | null; jobId: string | null; subscriberId: string | null }): EmailKind {
  if (row.jobId) return row.subscriberId ? 'MAILING' : 'BULK_EMAIL';
  const raw = (row.subject ?? '').trim();
  if (raw.startsWith('[Test] ')) return 'MAILING_TEST';
  if (row.subscriberId) return 'SUBSCRIBER_WELCOME';
  const title = subjectTitle(row.subject);
  switch (title) {
    case 'Reset your password':           return 'PASSWORD_RESET';
    case 'Activate your account':         return 'INVITATION';
    case 'Confirm your e-mail address':   return 'EMAIL_VERIFICATION';
    case 'Your password was changed':     return 'PASSWORD_CHANGED';
    case 'Super Administrator change':    return 'SECURITY_NOTICE';
    case 'Your account has been approved': return 'ACCOUNT_APPROVED';
    case 'Your coach application was approved': return 'APPLICATION_APPROVED';
    case 'Your teacher application':
    case 'Your coach application':        return 'APPLICATION_DECISION';
    case 'You are subscribed to Rwanda Olympiad Foundation news': return 'SUBSCRIBER_WELCOME';
  }
  if (title.startsWith('Welcome to ')) return 'WELCOME';
  if (title.startsWith('More information needed for your ')) return 'APPLICATION_INFO_REQUEST';
  if (title.startsWith('Contact form: ')) return 'CONTACT_FORM';
  return 'NOTIFICATION';
}

export const priorityOf = (kind: string | null | undefined): EmailPriority =>
  KIND_PRIORITY[(kind ?? 'OTHER') as EmailKind] ?? 'NORMAL';
