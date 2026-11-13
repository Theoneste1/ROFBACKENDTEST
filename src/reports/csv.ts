/**
 * Minimal RFC 4180 CSV writer with spreadsheet formula-injection protection:
 * cells starting with = + - @ (or tab/CR) are prefixed with an apostrophe so
 * Excel/Sheets treat them as text, not formulas.
 *
 * Exports are STREAMED (M5): a CsvExport is a header plus batches of rows read from the database
 * a batch at a time, so an export has no row limit and its memory does not grow with its size.
 * Before, every export stopped silently at 50,000 rows.
 */
export type CsvValue = string | number | boolean | Date | null | undefined;

/** BOM so Excel opens UTF-8 (names with accents) correctly. */
export const CSV_BOM = '﻿';

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return CSV_BOM + [headers, ...rows].map(csvLine).join('');
}

/** One CSV line, CRLF-terminated. */
export function csvLine(row: CsvValue[]): string {
  return row.map(cell).join(',') + '\r\n';
}

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Only free text can carry a formula; real numbers (e.g. -5) stay numeric.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ─── Streamed exports ─────────────────────────────────────────────────────────

export interface CsvExport {
  headers: string[];
  /** Rows in order, a batch at a time. */
  batches: AsyncIterable<CsvValue[][]>;
}

/** Rows per database round trip. REPORT_CSV_BATCH_SIZE (tests only) makes the e2e suite cross batch borders. */
export function csvBatchSize(): number {
  const n = Number(process.env.REPORT_CSV_BATCH_SIZE);
  return Number.isInteger(n) && n > 0 ? n : 2_000;
}

/** An export whose rows are already in memory (aggregate reports with a bounded number of rows). */
export function csvFromRows(headers: string[], rows: CsvValue[][]): CsvExport {
  return { headers, batches: (async function* () { if (rows.length) yield rows; })() };
}

/** The whole export as one string (tests, and callers that need the text). */
export async function csvText(exp: CsvExport): Promise<string> {
  let out = CSV_BOM + csvLine(exp.headers);
  for await (const batch of exp.batches) out += batch.map(csvLine).join('');
  return out;
}

export type BatchPage = { take: number; skip?: number; cursor?: { id: string } };

/**
 * Keyset paging by `id` (Prisma cursor): `fetch` must apply the export's orderBy, which must end with
 * `id` and use only the model's own columns. Stable while rows are added or removed during the export.
 */
export async function* keysetBatches<T extends { id: string }>(fetch: (page: BatchPage) => Promise<T[]>, size = csvBatchSize()): AsyncGenerator<T[]> {
  let after: string | undefined;
  for (;;) {
    const rows = await fetch({ take: size, ...(after !== undefined && { cursor: { id: after }, skip: 1 }) });
    if (rows.length) yield rows;
    if (rows.length < size) return;
    after = rows[rows.length - 1].id;
  }
}

/**
 * Offset paging, for an order through a relation (where keyset paging is not used). Its order must be
 * total (end with `id`); a row added or removed during the export can shift a later page by one.
 */
export async function* offsetBatches<T>(fetch: (page: BatchPage) => Promise<T[]>, size = csvBatchSize()): AsyncGenerator<T[]> {
  for (let skip = 0; ; skip += size) {
    const rows = await fetch({ take: size, skip });
    if (rows.length) yield rows;
    if (rows.length < size) return;
  }
}

/** Turn each batch of records into CSV rows (may query per batch, e.g. grouped counts for those ids). */
export async function* mapBatches<T>(source: AsyncIterable<T[]>, toRows: (batch: T[]) => Promise<CsvValue[][]> | CsvValue[][]): AsyncGenerator<CsvValue[][]> {
  for await (const batch of source) yield await toRows(batch);
}
