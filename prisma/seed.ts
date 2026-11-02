/**
 * Seed script — idempotent; safe to run repeatedly.
 *
 *   npx prisma db seed            (or: npx tsx prisma/seed.ts)
 *
 * Always ensures:
 *   - the two divisions (JUNIOR: S1–S3, SENIOR: S4–S6)
 *   - the four fixed Mathematics courses
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
import { PrismaClient, type CourseCode, type DivisionCode, type GradeLevel } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const BCRYPT_COST = 12;

const DIVISIONS: Array<{ code: DivisionCode; name: string; description: string }> = [
  { code: 'JUNIOR', name: 'Junior', description: 'Senior 1 to Senior 3 (S1–S3).' },
  { code: 'SENIOR', name: 'Senior', description: 'Senior 4 to Senior 6 (S4–S6).' },
];

const COURSES: Array<{ code: CourseCode; title: string; description: string }> = [
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

async function seedDivisions() {
  for (const d of DIVISIONS) {
    await prisma.division.upsert({ where: { code: d.code }, create: d, update: {} });
  }
  console.log(`✅ Divisions: ${DIVISIONS.map((d) => d.code).join(', ')}`);
}

async function seedCourses() {
  for (const [i, c] of COURSES.entries()) {
    await prisma.course.upsert({
      where:  { code: c.code },
      create: { ...c, sortOrder: i, status: 'PUBLISHED', publishedAt: new Date() },
      update: {}, // never overwrite admin edits
    });
  }
  console.log(`✅ Courses: ${COURSES.map((c) => c.title).join(', ')}`);
}

async function seedAdmin() {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (existing) {
    console.log(`✅ Admin already exists: ${existing.username}`);
    return;
  }

  const fromEnv  = process.env.SEED_ADMIN_PASSWORD;
  const password = fromEnv ?? randomBytes(12).toString('base64url');
  await prisma.user.create({
    data: {
      firstName:    'System',
      lastName:     'Admin',
      username:     process.env.SEED_ADMIN_USERNAME ?? 'admin',
      email:        process.env.SEED_ADMIN_EMAIL ?? 'admin@rof.local',
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      role:         'ADMIN',
    },
  });

  console.log('✅ Admin created: username "admin"');
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
      create: { username: m.username, firstName: m.firstName, lastName: m.lastName, email: `${m.username}@rof.local`, passwordHash: password, role: 'MENTOR' },
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
        passwordHash: password, role: 'STUDENT', gradeLevel: s.gradeLevel,
        divisionId: divisions.get(division)!, schoolId: school.id, homeLocation: 'Kigali',
      },
      update: {},
    });
  }

  console.log('✅ Demo data: mentor.junior, mentor.senior, student.s2, student.s5 (password "Demo1234")');
}

async function main() {
  await seedDivisions();
  await seedCourses();
  await seedAdmin();
  if (process.env.SEED_DEMO === 'true') await seedDemo();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
