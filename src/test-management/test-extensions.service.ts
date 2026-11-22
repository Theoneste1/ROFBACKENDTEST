/**
 * Test Management (WS3, Phase 2): deadline extensions. Administrators in every subject; a Head Coach only in the subjects
 * they head (TestsService.loadInScope: 404 TEST_NOT_FOUND, 403 SCOPE_FORBIDDEN).
 *
 *   kinds    TEST (every student of the test), STUDENT (one student, whoever submits for them), TEACHER (only that
 *            teacher's own submissions for the verified students of their schools).
 *   create   a new deadline later than the test's closesAt and than now (database time), a mandatory reason; at most one
 *            ACTIVE extension per target (409 EXTENSION_ALREADY_ACTIVE; a partial unique index is the backstop).
 *   edit     a new deadline and/or reason (the reason for the change is mandatory) — only while active and not expired.
 *   cancel   with a mandatory reason — only while active and not expired.
 * The test's closesAt and originalClosesAt never change. Every write is audited (TESTS) in its transaction, which holds
 * the test row FOR UPDATE: a submission (FOR SHARE) sees either the old or the new extension, never half of it. The
 * recipient of an individual (STUDENT / TEACHER) extension is told once (decision notification test.extension.granted,
 * dedupe key per extension). "Extended" is shown to Administrators and Head Coaches only — never in a marker's data.
 *
 * Phase 3 (G5): once marking of a submission has begun (any status after SUBMITTED), nothing can be submitted for that
 * student any more, so a new or later deadline that would apply to it is refused (409 MARKING_STARTED): a whole-test
 * extension once any submission of the test is being marked; a student's once their submission is; a teacher's once a
 * submission of a student they may submit for (or did submit for) is. Shortening or cancelling stays possible.
 */
import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { DecisionEvents } from '../decision-notifications/decision-content.js';
import { DecisionNotificationsService } from '../decision-notifications/decision-notifications.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CancelTestExtensionDto, CreateTestExtensionDto, ExtensionTargetsQueryDto, ListTestExtensionsQueryDto, UpdateTestExtensionDto,
} from './dto/submission.dto.js';
import { divisionMatches, levelWhere, type TestDivisionValue } from './submission-rules.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { TestsService, lockTest } from './tests.service.js';
import { SCHOOL_MEMBER_CLAIMS } from '../common/access/access.service.js';

type Tx = Prisma.TransactionClient;

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;
const EXTENSION_INCLUDE = {
  student:     { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } },
  teacher:     PERSON,
  grantedBy:   PERSON,
  editedBy:    PERSON,
  cancelledBy: PERSON,
} as const satisfies Prisma.TestExtensionInclude;

type ExtensionRow = Prisma.TestExtensionGetPayload<{ include: typeof EXTENSION_INCLUDE }>;

const extensionNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'EXTENSION_NOT_FOUND', 'Extension not found for this test.');

