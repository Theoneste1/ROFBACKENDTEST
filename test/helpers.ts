/**
 * Shared e2e helpers: boot the real app, reset the database and create
 * the baseline data every scenario needs.
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { AppModule } from '../src/app/app.module.js';
import { configureApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { GradeLevel } from '../src/generated/prisma/client.js';

export const PASSWORD = 'Passw0rd!';

export interface TestContext {
  app:    NestExpressApplication;
  prisma: PrismaService;
  http:   () => ReturnType<typeof request>;
  ids:    BaseIds;
}

export interface BaseIds {
  year: string;            // the current academic year
  junior: string;
  senior: string;
  algebra: string;
  geometry: string;
  admin: string;
  mentorJunior: string;    // assigned to Algebra × Junior
  mentorJunior2: string;   // also assigned to Algebra × Junior
  mentorSenior: string;    // assigned to Algebra × Senior
  studentJunior: string;   // S2
  studentJunior2: string;  // S3
  studentSenior: string;   // S5
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  await resetDatabase(prisma);
  const ids = await seedBase(prisma);

  return { app, prisma, http: () => request(app.getHttpServer()), ids };
}

/** Remove every row (test database only — guarded in setup-env.ts). */
export async function resetDatabase(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }
}

async function seedBase(prisma: PrismaService): Promise<BaseIds> {
  const hash = await bcrypt.hash(PASSWORD, 4);

  const maths  = await prisma.discipline.create({ data: { code: 'MATHEMATICS', name: 'Mathematics' } });
  const year   = await prisma.academicYear.create({
    data: {
      name: '2026-2027', startsOn: new Date('2026-09-01'), endsOn: new Date('2027-07-31'),
      status: 'ACTIVE', isCurrent: true,
    },
  });
  const junior = await prisma.division.create({ data: { code: 'JUNIOR', name: 'Junior' } });
  const senior = await prisma.division.create({ data: { code: 'SENIOR', name: 'Senior' } });

  const courses = await Promise.all(
    ['ALGEBRA', 'GEOMETRY', 'NUMBER_THEORY', 'COMBINATORICS'].map((code, i) =>
      prisma.course.create({
        data: {
          code, disciplineId: maths.id, title: code.replace('_', ' '), description: `${code} course`,
          sortOrder: i, status: 'PUBLISHED', publishedAt: new Date(),
        },
      }),
    ),
  );
  const algebra  = courses[0];
  const geometry = courses[1];

  const school = await prisma.school.create({ data: { name: 'Test School', location: 'Kigali' } });

  const user = (username: string, role: 'ADMIN' | 'MENTOR' | 'STUDENT', grade?: GradeLevel) =>
    prisma.user.create({
      data: {
        username, firstName: username, lastName: 'Test', email: `${username}@test.local`,
        passwordHash: hash, role, activatedAt: new Date(),
        ...(grade && {
          gradeLevel: grade,
          divisionId: ['S1', 'S2', 'S3'].includes(grade) ? junior.id : senior.id,
          schoolId:   school.id,
        }),
      },
    });

  const admin          = await user('admin', 'ADMIN');
  const mentorJunior   = await user('mentor.j', 'MENTOR');
  const mentorJunior2  = await user('mentor.j2', 'MENTOR');
  const mentorSenior   = await user('mentor.s', 'MENTOR');
  const studentJunior  = await user('student.j', 'STUDENT', 'S2');
  const studentJunior2 = await user('student.j2', 'STUDENT', 'S3');
  const studentSenior  = await user('student.s', 'STUDENT', 'S5');

  for (const s of [studentJunior, studentJunior2, studentSenior]) {
    await prisma.studentEnrollment.create({
      data: {
        studentId: s.id, academicYearId: year.id, gradeLevel: s.gradeLevel!,
        divisionId: s.divisionId!, schoolId: s.schoolId,
      },
    });
  }

  await prisma.mentorAssignment.createMany({
    data: [
      { mentorId: mentorJunior.id,  courseId: algebra.id, divisionId: junior.id },
      { mentorId: mentorJunior2.id, courseId: algebra.id, divisionId: junior.id },
      { mentorId: mentorSenior.id,  courseId: algebra.id, divisionId: senior.id },
    ],
  });

  return {
    year: year.id, junior: junior.id, senior: senior.id, algebra: algebra.id, geometry: geometry.id,
    admin: admin.id, mentorJunior: mentorJunior.id, mentorJunior2: mentorJunior2.id,
    mentorSenior: mentorSenior.id, studentJunior: studentJunior.id,
    studentJunior2: studentJunior2.id, studentSenior: studentSenior.id,
  };
}

/** Log in and return the access token. */
export async function login(ctx: TestContext, username: string, password = PASSWORD): Promise<string> {
  const res = await ctx.http().post('/api/v1/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.access_token;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A minimal valid PDF (magic bytes are what the upload check inspects). */
export const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n',
);

/** A Windows executable header — must be rejected whatever its name claims. */
export const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);

/** An ISO date `days` from now. */
export const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
