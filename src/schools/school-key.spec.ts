import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { schoolKey } from './school-key.js';

describe('schoolKey (P1-11)', () => {
  it.each([
    ['  Lycée de Kigali ', 'lycee de kigali'],
    ['LYCEE DE KIGALI', 'lycee de kigali'],
    ['G.S  Remera', 'g s remera'],
    ['ES  Bumbogo—', 'es bumbogo'],
    ['Collège Saint-André', 'college saint andre'],
  ])('%j → %j', (input, key) => expect(schoolKey(input)).toBe(key));

  it('uses the same accent table and pattern as the M8 migration SQL (cannot drift)', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '20261121000700_official_school_list', 'migration.sql'), 'utf8');
    expect(sql).toContain("'àáâäãåçèéêëìíîïñòóôöõùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'), '[^a-z0-9]+', ' ', 'g'))");
    const src = readFileSync(join(__dirname, 'school-key.ts'), 'utf8');
    expect(src).toContain("const FROM = 'àáâäãåçèéêëìíîïñòóôöõùúûüýÿ';");
    expect(src).toContain("const TO   = 'aaaaaaceeeeiiiinooooouuuuyy';");
  });
});