@Injectable()
export class TestExtensionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tests: TestsService,
    private readonly audit: AuditService,
    private readonly deadlines: TestDeadlineService,
    private readonly notices: DecisionNotificationsService,
  ) {}

  /** The test's extensions (active by default), newest first, with who granted, edited or cancelled them. */
  async list(testId: string, q: ListTestExtensionsQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const state = q.state ?? 'active';
    const where: Prisma.TestExtensionWhereInput = {
      testId,
      ...(q.kind && { kind: q.kind }),
      ...(state === 'active' ? { cancelledAt: null } : state === 'cancelled' ? { cancelledAt: { not: null } } : {}),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total, now] = await Promise.all([
      this.prisma.testExtension.findMany({ where, include: EXTENSION_INCLUDE, orderBy: [{ grantedAt: 'desc' }, { id: 'asc' }], skip, take }),
      this.prisma.testExtension.count({ where }),
      this.deadlines.now(),
    ]);
    return paginated(rows.map((r) => extensionView(r, now)), total, page, limit);
  }

  /**
   * Who an individual extension can be for: STUDENT — student accounts of the test's division; TEACHER — teacher
   * accounts. Each with the id of their active extension on this test, if any.
   */
  async targets(testId: string, q: ExtensionTargetsQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const test = await this.prisma.test.findUniqueOrThrow({ where: { id: testId }, select: { division: true } });
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.UserWhereInput = {
      role: q.kind,
      accountStatus: 'ACTIVE',
      ...(q.kind === 'STUDENT' && test.division !== 'ALL' && levelWhere(test.division)),
      ...(contains && { OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const active = ids.length ? await this.prisma.testExtension.findMany({
      where: { testId, cancelledAt: null, kind: q.kind, ...(q.kind === 'STUDENT' ? { studentId: { in: ids } } : { teacherId: { in: ids } }) },
      select: { id: true, studentId: true, teacherId: true },
    }) : [];
    const activeOf = new Map(active.map((e) => [(q.kind === 'STUDENT' ? e.studentId : e.teacherId)!, e.id]));
    return paginated(rows.map((r) => ({ ...r, activeExtensionId: activeOf.get(r.id) ?? null })), total, page, limit);
  }

  async create(testId: string, dto: CreateTestExtensionDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    assertTargetShape(dto);
    const newDeadline = new Date(dto.newDeadline);
    const notices: Array<string | null> = [];
    const id = await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      const now = await this.deadlines.now(tx);
      assertDeadline(newDeadline, test.closesAt, now);
      const recipient = await this.requireTarget(tx, dto, test.division);
      await assertNotInMarking(tx, testId, dto.kind, dto.studentId ?? null, dto.teacherId ?? null);
      const existing = await tx.testExtension.findFirst({
        where: {
          testId, kind: dto.kind, cancelledAt: null,
          ...(dto.kind === 'STUDENT' && { studentId: dto.studentId }), ...(dto.kind === 'TEACHER' && { teacherId: dto.teacherId }),
        },
        select: { id: true },
      });
      if (existing) {
        throw new AppError(HttpStatus.CONFLICT, 'EXTENSION_ALREADY_ACTIVE', 'An active extension already exists for this target: edit or cancel it.', { extensionId: existing.id });
      }
      const ext = await tx.testExtension.create({
        data: {
          testId, kind: dto.kind, studentId: dto.kind === 'STUDENT' ? dto.studentId! : null, teacherId: dto.kind === 'TEACHER' ? dto.teacherId! : null,
          newDeadline, reason: dto.reason, grantedById: user.id, grantedAt: now,
        },
        select: { id: true },
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_EXTENSION_GRANTED', entity: 'TestExtension', entityId: ext.id,
        metadata: {
          testId, subjectId: test.disciplineId, kind: dto.kind, studentId: dto.studentId ?? null, teacherId: dto.teacherId ?? null,
          newDeadline: newDeadline.toISOString(), closesAt: test.closesAt.toISOString(), reason: dto.reason,
        },
      }, tx);
      // The individual recipient is told once (dedupe key per extension; a retried request adds nothing).
      if (recipient && recipient.accountStatus === 'ACTIVE') {
        const subject = await tx.discipline.findUniqueOrThrow({ where: { id: test.disciplineId }, select: { name: true } });
        notices.push(await this.notices.enqueue(tx, {
          type: DecisionEvents.TestExtensionGranted, dedupeKey: `${DecisionEvents.TestExtensionGranted}:${ext.id}`,
          recipient: { userId: recipient.id, email: recipient.email, firstName: recipient.firstName },
          entity: { type: 'TestExtension', id: ext.id },
          payload: {
            activated: recipient.activatedAt !== null, testTitle: test.title, subjectName: subject.name,
            deadline: newDeadline.toISOString(), audience: dto.kind === 'STUDENT' ? 'STUDENT' : 'TEACHER',
          },
        }));
      }
      return ext.id;
    });
    this.notices.dispatchAfterCommit(notices);
    return this.one(testId, id);
  }

  async update(testId: string, extensionId: string, dto: UpdateTestExtensionDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      const now = await this.deadlines.now(tx);
      const ext = await this.requireChangeable(tx, testId, extensionId, now);
      const newDeadline = dto.newDeadline ? new Date(dto.newDeadline) : ext.newDeadline;
      if (dto.newDeadline) assertDeadline(newDeadline, test.closesAt, now);
      if (newDeadline.getTime() > ext.newDeadline.getTime()) await assertNotInMarking(tx, testId, ext.kind, ext.studentId, ext.teacherId);
      await tx.testExtension.update({
        where: { id: extensionId },
        data:  { newDeadline, reason: dto.reason, editedAt: now, editedById: user.id },
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_EXTENSION_UPDATED', entity: 'TestExtension', entityId: extensionId,
        metadata: {
          testId, subjectId: test.disciplineId, kind: ext.kind, studentId: ext.studentId, teacherId: ext.teacherId,
          before: { newDeadline: ext.newDeadline.toISOString(), reason: ext.reason },
          after:  { newDeadline: newDeadline.toISOString(), reason: dto.reason },
        },
      }, tx);
    });
    return this.one(testId, extensionId);
  }

  async cancel(testId: string, extensionId: string, dto: CancelTestExtensionDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      const now = await this.deadlines.now(tx);
      const ext = await this.requireChangeable(tx, testId, extensionId, now);
      await tx.testExtension.update({ where: { id: extensionId }, data: { cancelledAt: now, cancelledById: user.id, cancelReason: dto.reason } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_EXTENSION_CANCELLED', entity: 'TestExtension', entityId: extensionId,
        metadata: {
          testId, subjectId: test.disciplineId, kind: ext.kind, studentId: ext.studentId, teacherId: ext.teacherId,
          newDeadline: ext.newDeadline.toISOString(), reason: dto.reason,
        },
      }, tx);
    });
    return this.one(testId, extensionId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private async one(testId: string, id: string) {
    const [row, now] = await Promise.all([
      this.prisma.testExtension.findFirst({ where: { id, testId }, include: EXTENSION_INCLUDE }),
      this.deadlines.now(),
    ]);
    if (!row) throw extensionNotFound();
    return extensionView(row, now);
  }

  /** 404 EXTENSION_NOT_FOUND; 409 EXTENSION_CANCELLED; 409 EXTENSION_EXPIRED (its deadline has passed). */
  private async requireChangeable(tx: Tx, testId: string, id: string, now: Date) {
    const ext = await tx.testExtension.findFirst({ where: { id, testId } });
    if (!ext) throw extensionNotFound();
    if (ext.cancelledAt) throw new AppError(HttpStatus.CONFLICT, 'EXTENSION_CANCELLED', 'This extension was cancelled.');
    if (ext.newDeadline.getTime() <= now.getTime()) {
      throw new AppError(HttpStatus.CONFLICT, 'EXTENSION_EXPIRED', 'This extension has expired; it can no longer change.', { newDeadline: ext.newDeadline.toISOString() });
    }
    return ext;
  }

  /** The student (of the test's division) or teacher an individual extension names; null for a whole-test extension. */
  private async requireTarget(tx: Tx, dto: CreateTestExtensionDto, division: TestDivisionValue) {
    if (dto.kind === 'TEST') return null;
    const id = dto.kind === 'STUDENT' ? dto.studentId! : dto.teacherId!;
    const u = await tx.user.findUnique({
      where: { id },
      select: { id: true, role: true, email: true, firstName: true, accountStatus: true, activatedAt: true, gradeLevel: true, division: { select: { code: true } } },
    });
    if (dto.kind === 'STUDENT') {
      if (!u || u.role !== 'STUDENT') throw new AppError(HttpStatus.NOT_FOUND, 'STUDENT_NOT_FOUND', 'Student not found.');
      if (!divisionMatches(division, u)) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'STUDENT_NOT_IN_DIVISION', 'This student is not at the test\'s Olympiad level.');
      }
    } else if (!u || u.role !== 'TEACHER') {
      throw new AppError(HttpStatus.NOT_FOUND, 'TEACHER_NOT_FOUND', 'Teacher not found.');
    }
    return u;
  }
}

