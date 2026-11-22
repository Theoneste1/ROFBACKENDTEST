/**
 * Test Management (WS3, Phase 1): tests, their optional questions and their two files (paper, marking guide).
 *
 * Who: Administrators in every subject; a Head Coach only in the subjects they head (AccessService.programmeScope, read
 * fresh on every request; another subject → 403 SCOPE_FORBIDDEN). Any Head Coach of the subject may act; the audit log
 * records which one did. Coaches, Teachers and Students never reach these routes (permission guard).
 *
 * Every write runs in one transaction with its audit entry (category TESTS). Writes to one test are serialised by a row
 * lock on the test, so the question sum rule holds under concurrent requests. Lists are paginated and read in a fixed
 * number of queries (no per-row query).
 *
 * New tables only: the course-assignment pipeline (assignments, submissions, reviews, results) is not touched.
 *
 * Phase 2: once ANY student has submitted (TestSubmission rows; the submit transaction holds the test row FOR SHARE, so
 * this check and a submission never race), the test keeps its subject, division, answer format, opening time, deadline
 * (a later one is given by an extension, which never changes closesAt) and maximum; its questions keep their number,
 * order and marks; its paper stays. 409 TEST_LOCKED_BY_SUBMISSIONS (with the fields). Unpublishing or deleting it: 409
 * TEST_HAS_SUBMISSIONS. Still editable: the title, a question's wording, the marking guide. (submission-rules.ts)
 */
import { DivisionsService } from '../divisions/divisions.service.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { StorageService } from '../common/storage/storage.service.js';
import type { FilePurpose, Prisma, TestFileKind } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateTestDto, ListTestsQueryDto, ReorderTestQuestionsDto, TestFileKindParam, TestQuestionInputDto, UpdateTestDto,
  UpdateTestQuestionDto,
} from './dto/test.dto.js';
import { lockedBySubmissions, lockedFieldsIn } from './submission-rules.js';
import {
  MAX_QUESTIONS, assertMaxMarksCoversQuestions, assertPublishable, assertQuestionMarks, assertSubjectInScope, assertWindow,
  neutralFileName, nextOriginalClosesAt, questionTotals, subjectFilter, type SubjectScope,
} from './test-rules.js';

type Tx = Prisma.TransactionClient;

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;
const FILE_SELECT = { select: { kind: true, createdAt: true, file: { select: { id: true, mimeType: true, size: true, storageKey: true } } } } as const;

const TEST_INCLUDE = {
  discipline: { select: { id: true, code: true, name: true } },
  createdBy:  PERSON,
  files:      FILE_SELECT,
  _count:     { select: { questions: true } },
} as const satisfies Prisma.TestInclude;

type TestRow = Prisma.TestGetPayload<{ include: typeof TEST_INCLUDE }>;
type FileRow = TestRow['files'][number];

const KIND_OF: Record<TestFileKindParam, TestFileKind> = { 'paper': 'PAPER', 'marking-guide': 'MARKING_GUIDE' };
const PURPOSE_OF: Record<TestFileKind, FilePurpose> = { PAPER: 'TEST_PAPER', MARKING_GUIDE: 'MARKING_GUIDE' };

export const testNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'TEST_NOT_FOUND', 'Test not found.');

