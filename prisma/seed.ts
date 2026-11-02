/**
 * Seed script — creates the first admin account if none exists and upserts courses.
 * Run with:  npx tsx prisma/seed.ts
 *
 * After the first admin is seeded, use POST /auth/register/admin
 * (authenticated as admin) to create additional admin accounts.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '../src/generated/prisma/client.js';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  }),
});

const courses = [
  {
    title: 'Algebra',
    subject: 'Algebra',
    description: 'Equations, inequalities, functions and more.',
  },
  {
    title: 'Geometry',
    subject: 'Geometry',
    description:
      'Triangles, circles, transformations and more. ' +
      'Geometry is the study of shapes, sizes, relative positions of figures, and the properties of space.',
  },
  {
    title: 'Number Theory',
    subject: 'Number Theory',
    description: 'Divisibility, primes, congruences and more.',
  },
  {
    title: 'Combinatorics',
    subject: 'Combinatorics',
    description: 'Counting, permutations, combinations and more.',
  },
];

async function main() {
  const existingAdmin = await prisma.user.findFirst({
    where: { role: Role.ADMIN },
  });
  let admin = existingAdmin;

  if (!admin) {
    const passwordHash = await bcrypt.hash('Admin123!', 10);
    admin = await prisma.user.create({
      data: {
        firstName: 'System',
        lastName: 'Admin',
        username: 'admin',
        email: 'admin@rof.local',
        passwordHash,
        role: Role.ADMIN,
      },
    });
  }

  if (existingAdmin) {
    console.log(`✅ Admin already exists: ${admin.username}`);
  } else {
    console.log(`✅ Admin seeded: ${admin.username} / Admin123!`);
    console.log('   ⚠️  Change the password after first login!');
  }

  for (const course of courses) {
    const existingCourse = await prisma.course.findFirst({
      where: { title: course.title, subject: course.subject },
    });

    if (existingCourse) {
      await prisma.course.update({
        where: { id: existingCourse.id },
        data: course,
      });
    } else {
      await prisma.course.create({
        data: { ...course, createdById: admin.id },
      });
    }
  }
  console.log(`Seeded ${courses.length} courses`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
