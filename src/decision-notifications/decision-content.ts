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
  TeacherStudentsAssigned:    'teacher.students.assigned',
  /** Test Management Phase 2: the student or teacher an individual deadline extension was granted to (told once). */
  TestExtensionGranted:       'test.extension.granted',
  /** Test Management Phase 3: a coach was given submissions to mark (told once per assignment action). Blind: no student. */
  TestMarkingAssigned:        'test.marking.assigned',
  /** Test Management Phase 3: a reviewer returned a coach's marking for correction (told once per return). Blind. */
  TestMarkingReturned:        'test.marking.returned',
  /** Test Management Phase 4: results published — the student (their own result) and each teacher of the student's school
   *  (once per publication, however many of their students). Never another student's data. */
  TestResultsPublished:       'test.results.published',
  /** Test Management Phase 4 (G6): a published result was withdrawn by an unlock — the student and the teachers of their
   *  school, once per withdrawal. */
  TestResultWithdrawn:        'test.result.withdrawn',
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

/** count: students newly assigned by one action (absent for a bulk operation, whose items finish one by one). Never names: students are minors. */
export interface StudentsAssignedPayload { activated: boolean; count?: number }

/**
 * test.extension.granted: the test (title, subject), the new deadline (ISO 8601) and who it is for: STUDENT (their own
 * deadline) or TEACHER (their submissions for the students of their schools). Never another student's data.
 */
export interface TestExtensionPayload {
  activated: boolean; testTitle: string; subjectName: string; deadline: string; audience: 'STUDENT' | 'TEACHER';
}

/**
 * test.marking.assigned / test.marking.returned (the coach who marks): the test (title, subject) and how many submissions
 * (assigned) — never a student's name, school or submission code beyond what the marking queue shows. Blind marking.
 */
export interface TestMarkingPayload { activated: boolean; testTitle: string; subjectName: string; count: number }

/**
 * test.results.published / test.result.withdrawn: the test (id for the link, title, subject) and who it is for —
 * STUDENT (their own result) or TEACHER (results of students of their school; a count at most). Never a mark, a rank, a
 * name or anything else about another student.
 */
export interface TestResultsPayload {
  activated: boolean; testId: string; testTitle: string; subjectName: string; audience: 'STUDENT' | 'TEACHER'; count?: number;
}

export type DecisionPayload =
  SchoolVerifiedPayload | ApprovedPayload | PermissionsGrantedPayload | StudentsAssignedPayload | TestExtensionPayload | TestMarkingPayload
  | TestResultsPayload;

/** The results page of the recipient's portal for one test (the in-app link and the e-mail button). */
export const resultsPageOf = (audience: 'STUDENT' | 'TEACHER', testId: string) =>
  (audience === 'STUDENT' ? `/student/results/${testId}` : `/teacher/results/${testId}`);

/** The coach's marking queue (the in-app link and the e-mail button). */
export const MARKING_QUEUE_PATH = '/mentor/marking';

/** A deadline as people in Rwanda read it (Kigali time). */
export function kigaliTime(iso: string): string {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso))} (Kigali time)`;
}

/** The tests page of the recipient's portal (the in-app link and the e-mail button). */
export const testsPageOf = (audience: 'STUDENT' | 'TEACHER') => (audience === 'STUDENT' ? '/student/tests' : '/teacher/tests');

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
  /** Frontend path the notification opens (optional). */
  link?: string;
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
          `${approved}\n\nBefore you can log in, please confirm your e-mail address: open the separate e-mail ` +
          `"Confirm your e-mail address" we have sent you and click its button.\n\n${ORG}`,
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
    case DecisionEvents.TeacherStudentsAssigned: {
      const p = payload as StudentsAssignedPayload;
      const subject = 'Students have been assigned to you';
      const what = p.count === undefined ? 'students' : p.count === 1 ? 'a student' : `${p.count} students`;
      return {
        subject, heading: subject, greeting,
        body:
          `An administrator has assigned ${what} to you on the ${ORG} platform. You can see them under My Students.\n\n${ORG}`,
        action: p.activated ? loginAction(appUrl) : undefined,
      };
    }
    case DecisionEvents.TestExtensionGranted: {
      const p = payload as TestExtensionPayload;
      const subject = `Deadline extended: ${p.testTitle}`;
      const whose = p.audience === 'STUDENT' ? 'your answers' : 'the answers you submit for the students of your school';
      const base = appUrl?.trim().replace(/\/+$/, '');
      return {
        subject, heading: subject, greeting,
        body:
          `The deadline for ${whose} to the ${p.subjectName} test "${p.testTitle}" has been extended to ${kigaliTime(p.deadline)}.\n\n` +
          `You can submit or replace them until then.\n\n${ORG}`,
        action: p.activated && base ? { label: 'Open my tests', url: `${base}${testsPageOf(p.audience)}` } : undefined,
      };
    }
    case DecisionEvents.TestMarkingAssigned:
    case DecisionEvents.TestMarkingReturned: {
      const p = payload as TestMarkingPayload;
      const assigned = type === DecisionEvents.TestMarkingAssigned;
      const subject = assigned ? `Submissions to mark: ${p.testTitle}` : `Marking returned for correction: ${p.testTitle}`;
      const what = p.count === 1 ? 'a submission' : `${p.count} submissions`;
      const base = appUrl?.trim().replace(/\/+$/, '');
      return {
        subject, heading: subject, greeting,
        body: assigned
          ? `You have been given ${what} of the ${p.subjectName} test "${p.testTitle}" to mark.