@Injectable()
export class TestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly divisions: DivisionsService,
  ) {}

  // ── Scope ───────────────────────────────────────────────────────────────────

  /** 'all' for Administrators, the headed subjects for a Head Coach (fresh on every request); anyone else is refused. */
  scope(user: AuthUser): Promise<SubjectScope> {
    return this.access.programmeScope(user);
  }

  /** The subjects the caller may manage tests in (the create form's choices). */
  async subjects(user: AuthUser) {
    const scope = await this.scope(user);
    return this.prisma.discipline.findMany({
      where:   { isActive: true, ...(scope === 'all' ? {} : { id: { in: [...scope] } }) },
      select:  { id: true, code: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  // ── Tests ───────────────────────────────────────────────────────────────────

  async list(q: ListTestsQueryDto, user: AuthUser) {
    const scope = await this.scope(user);
    if (q.subjectId) assertSubjectInScope(scope, q.subjectId);
    const where: Prisma.TestWhereInput = {
      ...subjectFilter(scope),
      ...(q.subjectId && { disciplineId: q.subjectId }),
      ...(q.division && { division: q.division }),
      ...(q.status && { status: q.status }),
      ...(q.q && { title: { contains: q.q, mode: 'insensitive' } }),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.test.findMany({ where, include: TEST_INCLUDE, orderBy: [{ opensAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], skip, take }),
      this.prisma.test.count({ where }),
    ]);
    // Question totals of the whole page in one query.
    const sums = rows.length
      ? await this.prisma.testQuestion.groupBy({ by: ['testId'], where: { testId: { in: rows.map((r) => r.id) } }, _sum: { maxMarks: true } })
      : [];
    const sumOf = new Map(sums.map((s) => [s.testId, s._sum.maxMarks ?? 0]));
    return paginated(rows.map((r) => testView(r, sumOf.get(r.id) ?? 0)), total, page, limit);
  }

  async get(id: string, user: AuthUser) {
    const test = await this.loadInScope(id, user);
    return this.detail(test.id);
  }

  async create(dto: CreateTestDto, user: AuthUser) {
    const scope = await this.scope(user);
    await this.requireSubject(dto.subjectId);
    assertSubjectInScope(scope, dto.subjectId);
    const opensAt = new Date(dto.opensAt);
    const closesAt = new Date(dto.closesAt);
    assertWindow(opensAt, closesAt);
    // Who the test is for: ALL or an ACTIVE division (administrator-managed, owner 2026-11-21/22).
    await this.divisions.assertTestLevel(dto.division);
    const questions = dto.questions ?? [];
    assertQuestionMarks('DRAFT', dto.maxMarks, questions.map((x) => x.maxMarks));

    const id = await this.prisma.$transaction(async (tx) => {
      const test = await tx.test.create({
        data: {
          title: dto.title, disciplineId: dto.subjectId, division: dto.division, answerFormat: dto.answerFormat,
          opensAt, closesAt, originalClosesAt: closesAt, maxMarks: dto.maxMarks, createdById: user.id,
          questions: { create: questions.map((x, i) => ({ order: i + 1, prompt: x.prompt, maxMarks: x.maxMarks })) },
        },
        select: { id: true },
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_CREATED', entity: 'Test', entityId: test.id,
        metadata: {
          subjectId: dto.subjectId, title: dto.title, division: dto.division, answerFormat: dto.answerFormat,
          opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString(), maxMarks: dto.maxMarks, questions: questions.length,
        },
      }, tx);
      return test.id;
    });
    return this.detail(id);
  }

  async update(id: string, dto: UpdateTestDto, user: AuthUser) {
    if (dto.division !== undefined) await this.divisions.assertTestLevel(dto.division);
    const changed = Object.entries(dto).filter(([, v]) => v !== undefined);
    if (changed.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Nothing to change.');
    const scope = await this.scope(user);
    await this.loadInScope(id, user, scope);
    if (dto.subjectId) {
      await this.requireSubject(dto.subjectId);
      assertSubjectInScope(scope, dto.subjectId);
    }

    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      // Only real changes count (a form sending an unchanged value is not refused).
      const current: Record<string, unknown> = {
        subjectId: test.disciplineId, division: test.division, answerFormat: test.answerFormat,
        opensAt: test.opensAt.toISOString(), closesAt: test.closesAt.toISOString(), maxMarks: test.maxMarks,
      };
      const asked: Record<string, unknown> = {
        ...dto, ...(dto.opensAt && { opensAt: new Date(dto.opensAt).toISOString() }), ...(dto.closesAt && { closesAt: new Date(dto.closesAt).toISOString() }),
      };
      const locked = lockedFieldsIn(Object.fromEntries(Object.entries(asked).filter(([k, v]) => v !== undefined && v !== current[k])));
      if (locked.length && (await hasSubmissions(tx, id))) throw lockedBySubmissions('its ' + locked.join(', '), locked);
      if (dto.subjectId && dto.subjectId !== test.disciplineId && test.status !== 'DRAFT') {
        throw new AppError(HttpStatus.CONFLICT, 'TEST_PUBLISHED', 'A published test keeps its subject. Unpublish it first.');
      }
      const opensAt = dto.opensAt ? new Date(dto.opensAt) : test.opensAt;
      const closesAt = dto.closesAt ? new Date(dto.closesAt) : test.closesAt;
      assertWindow(opensAt, closesAt);
      const maxMarks = dto.maxMarks ?? test.maxMarks;
      if (dto.maxMarks !== undefined && dto.maxMarks !== test.maxMarks) {
        const marks = await questionMarks(tx, id);
        assertMaxMarksCoversQuestions(maxMarks, marks);
        assertQuestionMarks(test.status, maxMarks, marks);
      }
      const data: Prisma.TestUncheckedUpdateInput = {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.subjectId !== undefined && { disciplineId: dto.subjectId }),
        ...(dto.division !== undefined && { division: dto.division }),
        ...(dto.answerFormat !== undefined && { answerFormat: dto.answerFormat }),
        ...(dto.opensAt !== undefined && { opensAt }),
        ...(dto.closesAt !== undefined && { closesAt, originalClosesAt: nextOriginalClosesAt(test, closesAt) }),
        ...(dto.maxMarks !== undefined && { maxMarks }),
      };
      await tx.test.update({ where: { id }, data });
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [k, v] of changed) {
        const field = k === 'subjectId' ? 'disciplineId' : k;
        const old = (test as Record<string, unknown>)[field];
        before[k] = old instanceof Date ? old.toISOString() : old;
        after[k] = k === 'opensAt' || k === 'closesAt' ? new Date(v as string).toISOString() : v;
      }
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_UPDATED', entity: 'Test', entityId: id,
        metadata: { subjectId: dto.subjectId ?? test.disciplineId, before, after, status: test.status },
      }, tx);
    });
    return this.detail(id);
  }

  /** Only a DRAFT test is deleted (with its questions and file links; the files become orphans, cleaned nightly). */
  async remove(id: string, user: AuthUser) {
    await this.loadInScope(id, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      if (await hasSubmissions(tx, id)) throw hasSubmissionsError('deleted');
      if (test.status !== 'DRAFT') {
        throw new AppError(HttpStatus.CONFLICT, 'TEST_PUBLISHED', 'A published test cannot be deleted. Unpublish it first.');
      }
      const questions = await tx.testQuestion.count({ where: { testId: id } });
      const files = await tx.testFile.findMany({ where: { testId: id }, select: { kind: true, fileId: true } });
      await tx.test.delete({ where: { id } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_DELETED', entity: 'Test', entityId: id,
        metadata: { subjectId: test.disciplineId, title: test.title, maxMarks: test.maxMarks, questions, files },
      }, tx);
    });
  }

  async publish(id: string, user: AuthUser) {
    await this.loadInScope(id, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      if (test.status === 'PUBLISHED') throw new AppError(HttpStatus.CONFLICT, 'TEST_ALREADY_PUBLISHED', 'This test is already published.');
      const marks = await questionMarks(tx, id);
      const hasPaper = (await tx.testFile.count({ where: { testId: id, kind: 'PAPER' } })) > 0;
      const now = new Date();
      assertPublishable({ maxMarks: test.maxMarks, closesAt: test.closesAt, hasPaper, questionMarks: marks }, now);
      const first = test.publishedAt === null;
      await tx.test.update({
        where: { id },
        data:  { status: 'PUBLISHED', ...(first && { publishedAt: now, originalClosesAt: test.closesAt }) },
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_PUBLISHED', entity: 'Test', entityId: id,
        metadata: { subjectId: test.disciplineId, firstPublication: first, closesAt: test.closesAt.toISOString() },
      }, tx);
    });
    return this.detail(id);
  }

  /** Back to DRAFT — refused once students have submitted (409 TEST_HAS_SUBMISSIONS). */
  async unpublish(id: string, user: AuthUser) {
    await this.loadInScope(id, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      if (test.status !== 'PUBLISHED') throw new AppError(HttpStatus.CONFLICT, 'TEST_NOT_PUBLISHED', 'This test is not published.');
      if (await hasSubmissions(tx, id)) throw hasSubmissionsError('unpublished');
      await tx.test.update({ where: { id }, data: { status: 'DRAFT' } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_UNPUBLISHED', entity: 'Test', entityId: id,
        metadata: { subjectId: test.disciplineId },
      }, tx);
    });
    return this.detail(id);
  }

  // ── Questions ───────────────────────────────────────────────────────────────

  async addQuestion(id: string, dto: TestQuestionInputDto, user: AuthUser) {
    await this.loadInScope(id, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      if (await hasSubmissions(tx, id)) throw lockedBySubmissions('its questions');
      const existing = await tx.testQuestion.findMany({ where: { testId: id }, select: { order: true, maxMarks: true } });
      if (existing.length >= MAX_QUESTIONS) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_QUESTIONS', `A test has at most ${MAX_QUESTIONS} questions.`);
      }
      assertQuestionMarks(test.status, test.maxMarks, [...existing.map((q) => q.maxMarks), dto.maxMarks]);
      const order = existing.reduce((m, q) => Math.max(m, q.order), 0) + 1;
      const q = await tx.testQuestion.create({ data: { testId: id, order, prompt: dto.prompt, maxMarks: dto.maxMarks }, select: { id: true } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_QUESTION_ADDED', entity: 'TestQuestion', entityId: q.id,
        metadata: { testId: id, subjectId: test.disciplineId, order, maxMarks: dto.maxMarks },
      }, tx);
    });
    return this.detail(id);
  }

  async updateQuestion(id: string, questionId: string, dto: UpdateTestQuestionDto, user: AuthUser) {
    if (dto.prompt === undefined && dto.maxMarks === undefined) throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Nothing to change.');
    await this.loadInScope(id, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      const questions = await tx.testQuestion.findMany({ where: { testId: id }, select: { id: true, maxMarks: true, prompt: true } });
      const current = questions.find((q) => q.id === questionId);
      if (!current) throw questionNotFound();
      if (dto.maxMarks !== undefined && dto.maxMarks !== current.maxMarks && (await hasSubmissions(tx, id))) {
        throw lockedBySubmissions('its question marks', ['maxMarks']);
      }
      if (dto.maxMarks !== undefined) {
        assertQuestionMarks(test.status, test.maxMarks, questions.map((q) => (q.id === questionId ? dto.maxMarks! : q.maxMarks)));
      }
      await tx.testQuestion.update({
        where: { id: questionId },
        data:  { ...(dto.prompt !== undefined && { prompt: dto.prompt }), ...(dto.maxMarks !== undefined && { maxMarks: dto.maxMarks }) },
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_QUESTION_UPDATED', entity: 'TestQuestion', entityId: questionId,
        metadata: {
          testId: id, subjectId: test.disciplineId,
          ...(dto.maxMarks !== undefined && { maxMarks: { from: current.maxMarks, to: dto.maxMarks } }),
          promptChanged: dto.prompt !== undefined && dto.prompt !== current.prompt,
        },
      }, tx);
    });
    return this.detail(id);
  }

  /** Remove a question; the remaining ones are renumbered 1…n in their order. */
  async removeQuestion(id: string, questionId: string, user: AuthUser) {
    await this.loadInScope(id, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      if (await hasSubmissions(tx, id)) throw lockedBySubmissions('its questions');
      const questions = await tx.testQuestion.findMany({ where: { testId: id }, orderBy: { order: 'asc' }, select: { id: true, maxMarks: true, order: true } });
      const current = questions.find((q) => q.id === questionId);
      if (!current) throw questionNotFound();
      const rest = questions.filter((q) => q.id !== questionId);
      assertQuestionMarks(test.status, test.maxMarks, rest.map((q) => q.maxMarks));
      if (test.status === 'PUBLISHED' && rest.length === 0 && (await tx.testFile.count({ where: { testId: id, kind: 'PAPER' } })) === 0) {
        throw new AppError(HttpStatus.CONFLICT, 'TEST_NOT_READY', 'A published test needs a paper or at least one question.', { problems: ['NO_PAPER_OR_QUESTIONS'] });
      }
      await tx.testQuestion.delete({ where: { id: questionId } });
      await renumber(tx, rest.map((q) => q.id));
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_QUESTION_REMOVED', entity: 'TestQuestion', entityId: questionId,
        metadata: { testId: id, subjectId: test.disciplineId, order: current.order, maxMarks: current.maxMarks },
      }, tx);
    });
    return this.detail(id);
  }

  async reorderQuestions(id: string, dto: ReorderTestQuestionsDto, user: AuthUser) {
    await this.loadInScope(id, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      if (await hasSubmissions(tx, id)) throw lockedBySubmissions('the order of its questions');
      const questions = await tx.testQuestion.findMany({ where: { testId: id }, orderBy: { order: 'asc' }, select: { id: true } });
      const ids = new Set(questions.map((q) => q.id));
      if (dto.questionIds.length !== ids.size || dto.questionIds.some((q) => !ids.has(q))) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'QUESTION_ORDER_MISMATCH', 'List every question of this test exactly once.',
          { expected: questions.length, received: dto.questionIds.length });
      }
      await renumber(tx, dto.questionIds);
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_QUESTIONS_REORDERED', entity: 'Test', entityId: id,
        metadata: { subjectId: test.disciplineId, from: questions.map((q) => q.id), to: dto.questionIds },
      }, tx);
    });
    return this.detail(id);
  }

  // ── Files (private; neutral download names) ─────────────────────────────────

  /** Upload or replace the paper or the marking guide. Authorisation runs BEFORE anything is stored. */
  async putFile(id: string, kindParam: TestFileKindParam, file: Express.Multer.File | undefined, user: AuthUser) {
    const kind = KIND_OF[kindParam];
    await this.loadInScope(id, user);
    if (!file) throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Attach the file (multipart field "file").');
    const stored = await this.storage.store(file, PURPOSE_OF[kind], user.id);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      if (kind === 'PAPER' && (await hasSubmissions(tx, id))) throw lockedBySubmissions('its paper');
      const previous = await tx.testFile.findUnique({ where: { testId_kind: { testId: id, kind } }, select: { id: true, fileId: true } });
      if (previous) await tx.testFile.delete({ where: { id: previous.id } });
      const link = await tx.testFile.create({ data: { testId: id, kind, fileId: stored.id }, select: { id: true } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: previous ? 'TEST_FILE_REPLACED' : 'TEST_FILE_UPLOADED', entity: 'TestFile', entityId: link.id,
        metadata: {
          testId: id, subjectId: test.disciplineId, kind, fileId: stored.id, mimeType: stored.mimeType, size: stored.size,
          ...(previous && { previousFileId: previous.fileId }),
        },
      }, tx);
    });
    return this.detail(id);
  }

  async removeFile(id: string, kindParam: TestFileKindParam, user: AuthUser) {
    const kind = KIND_OF[kindParam];
    await this.loadInScope(id, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, id);
      const link = await tx.testFile.findUnique({ where: { testId_kind: { testId: id, kind } }, select: { id: true, fileId: true } });
      if (!link) throw fileNotFound();
      if (kind === 'PAPER' && (await hasSubmissions(tx, id))) throw lockedBySubmissions('its paper');
      if (kind === 'PAPER' && test.status === 'PUBLISHED' && (await tx.testQuestion.count({ where: { testId: id } })) === 0) {
        throw new AppError(HttpStatus.CONFLICT, 'TEST_NOT_READY', 'A published test needs a paper or at least one question.', { problems: ['NO_PAPER_OR_QUESTIONS'] });
      }
      await tx.testFile.delete({ where: { id: link.id } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_FILE_REMOVED', entity: 'TestFile', entityId: link.id,
        metadata: { testId: id, subjectId: test.disciplineId, kind, fileId: link.fileId },
      }, tx);
    });
    return this.detail(id);
  }

  /**
   * Stream the paper or the marking guide under a neutral name. The marking guide is served only to those who may read it
   * (mayReadMarkingGuide): Administrators and the subject's Head Coaches. Assigned markers read it through their own,
   * blind route (GET /marking/submissions/:code/marking-guide: authorisation AND assignment checked).
   */
  async sendFile(id: string, kindParam: TestFileKindParam, user: AuthUser, res: Response, download: boolean) {
    const kind = KIND_OF[kindParam];
    const test = await this.loadInScope(id, user);
    if (kind === 'MARKING_GUIDE' && !(await this.mayReadMarkingGuide(user, test.disciplineId))) throw fileNotFound();
    const { title } = (await this.prisma.test.findUnique({ where: { id }, select: { title: true } }))!;
    const link = await this.prisma.testFile.findUnique({
      where: { testId_kind: { testId: id, kind } },
      select: { file: { select: { storageKey: true, mimeType: true, size: true } } },
    });
    if (!link) throw fileNotFound();
    await this.storage.send(res, { ...link.file, originalName: neutralFileName(kind, link.file.storageKey, title) }, { download });
  }

  /** Everyone who manages the subject's tests (Administrators, its Head Coaches). Markers: test-marker.service.ts. */
  private async mayReadMarkingGuide(user: AuthUser, disciplineId: string): Promise<boolean> {
    const scope = await this.scope(user);
    return scope === 'all' || scope.includes(disciplineId);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** 404 TEST_NOT_FOUND, then 403 SCOPE_FORBIDDEN outside the caller's subjects (also used by the Phase 2 services). */
  async loadInScope(id: string, user: AuthUser, scope?: SubjectScope) {
    const test = await this.prisma.test.findUnique({ where: { id }, select: { id: true, disciplineId: true } });
    if (!test) throw testNotFound();
    assertSubjectInScope(scope ?? (await this.scope(user)), test.disciplineId);
    return test;
  }

  private async requireSubject(disciplineId: string) {
    const d = await this.prisma.discipline.findUnique({ where: { id: disciplineId }, select: { isActive: true } });
    if (!d) throw new AppError(HttpStatus.BAD_REQUEST, 'SUBJECT_NOT_FOUND', 'Subject not found.', { subjectId: disciplineId });
    if (!d.isActive) throw new AppError(HttpStatus.BAD_REQUEST, 'SUBJECT_INACTIVE', 'This subject is not active.', { subjectId: disciplineId });
  }

  /** The full test: details, totals, files and questions in order. */
  private async detail(id: string) {
    const [test, questions, submissionCount] = await Promise.all([
      this.prisma.test.findUnique({ where: { id }, include: TEST_INCLUDE }),
      this.prisma.testQuestion.findMany({ where: { testId: id }, orderBy: { order: 'asc' }, select: { id: true, order: true, prompt: true, maxMarks: true } }),
      this.prisma.testSubmission.count({ where: { testId: id } }),
    ]);
    if (!test) throw testNotFound();
    // submissionCount (Phase 2): above 0, the fields in submission-rules.ts LOCKED_AFTER_SUBMISSIONS no longer change.
    return { ...testView(test, questions.reduce((a, q) => a + q.maxMarks, 0)), questions, submissionCount };
  }
}

