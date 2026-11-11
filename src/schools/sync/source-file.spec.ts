import { nesaCsv, nesaRow, nesaWorkbook } from './nesa-fixture.testing.js';
import { readSourceFile } from './source-file.js';
import { NESA_COLUMNS, SYNC_DATASETS, SYNC_MAX_BYTES } from './sync-datasets.js';
import { reconcile } from './sync-report.js';
import { directoryPlaces, normaliseNesaRow } from './nesa-normaliser.js';

const NESA = SYNC_DATASETS['NESA:ACCREDITED_SCHOOLS'];
const xlsx = async (...a: Parameters<typeof nesaWorkbook>) => ({ buffer: await nesaWorkbook(...a), originalname: 'nesa.xlsx' });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code ?? e.message);

describe('sync source file (S2a)', () => {
  it('xlsx: the "All Schools" sheet; every cell kept verbatim (nothing trimmed); the Summary read as label → number (formula results too)', async () => {
    const rows = [nesaRow({ 'School Name': '  EP  SPACED ', 'School Code': '220001' }), nesaRow()];
    const parsed = await readSourceFile(NESA, await xlsx(rows, { summary: [['Total schools', 2, 'COUNTA(A:A)'], ['South', 2]] }));
    expect(parsed.format).toBe('xlsx');
    expect(parsed.rows.map((r) => [r.row, r.sourceRef, r.raw['School Name']])).toEqual([[2, 'All Schools!2', '  EP  SPACED '], [3, 'All Schools!3', rows[1]['School Name']]]);
    expect(Object.keys(parsed.rows[0].raw)).toEqual([...NESA_COLUMNS]);
    expect(parsed.summary).toEqual([{ label: 'Total schools', value: 2 }, { label: 'South', value: 2 }]);
  });

  it('csv: the same columns, verbatim; no summary', async () => {
    const parsed = await readSourceFile(NESA, { buffer: nesaCsv([nesaRow({ Village: ' Gako ' })]), originalname: 'nesa.csv' });
    expect(parsed).toMatchObject({ format: 'csv', summary: null });
    expect(parsed.rows[0].raw.Village).toBe(' Gako ');
  });

  it('header: exactly the 18 columns (order free); missing, unknown or repeated → INVALID_SYNC_HEADER', async () => {
    const reordered = [...NESA_COLUMNS].reverse();
    expect((await readSourceFile(NESA, await xlsx([nesaRow()], { columns: reordered }))).rows).toHaveLength(1);
    expect(await code(readSourceFile(NESA, await xlsx([nesaRow()], { columns: NESA_COLUMNS.slice(1) })))).toBe('INVALID_SYNC_HEADER');
    expect(await code(readSourceFile(NESA, await xlsx([nesaRow()], { columns: [...NESA_COLUMNS, 'Extra'] })))).toBe('INVALID_SYNC_HEADER');
    expect(await code(readSourceFile(NESA, await xlsx([nesaRow()], { columns: [...NESA_COLUMNS, 'Email'] })))).toBe('INVALID_SYNC_HEADER');
  });

  it('the data sheet is found by name only; formula / date cells in the data become row problems (the row is kept)', async () => {
    expect(await code(readSourceFile(NESA, await xlsx([nesaRow()], { sheet: 'Schools' })))).toBe('SYNC_SHEET_MISSING');
    const parsed = await readSourceFile(NESA, await xlsx([nesaRow(), nesaRow()], {
      cell: (row, column) => (row === 0 && column === 'Phone' ? { formula: 'A1&"x"', result: 'x' } : row === 1 && column === 'Cell' ? new Date('2026-01-01') : undefined),
    }));
    expect(parsed.rows.map((r) => r.problems)).toEqual([['Phone: a formula, not a value'], ['Cell: a date, not text']]);
    expect(parsed.rows[0].raw.Phone).toBe('');
  });

  it('limits and file types: 10 MB, an empty file, other extensions, a CSV that is a zip', async () => {
    expect(await code(readSourceFile(NESA, { buffer: Buffer.alloc(SYNC_MAX_BYTES + 1, 0x41), originalname: 'big.csv' }))).toBe('FILE_TOO_LARGE');
    expect(await code(readSourceFile(NESA, undefined))).toBe('FILE_REQUIRED');
    expect(await code(readSourceFile(NESA, { buffer: Buffer.from('x'), originalname: 'nesa.xls' }))).toBe('UNSUPPORTED_FILE_TYPE');
    expect(await code(readSourceFile(NESA, { buffer: await nesaWorkbook([nesaRow()]), originalname: 'nesa.csv' }))).toBe('UNSUPPORTED_FILE_TYPE');
    expect(await code(readSourceFile(NESA, { buffer: Buffer.from(NESA_COLUMNS.join(','), 'utf8'), originalname: 'nesa.csv' }))).toBe('EMPTY_IMPORT');
  });

  it('reconciliation: the source\'s total and provinces against the rows read', async () => {
    const places = directoryPlaces([{ province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }]);
    const rows = [nesaRow(), nesaRow(), nesaRow({ Province: 'East', District: 'Ngoma', Sector: 'Kibungo' })].map((r) => normaliseNesaRow(r, places));
    const r = reconcile([{ label: 'Total', value: 3 }, { label: 'South', value: 2 }, { label: 'East', value: 2 }, { label: 'Huye', value: 2 }], rows);
    expect(r).toMatchObject({ summaryAvailable: true, rowsRead: 3, mismatches: 1 });
    expect(r.checks.map((c) => [c.label, c.source, c.read, c.matches])).toEqual([['Total', 3, 3, true], ['South', 2, 2, true], ['East', 2, 1, false], ['Huye', 2, 2, true]]);
    expect(reconcile(null, rows)).toMatchObject({ summaryAvailable: false, mismatches: 0 });
  });
});
