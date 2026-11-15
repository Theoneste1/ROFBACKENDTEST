/**
 * NESA accredited-schools rows → normalised values (normaliser "nesa-v1"; school directory S2a,
 * owner-approved 2026-11-11). Pure: the raw cells stay untouched (they are stored verbatim);
 * this only derives values to compare with the directory, and records every problem as an issue.
 *
 *   name           trimmed at the ends only — internal spacing and spelling kept exactly (Q9)
 *   province       East / North / South / West / Kigali City → the stored spelling (M8)
 *   district …     matched to the directory ignoring case; unknown → kept as published (a new place)
 *   code           6 digits: VALID when its first digit is the province's, PROVINCE_MISMATCH
 *                  otherwise; anything else (N/A, -, RW034, "5705 25", "SDMS CODE: …") → NONE
 *   status         ownership: PUBLIC / GOVERNMENT AIDED / PRIVATE; N/A → none
 *   accommodation  DAY / BOARDING / MIXED; N/A → none
 *   e-mail, phone  each usable value, normalised as in S1; N/A, "No Primary", the letter O for a
 *                  zero and anything unreadable → no contact, an issue (never corrected; Q4)
 *   levels         the Yes flags and the level codes of the levels column; "(L)" kept as the
 *                  qualifier; anything else there (e.g. BOARDING STATUS (BD)) → an issue
 *   programmes     "NAME (CODE)" entries of the programmes column
 *
 * Issues never contain a contact value (they appear in reports).
 */
import { normaliseContact, normalisePhone } from '../directory/school-contacts.js';
import { schoolKey } from '../school-key.js';
import { PROVINCE_BY_CODE_PREFIX } from '../school-rules.js';

export const NESA_NORMALISER_VERSION = 'nesa-v1';

export interface SyncIssue { code: string; field: string; message: string }
export type CodeStatus = 'VALID' | 'PROVINCE_MISMATCH' | 'NONE';
export interface NormalisedContact { type: 'EMAIL' | 'PHONE'; value: string }
export interface NormalisedLevel { code: string; qualifier: string | null; sourceToken: string }
export interface NormalisedProgramme {
  code: string | null; name: string; category: 'A_LEVEL_COMBINATION' | 'TVET_TRADE' | 'OTHER'; tvetLevel: number | null; sourceToken: string;
}
export interface PlaceSpelling { province: string; district: string; sector: string }

export interface NormalisedRow {
  name: string | null;
  nameKey: string | null;
  province: string | null;
  district: string | null;
  sector: string | null;
  cell: string | null;
  village: string | null;
  /** Whether province → district → sector is a place of the directory. */
  placeKnown: boolean;
  /** The place as published (for a new place). */
  publishedPlace: PlaceSpelling;
  /** The code exactly as published (trimmed) and what it is. */
  rawCode: string;
  code: string | null;
  codeStatus: CodeStatus;
  ownership: 'PUBLIC' | 'GOVERNMENT_AIDED' | 'PRIVATE' | null;
  accommodation: 'DAY' | 'BOARDING' | 'MIXED' | null;
  contacts: NormalisedContact[];
  levels: NormalisedLevel[];
  programmes: NormalisedProgramme[];
  /** Fingerprint of the published name and place (a matching aid, not an identity). */
  fingerprint: string | null;
  issues: SyncIssue[];
}

/** The directory's places (province → district → sector), to match spellings ignoring case. */
export interface DirectoryPlaces {
  provinces: ReadonlySet<string>;
  /** lower(province|district) → stored district, lower(province|district|sector) → stored sector. */
  districts: ReadonlyMap<string, string>;
  sectors: ReadonlyMap<string, string>;
}

export function directoryPlaces(places: ReadonlyArray<{ province: string | null; district: string | null; sector: string | null }>): DirectoryPlaces {
  const provinces = new Set<string>();
  const districts = new Map<string, string>();
  const sectors = new Map<string, string>();
  for (const p of places) {
    if (!p.province || !p.district || !p.sector) continue;
    provinces.add(p.province);
    districts.set(`${p.province}|${p.district}`.toLowerCase(), p.district);
    sectors.set(`${p.province}|${p.district}|${p.sector}`.toLowerCase(), p.sector);
  }
  return { provinces, districts, sectors };
}

