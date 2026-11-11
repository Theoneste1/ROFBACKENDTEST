import { categoryListDigest, decide, decisionsDigestOf, unmetDependencies, type ReviewChange, type ReviewItem } from './sync-decisions.js';

const place = { province: 'Southern Province', district: 'Huye', sector: 'Tumba Nshya' };
const items: ReviewItem[] = [
  { id: 'i-new', outcome: 'NEW', normalized: { placeKnown: false, ...place } },
  { id: 'i-match', outcome: 'MATCHED', normalized: { placeKnown: true, province: 'Southern Province', district: 'Huye', sector: 'Ngoma' } },
  { id: 'i-move', outcome: 'MATCHED', normalized: { placeKnown: false, ...place } },
];
const ch = (id: string, kind: string, o: Partial<ReviewChange> = {}): ReviewChange => ({
  id, kind, field: null, itemId: null, schoolId: null, currentValue: null, publishedValue: null, decision: 'PENDING', ...o,
});
const base = (): ReviewChange[] => [
  ch('p', 'NEW_PLACE', { field: 'place', publishedValue: place }),
  ch('c', 'CREATE_SCHOOL', { itemId: 'i-new', publishedValue: { name: 'EP NEW', ...place } }),
  ch('c-lvl', 'ADD_LEVEL', { itemId: 'i-new', field: 'PR', publishedValue: { code: 'PR' } }),
  ch('c-tel', 'ADD_CONTACT', { itemId: 'i-new', field: 'PHONE', publishedValue: { type: 'PHONE', value: '+250788000001' } }),
  ch('m-cell', 'FILL_EMPTY', { itemId: 'i-match', schoolId: 's1', field: 'cell', publishedValue: 'Butare' }),
  ch('m-name', 'CHANGE', { itemId: 'i-match', schoolId: 's1', field: 'name', currentValue: 'A', publishedValue: 'B' }),
  ch('mv-sector', 'CHANGE', { itemId: 'i-move', schoolId: 's2', field: 'sector', currentValue: 'Ngoma', publishedValue: 'Tumba Nshya' }),
  ch('r', 'RESOLVE_CONFLICT', { itemId: 'i-match', publishedValue: { action: 'LINK', schoolId: 's9' } }),
];
const run = (changes: ReviewChange[], req: Parameters<typeof decide>[2], superAdmin = false) => decide(changes, items, req, { superAdmin });
const apply = (changes: ReviewChange[], out: ReturnType<typeof decide>) => changes.map((c) => ({ ...c, decision: out.updates.get(c.id) ?? c.decision }));

