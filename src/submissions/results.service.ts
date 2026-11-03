/**
 * Results and formal feedback.
 *
 * A result is the published outcome of a mentor's review: score, formal
 * feedback and feedback files. It is deliberately separate from discussions —
 * there are no comments or replies on a result (`repliesAllowed: false`), and
 * questions about an assignment belong in its discussion threads.
 *
 *   Students: only their own, only once PUBLISHED. Earlier published versions
 *             of a corrected result stay visible as `previousVersions`.
 *   Admins:   the full publication history of any submission — every
 *             publication with who released it and when, and every withdrawal.
 *
 * Nothing here writes: publication itself is the admin workflow in
 * SubmissionsService (approve → publish / publish all for an assignment).
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { ATTACHMENT_SELECT } from '../common/storage/attachments.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ListResultsDto } from './dto/list-results.dto.js';

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;

const RESULT_REVIEW_SELECT = {
  id: true, cycle: true, score: true, percentage: true, feedback: true,
  markedAt: true, returnedAt: true, publishedAt: true,
  mentor:      { select: { firstName: true, lastName: true } },
  attachments: { orderBy: { sortOrder: 'asc' as const }, select: ATTACHMENT_SELECT },
} as const;

const RESULT_SELECT = {
  id: true, revisionCount: true, isLate: true, submittedAt: true, pointsAwarded: true, publishedAt: true,
  assignment: {
    select: {
      id: true, title: true, description: true, deadline: true, maximumMarks: true, points: true,
      course:       { select: { id: true, code: true, title: true } },
      division:     { select: { id: true, code: true, name: true } },
      academicYear: { select: { id: true, name: true } },
    },
  },
  revisions: {
    orderBy: { revisionNumber: 'desc' as const },
    take:    1,
    select:  {
      revisionNumber: true, answerText: true, note: true, isLate: true, submittedAt: true,
      attachments: { orderBy: { sortOrder: 'asc' as const }, select: ATTACHMENT_SELECT },
    },
  },
  publishedReview: { select: RESULT_REVIEW_SELECT },
} as const;

type ResultRow = Prisma.SubmissionGetPayload<{ select: typeof RESULT_SELECT }>;

@Injectable()
export class ResultsService {
  constructor(private readonly prisma: PrismaService) {}

  /** STUDENT: own published results, newest first. */
  async listMine(user: AuthUser, q: ListResultsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SubmissionWhereInput = {
      studentId: user.id,
      status:    'PUBLISHED',
      publishedReviewId: { not: null },
      ...((q.courseId || q.academicYearId) && {
        assignment: {
          ...(q.courseId       && { courseId: q.courseId }),
          ...(q.academicYearId && { academicYearId: q.academicYearId }),
        },
      }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.submission.findMany({ where, select: RESULT_SELECT, orderBy: { publishedAt: 'desc' }, skip, take }),
      this.prisma.submission.count({ where }),
    ]);
    return paginated(rows.map((r) => this.summary(r)), total, page, limit);
  }

  /** STUDENT: one published result with everything needed to display it. */
  async getMine(submissionId: string, user: AuthUser) {
    const row = await this.prisma.submission.findFirst({
      where:  { id: submissionId, studentId: user.id, status: 'PUBLISHED', publishedReviewId: { not: null } },
      select: RESULT_SELECT,
    });
    // Unpublished, someone else's, or unknown: indistinguishable on purpose.
    if (!row) throw new NotFoundException('Result not found.');

    const latest = row.revisions[0];
    const review = row.publishedReview!;
    return {
      ...this.summary(row),
      submission: {
        submittedAt: row.submittedAt,
        isLate:      row.isLate,
        attempts:    row.revisionCount + 1,
        answerText:  latest?.answerText ?? null,
        note:        latest?.note ?? null,
        files:       latest?.attachments ?? [],
      },
      feedback: {
        text:   review.feedback,
        mentor: review.mentor,
        files:  review.attachments.map((a) => ({
          ...a,
          downloadPath: `/api/v1/me/results/${row.id}/feedback-files/${a.id}`,
        })),
      },
      previousVersions: await this.previousVersions(row.id),
      /** Formal results are not a conversation: no reply box. */
      repliesAllowed: false as const,
    };
  }

  /**
   * ADMIN: every publication of a submission's result — which review cycle,
   * the score, who published it and when, and when/why it was withdrawn.
   */
  async publicationHistory(submissionId: string) {
    const sub = await this.prisma.submission.findUnique({
      where:  { id: submissionId },
      select: {
        id: true, status: true, publishedAt: true,
        resultRelease: { select: { id: true, note: true, publishedAt: true, publishedBy: PERSON } },
      },
    });
    if (!sub) throw new NotFoundException('Submission not found.');

    const reviews = await this.prisma.mentorReview.findMany({
      where:   { submissionId, publishedAt: { not: null } },
      orderBy: { cycle: 'asc' },
      select:  {
        id: true, cycle: true, status: true, score: true, percentage: true, publishedAt: true, returnedAt: true,
        mentor: PERSON,
        events: {
          where:   { type: { in: ['PUBLISHED', 'REOPENED'] } },
          orderBy: { createdAt: 'asc' },
          select:  { type: true, note: true, createdAt: true, actor: PERSON },
        },
      },
    });

    return {
      submissionId:   sub.id,
      status:         sub.status,
      currentRelease: sub.resultRelease,
      publications:   reviews.map((r) => {
        const published = r.events.find((e) => e.type === 'PUBLISHED');
        const withdrawn = r.events.find((e) => e.type === 'REOPENED');
        return {
          reviewId:    r.id,
          cycle:       r.cycle,
          score:       r.score,
          percentage:  r.percentage,
          mentor:      r.mentor,
          reviewedAt:  r.returnedAt,
          publishedAt: r.publishedAt,
          publishedBy: published?.actor ?? null,
          withdrawn:   withdrawn ? { at: withdrawn.createdAt, by: withdrawn.actor, note: withdrawn.note } : null,
        };
      }),
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private summary(row: ResultRow) {
    const review = row.publishedReview!;
    return {
      submissionId:  row.id,
      assignment:    row.assignment,
      score:         review.score,
      maximumMarks:  row.assignment.maximumMarks,
      percentage:    review.percentage,
      pointsAwarded: row.pointsAwarded,
      /** When the mentor completed the review. */
      reviewedAt:    review.returnedAt ?? review.markedAt,
      publishedAt:   row.publishedAt,
    };
  }

  /** Earlier published scores of a result that was later corrected. */
  private async previousVersions(submissionId: string) {
    const superseded = await this.prisma.mentorReview.findMany({
      where:   { submissionId, status: 'SUPERSEDED', publishedAt: { not: null } },
      orderBy: { cycle: 'asc' },
      select:  {
        score: true, percentage: true, publishedAt: true,
        events: { where: { type: 'REOPENED' }, select: { createdAt: true }, take: 1 },
      },
    });
    return superseded.map((r) => ({
      score: r.score, percentage: r.percentage, publishedAt: r.publishedAt, withdrawnAt: r.events[0]?.createdAt ?? null,
    }));
  }
}
