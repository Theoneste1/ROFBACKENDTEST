/**
 * PR B guard: the application creates a school in exactly one place — AdminSchoolsService.create
 * (POST /admin/schools, schools.manage). Invitations, CSV imports and registration only refer to
 * existing schools. Any new way of creating a school must be added here on purpose (PR D's
 * approved bulk school import will be the next one).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..');
const ALLOWED = ['schools/admin-schools.service.ts'];
const CREATES_SCHOOL = /\.school\.(create|createMany|createManyAndReturn|upsert)\s*\(|INSERT\s+INTO\s+"School"/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('school creation guard (PR B)', () => {
  it('only AdminSchoolsService creates schools', () => {
    const creators = files(SRC).filter((f) => CREATES_SCHOOL.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f).split(sep).join('/'));
    expect(creators).toEqual(ALLOWED);
  });

  it('the pattern catches every Prisma creation form and raw SQL', () => {
    for (const s of ['tx.school.create({', 'this.prisma.school.upsert(', 'db.school.createMany (', 'INSERT INTO "School" (']) expect([s, CREATES_SCHOOL.test(s)]).toEqual([s, true]);
    for (const s of ['tx.school.findUnique(', 'tx.school.update(', 'tx.schoolAffiliation.create(']) expect([s, CREATES_SCHOOL.test(s)]).toEqual([s, false]);
  });
});
