import { MAX_FILE_NAME, sanitizeFileName } from './file-name.js';

describe('sanitizeFileName (PR D: the uploaded name is untrusted)', () => {
  it('keeps only the last path component', () => {
    expect(sanitizeFileName('../../etc/passwd.csv')).toBe('passwd.csv');
    expect(sanitizeFileName('C:\\Users\\a\\schools.xlsx')).toBe('schools.xlsx');
    expect(sanitizeFileName('/abs/x.csv')).toBe('x.csv');
  });

  it('removes control and invisible formatting characters (a direction override cannot disguise the extension)', () => {
    expect(sanitizeFileName('sch\u0000oo\u0007ls\n.csv')).toBe('schools.csv');
    expect(sanitizeFileName('invoice\u202Ecod.xlsx')).toBe('invoicecod.xlsx');
    expect(sanitizeFileName('a\u200Bb.csv')).toBe('ab.csv');
  });

  it('collapses whitespace, limits the length by code point, never empty', () => {
    expect(sanitizeFileName('  my    schools .csv ')).toBe('my schools .csv');
    const long = sanitizeFileName('é'.repeat(500) + '.csv');
    expect([...long]).toHaveLength(MAX_FILE_NAME);
    expect(sanitizeFileName('😀'.repeat(200))).toBe('😀'.repeat(MAX_FILE_NAME));   // no broken surrogate pair
    for (const empty of ['', '   ', '../', '\u202E', undefined, null]) expect(sanitizeFileName(empty as any)).toBe('upload');
  });
});
