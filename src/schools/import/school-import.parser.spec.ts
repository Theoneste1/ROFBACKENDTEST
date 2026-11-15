import { deflateRawSync } from 'node:zlib';

import ExcelJS from 'exceljs';

import { inspectZip, parseSchoolImport, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, ZIP_MAX_ENTRIES } from './school-import.parser.js';
import { csvTemplate, xlsxTemplate } from './school-import.template.js';

const csv = (text: string, name = 'schools.csv') => ({ buffer: Buffer.from(text, 'utf8'), originalname: name });
const codeOf = async (p: Promise<unknown>) => p.then(() => null, (e: any) => e.code ?? e.message);

/** A workbook whose "Schools" sheet holds these rows (row arrays; null = empty cell). */
async function xlsx(rows: unknown[][], opts: { sheet?: string; extraFirstSheet?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  if (opts.extraFirstSheet) wb.addWorksheet('Notes').addRow(['not this one']);
  const ws = wb.addWorksheet(opts.sheet ?? 'Schools');
  rows.forEach((r, i) => r.forEach((v, j) => { if (v !== null && v !== undefined) ws.getCell(i + 1, j + 1).value = v as ExcelJS.CellValue; }));
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), originalname: 'schools.xlsx' };
}

/** A hand-made zip (stored or deflated entries; sizes and flags can lie). */
function zip(entries: Array<{ name: string; data: Buffer; deflate?: boolean; declared?: number; flags?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const usize = e.declared ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(e.flags ?? 0, 6); local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(usize, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(e.flags ?? 0, 8); central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(usize, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const zipCode = (buf: Buffer) => { try { inspectZip(buf); return null; } catch (e: any) { return [e.code, e.message]; } };

describe('school import file reading (PR D)', () => {
  describe('type, size and signature — before any parsing', () => {
    it('extension .csv / .xlsx only', async () => {
      expect(await codeOf(parseSchoolImport(undefined))).toBe('FILE_REQUIRED');
      for (const name of ['s.xls', 's.xlsm', 's.txt', 's', 's.csv.exe']) expect([name, await codeOf(parseSchoolImport(csv('name\nA', name)))]).toEqual([name, 'UNSUPPORTED_FILE_TYPE']);
      expect(await codeOf(parseSchoolImport(csv('name\nA School', 'S.CSV')))).toBeNull();
    });
    it('size: at most 1 MB', async () => {
      expect(await codeOf(parseSchoolImport(csv('name\n' + 'A'.repeat(IMPORT_MAX_BYTES))))).toBe('FILE_TOO_LARGE');
    });
    it('a .csv must be UTF-8 text without NUL bytes and not a zip; an .xlsx must be a zip', async () => {
      expect(await codeOf(parseSchoolImport({ buffer: Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xe9, 0x41]), originalname: 'latin1.csv' }))).toBe('UNSUPPORTED_FILE_TYPE');
      expect(await codeOf(parseSchoolImport({ buffer: Buffer.from('name\nA\u0000B'), originalname: 'nul.csv' }))).toBe('UNSUPPORTED_FILE_TYPE');
      expect(await codeOf(parseSchoolImport({ buffer: (await xlsx([['name'], ['A School']])).buffer, originalname: 'renamed.csv' }))).toBe('UNSUPPORTED_FILE_TYPE');
      expect(await codeOf(parseSchoolImport({ buffer: Buffer.from('name\nA School'), originalname: 'renamed.xlsx' }))).toBe('UNSUPPORTED_FILE_TYPE');
    });
  });

  describe('zip checks — before exceljs', () => {
    const tiny = { name: 'a.xml', data: Buffer.from('<a/>') };
    it('accepts a normal workbook', async () => {
      expect(zipCode((await xlsx([['name'], ['A School']])).buffer)).toBeNull();
    });
    it('too many entries', () => {
      expect(zipCode(zip(Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({ ...tiny, name: `p${i}.xml` })))))
        .toEqual(['INVALID_XLSX', expect.stringMatching(/more than 50 parts/)]);
    });
    it('declared uncompressed size over 20 MB (an honest bomb)', () => {
      expect(zipCode(zip([{ name: 'big.xml', data: Buffer.alloc(21 * 1024 * 1024), deflate: true }])))
        .toEqual(['INVALID_XLSX', expect.stringMatching(/more than 20 MB/)]);
    });
    it('an entry that unpacks to more than it declares (a lying bomb) is caught by the bounded inflate', () => {
      expect(zipCode(zip([{ name: 'liar.xml', data: Buffer.alloc(5 * 1024 * 1024), deflate: true, declared: 100 }])))
        .toEqual(['INVALID_XLSX', expect.stringMatching(/unpacks to more than it declares/)]);
    });
    it('encrypted entries, unsafe paths and macros', () => {
      expect(zipCode(zip([{ ...tiny, flags: 1 }]))?.[1]).toMatch(/encrypted/);
      for (const name of ['../evil.xml', '/abs.xml', 'C:/x.xml', 'a\\b.xml', 'xl/../../x.xml']) expect([name, zipCode(zip([{ ...tiny, name }]))?.[1]]).toEqual([name, expect.stringMatching(/unsafe path/)]);
      expect(zipCode(zip([{ ...tiny, name: 'xl/vbaProject.bin' }]))?.[1]).toMatch(/macros/);
    });
    it('a corrupt zip', () => {
      expect(zipCode(Buffer.from('PK\u0003\u0004 not really a zip'))?.[0]).toBe('INVALID_XLSX');
    });
  });

  describe('cells are text; formulas, dates and errors refused per row', () => {
    it('strings, numbers (codes typed as numbers), booleans, rich text, hyperlinks', async () => {
      const f = await xlsx([
        ['name', 'code', 'ownership', 'location'],
        [{ richText: [{ text: 'GS ' }, { text: 'Rich' }] }, 220001, 'PUBLIC', { text: 'Ngoma', hyperlink: 'https://x' }],
      ]);
      expect((await parseSchoolImport(f)).rows).toEqual([{ row: 2, values: { name: 'GS Rich', code: '220001', ownership: 'PUBLIC', location: 'Ngoma' }, errors: [] }]);
    });
    it('a formula cell (value or shared), a date, an error value → a row error naming the cell; never evaluated', async () => {
      const f = await xlsx([
        ['name', 'location'],
        [{ formula: 'CONCAT("A","B")', result: 'AB' }, 'x'],
        ['Dated School', new Date('2026-01-01')],
        ['Broken School', { error: '#REF!' }],
      ]);
      const rows = (await parseSchoolImport(f)).rows;
      expect(rows.map((r) => [r.row, r.values.name ?? null, r.errors.join()])).toEqual([
        [2, null, expect.stringMatching(/Formulas are not imported.*cell A2/)],
        [3, 'Dated School', expect.stringMatching(/Dates are not accepted.*cell B3/)],
        [4, 'Broken School', expect.stringMatching(/error value.*cell B4/)],
      ]);
    });
    it('a formula in the header row refuses the file', async () => {
      expect(await codeOf(parseSchoolImport(await xlsx([[{ formula: '"name"', result: 'name' }], ['A School']])))).toBe('INVALID_IMPORT_HEADER');
    });
    it('the "Schools" sheet is read even when it is not first; otherwise the first sheet', async () => {
      expect((await parseSchoolImport(await xlsx([['name'], ['From Schools']], { extraFirstSheet: true }))).rows[0].values.name).toBe('From Schools');
      expect((await parseSchoolImport(await xlsx([['name'], ['From First']], { sheet: 'Sheet1' }))).rows[0].values.name).toBe('From First');
    });
  });

  describe('CSV and XLSX behave identically', () => {
    const table = [
      ['name', 'countryCode', 'code', 'ownership', 'location'],
      ['  GS One  ', 'RW', '220001', '   ', ''],
      [null, null, null, null, null],
      ['   ', '  ', null, null, null],
      ['GS Two', 'KE', null, 'PRIVATE', 'Nairobi'],
    ];
    const asCsv = table.map((r) => r.map((v) => (v === null ? '' : `"${v}"`)).join(',')).join('\r\n');
    it('trimmed values, whitespace-only = not provided, blank rows ignored, same row numbers', async () => {
      const fromCsv = (await parseSchoolImport(csv(asCsv))).rows;
      const fromXlsx = (await parseSchoolImport(await xlsx(table))).rows;
      expect(fromCsv).toEqual([
        { row: 2, values: { name: 'GS One', countryCode: 'RW', code: '220001' }, errors: [] },
        { row: 5, values: { name: 'GS Two', countryCode: 'KE', ownership: 'PRIVATE', location: 'Nairobi' }, errors: [] },
      ]);
      expect(fromXlsx).toEqual(fromCsv);
    });
    it('header: name required, known columns only, each once; any order', async () => {
      for (const [text, missing, unknown, repeated] of [
        ['code\n220001', ['name'], [], []], ['name,colour\nA,red', [], ['colour'], []], ['name,name\nA,B', [], [], ['name']], ['name,,code\nA,,1', [], [''], []],
      ] as Array<[string, string[], string[], string[]]>) {
        const err: any = await parseSchoolImport(csv(text)).catch((e) => e);
        expect([text, err.code, err.details?.missing, err.details?.unknown, err.details?.repeated]).toEqual([text, 'INVALID_IMPORT_HEADER', missing, unknown, repeated]);
        const fromX: any = await parseSchoolImport(await xlsx(text.split('\n').map((l) => l.split(',').map((v) => v || null)))).catch((e) => e);
        expect([text, fromX.code]).toEqual([text, 'INVALID_IMPORT_HEADER']);
      }
      expect((await parseSchoolImport(csv('code,name\n220001,A School'))).rows[0].values).toEqual({ code: '220001', name: 'A School' });
    });
    it('the limit counts non-empty data rows; a header with no data → EMPTY_IMPORT', async () => {
      const body = (n: number, blanks = 0) => ['name', ...Array.from({ length: n }, (_, i) => `School ${i}`), ...Array(blanks).fill(',')].join('\n');
      expect((await parseSchoolImport(csv(body(IMPORT_MAX_ROWS, 50)))).rows).toHaveLength(IMPORT_MAX_ROWS);
      expect(await codeOf(parseSchoolImport(csv(body(IMPORT_MAX_ROWS + 1))))).toBe('TOO_MANY_ROWS');
      expect(await codeOf(parseSchoolImport(csv('name\n\n , \n')))).toBe('EMPTY_IMPORT');
      expect(await codeOf(parseSchoolImport(await xlsx([['name'], [null], ['  ']])))).toBe('EMPTY_IMPORT');
    });
  });

  describe('templates', () => {
    it('CSV: exactly the header row', async () => {
      expect(csvTemplate().replace(/^\uFEFF/, '').trim()).toBe('name,countryCode,code,province,district,sector,location,ownership');
      expect(await codeOf(parseSchoolImport(csv(csvTemplate())))).toBe('EMPTY_IMPORT');
    });
    it('XLSX: a Schools sheet with only the header (text-formatted) and an Instructions sheet with the example — nothing importable', async () => {
      const buffer = await xlsxTemplate();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      expect(wb.worksheets.map((s) => s.name)).toEqual(['Schools', 'Instructions']);
      const schools = wb.getWorksheet('Schools')!;
      expect(schools.rowCount).toBe(1);
      expect((schools.getRow(1).values as unknown[]).slice(1)).toEqual(['name', 'countryCode', 'code', 'province', 'district', 'sector', 'location', 'ownership']);
      expect(schools.getColumn(3).numFmt).toBe('@');
      const help = JSON.stringify(wb.getWorksheet('Instructions')!.getSheetValues());
      expect(help).toContain('GS Example Ngoma');
      expect(help).toContain('PUBLIC, GOVERNMENT_AIDED, PRIVATE');
      expect(await codeOf(parseSchoolImport({ buffer, originalname: 'template.xlsx' }))).toBe('EMPTY_IMPORT');
    });
  });
});
