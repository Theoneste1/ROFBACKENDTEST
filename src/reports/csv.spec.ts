import { toCsv } from './csv.js';

const BOM = '﻿';

describe('toCsv', () => {
  it('starts with a UTF-8 BOM and uses CRLF line endings', () => {
    const csv = toCsv(['a', 'b'], [[1, 2]]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toBe(`${BOM}a,b\r\n1,2\r\n`);
  });

  it('writes only the header row when there is no data', () => {
    expect(toCsv(['name'], [])).toBe(`${BOM}name\r\n`);
  });

  it('renders null/undefined as empty, booleans as text and dates as ISO', () => {
    const d = new Date('2026-11-03T10:00:00.000Z');
    expect(toCsv(['a', 'b', 'c', 'd'], [[null, undefined, true, d]]))
      .toBe(`${BOM}a,b,c,d\r\n,,true,2026-11-03T10:00:00.000Z\r\n`);
  });

  it('quotes cells containing commas, quotes or newlines and doubles inner quotes', () => {
    const csv = toCsv(['x'], [['a,b'], ['say "hi"'], ['line1\nline2'], ['cr\rhere']]);
    expect(csv).toBe(`${BOM}x\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n"cr\rhere"\r\n`);
  });

  it('keeps accented names intact', () => {
    expect(toCsv(['name'], [['Émilie Niyonsaba']])).toContain('Émilie Niyonsaba');
  });

  describe('formula-injection protection', () => {
    it.each(['=SUM(A1:A2)', '+1+1', '-2+3', '@cmd'])('prefixes %s with an apostrophe', (value) => {
      expect(toCsv(['x'], [[value]])).toBe(`${BOM}x\r\n'${value}\r\n`);
    });

    it('prefixes leading tabs', () => {
      expect(toCsv(['x'], [['\tfoo']])).toBe(`${BOM}x\r\n'\tfoo\r\n`);
    });

    it('prefixes and quotes when both apply', () => {
      expect(toCsv(['x'], [['=HYPERLINK("http://x","y")']]))
        .toBe(`${BOM}x\r\n"'=HYPERLINK(""http://x"",""y"")"\r\n`);
    });

    it('also protects header cells', () => {
      expect(toCsv(['=evil'], [])).toBe(`${BOM}'=evil\r\n`);
    });

    it('does not touch the characters when they are not leading', () => {
      expect(toCsv(['x'], [['a=b'], ['user@x.rw']])).toBe(`${BOM}x\r\na=b\r\nuser@x.rw\r\n`);
    });
  });
});