describe('sync review decisions (S2b)', () => {
  it('a change needing a NEW_PLACE cannot be approved while the place is pending or rejected — nor a new school\'s additions before its CREATE_SCHOOL', () => {
    for (const id of ['c', 'mv-sector']) {
      expect(run(base(), { decisions: [{ changeId: id, decision: 'APPROVED' }], categories: [] }).problems).toEqual([
        { code: 'DEPENDENCY_NOT_APPROVED', changeId: id, dependsOn: [{ changeId: 'p', kind: 'NEW_PLACE', decision: 'PENDING' }] },
      ]);
    }
    expect(run(base(), { decisions: [{ changeId: 'c-lvl', decision: 'APPROVED' }], categories: [] }).problems[0]).toMatchObject({ code: 'DEPENDENCY_NOT_APPROVED', dependsOn: [{ changeId: 'c' }] });
    // Together, in one request, places and new schools first: allowed.
    const out = run(base(), { decisions: [{ changeId: 'c-lvl', decision: 'APPROVED' }, { changeId: 'c', decision: 'APPROVED' }, { changeId: 'p', decision: 'APPROVED' }], categories: [] });
    expect(out.problems).toEqual([]);
    expect([...out.updates].sort()).toEqual([['c', 'APPROVED'], ['c-lvl', 'APPROVED'], ['p', 'APPROVED']]);
  });

  it('rejecting a place (or a new school) returns every APPROVED change depending on it to PENDING, transitively', () => {
    let changes = apply(base(), run(base(), { decisions: ['p', 'c', 'c-lvl', 'c-tel', 'mv-sector'].map((changeId) => ({ changeId, decision: 'APPROVED' as const })), categories: [] }));
    const out = run(changes, { decisions: [{ changeId: 'p', decision: 'REJECTED' }], categories: [] });
    expect([...out.updates].sort()).toEqual([['c', 'PENDING'], ['c-lvl', 'PENDING'], ['c-tel', 'PENDING'], ['mv-sector', 'PENDING'], ['p', 'REJECTED']]);
    expect(out.reverted.sort()).toEqual(['c', 'c-lvl', 'c-tel', 'mv-sector']);
    changes = apply(changes, out);
    expect(unmetDependencies(changes, items)).toEqual([]);
  });

  it('categories: only FILL_EMPTY, ADD_LEVEL, ADD_PROGRAMME, CREATE_SCHOOL, NAME_RESTORE; bound to the list digest; blocked ones stay PENDING; an explicit rejection stays', () => {
    const changes = base();
    for (const kind of ['CHANGE', 'ADD_CONTACT', 'NEW_PLACE', 'RESOLVE_CONFLICT']) {
      expect(run(changes, { decisions: [], categories: [{ kind, listDigest: categoryListDigest(changes, kind) }] }).problems).toEqual([{ code: 'NOT_A_CATEGORY_KIND', kind }]);
    }
    expect(run(changes, { decisions: [], categories: [{ kind: 'FILL_EMPTY', listDigest: 'x'.repeat(64) }] }).problems).toEqual([{ code: 'CATEGORY_LIST_CHANGED', kind: 'FILL_EMPTY' }]);
    const out = run(changes, { decisions: [], categories: [{ kind: 'ADD_LEVEL', listDigest: categoryListDigest(changes, 'ADD_LEVEL') }, { kind: 'FILL_EMPTY', listDigest: categoryListDigest(changes, 'FILL_EMPTY') }] });
    expect([...out.updates]).toEqual([['m-cell', 'APPROVED']]);
    expect(out.blocked).toEqual(['c-lvl']);   // its new school is not approved
    const rejected = changes.map((c) => (c.id === 'm-cell' ? { ...c, decision: 'REJECTED' as const } : c));
    expect(run(rejected, { decisions: [], categories: [{ kind: 'FILL_EMPTY', listDigest: categoryListDigest(rejected, 'FILL_EMPTY') }] }).updates.size).toBe(0);
  });

  it('the list digest changes with any listed change, its values or its decision', () => {
    const changes = base();
    const d = categoryListDigest(changes, 'FILL_EMPTY');
    expect(categoryListDigest([...changes].reverse(), 'FILL_EMPTY')).toBe(d);
    expect(categoryListDigest(changes.map((c) => (c.id === 'm-cell' ? { ...c, publishedValue: 'Other' } : c)), 'FILL_EMPTY')).not.toBe(d);
    expect(categoryListDigest(changes.map((c) => (c.id === 'm-cell' ? { ...c, decision: 'REJECTED' as const } : c)), 'FILL_EMPTY')).not.toBe(d);
    expect(categoryListDigest([...changes, ch('m-2', 'FILL_EMPTY')], 'FILL_EMPTY')).not.toBe(d);
  });

  it('RESOLVE_CONFLICT is decided only by a Super Admin; unknown changes are refused; nothing is changed when anything is refused', () => {
    expect(run(base(), { decisions: [{ changeId: 'r', decision: 'APPROVED' }], categories: [] }).problems).toEqual([{ code: 'SUPER_ADMIN_ONLY', changeId: 'r', kind: 'RESOLVE_CONFLICT' }]);
    expect([...run(base(), { decisions: [{ changeId: 'r', decision: 'APPROVED' }], categories: [] }, true).updates]).toEqual([['r', 'APPROVED']]);
    const out = run(base(), { decisions: [{ changeId: 'm-name', decision: 'APPROVED' }, { changeId: 'nope', decision: 'APPROVED' }], categories: [] });
    expect(out.problems).toEqual([{ code: 'UNKNOWN_CHANGE', changeId: 'nope' }]);
    expect(out.updates.size).toBe(0);
  });

  it('the decisions digest: order-independent, sensitive to every decision', () => {
    const changes = base();
    const d = decisionsDigestOf(changes);
    expect(decisionsDigestOf([...changes].reverse())).toBe(d);
    expect(decisionsDigestOf(changes.map((c, i) => (i === 0 ? { ...c, decision: 'APPROVED' as const } : c)))).not.toBe(d);
  });
});
