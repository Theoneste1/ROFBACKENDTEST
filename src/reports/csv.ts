/**
 * Minimal RFC 4180 CSV writer with spreadsheet formula-injection protection:
 * cells starting with = + - @ (or tab/CR) are prefixed with an apostrophe so
 * Excel/Sheets treat them as text, not formulas.
 */
export type CsvValue = string | number | boolean | Date | null | undefined;

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(cell).join(','));
  // BOM so Excel opens UTF-8 (names with accents) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Only free text can carry a formula; real numbers (e.g. -5) stay numeric.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
