import { parseCsv } from './csv-parse.js';

describe('parseCsv', () => {
  it('reads headers and records keyed by header, with file line numbers', () => {
    const { headers, records } = parseCsv('firstName,lastName\nAda,Uwase\nJean,Habimana\n');
    expect(headers).toEqual(['firstName', 'lastName']);
    expect(records).toEqual([
      { line: 2, values: { firstName: 'Ada', lastName: 'Uwase' } },
      { line: 3, values: { firstName: 'Jean', lastName: 'Habimana' } },
    ]);
  });

  it('handles CRLF, a UTF-8 BOM, quoted commas, escaped quotes and accents', () => {
    const { headers, records } = parseCsv('﻿name,school\r\n"Uwase, Ada","Lycée ""Saint"" Paul"\r\n');
    expect(headers).toEqual(['name', 'school']);
    expect(records[0].values).toEqual({ name: 'Uwase, Ada', school: 'Lycée "Saint" Paul' });
  });

  it('keeps line breaks inside quotes and reports the starting line', () => {
    const { records } = parseCsv('a,b\n"line1\nline2",x\ny,z');
    expect(records[0]).toEqual({ line: 2, values: { a: 'line1\nline2', b: 'x' } });
    expect(records[1].line).toBe(4);
  });

  it('skips blank lines, trims cells and fills missing trailing cells', () => {
    const { records } = parseCsv('a,b,c\n\n  1 , 2 \n,,\n');
    expect(records).toEqual([{ line: 3, values: { a: '1', b: '2', c: '' } }]);
  });

  it('returns nothing for an empty file and throws on an unterminated quote', () => {
    expect(parseCsv('')).toEqual({ headers: [], records: [] });
    expect(() => parseCsv('a\n"open')).toThrow(/Unterminated/);
  });
});
