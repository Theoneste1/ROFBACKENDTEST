/**
 * Reading a directory-sync source file (school directory S2a). The file-safety checks of the
 * general import (PR D) run first: size, extension, CSV text checks, and the .xlsx zip checks
 * (inspectZip) before any library unpacks the archive. Then:
 *
 *   - the data sheet is the dataset's sheet, found by name (a .csv holds only the data);
 *   - the header row must contain exactly the dataset's columns (each once; order free);
 *   - every cell is kept VERBATIM as text (raw) — nothing trimmed or corrected; a formula, date or
 *     error cell in the data is kept as empty with a row problem (the row is never dropped);
 *   - the dataset's summary sheet (if any) is read as label → number pairs (formula results
 *     included), for reconciliation only.
 */
import { extname } from 'node:path';

import { HttpStatus } from '@nestjs/common';
import ExcelJS from 'exceljs';

import { parseCsv } from '../../common/csv-parse.js';
import { AppError } from '../../common/errors/app-error.js';
import { inspectZip } from '../import/school-import.parser.js';
import {
  SYNC_MAX_BYTES, SYNC_MAX_ROWS, SYNC_ZIP_MAX_ENTRIES, SYNC_ZIP_MAX_UNCOMPRESSED, type SyncDataset,
} from './sync-datasets.js';

export interface SourceRow {
  /** 1-based row number in the sheet (or line in the CSV). */
  row: number;
  sourceRef: string;
  /** Every column of the dataset → the cell exactly as published. */
  raw: Record<string, string>;
  /** Cells that could not be read as text (formula, date, error). */
  problems: string[];
}

export interface SourceSummaryLine { label: string; value: number }

export interface ParsedSource {
  format: 'csv' | 'xlsx';
  rows: SourceRow[];
  /** null: the file has no summary (a .csv, or no summary sheet). */
  summary: SourceSummaryLine[] | null;
}

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MAX_SUMMARY_LINES = 500;
const unsupported = (message: string) => new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_FILE_TYPE', message);
const invalidXlsx = (message: string) => new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'INVALID_XLSX', message);

