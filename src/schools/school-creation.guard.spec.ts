/**
 * PR B guard: the application creates a school in exactly one place — AdminSchoolsService.create
 * (POST /admin/schools, schools.manage). Invitations, CSV imports and registration only refer to
 * existing schools. Any new way of creating a school must be added here on purpose (PR D's
 * approved bulk school import will be the next one).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..');
/** Single create (PR B) and the separately authorised bulk import (PR D) — nothing else. */
const ALLOWED = ['schools/admin-schools.service.ts', 'schools/import/school-import.service.ts', 'schools/sync/review/school-sync-apply.service.ts'];
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

  it('the import service creates schools in exactly one place — its createSchools step — not through a general helper', () => {
    const source = readFileSync(join(SRC, 'schools/import/school-import.service.ts'), 'utf8');
    const creations = source.match(new RegExp(CREATES_SCHOOL.source, 'gi')) ?? [];
    expect(creations).toHaveLength(1);
    const body = source.slice(source.indexOf('private async createSchools('));
    expect(CREATES_SCHOOL.test(body.slice(0, body.indexOf('\n  }\n')))).toBe(true);
    // The directory sync (S2b): exactly one creation, inside its locked, approved apply.
    const apply = readFileSync(join(SRC, 'schools/sync/review/school-sync-apply.service.ts'), 'utf8');
    expect(apply.match(new RegExp(CREATES_SCHOOL.source, 'gi'))).toHaveLength(1);
    const applyBody = apply.slice(apply.indexOf('private async applyOnce('), apply.indexOf('// ─── After apply'));
    expect(CREATES_SCHOOL.test(applyBody)).toBe(true);
    expect(applyBody).toContain("await lockSchoolDirectory(tx, 'exclusive');");
    // AdminSchoolsService: exactly one creation too (its create()).
    expect(readFileSync(join(SRC, 'schools/admin-schools.service.ts'), 'utf8').match(new RegExp(CREATES_SCHOOL.source, 'gi'))).toHaveLength(1);
  });

  it('the pattern catches every Prisma creation form and raw SQL', () => {
    for (const s of ['tx.school.create({', 'this.prisma.school.upsert(', 'db.school.createMany (', 'INSERT INTO "School" (']) expect([s, CREATES_SCHOOL.test(s)]).toEqual([s, true]);
    for (const s of ['tx.school.findUnique(', 'tx.school.update(', 'tx.schoolAffiliation.create(']) expect([s, CREATES_SCHOOL.test(s)]).toEqual([s, false]);
  });
});
