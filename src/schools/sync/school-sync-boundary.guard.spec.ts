/**
 * S2a write boundary (G; owner-approved 2026-11-11), checked on the source code: the directory
 * sync's S2a code writes ONLY its staging tables (SchoolSyncRun, SchoolSyncItem,
 * SchoolSyncChange) and audit entries — never a school, contact, education level, programme,
 * external id or source record. Those writes belong exclusively to S2b's approved apply.
 * The e2e test (school-sync-staging.e2e-spec.ts) proves the same on a database (checksums).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname);
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => [f, readFileSync(join(DIR, f), 'utf8')] as const);

const WRITE = '(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)';
const DIRECTORY_WRITE = new RegExp(`\\.(school|schoolContact|schoolEducationLevel|schoolProgramme|programme|schoolExternalId|schoolSourceRecord|educationLevel|schoolDataSource)\\.${WRITE}\\s*\\(`);
const DIRECTORY_SQL = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(School|SchoolContact|SchoolEducationLevel|SchoolProgramme|Programme|SchoolExternalId|SchoolSourceRecord|EducationLevel|SchoolDataSource)"/i;
const ANY_WRITE = new RegExp(`\\.([a-zA-Z]+)\\.${WRITE}\\s*\\(`, 'g');
const STAGING = new Set(['schoolSyncRun', 'schoolSyncItem', 'schoolSyncChange']);

describe('school directory sync — S2a write boundary', () => {
  it('no S2a file writes a directory table (Prisma or SQL)', () => {
    for (const [name, src] of files) {
      expect([name, DIRECTORY_WRITE.test(src), DIRECTORY_SQL.test(src)]).toEqual([name, false, false]);
    }
  });

  it('the only tables S2a writes are its staging tables (audit entries go through AuditService)', () => {
    const written = new Set<string>();
    for (const [, src] of files) for (const m of src.matchAll(ANY_WRITE)) written.add(m[1]);
    expect([...written].filter((t) => !STAGING.has(t))).toEqual([]);
    expect([...written].sort()).toEqual(['schoolSyncChange', 'schoolSyncItem', 'schoolSyncRun']);
    expect(files.some(([, src]) => /\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe/.test(src))).toBe(false);
  });

  it('the purge clears only staged values (raw, normalized, currentValue, publishedValue) and stagedPurgedAt', () => {
    const src = files.find(([n]) => n === 'school-sync.service.ts')![1].replace(/\r\n/g, '\n');
    const purge = src.slice(src.indexOf('async purgeStaging('), src.indexOf('/** Daily: expire, then purge. */'));
    const updates = [...purge.matchAll(/\.(schoolSyncRun|schoolSyncItem|schoolSyncChange)\.updateMany\(\{[^]*?data: (\{[^}]*\})/g)].map((m) => [m[1], m[2]]);
    expect(updates).toEqual([
      ['schoolSyncRun', '{ stagedPurgedAt: this.now() }'],
      ['schoolSyncItem', '{ raw: Prisma.DbNull, normalized: Prisma.DbNull }'],
      ['schoolSyncChange', '{ currentValue: Prisma.DbNull, publishedValue: Prisma.DbNull }'],
    ]);
  });

  it('the patterns catch what they must', () => {
    for (const s of ['tx.school.update(', 'this.prisma.schoolSourceRecord.createMany(', 'tx.schoolExternalId.create (', 'tx.programme.upsert(']) expect([s, DIRECTORY_WRITE.test(s)]).toEqual([s, true]);
    for (const s of ['tx.school.findMany(', 'tx.schoolSyncRun.create(', 'tx.schoolSyncItem.updateMany(']) expect([s, DIRECTORY_WRITE.test(s)]).toEqual([s, false]);
    for (const s of ['INSERT INTO "School"', 'UPDATE "SchoolContact" SET', 'DELETE FROM "SchoolSourceRecord"']) expect([s, DIRECTORY_SQL.test(s)]).toEqual([s, true]);
  });
});
