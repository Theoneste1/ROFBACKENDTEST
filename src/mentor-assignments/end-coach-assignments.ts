import type { AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OPEN_REVIEW_STATUSES } from '../submissions/submissions.constants.js';

export interface EndedCoachAssignment {
  id:         string;
  courseId:   string;
  divisionId: string;
}

/**
 * Deactivates every active coach assignment (MentorAssignment) of a user who
 * is no longer a coach — called inside the role-change transaction, so the
 * role and the assignments always change together.
 *
 * Rows are kept (isActive = false), never deleted: assignment history, past
 * reviews and reports stay intact. Changing the user back to MENTOR does NOT
 * re-activate them; an administrator assigns the coach again explicitly.
 *
 * Each deactivated assignment is audited as UNASSIGN_MENTOR (same action as a
 * manual unassign) with the reason and the number of still-open review cycles
 * in that scope, which stay with the former coach until an admin reassigns them.
 */
export async function endCoachAssignments(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  mentorId: string,
  actor: { actorId: string; actorRole: string },
  context: { from: string; to: string },
): Promise<EndedCoachAssignment[]> {
  const active = await tx.mentorAssignment.findMany({
    where:   { mentorId, isActive: true },
    select:  { id: true, courseId: true, divisionId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (active.length === 0) return [];

  await tx.mentorAssignment.updateMany({
    where: { id: { in: active.map((a) => a.id) } },
    data:  { isActive: false },
  });

  for (const a of active) {
    const openReviewsToReassign = await tx.mentorReview.count({
      where: {
        mentorId,
        status:     { in: OPEN_REVIEW_STATUSES },
        currentFor: { isNot: null },
        submission: { assignment: { courseId: a.courseId, divisionId: a.divisionId } },
      },
    });
    await audit.log({
      ...actor, action: 'UNASSIGN_MENTOR', entity: 'MentorAssignment', entityId: a.id,
      metadata: { reason: 'ROLE_CHANGE', from: context.from, to: context.to, mentorId, openReviewsToReassign },
    }, tx);
  }
  return active;
}
