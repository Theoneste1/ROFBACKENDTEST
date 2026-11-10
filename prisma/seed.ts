/**
 * Seed script — idempotent; safe to run repeatedly.
 *
 *   npx prisma db seed            (or: npx tsx prisma/seed.ts)
 *
 * Always ensures:
 *   - the Mathematics discipline
 *   - the two divisions (JUNIOR: S1–S3, SENIOR: S4–S6)
 *   - the four fixed Mathematics courses
 *   - a current academic year (Sept–July containing today) if none is current
 *   - an enrolment in the current year for every active student without one
 *   - a first ADMIN account (only if no admin exists)
 *
 * The admin password comes from SEED_ADMIN_PASSWORD; if unset, a random one is
 * generated and printed ONCE. Nothing is overwritten on later runs.
 *
 * SEED_DEMO=true additionally creates demo mentors/students for local
 * frontend development. It is refused when NODE_ENV=production.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaClient, type DivisionCode, type GradeLevel } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const BCRYPT_COST = 12;

const DIVISIONS: Array<{ code: DivisionCode; name: string; description: string }> = [
  { code: 'JUNIOR', name: 'Junior', description: 'Senior 1 to Senior 3 (S1–S3).' },
  { code: 'SENIOR', name: 'Senior', description: 'Senior 4 to Senior 6 (S4–S6).' },
];

const MATHEMATICS = { code: 'MATHEMATICS', name: 'Mathematics', description: 'Olympiad mathematics.' };

const COURSES: Array<{ code: string; title: string; description: string }> = [
  {
    code:        'ALGEBRA',
    title:       'Algebra',
    description: 'Equations, inequalities, polynomials, functions and functional equations.',
  },
  {
    code:        'GEOMETRY',
    title:       'Geometry',
    description: 'Triangles, circles, transformations and the properties of space.',
  },
  {
    code:        'NUMBER_THEORY',
    title:       'Number Theory',
    description: 'Divisibility, primes, modular arithmetic and Diophantine equations.',
  },
  {
    code:        'COMBINATORICS',
    title:       'Combinatorics',
    description: 'Counting, permutations, combinations, pigeonhole principle and graph theory.',
  },
];

async function seedDiscipline() {
  const d = await prisma.discipline.upsert({ where: { code: MATHEMATICS.code }, create: MATHEMATICS, update: {} });
  console.log(`✅ Discipline: ${d.name}`);
  return d.id;
}

async function seedDivisions() {
  for (const d of DIVISIONS) {
    await prisma.division.upsert({ where: { code: d.code }, create: d, update: {} });
  }
  console.log(`✅ Divisions: ${DIVISIONS.map((d) => d.code).join(', ')}`);
}

async function seedCourses(disciplineId: string) {
  for (const [i, c] of COURSES.entries()) {
    await prisma.course.upsert({
      where:  { disciplineId_code: { disciplineId, code: c.code } },
      create: { ...c, disciplineId, sortOrder: i, status: 'PUBLISHED', publishedAt: new Date() },
      update: {}, // never overwrite admin edits
    });
  }
  console.log(`✅ Courses: ${COURSES.map((c) => c.title).join(', ')}`);
}

/** Rwandan school years run September → July. */
async function seedAcademicYear() {
  const current = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  if (current) {
    console.log(`✅ Current academic year: ${current.name}`);
    return current.id;
  }
  const now = new Date();
  const y = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const year = await prisma.academicYear.upsert({
    where:  { name: `${y}-${y + 1}` },
    create: {
      name: `${y}-${y + 1}`, startsOn: new Date(Date.UTC(y, 8, 1)), endsOn: new Date(Date.UTC(y + 1, 6, 31)),
      status: 'ACTIVE', isCurrent: true,
    },
    update: { status: 'ACTIVE', isCurrent: true },
  });
  console.log(`✅ Current academic year: ${year.name}`);
  return year.id;
}

/** Every active student must have an enrolment in the current year. */
async function seedEnrollments(academicYearId: string) {
  const students = await prisma.user.findMany({
    where: {
      role: 'STUDENT', isActive: true, gradeLevel: { not: null }, divisionId: { not: null },
      studentEnrollments: { none: { academicYearId } },
    },
    select: { id: true, gradeLevel: true, divisionId: true, schoolId: true },
  });
  for (const s of students) {
    await prisma.studentEnrollment.create({
      data: { studentId: s.id, academicYearId, gradeLevel: s.gradeLevel!, divisionId: s.divisionId!, schoolId: s.schoolId },
    });
  }
  if (students.length) console.log(`✅ Enrolled ${students.length} student(s) in the current year`);
}

