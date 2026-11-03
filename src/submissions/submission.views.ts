/**
 * Role-specific projections of a submission.
 *
 *   STUDENT — never sees a score, feedback or mentor before PUBLISHED, and never
 *             sees internal coordination notes or unpublished review cycles.
 *   MENTOR  — sees the work, the student's name and the current review cycle
 *             (including why the admin sent it back); never the admin's
 *             internal coordination note.
 *   ADMIN   — everything, including the full review history.
 */
import { ATTACHMENT_SELECT } from '../common/storage/attachments.js';
import { deriveStudentDisplayStatus } from './student-display-status.js';

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;

const REVIEW_SELECT = {
  id: true, cycle: true, status: true,
  score: true, percentage: true, feedback: true,
  assignedAt: true, startedAt: true, markedAt: true, returnedAt: true,
  decidedAt: true, decisionNote: true, coordinationNote: true, publishedAt: true,
  mentor:      PERSON,
  attachments: { orderBy: { sortOrder: 'asc' as const }, select: ATTACHMENT_SELECT },
} as const;

export const SUBMISSION_INCLUDE = {
  assignment: {
    select: {
      id: true, title: true, maximumMarks: true, points: true, deadline: true,
      allowResubmission: true, maxResubmissions: true, courseId: true, divisionId: true, status: true,
      course:   { select: { id: true, code: true, title: true } },
      division: { select: { id: true, code: true, name: true } },
    },
  },
  student: { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true } },
  revisions: {
    orderBy: { revisionNumber: 'asc' as const },
    select:  {
      id: true, revisionNumber: true, note: true, isLate: true, submittedAt: true,
      attachments: { orderBy: { sortOrder: 'asc' as const }, select: ATTACHMENT_SELECT },
    },
  },
  currentReview:   { select: REVIEW_SELECT },
  publishedReview: { select: REVIEW_SELECT },
  resultRelease:   { select: { id: true, publishedAt: true } },
} as const;

/** Full review history (admins). */
export const REVIEW_HISTORY_SELECT = {
  ...REVIEW_SELECT,
  assignedBy:        PERSON,
  decidedBy:         PERSON,
  distributionBatch: { select: { id: true, strategy: true, createdAt: true } },
  events: {
    orderBy: { createdAt: 'asc' as const },
    select:  { id: true, type: true, score: true, note: true, createdAt: true, actor: PERSON },
  },
} as const;

type Attachment = { id: string; sortOrder: number; file: { id: string; originalName: string; mimeType: string; size: number } };
type Review = {
  id: string; cycle: number; status: string;
  score: number | null; percentage: number | null; feedback: string | null;
  assignedAt: Date; startedAt: Date | null; markedAt: Date | null; returnedAt: Date | null;
  decidedAt: Date | null; decisionNote: string | null; coordinationNote: string | null; publishedAt: Date | null;
  mentor: { id: string; username: string; firstName: string; lastName: string };
  attachments: Attachment[];
};

/** Shape returned by `findMany/findUnique({ include: SUBMISSION_INCLUDE })`. */
export type SubmissionWithRelations = {
  id: string;
  status: string;
  assignmentId: string;
  studentId: string;
  revisionCount: number;
  isLate: boolean;
  submittedAt: Date | null;
  pointsAwarded: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  assignment: { id: string; title: string; maximumMarks: number; points: number; deadline: Date; [k: string]: unknown };
  student: { id: string; firstName: string; lastName: string; [k: string]: unknown };
  revisions: Array<{ id: string; revisionNumber: number; note: string | null; isLate: boolean; submittedAt: Date; attachments: Attachment[] }>;
  currentReview: Review | null;
  publishedReview: Review | null;
  resultRelease: { id: string; publishedAt: Date } | null;
};

const latestFiles = (s: SubmissionWithRelations) => s.revisions[s.revisions.length - 1]?.attachments ?? [];

const base = (s: SubmissionWithRelations) => ({
  id:            s.id,
  status:        s.status,
  assignment:    s.assignment,
  files:         latestFiles(s),
  revisionCount: s.revisionCount,
  isLate:        s.isLate,
  submittedAt:   s.submittedAt,
  revisions:     s.revisions,
  createdAt:     s.createdAt,
});

export function studentView(s: SubmissionWithRelations, hasViewed = true) {
  const view = {
    ...base(s),
    displayStatus: deriveStudentDisplayStatus({ hasViewed, submissionStatus: s.status }),
  };
  const r = s.publishedReview;
  if (s.status !== 'PUBLISHED' || !r) return view;

  return {
    ...view,
    result: {
      score:          r.score,
      maximumMarks:   s.assignment.maximumMarks,
      percentage:     r.percentage,
      pointsAwarded:  s.pointsAwarded,
      mentorFeedback: r.feedback,
      feedbackFiles:  r.attachments,
      mentor:         { firstName: r.mentor.firstName, lastName: r.mentor.lastName },
      publishedAt:    s.publishedAt,
    },
  };
}

export function mentorView(s: SubmissionWithRelations) {
  const r = s.currentReview;
  return {
    ...base(s),
    student: s.student,
    review: r && {
      id: r.id, cycle: r.cycle, status: r.status,
      score: r.score, percentage: r.percentage, feedback: r.feedback, attachments: r.attachments,
      assignedAt: r.assignedAt, startedAt: r.startedAt, markedAt: r.markedAt, returnedAt: r.returnedAt,
      /** Why the administrator sent the review back, if they did. */
      decisionNote: r.decisionNote,
    },
  };
}

export function adminView(s: SubmissionWithRelations) {
  return {
    ...base(s),
    student:         s.student,
    pointsAwarded:   s.pointsAwarded,
    publishedAt:     s.publishedAt,
    resultRelease:   s.resultRelease,
    review:          s.currentReview,
    publishedReview: s.publishedReview,
  };
}
