/**
 * Normalised school name (P1-11, M8): lower case, common accents removed, every
 * run of non-alphanumeric characters → one space, trimmed. Must match the SQL in
 * prisma/migrations/20261121000700_official_school_list/migration.sql
 * (school-key.spec.ts checks the two stay identical).
 *
 *   "  Lycée de Kigali " → "lycee de kigali"   ("LYCEE DE KIGALI" → the same)
 */
const FROM = 'àáâäãåçèéêëìíîïñòóôöõùúûüýÿ';
const TO   = 'aaaaaaceeeeiiiinooooouuuuyy';

export function schoolKey(name: string): string {
  let out = '';
  for (const ch of name.toLowerCase()) {
    const i = FROM.indexOf(ch);
    out += i >= 0 ? TO[i] : ch;
  }
  return out.replace(/[^a-z0-9]+/g, ' ').trim();
}
