import { schoolLockPlan, type LockableSchool } from './school-locks.js';

const S = (o: Partial<LockableSchool> = {}): LockableSchool => ({
  name: 'Lycée de Huye', code: '220001', countryCode: 'RW', district: 'Huye', isActive: true, ...o,
});

describe('schoolLockPlan (PR D) — name keys then codes, each sorted and de-duplicated', () => {
  it('create / import: the new name key and the new code', () => {
    expect(schoolLockPlan([{ before: null, after: S() }])).toEqual({ nameKeys: ['lycee de huye'], codes: ['220001'] });
    expect(schoolLockPlan([{ before: null, after: S({ code: null }) }])).toEqual({ nameKeys: ['lycee de huye'], codes: [] });
  });

  it('an import: every row, sorted, each once', () => {
    const plan = schoolLockPlan([
      { before: null, after: S({ name: 'Zeta School', code: '330001' }) },
      { before: null, after: S({ name: 'Alpha School', code: '110001' }) },
      { before: null, after: S({ name: 'ALPHA school!', code: '110001' }) },
    ]);
    expect(plan).toEqual({ nameKeys: ['alpha school', 'zeta school'], codes: ['110001', '330001'] });
  });

  it('PATCH name: the old and the new key', () => {
    expect(schoolLockPlan([{ before: S(), after: S({ name: 'Groupe Scolaire Huye' }) }]))
      .toEqual({ nameKeys: ['groupe scolaire huye', 'lycee de huye'], codes: [] });
  });

  it('PATCH district / country / active: the school\'s key only', () => {
    for (const after of [S({ district: 'Gisagara' }), S({ countryCode: 'KE' }), S({ isActive: false })]) {
      expect(schoolLockPlan([{ before: S(), after }])).toEqual({ nameKeys: ['lycee de huye'], codes: [] });
    }
  });

  it('PATCH code: the school\'s key, then the old and the new code (sorted); setting a first code locks only the new one', () => {
    expect(schoolLockPlan([{ before: S({ code: '220009' }), after: S({ code: '220002' }) }]))
      .toEqual({ nameKeys: ['lycee de huye'], codes: ['220002', '220009'] });
    expect(schoolLockPlan([{ before: S({ code: null }), after: S({ code: '220002' }) }]))
      .toEqual({ nameKeys: ['lycee de huye'], codes: ['220002'] });
  });

  it('a swap attempt locks the same set in the same order on both sides', () => {
    const a = schoolLockPlan([{ before: S({ name: 'A School', code: '110002' }), after: S({ name: 'A School', code: '110003' }) }]);
    const b = schoolLockPlan([{ before: S({ name: 'B School', code: '110003' }), after: S({ name: 'B School', code: '110002' }) }]);
    expect(a.codes).toEqual(['110002', '110003']);
    expect(b.codes).toEqual(a.codes);
  });

  it('only location / province / sector / ownership (not in the lock fields): no lock at all', () => {
    expect(schoolLockPlan([{ before: S(), after: S() }])).toEqual({ nameKeys: [], codes: [] });
  });

  it('a name without letters or digits adds no key (validation refuses it anyway)', () => {
    expect(schoolLockPlan([{ before: null, after: S({ name: '!!', code: null }) }])).toEqual({ nameKeys: [], codes: [] });
  });
});