/**
 * 409 MARKING_STARTED (G5): a submission this extension would reopen is already being marked (see the file header). Read
 * under the test's row lock, which distribution holds too.
 */
async function assertNotInMarking(tx: Tx, testId: string, kind: 'TEST' | 'STUDENT' | 'TEACHER', studentId: string | null, teacherId: string | null) {
  const teacherReach: Prisma.TestSubmissionWhereInput = {
    OR: [
      { versions: { some: { teacherId: teacherId ?? '' } } },
      { student: { schoolAffiliations: { some: { status: { in: [...SCHOOL_MEMBER_CLAIMS] }, supersededAt: null, school: { teachers: { some: { teacherId: teacherId ?? '', isActive: true } } } } } } },
    ],
  };
  const where: Prisma.TestSubmissionWhereInput = {
    testId, status: { not: 'SUBMITTED' },
    ...(kind === 'STUDENT' && { studentId: studentId ?? '' }),
    ...(kind === 'TEACHER' && teacherReach),
  };
  const n = await tx.testSubmission.count({ where });
  if (n > 0) {
    throw new AppError(HttpStatus.CONFLICT, 'MARKING_STARTED',
      'Marking has begun for submissions this extension would reopen: a later deadline can no longer apply to them.', { submissionsInMarking: n });
  }
}

