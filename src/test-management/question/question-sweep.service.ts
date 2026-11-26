/**
 * Question-level marking — the 5-minute sweep (design Rev 5.2 §6, addendum 5.2 §2). It never waits: per claim it takes the
 * holder's advisory lock with the TRY form (skipped when the coach is busy — their own next claim ends it anyway), then
 * the paper and the task with SKIP LOCKED, takes $t and rechecks. It ends:
 *   - claims whose lock expired (EXPIRED; the pool draft ABANDONED, returned work back to RETURNED for its marker);
 *   - claims and reserved returns of coaches who may no longer mark the question (AUTHORISATION_LOST / needs
 *     reassignment) — the backstop for losses outside the revocation paths (programme membership ended, account changes).
 * Expiry is never needed for correctness (an expired lock simply loses at the next claim); this keeps dashboards true.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service.js';
import { endCurrentClaim, lockPapers, lockTasks, lockedNow, projectPapers, tryLockCoach } from './question-store.js';
import { withdrawQuestionWork } from './question-withdraw.js';

@Injectable()
export class QuestionSweepService {
  private readonly logger = new Logger(QuestionSweepService.name);

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'question-marking-sweep' })
  async run(): Promise<void> {
    if (this.config.get('WORKERS_ENABLED') === 'false') return;
    if (String(this.config.get('QUESTION_MARKING_ENABLED') ?? '').toLowerCase() !== 'true') return;
    const r = await this.sweep();
    if (r.expired + r.unauthorised > 0) this.logger.log(`Question marking sweep: ${r.expired} expired claim(s), ${r.unauthorised} unauthorised.`);
  }

  async sweep(): Promise<{ expired: number; unauthorised: number; skipped: number }> {
    let expired = 0; let unauthorised = 0; let skipped = 0;
    const candidates = await this.prisma.$queryRaw<Array<{ taskId: string; submissionId: string; coachId: string }>>`
      SELECT k."id" AS "taskId", k."submissionId", c."coachId" FROM "TestTaskClaim" c JOIN "TestQuestionTask" k ON k."claimId" = c."id"
       WHERE c."endedAt" IS NULL AND k."lockExpiresAt" < clock_timestamp() ORDER BY k."id" LIMIT 500`;
    for (const c of candidates) {
      const done = await this.prisma.$transaction(async (tx) => {
        if (!(await tryLockCoach(tx, c.coachId))) return false;
        const papers = await lockPapers(tx, [c.submissionId], 'NO KEY UPDATE', true);
        if (papers.length === 0) return false;
        const task = (await lockTasks(tx, [c.taskId], true)).get(c.taskId);
        if (!task) return false;
        const t = await lockedNow(tx);
        const ok = await endCurrentClaim(tx, task, t, null, 'EXPIRED', { expectCoach: c.coachId, requireExpired: true });
        if (ok) await projectPapers(tx, [task.submissionId], null, t);
        return ok;
      });
      if (done) expired++; else skipped++;
    }
    const lost = await this.prisma.$queryRaw<Array<{ coachId: string }>>`
      SELECT DISTINCT x."coachId" FROM (
        SELECT k."holderId" AS "coachId", k."questionId" FROM "TestQuestionTask" k WHERE k."status" = 'IN_PROGRESS'
        UNION ALL SELECT k."reservedForId", k."questionId" FROM "TestQuestionTask" k WHERE k."status" = 'RETURNED' AND k."reservedForId" IS NOT NULL
      ) x JOIN "TestQuestion" q ON q."id" = x."questionId" JOIN "Test" te ON te."id" = q."testId"
       WHERE NOT can_mark_subject(x."coachId", te."disciplineId")
          OR NOT EXISTS (SELECT 1 FROM "TestQuestionMarker" m WHERE m."questionId" = q."id" AND m."coachId" = x."coachId" AND m."endedAt" IS NULL)`;
    for (const { coachId } of lost) {
      unauthorised += await this.prisma.$transaction(async (tx) => {
        if (!(await tryLockCoach(tx, coachId))) { skipped++; return 0; }
        return withdrawQuestionWork(tx, [coachId], { onlyIfUnauthorised: true }, null, 'The coach may no longer mark this question.');
      });
    }
    return { expired, unauthorised, skipped };
  }
}
