import { directoryPlaces, normaliseNesaRow } from './nesa-normaliser.js';
import { nesaRow, type NesaRow } from './nesa-fixture.testing.js';
import { matchRows, type DirectorySchool, type DirectorySnapshot } from './sync-matcher.js';

const places = directoryPlaces([
  { province: 'Southern Province', district: 'Huye', sector: 'Ngoma' },
  { province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' },
]);
const school = (o: Partial<DirectorySchool> & { id: string; name: string }): DirectorySchool => ({
  nameKey: null, code: null, countryCode: 'RW', province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
  cell: null, village: null, accommodation: null, ownership: null, source: 'OFFICIAL_LIST', isActive: true, ...o,
});
const snapshot = (schools: DirectorySchool[], o: Partial<DirectorySnapshot> = {}): DirectorySnapshot => ({
  schools, externalIds: new Map(), contacts: new Map(), levels: new Map(), programmeLinks: new Map(), programmes: [], ...o,
});
const run = (rows: Array<Partial<NesaRow>>, snap: DirectorySnapshot) =>
  matchRows(rows.map((r, i) => { const raw = nesaRow(r); return { row: i + 2, sourceRef: `All Schools!${i + 2}`, raw, problems: [], n: normaliseNesaRow(raw, places) }; }), snap);
const outcomes = (res: ReturnType<typeof run>) => res.items.filter((i) => i.rowNumber !== null).map((i) => [i.rowNumber, i.outcome, i.schoolId, i.matchedBy]);

describe('sync matcher — matching and conflicts', () => {
  it('INVALID rows are kept (no name, unknown province, no sector, unreadable cell)', () => {
    const raw = nesaRow({ 'School Code': '220001' });
    const res = matchRows([
      { row: 2, sourceRef: 'x!2', raw: nesaRow({ 'School Name': '' }), problems: [], n: normaliseNesaRow(nesaRow({ 'School Name': '' }), places) },
      { row: 3, sourceRef: 'x!3', raw: nesaRow({ Province: 'Mars' }), problems: [], n: normaliseNesaRow(nesaRow({ Province: 'Mars' }), places) },
      { row: 4, sourceRef: 'x!4', raw, problems: ['Phone: a formula, not a value'], n: normaliseNesaRow(raw, places) },
    ], snapshot([]));
    expect(res.items.map((i) => i.outcome)).toEqual(['INVALID', 'INVALID', 'INVALID']);
    expect(res.changes).toEqual([]);
  });

  it('a code repeated with a different name OR a different place → every row with it is a CONFLICT; nothing is assigned or matched', () => {
    const existing = school({ id: 's1', name: 'EP KARAMA', code: '220001' });
    for (const second of [{ 'School Name': 'EP OTHER' }, { Village: 'Elsewhere' }, { District: 'Gisagara', Sector: 'Save' }]) {
      const res = run([{ 'School Name': 'EP KARAMA', 'School Code': '220001', Village: 'Gako' }, { 'School Name': 'EP KARAMA', 'School Code': '220001', Village: 'Gako', ...second }], snapshot([existing]));
      expect(outcomes(res)).toEqual([[2, 'CONFLICT', null, null], [3, 'CONFLICT', null, null]]);
      expect(res.items[0].details).toMatchObject({ reasons: ['CODE_REPEATED_WITH_DIFFERENT_SCHOOL'], code: '220001', rows: [2, 3] });
      expect(res.changes.filter((c) => c.schoolId === 's1')).toEqual([]);
    }
  });

  it('only identical code + name + place rows are one school: the extra rows are DUPLICATE_ROW (following the first row\'s match)', () => {
    const existing = school({ id: 's1', name: 'EP KARAMA', code: '220001' });
    const row = { 'School Name': 'EP KARAMA', 'School Code': '220001', Cell: 'Butare', Village: 'Gako' };
    const res = run([row, { ...row, 'School Name': '  EP KARAMA ' }], snapshot([existing]));
    expect(outcomes(res)).toEqual([[2, 'MATCHED', 's1', 'CODE'], [3, 'DUPLICATE_ROW', 's1', null]]);
    expect(res.items[1].details).toMatchObject({ duplicateOfRow: 2 });
  });

  it('a code contradicting the province is a CONFLICT', () => {
    expect(outcomes(run([{ 'School Code': '120001' }], snapshot([])))).toEqual([[2, 'CONFLICT', null, null]]);
  });

  it('R2: a code matching a school whose name AND district both differ is a CONFLICT (no match, no code, no update); one of them equal → a match', () => {
    const existing = school({ id: 's1', name: 'GS KACYIRU', code: '220001', district: 'Gasabo', province: 'Southern Province' });
    const res = run([{ 'School Name': 'EP NGOMA', 'School Code': '220001' }], snapshot([existing]));
    expect(outcomes(res)).toEqual([[2, 'CONFLICT', null, null]]);
    expect(res.items[0].details).toMatchObject({ reasons: ['CODE_MATCHES_A_DIFFERENT_SCHOOL'], schoolId: 's1' });
    expect(res.changes).toEqual([]);
    expect(outcomes(run([{ 'School Name': 'GS KACYIRU', 'School Code': '220001' }], snapshot([existing])))).toEqual([[2, 'MATCHED', 's1', 'CODE']]);
    expect(outcomes(run([{ 'School Name': 'EP RENAMED', 'School Code': '220001' }], snapshot([school({ ...existing, district: 'Huye' })])))).toEqual([[2, 'MATCHED', 's1', 'CODE']]);
  });

  it('matching order: external id for the code, the code, a current or superseded fingerprint; then possible duplicates; else NEW', () => {
    const a = school({ id: 'a', name: 'EP A', code: '220010' });
    const b = school({ id: 'b', name: 'EP B (old name)' });
    const c = school({ id: 'c', name: 'EP C', source: 'LEGACY', district: null, province: null, sector: null });
    const snap = snapshot([a, b, c], { externalIds: new Map([['220010', 'a'], ['fp1|ep b|southern province|huye|ngoma|butare|v', 'b']]) });
    const res = run([
      { 'School Name': 'EP A', 'School Code': '220010' },
      { 'School Name': 'EP B', Village: 'V' },
      { 'School Name': 'EP C' },
      { 'School Name': 'EP NEW' },
    ], snap);
    expect(outcomes(res)).toEqual([[2, 'MATCHED', 'a', 'EXTERNAL_ID_CODE'], [3, 'MATCHED', 'b', 'FINGERPRINT'], [4, 'POSSIBLE_DUPLICATE', null, null], [5, 'NEW', null, null]]);
    expect(res.items[2].details).toMatchObject({ candidates: [expect.objectContaining({ id: 'c' })] });
  });

  it('a school matched by two rows → both CONFLICT; repeated fingerprints of rows without a code → CONFLICT', () => {
    const a = school({ id: 'a', name: 'EP A', code: '220010' });
    const snap = snapshot([a], { externalIds: new Map([['fp1|ep a|southern province|huye|ngoma|butare|v', 'a']]) });
    expect(outcomes(run([{ 'School Name': 'EP A', 'School Code': '220010' }, { 'School Name': 'EP A', Village: 'V' }], snap)))
      .toEqual([[2, 'CONFLICT', null, null], [3, 'CONFLICT', null, null]]);
    expect(outcomes(run([{ 'School Name': 'EP TWIN', Village: 'V' }, { 'School Name': 'EP TWIN', Village: 'V' }], snapshot([]))))
      .toEqual([[2, 'CONFLICT', null, null], [3, 'CONFLICT', null, null]]);
  });
});

describe('sync matcher — proposed changes', () => {
  it('one change per field: FILL_EMPTY for an empty field, CHANGE for a different value, never a clearing', () => {
    const s = school({ id: 's', name: 'EP A', code: '220001', cell: 'Butare', village: null, ownership: 'PRIVATE', accommodation: 'DAY' });
    const res = run([{ 'School Name': 'EP A', 'School Code': '220001', Cell: 'Butare', Village: 'Gako', 'School Status': 'PUBLIC', Accommodation: 'N/A', Email: '', Phone: '' }], snapshot([s]));
    expect(res.changes.filter((c) => !c.kind.startsWith('ADD_')).map((c) => [c.kind, c.field, c.currentValue, c.publishedValue])).toEqual([
      ['FILL_EMPTY', 'village', null, 'Gako'],
      ['CHANGE', 'ownership', 'PRIVATE', 'PUBLIC'],
    ]);
  });

  it('NAME_RESTORE only for an official school matched by code whose name is exactly the published name + " — " + district or + " (" + code + ")"', () => {
    const cases: Array<[string, string, string]> = [
      ['GS MWENDO — Huye', 'GS MWENDO', 'NAME_RESTORE'],
      ['ES BUMBOGO (220001)', 'ES BUMBOGO', 'NAME_RESTORE'],
      ['GS MWENDO - Huye', 'GS MWENDO', 'CHANGE'],          // a hyphen, not M8's em dash
      ['GS MWENDO — Gasabo', 'GS MWENDO', 'CHANGE'],        // not its district
      ['GS MWENDO (220009)', 'GS MWENDO', 'CHANGE'],        // not its code
      ['GS Mwendo — Huye', 'GS MWENDO', 'CHANGE'],          // case differs
    ];
    for (const [current, published, kind] of cases) {
      const res = run([{ 'School Name': published, 'School Code': '220001' }], snapshot([school({ id: 's', name: current, code: '220001' })]));
      expect([current, res.changes.filter((c) => c.field === 'name').map((c) => [c.kind, c.currentValue, c.publishedValue])]).toEqual([current, [[kind, current, published]]]);
    }
    const legacy = run([{ 'School Name': 'GS MWENDO', 'School Code': '220001' }], snapshot([school({ id: 's', name: 'GS MWENDO — Huye', code: '220001', source: 'ADMIN' })]));
    expect(legacy.changes.find((c) => c.field === 'name')?.kind).toBe('CHANGE');
  });

  it('additions: contacts, levels and programmes the school does not have yet; a fingerprint-matched school gets no code it does not hold', () => {
    const s = school({ id: 's', name: 'EP A', code: '220001' });
    const snap = snapshot([s], {
      contacts: new Map([['s', new Set(['EMAIL|known@example.org'])]]), levels: new Map([['s', new Set(['PR'])]]),
      programmes: [{ id: 'p1', code: 'MCB', name: 'MATHEMATICS-CHEMISTRY-BIOLOGY', category: 'A_LEVEL_COMBINATION', needsReview: false }],
    });
    const res = run([{
      'School Name': 'EP A', 'School Code': '220001', Email: 'known@example.org, new@example.org', Phone: '0788123456',
      'O-Level': 'Yes', 'All Education Levels (as listed by NESA)': 'PRIMARY (PR), ORDINARY LEVEL (OL)',
      'Combinations/Trades/Other Programmes': 'MATHEMATICS-CHEMISTRY-BIOLOGY (MCB), WELDING LEVEL 3 (WEL3)',
    }], snap);
    expect(res.changes.filter((c) => c.kind.startsWith('ADD_')).map((c) => [c.kind, c.field])).toEqual([
      ['ADD_CONTACT', 'EMAIL'], ['ADD_CONTACT', 'PHONE'], ['ADD_LEVEL', 'OL'], ['ADD_PROGRAMME', 'MCB'], ['ADD_PROGRAMME', 'WEL3'],
    ]);
    expect(res.changes.find((c) => c.field === 'WEL3')?.publishedValue).toMatchObject({ isNew: true, needsReview: true, programmeId: null });
    expect(res.changes.find((c) => c.field === 'MCB')?.publishedValue).toMatchObject({ isNew: false, programmeId: 'p1' });
  });

  it('a NEW row → CREATE_SCHOOL (+ additions); a new place → one NEW_PLACE per place listing its rows', () => {
    const res = run([
      { 'School Name': 'EP NEW 1', 'School Code': '220777', District: 'Huye', Sector: 'Tumba' },
      { 'School Name': 'EP NEW 2', District: 'huye', Sector: 'TUMBA' },
    ], snapshot([]));
    expect(res.changes.filter((c) => c.kind === 'CREATE_SCHOOL').map((c) => (c.publishedValue as any).code)).toEqual(['220777', null]);
    const places = res.changes.filter((c) => c.kind === 'NEW_PLACE');
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ itemIndex: null, publishedValue: { province: 'Southern Province', district: 'Huye', sector: 'Tumba', rowCount: 2, rows: [2, 3] } });
  });

  it('MISSING_FROM_SOURCE: official coded schools whose code is nowhere in the file (reported, nothing changes)', () => {
    const res = run([{ 'School Name': 'EP A', 'School Code': '220001' }], snapshot([
      school({ id: 'a', name: 'EP A', code: '220001' }), school({ id: 'gone', name: 'EP GONE', code: '220002' }), school({ id: 'adm', name: 'EP ADMIN', code: '220003', source: 'ADMIN' }),
    ]));
    expect(res.items.filter((i) => i.outcome === 'MISSING_FROM_SOURCE').map((i) => i.schoolId)).toEqual(['gone']);
    expect(res.changes.filter((c) => c.schoolId === 'gone')).toEqual([]);
  });
});

