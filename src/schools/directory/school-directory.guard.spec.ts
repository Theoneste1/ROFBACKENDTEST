/**
 * School directory S1 guards (owner-approved 2026-11-11), checked on the source code:
 *
 *   1. Contacts are read and written only by SchoolDirectoryDataService (Administrator routes).
 *      Public search, registration, the deprecated /schools routes, reports and every CSV export
 *      never select them (decisions 3 and D6: no contacts in exports, Super Admins included).
 *   2. Every file that writes a school or its directory data takes the directory lock (D1), so a
 *      directory sync (exclusive) never runs alongside a school write.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..', '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.testing.ts') ? [path] : [];
  });
}
const rel = (f: string) => relative(SRC, f).split(sep).join('/');

const READS_CONTACTS = /\.schoolContact\.|\bcontacts\s*:\s*(true|\{)|"SchoolContact"/;
const WRITES_SCHOOL_DATA = /\.(school|schoolContact|schoolEducationLevel|schoolProgramme|schoolExternalId|schoolSourceRecord)\.(create|createMany|createManyAndReturn|upsert|update|updateMany|delete|deleteMany)\s*\(|(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"School(Contact|EducationLevel|Programme|ExternalId|SourceRecord)?"/i;

describe('school directory guards (S1)', () => {
  it('contacts: only SchoolDirectoryDataService reads or writes them', () => {
    expect(files(SRC).filter((f) => READS_CONTACTS.test(readFileSync(f, 'utf8'))).map(rel))
      .toEqual(['schools/directory/school-directory-data.service.ts']);
  });

  it('contacts are never deleted, and what an audit entry records of a contact is masked — never its value (M1)', () => {
    const service = readFileSync(join(SRC, 'schools/directory/school-directory-data.service.ts'), 'utf8');
    for (const f of files(SRC)) expect([rel(f), /\.schoolContact\.(delete|deleteMany)\s*\(|DELETE\s+FROM\s+"SchoolContact"/i.test(readFileSync(f, 'utf8'))]).toEqual([rel(f), false]);
    const start = service.indexOf('const contactFacts');
    const facts = service.slice(service.indexOf('=>', start), service.indexOf('\n\n', start));   // the returned object
    expect(facts).toContain('masked: maskContact(c.type, c.value)');
    expect(facts.replace('maskContact(c.type, c.value)', '')).not.toMatch(/\bvalue\b\s*:|c\.value|rawValue/);
    // Every contact handed to an audit entry goes through contactFacts.
    const auditCalls = service.split('this.audit.log(').slice(1).map((c) => c.slice(0, c.indexOf('}, tx);')));
    for (const call of auditCalls) expect(call).not.toMatch(/\.value\b|rawValue/);
    // The reason of a contact change is recorded only through contactReason (e-mails and phones masked).
    const contactCalls = auditCalls.filter((c) => /'UPDATE_SCHOOL_CONTACTS'|'SCHOOL_CONTACT_VERIFIED'/.test(c));
    expect(contactCalls).toHaveLength(2);
    for (const call of contactCalls) {
      expect(call).toContain('...contactReason(dto.reason)');
      expect(call).not.toMatch(/reason:\s*dto\.reason/);
    }
  });

  it('every file that writes a school or its directory data takes the directory lock', () => {
    const writers = files(SRC).filter((f) => WRITES_SCHOOL_DATA.test(readFileSync(f, 'utf8')));
    expect(writers.map(rel).sort()).toEqual([
      'schools/admin-schools.service.ts',
      'schools/directory/school-directory-data.service.ts',
      'schools/import/school-import.service.ts',
    ]);
    for (const f of writers) expect([rel(f), /lockSchoolDirectory\(tx, 'shared'\)/.test(readFileSync(f, 'utf8'))]).toEqual([rel(f), true]);
  });

  it('the patterns catch what they must', () => {
    for (const s of ['tx.schoolContact.findMany(', 'select: { contacts: true }', 'contacts: { where', 'FROM "SchoolContact"']) expect([s, READS_CONTACTS.test(s)]).toEqual([s, true]);
    for (const s of ['tx.school.update(', 'tx.schoolProgramme.deleteMany(', 'UPDATE "School" SET', 'DELETE FROM "SchoolContact"']) expect([s, WRITES_SCHOOL_DATA.test(s)]).toEqual([s, true]);
    for (const s of ['tx.school.findMany(', 'tx.schoolAffiliation.update(', 'UPDATE "User" SET']) expect([s, WRITES_SCHOOL_DATA.test(s)]).toEqual([s, false]);
  });
});
