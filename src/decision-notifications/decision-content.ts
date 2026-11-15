/**
 * What each decision notification says (owner-approved contract). Pure functions: the outbox row's
 * stored first name and payload in, the e-mail and the in-app notification out. Never a password,
 * token, internal id or anyone else's data.
 */
import type { EmailAction } from '../email/templates.js';

export const DecisionEvents = {
  SchoolRequestVerified:      'school.request.verified',
  TeacherApplicationApproved: 'teacher.application.approved',
  CoachApplicationApproved:   'coach.application.approved',
  PermissionsGranted:         'permissions.granted',
} as const;

export type DecisionEventType = (typeof DecisionEvents)[keyof typeof DecisionEvents];

export const DECISION_EVENT_TYPES: readonly DecisionEventType[] = Object.values(DecisionEvents);

/**
 * `officialDirectory`: the linked school has an official code, so it is in the public directory
 * (PUBLIC_DIRECTORY). Absent (rows queued before this field existed) counts as true.
 * `audience`: STUDENT (a student's school claim; the e-mail adds a sign-in link) or TEACHER_APPLICANT
 * (no account yet; no link). Absent counts as TEACHER_APPLICANT (no link).
 */
export interface SchoolVerifiedPayload { schoolName: string; officialDirectory?: boolean; audience?: 'STUDENT' | 'TEACHER_APPLICANT' }
/** activated: the account could log in when the notice was queued (activatedAt set). */
export interface ApprovedPayload { activated: boolean }
export interface PermissionsGrantedPayload {
  activated:   boolean;
  permissions: Array<{ permission: string; label: string; description: string }>;
}

export type DecisionPayload = SchoolVerifiedPayload | ApprovedPayload | PermissionsGrantedPayload;

export interface DecisionEmail {
  subject:  string;
  heading:  string;
  greeting: string;
  body:     string;
  action?:  EmailAction;
}

export interface DecisionInApp {
  title: string;
  body:  string;
}

export const SCHOOL_VERIFIED_SUBJECT = 'Your school is now part of the ROF Olympiad Community!';

const ORG = 'Rwanda Olympiad Foundation';

const loginAction = (appUrl: string | null | undefined, label = 'Log in'): EmailAction | undefined => {
  const base = appUrl?.trim().replace(/\/+$/, '');
  return base ? { label, url: `${base}/login` } : undefined;
};

/** The students' sign-in line (owner wording); the button carries the link to APP_URL/login. */
export const SCHOOL_VERIFIED_SIGN_IN = 'You can sign in to your ROF LMS account to continue your Olympiad journey:';
export const SCHOOL_VERIFIED_SIGN_IN_LABEL = 'Sign in to ROF LMS';