const PROVINCES: Readonly<Record<string, string>> = {
  east: 'Eastern Province', eastern: 'Eastern Province', 'eastern province': 'Eastern Province',
  north: 'Northern Province', northern: 'Northern Province', 'northern province': 'Northern Province',
  south: 'Southern Province', southern: 'Southern Province', 'southern province': 'Southern Province',
  west: 'Western Province', western: 'Western Province', 'western province': 'Western Province',
  kigali: 'Kigali City', 'kigali city': 'Kigali City',
};
const OWNERSHIP: Readonly<Record<string, NormalisedRow['ownership']>> = {
  public: 'PUBLIC', 'government aided': 'GOVERNMENT_AIDED', 'government-aided': 'GOVERNMENT_AIDED', private: 'PRIVATE',
};
const ACCOMMODATION: Readonly<Record<string, NormalisedRow['accommodation']>> = { day: 'DAY', boarding: 'BOARDING', mixed: 'MIXED' };
const LEVEL_FLAGS: ReadonlyArray<[column: string, code: string]> = [['Pre-Primary', 'PPR'], ['Primary', 'PR'], ['O-Level', 'OL'], ['A-Level', 'AL']];
const LEVEL_CODES = new Set(['PPR', 'PR', 'OL', 'AL', 'PE']);
const NOT_AVAILABLE = /^(n\/?a|none|-+|nil|null)$/i;
/** "NAME (CODE)" — CODE may itself end with a parenthesised part, e.g. "OL(L)". */
const ENTRY = /^(.*?)\s*\(([^()]*(?:\([^()]*\))?)\)\s*$/;

const text = (v: string | undefined) => (v ?? '').trim();
const present = (v: string) => v !== '' && !NOT_AVAILABLE.test(v);

