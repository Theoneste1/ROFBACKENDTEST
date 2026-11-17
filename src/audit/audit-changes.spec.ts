import { AUDIT_TEXT_LIMIT, auditChanges } from './audit-changes.js';

describe('auditChanges (AUD-02)', () => {
  it('only the listed fields that changed; undefined = not part of the change', () => {
    expect(auditChanges({ a: 1, b: 'x', c: true }, { a: 2, b: 'x', c: undefined }, ['a', 'b', 'c'])).toEqual({ a: { from: 1, to: 2 } });
  });
  it('dates as ISO strings, compared by time; arrays by value; null for missing', () => {
    const d = new Date('2026-11-01T00:00:00Z');
    expect(auditChanges({ d, t: ['x'] as string[] }, { d: new Date(d), t: ['x'] }, ['d', 't'])).toEqual({});
    expect(auditChanges({ d, t: ['x'] as string[], n: null as string | null }, { d: new Date('2026-12-01T00:00:00Z'), t: ['y'], n: 'v' }, ['d', 't', 'n']))
      .toEqual({ d: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' }, t: { from: ['x'], to: ['y'] }, n: { from: null, to: 'v' } });
  });
  it('long text is cut', () => {
    const long = 'z'.repeat(AUDIT_TEXT_LIMIT + 50);
    const out = auditChanges({ s: 'short' }, { s: long }, ['s']);
    expect((out.s.to as string).length).toBe(AUDIT_TEXT_LIMIT + 1);
  });
  it('fields not listed are never included', () => {
    expect(auditChanges({ password: 'a', name: 'n' }, { password: 'b', name: 'n' }, ['name'])).toEqual({});
  });
});