/** Every student and coach in the Mathematics programme (P1-07; idempotent, MANUAL like any new account). */
async function seedMemberships(disciplineId: string) {
  const members = await prisma.user.findMany({ where: { role: { in: ['STUDENT', 'MENTOR'] } }, select: { id: true } });
  const { count } = await prisma.programmeMembership.createMany({
    data: members.map((u) => ({ userId: u.id, disciplineId, source: 'MANUAL' as const })),
    skipDuplicates: true,
  });
  console.log(`✅ Programme memberships: ${count} added`);
}

async function seedAdmin() {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (existing) {
    console.log(`✅ Admin already exists: ${existing.username}`);
    return;
  }

  const fromEnv  = process.env.SEED_ADMIN_PASSWORD;
  const password = fromEnv ?? randomBytes(12).toString('base64url');
  const username = process.env.SEED_ADMIN_USERNAME ?? 'admin';
  await prisma.user.create({
    data: {
      firstName:    'System',
      lastName:     'Admin',
      username,
      email:        process.env.SEED_ADMIN_EMAIL ?? 'admin@rof.local',
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      role:         'ADMIN',
      activatedAt:  new Date(),
    },
  });

  console.log(`✅ Admin created: username "${username}"`);
  if (!fromEnv) {
    console.log(`   Generated password (shown once): ${password}`);
    console.log('   ⚠️  Change it after first login (PATCH /api/v1/auth/password).');
  }
}

async function seedDemo() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SEED_DEMO is not allowed in production.');
  }
  const password = await bcrypt.hash('Demo1234', BCRYPT_COST);
  const divisions = new Map((await prisma.division.findMany()).map((d) => [d.code, d.id]));
  const courses   = await prisma.course.findMany();
  const admin     = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });

  const school = await prisma.school.upsert({
    where:  { name: 'Demo Secondary School' },
    create: { name: 'Demo Secondary School', location: 'Kigali' },
    update: {},
  });

  const mentors = [
    { username: 'mentor.junior', firstName: 'Jean',   lastName: 'Mentor', division: 'JUNIOR' as const },
    { username: 'mentor.senior', firstName: 'Aline',  lastName: 'Mentor', division: 'SENIOR' as const },
  ];
  for (const m of mentors) {
    const user = await prisma.user.upsert({
      where:  { username: m.username },
      create: { username: m.username, firstName: m.firstName, lastName: m.lastName, email: `${m.username}@rof.local`, passwordHash: password, role: 'MENTOR', activatedAt: new Date() },
      update: {},
    });
    for (const c of courses) {
      await prisma.mentorAssignment.upsert({
        where:  { mentorId_courseId_divisionId: { mentorId: user.id, courseId: c.id, divisionId: divisions.get(m.division)! } },
        create: { mentorId: user.id, courseId: c.id, divisionId: divisions.get(m.division)!, assignedById: admin.id },
        update: {},
      });
    }
  }

  const students: Array<{ username: string; firstName: string; gradeLevel: GradeLevel }> = [
    { username: 'student.s2', firstName: 'Eric',   gradeLevel: 'S2' },
    { username: 'student.s5', firstName: 'Grace',  gradeLevel: 'S5' },
  ];
  for (const s of students) {
    const division = ['S1', 'S2', 'S3'].includes(s.gradeLevel) ? 'JUNIOR' : 'SENIOR';
    await prisma.user.upsert({
      where:  { username: s.username },
      create: {
        username: s.username, firstName: s.firstName, lastName: 'Student', email: `${s.username}@rof.local`,
        passwordHash: password, role: 'STUDENT', gradeLevel: s.gradeLevel, activatedAt: new Date(),
        divisionId: divisions.get(division)!, schoolId: school.id, homeLocation: 'Kigali',
      },
      update: {},
    });
  }

  console.log('✅ Demo data: mentor.junior, mentor.senior, student.s2, student.s5 (password "Demo1234")');
}

async function main() {
  const disciplineId = await seedDiscipline();
  await seedDivisions();
  await seedCourses(disciplineId);
  const yearId = await seedAcademicYear();
  await seedAdmin();
  if (process.env.SEED_DEMO === 'true') await seedDemo();
  await seedEnrollments(yearId);
  await seedMemberships(disciplineId);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