export function normaliseNesaRow(raw: Readonly<Record<string, string>>, places: DirectoryPlaces): NormalisedRow {
  const issues: SyncIssue[] = [];
  const issue = (code: string, field: string, message: string) => issues.push({ code, field, message });

  // Name — trimmed at the ends only.
  const nameText = text(raw['School Name']);
  const name = present(nameText) ? nameText : null;
  const nameKey = name ? schoolKey(name) || null : null;
  if (!name || !nameKey) issue('NAME_MISSING', 'School Name', 'No school name.');

  // Place.
  const published: PlaceSpelling = { province: text(raw.Province), district: text(raw.District), sector: text(raw.Sector) };
  const province = PROVINCES[published.province.toLowerCase()] ?? null;
  if (!province) issue('PROVINCE_UNKNOWN', 'Province', `"${published.province}" is not a province of Rwanda.`);
  let district: string | null = present(published.district) ? published.district : null;
  let sector: string | null = present(published.sector) ? published.sector : null;
  if (!district) issue('DISTRICT_MISSING', 'District', 'No district.');
  if (!sector) issue('SECTOR_MISSING', 'Sector', 'No sector.');
  let placeKnown = false;
  if (province && district) {
    const d = places.districts.get(`${province}|${district}`.toLowerCase());
    if (d) district = d;
    if (sector) {
      const s = places.sectors.get(`${province}|${district}|${sector}`.toLowerCase());
      if (s) { sector = s; placeKnown = true; }
    }
  }
  if (province && district && sector && !placeKnown) issue('NEW_PLACE', 'Sector', `${published.sector}, ${published.district}, ${published.province} is not yet a place of the directory.`);
  const cellText = text(raw.Cell);
  const villageText = text(raw.Village);
  const cell = present(cellText) ? cellText : null;
  const village = present(villageText) ? villageText : null;

  // Code.
  const rawCode = text(raw['School Code']);
  let code: string | null = null;
  let codeStatus: CodeStatus = 'NONE';
  if (/^\d{6}$/.test(rawCode)) {
    code = rawCode;
    codeStatus = province && PROVINCE_BY_CODE_PREFIX[rawCode[0]] === province ? 'VALID' : 'PROVINCE_MISMATCH';
    if (codeStatus === 'PROVINCE_MISMATCH') issue('CODE_PROVINCE_MISMATCH', 'School Code', `Code ${rawCode} does not belong to ${province ?? published.province}.`);
  } else if (present(rawCode)) {
    issue('CODE_UNUSABLE', 'School Code', `"${rawCode.slice(0, 40)}" is not a 6-digit school code.`);
  } else {
    issue('CODE_MISSING', 'School Code', 'No school code.');
  }

  // Ownership and accommodation.
  const status = text(raw['School Status']);
  const ownership = present(status) ? OWNERSHIP[status.toLowerCase().replace(/\s+/g, ' ')] ?? null : null;
  if (present(status) && !ownership) issue('STATUS_UNKNOWN', 'School Status', `"${status.slice(0, 40)}" is not a known school status.`);
  if (!present(status)) issue('STATUS_MISSING', 'School Status', 'No school status.');
  const acc = text(raw.Accommodation);
  const accommodation = present(acc) ? ACCOMMODATION[acc.toLowerCase()] ?? null : null;
  if (present(acc) && !accommodation) issue('ACCOMMODATION_UNKNOWN', 'Accommodation', `"${acc.slice(0, 40)}" is not a known accommodation.`);

  // Contacts — never corrected, never echoed in an issue.
  const contacts: NormalisedContact[] = [];
  const seen = new Set<string>();
  for (const [column, type] of [['Email', 'EMAIL'], ['Phone', 'PHONE']] as const) {
    const cellValue = text(raw[column]);
    if (!present(cellValue)) { issue('CONTACT_MISSING', column, `No ${column.toLowerCase()}.`); continue; }
    const parts = cellValue.split(/\s*[,;/|\n]\s*|\s+(?:or|and)\s+/i).filter((x) => x !== '');
    let unusable = 0;
    for (const part of parts) {
      const n = type === 'PHONE' ? normalisePhone(part) : (() => { const r = normaliseContact('EMAIL', part); return 'value' in r ? r.value : null; })();
      if (!n) { unusable++; continue; }
      const k = `${type}|${n}`;
      if (!seen.has(k)) { seen.add(k); contacts.push({ type, value: n }); }
    }
    if (unusable) issue('CONTACT_UNUSABLE', column, `${unusable} ${column.toLowerCase()} value(s) not usable (kept in the source record only).`);
  }

  // Levels — flags and level codes.
  const levelsColumn = text(raw['All Education Levels (as listed by NESA)']);
  const fromCodes = new Map<string, NormalisedLevel>();
  for (const token of entries(levelsColumn)) {
    const m = ENTRY.exec(token);
    if (!m) continue;
    const inner = m[2].trim();
    const base = /^(PPR|PR|OL|AL|PE)\b/.exec(inner)?.[1] ?? null;
    if (!base || !LEVEL_CODES.has(base)) {
      if (/LEVEL|PRIMARY|STATUS|EDUCATION/i.test(m[1])) issue('LEVEL_UNKNOWN', 'All Education Levels (as listed by NESA)', `"${token.slice(0, 60)}" is not a known education level.`);
      continue;
    }
    const qualifier = inner.slice(base.length).trim() || null;
    if (!fromCodes.has(base)) fromCodes.set(base, { code: base, qualifier, sourceToken: token });
  }
  const levels = new Map(fromCodes);
  for (const [column, codeOf] of LEVEL_FLAGS) {
    const flag = /^yes$/i.test(text(raw[column]));
    if (flag && !levels.has(codeOf)) levels.set(codeOf, { code: codeOf, qualifier: null, sourceToken: `${column}: Yes` });
    if (flag !== fromCodes.has(codeOf)) issue('LEVEL_FLAG_MISMATCH', column, `The ${column} flag and the levels column disagree.`);
  }

  // Programmes.
  const programmes: NormalisedProgramme[] = [];
  const seenProgrammes = new Set<string>();
  for (const token of entries(text(raw['Combinations/Trades/Other Programmes']))) {
    if (!present(token)) continue;
    const m = ENTRY.exec(token);
    const pName = (m ? m[1] : token).trim();
    const pCode = m ? m[2].trim() || null : null;
    if (!pName) continue;
    if (pCode && LEVEL_CODES.has(pCode.replace(/\(.*$/, '').trim())) continue;   // a level, not a programme
    const category = classify(pName, pCode);
    const key = pCode ? `code:${pCode.toUpperCase()}` : `name:${category}|${pName.toUpperCase()}`;
    if (seenProgrammes.has(key)) continue;
    seenProgrammes.add(key);
    programmes.push({ code: pCode, name: pName, category, tvetLevel: tvetLevel(pName), sourceToken: token });
  }

  const fingerprint = nameKey && province && district && sector
    ? ['fp1', nameKey, province, district, sector, cell ?? '', village ?? ''].map((x) => x.toLowerCase()).join('|')
    : null;

  return {
    name, nameKey, province, district, sector, cell, village, placeKnown, publishedPlace: published,
    rawCode, code, codeStatus, ownership, accommodation, contacts,
    levels: [...levels.values()].sort((a, b) => a.code.localeCompare(b.code)),
    programmes, fingerprint, issues,
  };
}

/** Entries of a list cell: split on new lines, semicolons and pipes, and on commas between entries. */
function entries(cellValue: string): string[] {
  return cellValue
    .split(/\s*[\n;|]\s*/)
    .flatMap((part) => part.split(/(?<=\))\s*,\s*/))
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

function classify(name: string, code: string | null): NormalisedProgramme['category'] {
  if (/\bLEVEL\s*\d\b|\bL\s?\d\b|TVET|TECHNICAL|VOCATIONAL/i.test(name)) return 'TVET_TRADE';
  if (code && /^[A-Z]{3,4}$/.test(code) && /-/.test(name)) return 'A_LEVEL_COMBINATION';
  return 'OTHER';
}

function tvetLevel(name: string): number | null {
  const m = /\b(?:LEVEL\s*|L\s?)(\d)\b/i.exec(name);
  return m ? Number(m[1]) : null;
}