describe('sync matcher — reviewer resolutions and identity (S2b)', () => {
  it('a code whose school differs from the school its fingerprint already belongs to is a CONFLICT (no match, no change)', () => {
    const a = school({ id: 'a', name: 'EP A', code: '220010' });
    const b = school({ id: 'b', name: 'EP B' });
    const res = run([{ 'School Name': 'EP A', 'School Code': '220010', Village: 'V' }], snapshot([a, b], { externalIds: new Map([['fp1|ep a|southern province|huye|ngoma|butare|v', 'b']]) }));
    expect(outcomes(res)).toEqual([[2, 'CONFLICT', null, null]]);
    expect(res.items[0].details).toMatchObject({ reasons: ['FINGERPRINT_BELONGS_TO_ANOTHER_SCHOOL'], fingerprintSchoolId: 'b' });
    expect(res.changes).toEqual([]);
  });

  it('LINK: a CONFLICT / POSSIBLE_DUPLICATE row becomes MATCHED by REVIEW; its differences are ordinary per-field changes; a disputed code is never used — a verified one is', () => {
    const target = school({ id: 't', name: 'EP TARGET', code: null, cell: null });
    const conflictRows = [{ 'School Name': 'EP ONE', 'School Code': '220500', Cell: 'Butare' }, { 'School Name': 'EP TWO', 'School Code': '220500' }];
    const plain = run(conflictRows, snapshot([target]), );
    expect(outcomes(plain)).toEqual([[2, 'CONFLICT', null, null], [3, 'CONFLICT', null, null]]);
    const linked = matchRows(conflictRows.map((r, i) => { const raw = nesaRow(r); return { row: i + 2, sourceRef: `x!${i + 2}`, raw, problems: [], n: normaliseNesaRow(raw, places) }; }),
      snapshot([target]), new Map([[2, { action: 'LINK' as const, schoolId: 't' }]]));
    expect(outcomes(linked)).toEqual([[2, 'MATCHED', 't', 'REVIEW'], [3, 'CONFLICT', null, null]]);
    expect(linked.items[0].details).toMatchObject({ resolvedFrom: 'CONFLICT', codeDisputed: true });
    expect(linked.changes.filter((c) => c.schoolId === 't').map((c) => [c.kind, c.field])).toEqual(expect.arrayContaining([['CHANGE', 'name'], ['FILL_EMPTY', 'cell']]));
    expect(linked.changes.find((c) => c.field === 'code')).toBeUndefined();   // the disputed 220500 is never used
    const verified = matchRows(conflictRows.map((r, i) => { const raw = nesaRow(r); return { row: i + 2, sourceRef: `x!${i + 2}`, raw, problems: [], n: normaliseNesaRow(raw, places) }; }),
      snapshot([target]), new Map([[2, { action: 'LINK' as const, schoolId: 't', code: '220777' }]]));
    expect(verified.changes.find((c) => c.field === 'code')).toMatchObject({ kind: 'FILL_EMPTY', publishedValue: '220777' });
  });

  it('CREATE: the row becomes NEW with a CREATE_SCHOOL carrying only a verified code (never the disputed one); a resolution on an ordinary row is ignored', () => {
    const rows = [{ 'School Name': 'EP ONE', 'School Code': '220500' }, { 'School Name': 'EP TWO', 'School Code': '220500' }, { 'School Name': 'EP PLAIN' }];
    const inputs = rows.map((r, i) => { const raw = nesaRow(r); return { row: i + 2, sourceRef: `x!${i + 2}`, raw, problems: [], n: normaliseNesaRow(raw, places) }; });
    const res = matchRows(inputs, snapshot([]), new Map<number, { action: 'CREATE'; code?: string | null }>([[2, { action: 'CREATE' }], [3, { action: 'CREATE', code: '220888' }], [4, { action: 'CREATE', code: '220999' }]]));
    expect(outcomes(res)).toEqual([[2, 'NEW', null, null], [3, 'NEW', null, null], [4, 'NEW', null, null]]);
    expect(res.changes.filter((c) => c.kind === 'CREATE_SCHOOL').map((c) => (c.publishedValue as any).code)).toEqual([null, '220888', null]);
  });
});
