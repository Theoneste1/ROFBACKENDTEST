/**
 * Role-specific projections of a submission.
 *
 *   STUDENT — never sees a score, feedback or mentor before PUBLISHED, and never
 *             sees internal coordination notes.
 *   MENTOR  — sees the work and their own review, plus why the admin returned it;
 *             not the admin's internal coordination note.
 *   ADMIN   — everything.
 */
import { deriveStudentDisplayStatus } from './student-display-status.js';

const FILE = { select: { id: true, originalName: true, mimeType: true, size: true } } as const;

export const SUBMISSION_INCLUDE = {
  assignment: {
    select: {
      id: true, title: true, maximumMarks: true, points: true, deadline: true,
      allowResubmission: true, maxResubmissions: true, courseId: true, divisionId: true,
      course:   { select: { id: true, code: true, title: true } },
      division: { select: { id: true, code: true, name: true } },
    },
  },
  student:      { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true } },
  mentor:       { select: { id: true, username: true, firstName: true, lastName: true } },
  reopenedBy:   { select: { id: true, username: true } },
  file:         FILE,
  feedbackFile: FILE,
  revisions: {
    orderBy: { revisionNumber: 'asc' },
    select:  { revisionNumber: true, note: true, isLate: true, submittedAt: true, file: FILE },
  },
} as const;

/** Shape returned by `findMany/findUnique({ include: SUBMISSION_INCLUDE })`. */
export type SubmissionWithRelations = {
  id: string;
  status: string;
  revisionCount: number;
  isLate: boolean;
  score: number | null;
  percentage: number | null;
  mentorFeedback: string | null;
  coordinationNote: string | null;
  rejectionReason: string | null;
  pointsAwarded: number;
  previousScore: number | null;
  reopenNote: string | null;
  reopenedAt: Date | null;
  submittedAt: Date | null;
  assignedAt: Date | null;
  reviewStartedAt: Date | null;
  markedAt: Date | null;
  submittedToAdminAt: Date | null;
  approvedAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  assignment: { id: string; title: string; maximumMarks: number; points: number; deadline: Date; [k: string]: unknown };
  student: { id: string; firstName: string; lastName: string; [k: string]: unknown };
  mentor: { id: string; firstName: string; lastName: string; [k: string]: unknown } | null;
  reopenedBy: { id: string; username: string } | null;
  file: unknown;
  feedbackFile: unknown;
  revisions: unknown[];
};

export function studentView(s: SubmissionWithRelations, hasViewed = true) {
  const base = {
    id:            s.id,
    status:        s.status,
    displayStatus: deriveStudentDisplayStatus({ hasViewed, submissionStatus: s.status }),
    assignment:    s.assignment,
    file:          s.file,
    revisionCount: s.revisionCount,
    isLate:        s.isLate,
    submittedAt:   s.submittedAt,
    revisions:     s.revisions,
    createdAt:     s.createdAt,
  };

  if (s.status !== 'PUBLISHED') return base;

  return {
    ...base,
    result: {
      score:          s.score,
      maximumMarks:   s.assignment.maximumMarks,
      percentage:     s.percentage,
      pointsAwarded:  s.pointsAwarded,
      mentorFeedback: s.mentorFeedback,
      feedbackFile:   s.feedbackFile,
      mentor:         s.mentor ? { firstName: s.mentor.firstName, lastName: s.mentor.lastName } : null,
      publishedAt:    s.publishedAt,
    },
  };
}

export function mentorView(s: SubmissionWithRelations) {
  const { coordinationNote, reopenedBy, ...rest } = s;
  void coordinationNote;
  void reopenedBy;
  return rest;
}

export function adminView(s: SubmissionWithRelations) {
  return s;
}