/** Lock the test row for the rest of the transaction (serialises every write to one test) and return it. */
export async function lockTest(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "Test" WHERE "id" = ${id} FOR UPDATE`;
  const test = await tx.test.findUnique({ where: { id } });
  if (!test) throw testNotFound();
  return test;
}

/** Whether any student has submitted to this test (Phase 2 locks; read under the test's row lock). */
async function hasSubmissions(tx: Tx, testId: string): Promise<boolean> {
  return (await tx.testSubmission.count({ where: { testId } })) > 0;
}

const hasSubmissionsError = (what: string) => new AppError(HttpStatus.CONFLICT, 'TEST_HAS_SUBMISSIONS',
  `Students have already submitted to this test: it cannot be ${what}.`);

async function questionMarks(tx: Tx, testId: string): Promise<number[]> {
  return (await tx.testQuestion.findMany({ where: { testId }, select: { maxMarks: true } })).map((q) => q.maxMarks);
}

/** Give these questions the orders 1…n (two statements: out of the way first, so the unique (testId, order) never clashes). */
async function renumber(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return;
  await tx.$executeRaw`UPDATE "TestQuestion" SET "order" = "order" + 100000 WHERE "id" = ANY(${[...ids]}::text[])`;
  await tx.$executeRaw`
    UPDATE "TestQuestion" q SET "order" = v.ord::int, "updatedAt" = CURRENT_TIMESTAMP
      FROM unnest(${[...ids]}::text[]) WITH ORDINALITY AS v(id, ord)
     WHERE q."id" = v.id`;
}

function fileView(files: FileRow[], kind: TestFileKind, title: string) {
  const f = files.find((x) => x.kind === kind);
  return f ? { fileId: f.file.id, name: neutralFileName(kind, f.file.storageKey, title), mimeType: f.file.mimeType, size: f.file.size, uploadedAt: f.createdAt } : null;
}

/** The API shape of a test (list rows and the detail). The uploader's own file names are never returned. */
function testView(t: TestRow, questionMarksTotal: number) {
  const totals = questionTotals(t.maxMarks, t._count.questions ? [questionMarksTotal] : []);
  return {
    id: t.id, title: t.title,
    subject: t.discipline,
    division: t.division, answerFormat: t.answerFormat,
    opensAt: t.opensAt, closesAt: t.closesAt, originalClosesAt: t.originalClosesAt,
    deadlineMoved: t.closesAt.getTime() !== t.originalClosesAt.getTime(),
    maxMarks: t.maxMarks, status: t.status, publishedAt: t.publishedAt,
    questionCount: t._count.questions, questionMarksTotal: totals.total, questionsComplete: totals.complete,
    files: { paper: fileView(t.files, 'PAPER', t.title), markingGuide: fileView(t.files, 'MARKING_GUIDE', t.title) },
    createdBy: t.createdBy, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

const questionNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'QUESTION_NOT_FOUND', 'Question not found in this test.');
const fileNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'TEST_FILE_NOT_FOUND', 'This test has no such file.');