/** 400 EXTENSION_TARGET_REQUIRED / EXTENSION_TARGET_NOT_ALLOWED: exactly the id the kind needs. */
function assertTargetShape(dto: CreateTestExtensionDto) {
  const need = dto.kind === 'STUDENT' ? 'studentId' : dto.kind === 'TEACHER' ? 'teacherId' : null;
  if (need && !dto[need]) throw new AppError(HttpStatus.BAD_REQUEST, 'EXTENSION_TARGET_REQUIRED', `A ${dto.kind.toLowerCase()} extension needs ${need}.`);
  for (const f of ['studentId', 'teacherId'] as const) {
    if (f !== need && dto[f]) throw new AppError(HttpStatus.BAD_REQUEST, 'EXTENSION_TARGET_NOT_ALLOWED', `A ${dto.kind.toLowerCase()} extension takes no ${f}.`);
  }
}

/** 400 EXTENSION_NOT_LATER (not after the test's own deadline) / EXTENSION_IN_PAST (not after now, database time). */
function assertDeadline(newDeadline: Date, closesAt: Date, now: Date) {
  if (newDeadline.getTime() <= closesAt.getTime()) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'EXTENSION_NOT_LATER', 'An extension must end after the test\'s own deadline.', { closesAt: closesAt.toISOString() });
  }
  if (newDeadline.getTime() <= now.getTime()) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'EXTENSION_IN_PAST', 'An extension must end in the future.');
  }
}

/** Administrators' and Head Coaches' view: active / expired / cancelled, who granted, edited, cancelled. */
function extensionView(e: ExtensionRow, now: Date) {
  const state = e.cancelledAt ? 'CANCELLED' : e.newDeadline.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
  return {
    id: e.id, testId: e.testId, kind: e.kind, state,
    student: e.student, teacher: e.teacher,
    newDeadline: e.newDeadline, reason: e.reason,
    grantedBy: e.grantedBy, grantedAt: e.grantedAt,
    editedBy: e.editedBy, editedAt: e.editedAt,
    cancelledBy: e.cancelledBy, cancelledAt: e.cancelledAt, cancelReason: e.cancelReason,
  };
}
