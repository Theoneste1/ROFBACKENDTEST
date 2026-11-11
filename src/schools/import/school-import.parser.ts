/**
 * Reading a school import file (PR D). Every check that protects the server runs BEFORE any
 * library parses the file:
 *
 *   1. present; at most IMPORT_MAX_BYTES (also enforced by the upload interceptor)
 *   2. extension .csv or .xlsx only (.xls, .xlsm and anything else: 415)
 *   3. signature: .xlsx starts with the zip signature; .csv is strict UTF-8 without NUL bytes
 *      and is not a zip in disguise
 *   4. .xlsx zip checks on the central directory — at most ZIP_MAX_ENTRIES entries, at most
 *      ZIP_MAX_UNCOMPRESSED bytes declared, no encrypted entries, no ZIP64, no absolute / ".."
 *      paths, no macro part (vbaProject.bin) — then every entry is actually inflated under a
 *      hard output limit and must match its declared size (a lying zip bomb is caught)
 *   5. only then exceljs reads the workbook; only the "Schools" sheet (else the first) is read
 *
 * Cells are text: CSV through the RFC 4180 parser (nothing evaluated); XLSX strings, numbers
 * and booleans become strings, rich text and hyperlinks their text; a FORMULA cell, a date or
 * an error value is a row error (formulas are never evaluated or imported).
 *
 * CSV and XLSX then behave identically: every value trimmed; an empty or whitespace-only cell
 * is "not provided"; a row whose cells are all blank is ignored; the header is the first
 * non-blank row; the row limit counts non-empty data rows; no data rows → EMPTY_IMPORT.
 */
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { HttpStatus } from '@nestjs/common';
import ExcelJS from 'exceljs';

import { AppError } from '../../common/errors/app-error.js';
import { parseCsv } from '../../common/csv-parse.js';

export const IMPORT_MAX_BYTES     = 1024 * 1024;
export const IMPORT_MAX_ROWS      = 1000;
export const ZIP_MAX_ENTRIES      = 50;
export const ZIP_MAX_UNCOMPRESSED = 20 * 1024 * 1024;

export const IMPORT_COLUMNS = ['name', 'countryCode', 'code', 'province', 'district', 'sector', 'location', 'ownership'] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export interface ImportRow {
  /** The CSV file line, or the XLSX sheet row — what an Administrator sees in their file. */
  row:    number;
  /** Provided values only (trimmed, non-empty). */
  values: Partial<Record<ImportColumn, string>>;
  /** Cell problems found while reading (formula, date, error value). */
  errors: string[];
}

export interface ParsedImport { format: 'csv' | 'xlsx'; rows: ImportRow[] }

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const unsupported = (message: string) => new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_FILE_TYPE', message);
const invalidXlsx = (message: string) => new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'INVALID_XLSX', message);

export async function parseSchoolImport(file: { buffer?: Buffer; originalname?: string; size?: number } | undefined): Promise<ParsedImport> {
  if (!file?.buffer?.length) throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Upload a .csv or .xlsx file in the "file" field.');
  if (file.buffer.length > IMPORT_MAX_BYTES) {
    throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'FILE_TOO_LARGE', 'The import file must be at most 1 MB.');
  }
  const ext = extname(String(file.originalname ?? '')).toLowerCase();
  if (ext === '.csv') return { format: 'csv', rows: readCsv(file.buffer) };
  if (ext === '.xlsx') return { format: 'xlsx', rows: await readXlsx(file.buffer) };
  throw unsupported('Upload a .csv or .xlsx file (.xls and macro-enabled .xlsm files are not accepted).');
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

function readCsv(buffer: Buffer): ImportRow[] {
  if (buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) throw unsupported('This file is not CSV text (it looks like a spreadsheet; save it as .xlsx).');
  if (buffer.includes(0)) throw unsupported('This file is not CSV text.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw unsupported('The file is not UTF-8 text. Save it as "CSV UTF-8".');
  }
  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(text);
  } catch (err) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_CSV', (err as Error).message);
  }
  const header = checkHeader(parsed.headers);
  return finish(parsed.records.map((r) => ({
    row: r.line,
    values: pick(header, header.map((h) => r.values[h] ?? '')),
    errors: [],
  })));
}

// ─── XLSX ────────────────────────────────────────────────────────────────────

async function readXlsx(buffer: Buffer): Promise<ImportRow[]> {
  if (!buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) throw unsupported('This file is not an .xlsx workbook.');
  inspectZip(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw invalidXlsx('The workbook could not be read. Save it again as an .xlsx file.');
  }
  const sheet = workbook.getWorksheet('Schools') ?? workbook.worksheets[0];
  if (!sheet) throw invalidXlsx('The workbook has no sheet.');

  let header: ImportColumn[] | null = null;
  let headerCols: number[] = [];
  const rows: ImportRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: Array<{ col: number; text: string; problem?: string }> = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => cells.push({ col, ...cellText(cell) }));
    if (!cells.some((c) => c.text !== '' || c.problem)) return;   // a blank row
    if (!header) {
      const bad = cells.find((c) => c.problem);
      if (bad) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_IMPORT_HEADER', 'The header row must contain plain text column names.');
      }
      // Columns 1..last header cell, blanks included — a blank header name is refused, as in CSV.
      const maxCol = Math.max(...cells.map((c) => c.col));
      const names = Array.from({ length: maxCol }, (_, i) => cells.find((c) => c.col === i + 1)?.text ?? '');
      header = checkHeader(names);
      headerCols = names.map((_, i) => i + 1);
      return;
    }
    const byCol = new Map(cells.map((c) => [c.col, c]));
    const values = header.map((_, i) => byCol.get(headerCols[i])?.text ?? '');
    const errors = cells.filter((c) => c.problem && headerCols.includes(c.col)).map((c) => `${c.problem} (cell ${columnLetter(c.col)}${row.number}).`);
    rows.push({ row: row.number, values: pick(header, values), errors });
  });
  if (!header) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_IMPORT_HEADER', 'The sheet has no header row.', { expected: IMPORT_COLUMNS });
  return finish(rows);
}