export async function readSourceFile(
  dataset: SyncDataset,
  file: { buffer?: Buffer; originalname?: string } | undefined,
): Promise<ParsedSource> {
  if (!file?.buffer?.length) throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Upload a .csv or .xlsx file in the "file" field.');
  if (file.buffer.length > SYNC_MAX_BYTES) {
    throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'FILE_TOO_LARGE', `A directory file must be at most ${SYNC_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  const ext = extname(String(file.originalname ?? '')).toLowerCase();
  if (ext === '.csv') return { format: 'csv', rows: finish(readCsv(dataset, file.buffer)), summary: null };
  if (ext === '.xlsx') {
    const { rows, summary } = await readXlsx(dataset, file.buffer);
    return { format: 'xlsx', rows: finish(rows), summary };
  }
  throw unsupported('Upload a .csv or .xlsx file (.xls and macro-enabled .xlsm files are not accepted).');
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

function readCsv(dataset: SyncDataset, buffer: Buffer): SourceRow[] {
  if (buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) throw unsupported('This file is not CSV text (it looks like a spreadsheet; upload it as .xlsx).');
  if (buffer.includes(0)) throw unsupported('This file is not CSV text.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw unsupported('The file is not UTF-8 text. Save it as "CSV UTF-8".');
  }
  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(text, { trimValues: false });
  } catch (err) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_CSV', (err as Error).message);
  }
  checkHeader(dataset, parsed.headers);
  return parsed.records.map((r) => ({
    row: r.line,
    sourceRef: `csv!${r.line}`,
    raw: Object.fromEntries(dataset.columns.map((c) => [c, r.values[c] ?? ''])),
    problems: [],
  }));
}

// ─── XLSX ────────────────────────────────────────────────────────────────────

async function readXlsx(dataset: SyncDataset, buffer: Buffer): Promise<{ rows: SourceRow[]; summary: SourceSummaryLine[] | null }> {
  if (!buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) throw unsupported('This file is not an .xlsx workbook.');
  inspectZip(buffer, { maxEntries: SYNC_ZIP_MAX_ENTRIES, maxUncompressed: SYNC_ZIP_MAX_UNCOMPRESSED });
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw invalidXlsx('The workbook could not be read. Save it again as an .xlsx file.');
  }
  const sheet = workbook.getWorksheet(dataset.sheet);
  if (!sheet) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'SYNC_SHEET_MISSING', `The workbook has no "${dataset.sheet}" sheet.`, {
      expected: dataset.sheet, sheets: workbook.worksheets.map((s) => s.name).slice(0, 50),
    });
  }

  let columns: Map<number, string> | null = null;
  const rows: SourceRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: Array<{ col: number; text: string; problem?: string }> = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => cells.push({ col, ...rawText(cell) }));
    if (!cells.some((c) => c.text.trim() !== '' || c.problem)) return;   // a blank row
    if (!columns) {
      if (cells.some((c) => c.problem)) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SYNC_HEADER', 'The header row must contain plain text column names.');
      const names = cells.map((c) => c.text.trim());
      checkHeader(dataset, names);
      columns = new Map(cells.map((c) => [c.col, c.text.trim()]));
      return;
    }
    const raw: Record<string, string> = Object.fromEntries(dataset.columns.map((c) => [c, '']));
    const problems: string[] = [];
    for (const c of cells) {
      const name = columns.get(c.col);
      if (!name) continue;   // outside the header: not part of the dataset
      raw[name] = c.text;
      if (c.problem) problems.push(`${name}: ${c.problem}`);
    }
    rows.push({ row: row.number, sourceRef: `${dataset.sheet}!${row.number}`, raw, problems });
  });
  if (!columns) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SYNC_HEADER', 'The sheet has no header row.', { expected: dataset.columns });

  return { rows, summary: dataset.summarySheet ? readSummary(workbook.getWorksheet(dataset.summarySheet)) : null };
}

/** A data cell as text, exactly as written; formulas, dates and errors are not data. */
function rawText(cell: ExcelJS.Cell): { text: string; problem?: string } {
  const v = cell.value as unknown;
  if (cell.type === ExcelJS.ValueType.Formula || (v !== null && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v))) {
    return { text: '', problem: 'a formula, not a value' };
  }
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'string') return { text: v };
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v) };
  if (v instanceof Date) return { text: '', problem: 'a date, not text' };
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray((v as { richText: unknown[] }).richText)) {
      return { text: (v as { richText: Array<{ text?: string }> }).richText.map((r) => r.text ?? '').join('') };
    }
    if ('error' in v) return { text: '', problem: 'an error value' };
    if ('text' in v && typeof (v as { text: unknown }).text === 'string') return { text: (v as { text: string }).text };   // a hyperlink
  }
  return { text: '', problem: 'unsupported content' };
}

/** label → number lines of a summary sheet (the first text cell and the first number after it). */
function readSummary(sheet: ExcelJS.Worksheet | undefined): SourceSummaryLine[] | null {
  if (!sheet) return null;
  const lines: SourceSummaryLine[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (lines.length >= MAX_SUMMARY_LINES) return;
    let label: string | null = null;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (lines.length >= MAX_SUMMARY_LINES) return;
      const v = cell.value as unknown;
      const n = typeof v === 'number' ? v
        : v !== null && typeof v === 'object' && 'result' in v && typeof (v as { result: unknown }).result === 'number' ? (v as { result: number }).result
        : null;
      if (label === null) {
        const t = typeof v === 'string' ? v.trim() : rawText(cell).text.trim();
        if (t && n === null) label = t.slice(0, 200);
        return;
      }
      if (n !== null && Number.isFinite(n)) { lines.push({ label, value: n }); label = '\u0000'; }
    });
  });
  return lines.filter((l) => l.label !== '\u0000');
}

// ─── Shared ──────────────────────────────────────────────────────────────────

function checkHeader(dataset: SyncDataset, names: string[]): void {
  const expected = new Set(dataset.columns);
  const seen = new Set<string>();
  const unknown: string[] = [];
  const repeated: string[] = [];
  for (const n of names) {
    if (!expected.has(n)) unknown.push(n);
    else if (seen.has(n)) repeated.push(n);
    seen.add(n);
  }
  const missing = dataset.columns.filter((c) => !seen.has(c));
  if (unknown.length || repeated.length || missing.length) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SYNC_HEADER', `The header row must contain exactly the ${dataset.name} columns.`, {
      expected: dataset.columns, missing, unknown: unknown.slice(0, 50), repeated,
    });
  }
}

function finish(rows: SourceRow[]): SourceRow[] {
  if (rows.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_IMPORT', 'The file has a header but no data rows.');
  if (rows.length > SYNC_MAX_ROWS) throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_ROWS', `At most ${SYNC_MAX_ROWS} rows per directory file.`);
  return rows;
}
