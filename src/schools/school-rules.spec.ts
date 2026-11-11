import { cleanSchoolName, codeProblems, PROVINCE_BY_CODE_PREFIX, provinceOfCode } from './school-rules.js';

describe('school rules (PR B)', () => {
  it('a code is 6 digits whose first digit is the province (as M8 stores it)', () => {
    expect(provinceOfCode('110101')).toBe('Kigali City');
    expect(provinceOfCode('220999')).toBe('Southern Province');
    expect(provinceOfCode('312345')).toBe('Western Province');
    expect(provinceOfCode('412345')).toBe('Northern Province');
    expect(provinceOfCode('512345')).toBe('Eastern Province');
    for (const bad of ['612345', '012345', '12345', '1234567', '12345a', ' 123456', '']) expect([bad, provinceOfCode(bad)]).toEqual([bad, null]);
    expect(Object.keys(PROVINCE_BY_CODE_PREFIX)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('codeProblems: format, prefix, and the province the school is in', () => {
    expect(codeProblems('220999', 'Southern Province')).toEqual([]);
    expect(codeProblems('220999', null)).toEqual([]);
    expect(codeProblems('22099', 'Southern Province')).toEqual(['A school code is exactly 6 digits.']);
    expect(codeProblems('920999', 'Southern Province')[0]).toMatch(/starts with 1/);
    expect(codeProblems('120999', 'Southern Province')).toEqual(['Code 120999 belongs to Kigali City, not Southern Province.']);
  });

  it('names are trimmed and inner whitespace collapsed; case and accents are kept', () => {
    expect(cleanSchoolName('  Lycée   de\tKigali ')).toBe('Lycée de Kigali');
  });
});
