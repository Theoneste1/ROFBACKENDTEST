/**
 * TestDeadlineService (WS3, Phase 2) — the ONE place a test deadline is computed, for every caller (student, teacher,
 * Administrator, Head Coach; later the marking start, G5). Database time only: `now()` reads clock_timestamp() (as UTC, like every timestamp column) from
 * PostgreSQL, never the application server's or the browser's clock; the rule itself is
 * submission-rules.ts → applicableDeadline (latest of closesAt and the applying ACTIVE extensions).
 */
import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { applicableDeadline, type ApplicableDeadline, type ExtensionLike, type Submitter } from './submission-rules.js';

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'testExtension'>;

const EXTENSION_SELECT = { id: true, kind: true, studentId: true, teacherId: true, newDeadline: true, cancelledAt: true } as const;

@Injectable()
export class TestDeadlineService {
  constructor(private readonly prisma: PrismaService) {}

  /** The database's current time (inside a transaction: the moment of this statement, after any lock was obtained). */
  async now(db: Pick<Prisma.TransactionClient, '$queryRaw'> = this.prisma): Promise<Date> {
    const [row] = await db.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
    return row.now;
  }

  /** The ACTIVE extensions of a test that could apply to these students / this teacher (one query). */
  async activeExtensions(db: Db, testId: string, opts: { studentIds?: readonly string[]; teacherId?: string } = {}): Promise<ExtensionLike[]> {
    return db.testExtension.findMany({
      where: {
        testId, cancelledAt: null,
        OR: [
          { kind: 'TEST' },
          ...(opts.studentIds?.length ? [{ kind: 'STUDENT' as const, studentId: { in: [...opts.studentIds] } }] : []),
          ...(opts.teacherId ? [{ kind: 'TEACHER' as const, teacherId: opts.teacherId }] : []),
        ],
      },
      select: EXTENSION_SELECT,
    });
  }

  /** The deadline that applies to ONE student's submission by this submitter. */
  async forSubmission(db: Db, test: { id: string; closesAt: Date }, studentId: string, submitter: Submitter): Promise<ApplicableDeadline> {
    const extensions = await this.activeExtensions(db, test.id, {
      studentIds: [studentId], ...(submitter.role === 'TEACHER' && { teacherId: submitter.teacherId }),
    });
    return applicableDeadline(test.closesAt, extensions, studentId, submitter);
  }

  /** Deadlines of many students at once (one query), for one submitter kind. */
  async forStudents(
    db: Db, test: { id: string; closesAt: Date }, studentIds: readonly string[], submitter: Submitter,
  ): Promise<Map<string, ApplicableDeadline>> {
    const extensions = await this.activeExtensions(db, test.id, {
      studentIds, ...(submitter.role === 'TEACHER' && { teacherId: submitter.teacherId }),
    });
    return new Map(studentIds.map((id) => [id, applicableDeadline(test.closesAt, extensions, id, submitter)]));
  }
}
