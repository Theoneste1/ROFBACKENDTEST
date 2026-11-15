/**
 * Synthetic NESA-shaped export files for tests (school directory S2a). Every value is invented —
 * the real NESA workbook (it holds personal e-mail addresses and phone numbers) is never used in
 * development or committed. Contact values use reserved example domains and unassigned numbers.
 */
import ExcelJS from 'exceljs';

import { NESA_COLUMNS } from './sync-datasets.js';

export type NesaRow = Record<(typeof NESA_COLUMNS)[number], string>;

let seq = 0;

/** A plausible row (Southern Province / Huye / Ngoma, primary school) with overrides. */
export function nesaRow(over: Partial<NesaRow> = {}): NesaRow {
  const n = ++seq;
  return {
    'No.': String(n), Province: 'South', District: 'Huye', Sector: 'Ngoma', Cell: 'Butare', Village: `Village ${n}`,
    'School Code': '', 'School Name': `EP SYNTHETIC ${n}`, Accommodation: 'DAY', 'School Status': 'PUBLIC',
    Email: `school${n}@example.org`, Phone: '0788000' + String(100 + (n % 900)).padStart(3, '0'),
    'Pre-Primary': 'No', Primary: 'Yes', 'O-Level': 'No', 'A-Level': 'No',
    'Combinations/Trades/Other Programmes': '',
    'All Education Levels (as listed by NESA)': 'PRIMARY (PR)',
    ...over,
  };
}

/** An .xlsx export: the "All Schools" sheet (header + rows, every value text) and optional "Summary" lines. */
export async function nesaWorkbook(rows: NesaRow[], opts: {
  summary?: Array<[label: string, value: number, formula?: string]>; sheet?: string; columns?: readonly string[];
  cell?: (row: number, column: string) => ExcelJS.CellValue | undefined;
} = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  if (opts.summary) {
    const s = wb.addWorksheet('Summary');
    s.addRow(['Source', 'NESA accredited-schools exports (synthetic test file)']);
    for (const [label, value, formula] of opts.summary) {
      const r = s.addRow([label]);
      r.getCell(2).value = formula ? { formula, result: value } : value;
    }
  }
  const ws = wb.addWorksheet(opts.sheet ?? 'All Schools');
  const columns = opts.columns ?? NESA_COLUMNS;
  ws.addRow([...columns]);
  rows.forEach((row, i) => {
    const r = ws.addRow(columns.map((c) => (row as Record<string, string>)[c] ?? ''));
    columns.forEach((c, j) => {
      const custom = opts.cell?.(i, c);
      if (custom !== undefined) r.getCell(j + 1).value = custom;
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A .csv export (RFC 4180, every value quoted). */
export function nesaCsv(rows: NesaRow[], columns: readonly string[] = NESA_COLUMNS): Buffer {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return Buffer.from([columns.map(q).join(','), ...rows.map((r) => columns.map((c) => q((r as Record<string, string>)[c] ?? '')).join(','))].join('\r\n'), 'utf8');
}
