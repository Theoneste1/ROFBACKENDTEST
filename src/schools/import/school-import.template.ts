/**
 * Import templates (PR D). CSV: the header row only. XLSX: a "Schools" sheet with the header row
 * only (every column formatted as text, so codes stay strings) and a separate "Instructions" sheet
 * with the rules, the allowed ownership values and an example — the example is never on the
 * importable sheet. Every value is written as a string (no formulas).
 */
import ExcelJS from 'exceljs';

import { toCsv } from '../../reports/csv.js';
import { SCHOOL_OWNERSHIP } from '../school-rules.js';
import { IMPORT_COLUMNS, IMPORT_MAX_ROWS } from './school-import.parser.js';

export const TEMPLATE_CSV_NAME  = 'schools-import-template.csv';
export const TEMPLATE_XLSX_NAME = 'schools-import-template.xlsx';
export const XLSX_CONTENT_TYPE  = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function csvTemplate(): string {
  return toCsv([...IMPORT_COLUMNS], []);
}

const INSTRUCTIONS: string[][] = [
  ['School import — instructions'],
  [''],
  ['Fill in the "Schools" sheet: one school per row, under the header row. Do not rename the header.'],
  ['Only the Schools sheet is imported. Nothing on this sheet is imported.'],
  [''],
  ['Column', 'Required', 'Rules'],
  ['name', 'yes', 'The school name (2–200 characters), exactly as officially published. Names may repeat: schools are told apart by code and place.'],
  ['countryCode', 'no', 'ISO 3166-1 alpha-2 country, default RW (Rwanda).'],
  ['code', 'no', 'Rwanda only: the official 6-digit code; its first digit is the province (1 Kigali City, 2 Southern, 3 Western, 4 Northern, 5 Eastern). Must be unique.'],
  ['province', 'Rwanda: yes', 'From the official directory (exactly as listed, e.g. "Southern Province").'],
  ['district', 'Rwanda: yes', 'From the official directory.'],
  ['sector', 'Rwanda: yes', 'From the official directory. Province, district and sector must be one place of the directory.'],
  ['location', 'outside Rwanda: yes', 'Rwanda: optional (default "Sector, District"). Another country: required; leave province, district and sector empty.'],
  ['ownership', 'no', `One of: ${SCHOOL_OWNERSHIP.join(', ')}. Empty: not recorded.`],
  [''],
  ['Rules'],
  ['Empty cells and blank rows are ignored. Enter values, not formulas: formula cells are refused.'],
  [`At most ${IMPORT_MAX_ROWS} schools and 1 MB per file. Every row must be valid, or nothing is imported.`],
  ['Existing schools are never changed: a code that already exists is an error (edit schools one by one instead).'],
  ['A school with the same name in the same district (or country) is a possible duplicate: run a dry run, review the'],
  ['candidates, then import with confirmPossibleDuplicates and the review token from the dry run (valid for 15 minutes).'],
  [''],
  ['Example (do not copy this sheet; type schools on the Schools sheet)'],
  [...IMPORT_COLUMNS],
  ['GS Example Ngoma', 'RW', '220999', 'Southern Province', 'Huye', 'Ngoma', '', 'PUBLIC'],
  ['Example International School', 'KE', '', '', '', '', 'Nairobi', 'PRIVATE'],
];

export async function xlsxTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const schools = wb.addWorksheet('Schools');
  schools.columns = IMPORT_COLUMNS.map((name) => ({ header: name, key: name, width: name === 'name' ? 40 : 20, style: { numFmt: '@' } }));
  schools.getRow(1).font = { bold: true };
  const help = wb.addWorksheet('Instructions');
  for (const line of INSTRUCTIONS) help.addRow(line.map((v) => String(v)));
  help.getRow(1).font = { bold: true, size: 14 };
  help.getColumn(1).width = 24;
  help.getColumn(3).width = 100;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