They are in your marking queue.

${ORG}`
          : `A reviewer returned your marking of ${what} of the ${p.subjectName} test "${p.testTitle}" for correction, with a comment.

It is back in your marking queue.

${ORG}`,
        action: p.activated && base ? { label: 'Open my marking queue', url: `${base}${MARKING_QUEUE_PATH}` } : undefined,
      };
    }
    case DecisionEvents.TestResultsPublished:
    case DecisionEvents.TestResultWithdrawn: {
      const p = payload as TestResultsPayload;
      const published = type === DecisionEvents.TestResultsPublished;
      const base = appUrl?.trim().replace(/\/+$/, '');
      const subject = published ? `Results published: ${p.testTitle}` : `Result withdrawn for review: ${p.testTitle}`;
      const body = p.audience === 'STUDENT'
        ? (published
          ? `Your result for the ${p.subjectName} test "${p.testTitle}" has been published.

You can see your marks and the markers' comments on your results page.`
          : `Your result for the ${p.subjectName} test "${p.testTitle}" has been withdrawn for review.

You will be told again when it is published.`)
        : (published
          ? `Results of the ${p.subjectName} test "${p.testTitle}" have been published for students of your school.

You can see them on the test's results page.`
          : `A result of the ${p.subjectName} test "${p.testTitle}" for a student of your school has been withdrawn for review.

It will be shown again once it is published.`);
      return {
        subject, heading: subject, greeting, body: `${body}

${ORG}`,
        action: p.activated && base ? { label: 'Open the results', url: `${base}${resultsPageOf(p.audience, p.testId)}` } : undefined,
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
    case DecisionEvents.TeacherStudentsAssigned: {
      const p = payload as StudentsAssignedPayload;
      const what = p.count === undefined ? 'students' : p.count === 1 ? 'a student' : `${p.count} students`;
      return { title: 'Students assigned to you', body: `An administrator assigned ${what} to you. See My Students.` };
    }
    case DecisionEvents.TestExtensionGranted: {
      const p = payload as TestExtensionPayload;
      const whose = p.audience === 'STUDENT' ? 'your deadline' : 'the deadline for your submissions';
      return {
        title: 'Deadline extended',
        body:  `${p.subjectName} test "${p.testTitle}": ${whose} is now ${kigaliTime(p.deadline)}.`,
        link:  testsPageOf(p.audience),
      };
    }
    case DecisionEvents.TestMarkingAssigned: {
      const p = payload as TestMarkingPayload;
      const what = p.count === 1 ? 'A submission' : `${p.count} submissions`;
      return { title: 'Submissions to mark', body: `${what} of the ${p.subjectName} test "${p.testTitle}" ${p.count === 1 ? 'is' : 'are'} in your marking queue.`, link: MARKING_QUEUE_PATH };
    }
    case DecisionEvents.TestMarkingReturned: {
      const p = payload as TestMarkingPayload;
      return { title: 'Marking returned for correction', body: `${p.subjectName} test "${p.testTitle}": a reviewer returned your marking with a comment.`, link: MARKING_QUEUE_PATH };
    }
    case DecisionEvents.TestResultsPublished: {
      const p = payload as TestResultsPayload;
      return {
        title: 'Results published',
        body: p.audience === 'STUDENT'
          ? `Your result for the ${p.subjectName} test "${p.testTitle}" is now available.`
          : `Results of the ${p.subjectName} test "${p.testTitle}" are now available for students of your school.`,
        link: resultsPageOf(p.audience, p.testId),
      };
    }
    case DecisionEvents.TestResultWithdrawn: {
      const p = payload as TestResultsPayload;
      return {
        title: 'Result withdrawn for review',
        body: p.audience === 'STUDENT'
          ? `Your result for the ${p.subjectName} test "${p.testTitle}" has been withdrawn for review.`
          : `A result of the ${p.subjectName} test "${p.testTitle}" for a student of your school has been withdrawn for review.`,
        link: resultsPageOf(p.audience, p.testId),
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