/** A cell as text, or the reason it cannot be imported. */
function cellText(cell: ExcelJS.Cell): { text: string; problem?: string } {
  const v = cell.value as unknown;
  if (cell.type === ExcelJS.ValueType.Formula || (v !== null && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v))) {
    return { text: '', problem: 'Formulas are not imported; enter the value itself' };
  }
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'string') return { text: v.trim() };
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v) };
  if (v instanceof Date) return { text: '', problem: 'Dates are not accepted; format the cell as text' };
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray((v as { richText: unknown[] }).richText)) {
      return { text: (v as { richText: Array<{ text?: string }> }).richText.map((r) => r.text ?? '').join('').trim() };
    }
    if ('error' in v) return { text: '', problem: 'The cell contains an error value' };
    if ('text' in v && typeof (v as { text: unknown }).text === 'string') return { text: (v as { text: string }).text.trim() };
  }
  return { text: '', problem: 'Unsupported cell content' };
}

function columnLetter(col: number): string {
  let s = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * Zip safety checks on the raw bytes, before any library unpacks them (see the file comment).
 * Throws 415 INVALID_XLSX.
 */
export function inspectZip(
  buf: Buffer,
  limits: { maxEntries: number; maxUncompressed: number } = { maxEntries: ZIP_MAX_ENTRIES, maxUncompressed: ZIP_MAX_UNCOMPRESSED },
): void {
  const bad = (why: string) => invalidXlsx(`The workbook was refused: ${why}.`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('it is not a valid zip archive');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw bad('ZIP64 archives are not accepted');
  if (entries > limits.maxEntries) throw bad(`it has more than ${limits.maxEntries} parts`);
  if (cdOffset + cdSize > eocd) throw bad('its directory is corrupt');

  let p = cdOffset;
  let declared = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('its directory is corrupt');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (flags & 0x1) throw bad('it contains encrypted parts');
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw bad('ZIP64 archives are not accepted');
    if (name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) throw bad('it contains an unsafe path');
    if (/(^|\/)vbaProject\.bin$/i.test(name)) throw bad('it contains macros');
    declared += usize;
    if (declared > limits.maxUncompressed) throw bad(`it unpacks to more than ${Math.round(limits.maxUncompressed / (1024 * 1024))} MB`);

    // Inflate this entry for real, bounded by its declared size: a zip that under-declares fails here.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw bad('it is corrupt');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + csize > buf.length) throw bad('it is corrupt');
    const data = buf.subarray(start, start + csize);
    let size: number;
    if (method === 0) size = data.length;
    else if (method === 8) {
      try {
        size = inflateRawSync(data, { maxOutputLength: Math.max(1, usize) }).length;
      } catch {
        throw bad('a part unpacks to more than it declares, or is corrupt');
      }
    } else throw bad('it uses an unsupported compression');
    if (size !== usize) throw bad('a part unpacks to a different size than it declares');
    p += 46 + nameLen + extraLen + commentLen;
  }
}

// ─── Shared ──────────────────────────────────────────────────────────────────

/** Header names (trimmed): known columns only, each once, `name` required. Order does not matter. */
function checkHeader(raw: string[]): ImportColumn[] {
  const names = raw.map((h) => h.trim());
  const known = IMPORT_COLUMNS as readonly string[];
  const unknown = names.filter((h) => !known.includes(h));
  const repeated = names.filter((h, i) => names.indexOf(h) !== i);
  const missing = known.includes('name') && !names.includes('name') ? ['name'] : [];
  if (unknown.length || repeated.length || missing.length) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_IMPORT_HEADER', 'The header row is not valid.', {
      missing, unknown, repeated: [...new Set(repeated)], expected: IMPORT_COLUMNS,
    });
  }
  return names as ImportColumn[];
}

function pick(header: ImportColumn[], values: string[]): Partial<Record<ImportColumn, string>> {
  const out: Partial<Record<ImportColumn, string>> = {};
  header.forEach((h, i) => { const v = (values[i] ?? '').trim(); if (v !== '') out[h] = v; });
  return out;
}

/** Blank rows ignored; the limit counts non-empty data rows; none → EMPTY_IMPORT. */
function finish(rows: ImportRow[]): ImportRow[] {
  const data = rows.filter((r) => Object.keys(r.values).length > 0 || r.errors.length > 0);
  if (data.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_IMPORT', 'The file has a header but no data rows.');
  if (data.length > IMPORT_MAX_ROWS) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_ROWS', `At most ${IMPORT_MAX_ROWS} schools per import.`);
  }
  return data;
}
