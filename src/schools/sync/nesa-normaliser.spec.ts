import { directoryPlaces, normaliseNesaRow } from './nesa-normaliser.js';
import { nesaRow } from './nesa-fixture.testing.js';

const places = directoryPlaces([
  { province: 'Southern Province', district: 'Huye', sector: 'Ngoma' },
  { province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' },
]);
const norm = (over: Parameters<typeof nesaRow>[0] = {}) => normaliseNesaRow(nesaRow(over), places);
const codes = (n: ReturnType<typeof norm>) => n.issues.map((i) => i.code);

describe('NESA normaliser (nesa-v1)', () => {
  it('name: trimmed at the ends only — internal spacing, case and spelling kept exactly', () => {
    expect(norm({ 'School Name': '  GS  KIGALI   — Annexe ' })).toMatchObject({ name: 'GS  KIGALI   — Annexe', nameKey: 'gs kigali annexe' });
    expect(codes(norm({ 'School Name': ' N/A ' }))).toContain('NAME_MISSING');
  });

  it('province: East / North / South / West / Kigali City → the stored spelling; anything else is an issue', () => {
    expect(['East', 'North', 'south', 'WEST', 'Kigali City'].map((p) => norm({ Province: p }).province))
      .toEqual(['Eastern Province', 'Northern Province', 'Southern Province', 'Western Province', 'Kigali City']);
    expect(norm({ Province: 'Central' })).toMatchObject({ province: null });
    expect(codes(norm({ Province: 'Central' }))).toContain('PROVINCE_UNKNOWN');
  });

  it('district / sector: matched to the directory ignoring case; an unknown place keeps its published spelling and is flagged', () => {
    expect(norm({ District: 'HUYE', Sector: 'ngoma' })).toMatchObject({ district: 'Huye', sector: 'Ngoma', placeKnown: true });
    const fresh = norm({ District: 'Huye', Sector: 'Tumba Nshya' });
    expect(fresh).toMatchObject({ district: 'Huye', sector: 'Tumba Nshya', placeKnown: false, publishedPlace: { province: 'South', district: 'Huye', sector: 'Tumba Nshya' } });
    expect(codes(fresh)).toContain('NEW_PLACE');
    expect(norm({ Cell: '  Rugali ', Village: 'N/A' })).toMatchObject({ cell: 'Rugali', village: null });
  });

  it('code: VALID (6 digits, the province\'s first digit), PROVINCE_MISMATCH, or NONE with the raw value kept', () => {
    expect(norm({ 'School Code': '220001' })).toMatchObject({ code: '220001', codeStatus: 'VALID', rawCode: '220001' });
    expect(norm({ 'School Code': '120001' })).toMatchObject({ code: '120001', codeStatus: 'PROVINCE_MISMATCH' });
    for (const junk of ['N/A', '-', 'RW034', 'NA', '5705 25', '5401021', '52135', 'SDMS CODE: 340209']) {
      const n = norm({ 'School Code': junk });
      expect([junk, n.code, n.codeStatus, n.rawCode]).toEqual([junk, null, 'NONE', junk]);
    }
  });

  it('status (ownership) and accommodation; N/A → none', () => {
    expect(['PUBLIC', 'GOVERNMENT AIDED', 'PRIVATE', 'N/A'].map((s) => norm({ 'School Status': s }).ownership)).toEqual(['PUBLIC', 'GOVERNMENT_AIDED', 'PRIVATE', null]);
    expect(['DAY', 'BOARDING', 'MIXED', 'N/A'].map((a) => norm({ Accommodation: a }).accommodation)).toEqual(['DAY', 'BOARDING', 'MIXED', null]);
  });

  it('contacts: usable values normalised; N/A, "No Primary" and the letter O never become contacts — and are never echoed in an issue', () => {
    expect(norm({ Email: ' Head@Example.ORG ', Phone: '0788 123 456 / +250 722 000 111' }).contacts).toEqual([
      { type: 'EMAIL', value: 'head@example.org' }, { type: 'PHONE', value: '+250788123456' }, { type: 'PHONE', value: '+250722000111' },
    ]);
    for (const phone of ['N/A', 'No Primary', 'No primary', '07881234O6', '0788 12']) {
      const n = norm({ Phone: phone });
      expect([phone, n.contacts.filter((c) => c.type === 'PHONE')]).toEqual([phone, []]);
      expect(JSON.stringify(n.issues)).not.toContain(phone);
    }
    const bad = norm({ Email: 'head at school dot rw', Phone: '07881234O6' });
    expect(codes(bad)).toEqual(expect.arrayContaining(['CONTACT_UNUSABLE']));
    expect(JSON.stringify(bad.issues)).not.toMatch(/head at school|07881234O6/);
  });

  it('levels: Yes flags and level codes; "(L)" kept as the qualifier; disagreements and odd entries are issues', () => {
    const n = norm({ 'Pre-Primary': 'Yes', Primary: 'Yes', 'All Education Levels (as listed by NESA)': 'PRE PRIMARY (PPR), PRIMARY (PR(L))' });
    expect(n.levels.map((l) => [l.code, l.qualifier])).toEqual([['PPR', null], ['PR', '(L)']]);
    const odd = norm({ 'O-Level': 'Yes', 'All Education Levels (as listed by NESA)': 'PRIMARY (PR); BOARDING STATUS (BD); ADVANCED LEVEL (AD)' });
    expect(odd.levels.map((l) => l.code)).toEqual(['OL', 'PR']);
    expect(codes(odd)).toEqual(expect.arrayContaining(['LEVEL_UNKNOWN', 'LEVEL_FLAG_MISMATCH']));
  });

  it('programmes: "NAME (CODE)" entries; levels skipped; A-Level combinations and TVET trades told apart; repeats once', () => {
    const n = norm({ 'Combinations/Trades/Other Programmes': 'MATHEMATICS-CHEMISTRY-BIOLOGY (MCB), SOFTWARE DEVELOPMENT LEVEL 5 (SOD5); PRIMARY (PR); MATHEMATICS-CHEMISTRY-BIOLOGY (MCB); TAILORING' });
    expect(n.programmes.map((p) => [p.code, p.name, p.category, p.tvetLevel])).toEqual([
      ['MCB', 'MATHEMATICS-CHEMISTRY-BIOLOGY', 'A_LEVEL_COMBINATION', null],
      ['SOD5', 'SOFTWARE DEVELOPMENT LEVEL 5', 'TVET_TRADE', 5],
      [null, 'TAILORING', 'OTHER', null],
    ]);
  });

  it('fingerprint: the normalised name and full place (a matching aid); none without a name or place', () => {
    expect(norm({ 'School Name': 'EP Karama', Cell: 'Butare', Village: 'Gako' }).fingerprint).toBe('fp1|ep karama|southern province|huye|ngoma|butare|gako');
    expect(norm({ 'School Name': '' }).fingerprint).toBeNull();
  });

  it('never changes the raw row', () => {
    const raw = nesaRow({ 'School Name': '  EP  X ', Phone: 'No Primary' });
    const copy = { ...raw };
    normaliseNesaRow(raw, places);
    expect(raw).toEqual(copy);
  });
});
