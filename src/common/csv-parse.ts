/**
 * Minimal RFC 4180 CSV parser (no dependency): quoted fields, escaped quotes
 * (""), commas and line breaks inside quotes, CRLF/LF, UTF-8 BOM.
 *
 * Returns the header row (trimmed) and one record per non-empty data row,
 * keyed by header, with the 1-based line number of the row in the file.
 */
export interface CsvRecord {
  line:   number;
  values: Record<string, string>;
}

export function parseCsv(text: string): { headers: string[]; records: CsvRecord[] } {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStart = 1;

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => { cells.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: rowStart, cells });
    cells = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === ',') endField();
    else if (ch === '\r') { /* handled with \n */ }
    else if (ch === '\n') { endRow(); line++; rowStart = line; }
    else field += ch;
  }
  if (inQuotes) throw new Error(`Unterminated quoted field starting on line ${rowStart}.`);
  if (field !== '' || cells.length > 0) endRow();

  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].cells.map((h) => h.trim());
  const records = rows.slice(1).map((r) => ({
    line:   r.line,
    values: Object.fromEntries(headers.map((h, i) => [h, (r.cells[i] ?? '').trim()])),
  }));
  return { headers, records };
}