/** The e-mail for an outbox row. `appUrl` is APP_URL (the login link is only added when the account is activated). */
export function decisionEmail(type: string, firstName: string, payload: unknown, appUrl: string | null | undefined): DecisionEmail {
  const greeting = `Dear ${firstName},`;
  switch (type) {
    case DecisionEvents.SchoolRequestVerified: {
      const p = payload as SchoolVerifiedPayload;
      // The owner's text, word for word ("Dear {firstName}," is the greeting line); owner decisions
      // 2026-11-14: version A (official code) says the school was added to the official directory;
      // version B (no code) only that it was verified. The same subject for both. No signature line:
      // the branded template's footer names the organisation once. Students (who have an account) get
      // a sign-in link to APP_URL; teacher applicants (no account yet) do not.
      const verified = p.officialDirectory === false
        ? `We are pleased to inform you that your school, ${p.schoolName}, has been successfully verified by the ` +
          'Rwanda Olympiad Foundation.\n\n'
        : `We are pleased to inform you that your school, ${p.schoolName}, has been successfully verified and added to the ` +
          'Rwanda Olympiad Foundation\'s official school directory.\n\n';
      const signIn = p.audience === 'STUDENT' ? loginAction(appUrl, SCHOOL_VERIFIED_SIGN_IN_LABEL) : undefined;
      return {
        subject: SCHOOL_VERIFIED_SUBJECT, heading: SCHOOL_VERIFIED_SUBJECT, greeting,
        body:
          verified +
          'Your school is now recognised as part of our growing Olympiad community.\n\n' +
          'Thank you for helping us expand opportunities for students across Rwanda!' +
          (signIn ? `\n\n${SCHOOL_VERIFIED_SIGN_IN}` : ''),
        ...(signIn && { action: signIn }),
      };
    }
    case DecisionEvents.TeacherApplicationApproved:
    case DecisionEvents.CoachApplicationApproved: {
      const p = payload as ApprovedPayload;
      const role = type === DecisionEvents.TeacherApplicationApproved ? 'Teacher' : 'Coach';
      const subject = `Your ${role.toLowerCase()} application has been approved`;
      const approved = `We are pleased to inform you that your application to join the ${ORG} platform as a ${role} has been approved.`;
      if (p.activated) {
        return {
          subject, heading: subject, greeting,
          body: `${approved}\n\nYour account is ready to use: log in with the username and password you chose when you applied.\n\n${ORG}`,
          action: loginAction(appUrl),
        };
      }
      return {
        subject, heading: subject, greeting,
        body:
          `${approved}\n\nBefore you can log in, please confirm your e-mail address with the link in the separate ` +
          `activation message we have sent you.\n\n${ORG}`,
      };
    }
    case DecisionEvents.PermissionsGranted: {
      const p = payload as PermissionsGrantedPayload;
      const several = p.permissions.length > 1;
      const subject = several ? 'You have been given new permissions' : 'You have been given a new permission';
      const list = p.permissions.map((g) => `• ${g.label}: ${g.description}`).join('\n');
      return {
        subject, heading: subject, greeting,
        body:
          `An administrator has given you the following ${several ? 'permissions' : 'permission'} on the ${ORG} platform:\n\n` +
          `${list}\n\n${several ? 'They apply' : 'It applies'} the next time you use the platform.\n\n${ORG}`,
        action: p.activated ? loginAction(appUrl) : undefined,
      };
    }
    default:
      throw new Error(`Unknown decision notification type "${type}".`);
  }
}

/** The in-app notification (recipients with an account). */
export function decisionInApp(type: string, payload: unknown): DecisionInApp {
  switch (type) {
    case DecisionEvents.SchoolRequestVerified: {
      const p = payload as SchoolVerifiedPayload;
      return {
        title: 'Your school has been verified',
        body:  p.officialDirectory === false
          ? `Your school, ${p.schoolName}, has been verified by the ${ORG}.`
          : `Your school, ${p.schoolName}, has been verified and added to the ${ORG}'s official school directory.`,
      };
    }
    case DecisionEvents.TeacherApplicationApproved:
      return { title: 'Your teacher application was approved', body: 'Welcome! Your application to join as a Teacher has been approved.' };
    case DecisionEvents.CoachApplicationApproved:
      return { title: 'Your coach application was approved', body: 'Welcome! Your application to join as a Coach has been approved.' };
    case DecisionEvents.PermissionsGranted: {
      const p = payload as PermissionsGrantedPayload;
      return {
        title: p.permissions.length > 1 ? 'New permissions' : 'New permission',
        body:  `An administrator gave you: ${p.permissions.map((g) => `${g.label} (${g.description})`).join('; ')}`,
      };
    }
    default:
      throw new Error(`Unknown decision notification type "${type}".`);
  }
}

/**
 * lastError as stored and shown in the delivery log: no e-mail addresses, API keys, bearer tokens,
 * secrets in URLs or long opaque strings (ids, tokens); one line, at most 500 characters.
 */
export function sanitiseError(message: unknown): string {
  const text = String(message instanceof Error ? message.message : message ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[address]')
    .replace(/\bre_[A-Za-z0-9_]+/g, '[key]')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/([?&;](?:token|key|api_key|apikey|secret|password|code|signature)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || 'Unknown error.').slice(0, 500);
}
