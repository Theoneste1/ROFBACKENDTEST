import { decisionSkip, inChunks, normaliseFilterSelection } from './bulk-decisions.js';

describe('bulk decisions (shared rules of SCHOOL, SCHOOL_AFFILIATION, TEACHER_APPLICATION, COACH_APPLICATION)', () => {
  it('normalises an ids selection: deduplicated and sorted', () => {
    expect(normaliseFilterSelection({ mode: 'ids', ids: ['c', 'a', 'c', 'b'] })).toEqual({ mode: 'ids', ids: ['a', 'b', 'c'] });
  });

  it('normalises a filter: keys sorted, strings trimmed, empty values dropped, false kept', () => {
    const n = normaliseFilterSelection({ mode: 'filter', filter: { status: 'PENDING', q: '  kig ', district: '', sector: null, isActive: false, hasCode: undefined } });
    expect(n).toEqual({ mode: 'filter', filter: { isActive: false, q: 'kig', status: 'PENDING' } });
    expect(Object.keys((n as { filter: object }).filter)).toEqual(['isActive', 'q', 'status']);
    // The same selection written differently normalises to the same value (the confirmation binds it).
    expect(normaliseFilterSelection({ mode: 'filter', filter: { status: 'PENDING', q: 'kig' } }))
      .toEqual(normaliseFilterSelection({ mode: 'filter', filter: { q: ' kig', status: 'PENDING', district: '' } }));
  });

  it('decisionSkip: target state → ALREADY_IN_STATE; another state → the given code; applicable → null', () => {
    expect(decisionSkip('REJECTED', 'REJECTED', ['PENDING'])).toMatchObject({ outcome: 'SKIPPED', code: 'ALREADY_IN_STATE' });
    expect(decisionSkip('APPROVED', 'REJECTED', ['PENDING'], 'ALREADY_DECIDED')).toMatchObject({ outcome: 'SKIPPED', code: 'ALREADY_DECIDED' });
    expect(decisionSkip('VERIFIED', 'REJECTED', ['PENDING'])).toMatchObject({ outcome: 'SKIPPED', code: 'NOT_APPLICABLE' });
    expect(decisionSkip('PENDING', 'REJECTED', ['PENDING'])).toBeNull();
  });

  it('inChunks loads every id once, in chunks', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id${i}`);
    const calls: number[] = [];
    const rows = await inChunks(ids, async (c) => { calls.push(c.length); return c; }, 5);
    expect(calls).toEqual([5, 5, 2]);
    expect(rows).toEqual(ids);
    expect(await inChunks([], async () => { throw new Error('not called'); })).toEqual([]);
  });
});
