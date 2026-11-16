import { readFileSync } from 'node:fs';

import { userListWhere } from '../users.service.js';
import { ACTION_RULES, BULK_ACTIONS, finalStatus, MEMBERSHIP_COLUMNS, normaliseParams, normaliseSelection, selectionToken, statusDecision } from './bulk-rules.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('bulk rules', () => {
  describe('selectionToken — bound to the action, its parameters, the selection and the exact matching accounts', () => {
    const sel = { mode: 'filter' as const, filter: { role: 'STUDENT', accountStatus: 'ACTIVE' } };
    const base = selectionToken('suspend', {}, sel, [A, B]);

    it('is stable: order of ids and of filter keys, duplicates and empty filter values do not matter', () => {
      expect(selectionToken('suspend', {}, sel, [B, A])).toBe(base);
      expect(selectionToken('suspend', {}, { mode: 'filter', filter: { accountStatus: 'ACTIVE', role: 'STUDENT', search: '' } }, [A, B])).toBe(base);
      expect(selectionToken('suspend', {}, { mode: 'ids', ids: [B, A, A] }, [A, B])).toBe(selectionToken('suspend', {}, { mode: 'ids', ids: [A, B] }, [A, B]));
      expect(base).toMatch(/^v1\.2\.[0-9a-f]{64}$/);
    });

    it('changes when an account joins or leaves the set — even with the same count', () => {
      expect(selectionToken('suspend', {}, sel, [A, B, C])).not.toBe(base);
      expect(selectionToken('suspend', {}, sel, [A])).not.toBe(base);
      expect(selectionToken('suspend', {}, sel, [A, C])).not.toBe(base);   // same total, different accounts
    });

    it('changes with the action, its parameters or the selection itself', () => {
      expect(selectionToken('archive', {}, sel, [A, B])).not.toBe(base);
      expect(selectionToken('assignRole', { role: 'MENTOR' }, sel, [A, B])).not.toBe(selectionToken('assignRole', { role: 'TEACHER' }, sel, [A, B]));
      expect(selectionToken('suspend', {}, { mode: 'filter', filter: { role: 'STUDENT' } }, [A, B])).not.toBe(base);
      expect(selectionToken('suspend', {}, { mode: 'ids', ids: [A, B] }, [A, B])).not.toBe(base);
    });
  });

  it('normalises selections and keeps only the parameters an action uses', () => {
    expect(normaliseSelection({ mode: 'ids', ids: [B, A, B] })).toEqual({ mode: 'ids', ids: [A, B] });
    expect(normaliseSelection({ mode: 'filter', filter: { search: '', role: 'ADMIN', isActive: undefined } })).toEqual({ mode: 'filter', filter: { role: 'ADMIN' } });
    expect(normaliseParams('suspend', { role: 'ADMIN', subject: 'x' })).toEqual({});
    expect(normaliseParams('assignRole', { role: 'MENTOR', gradeLevel: 'S1' })).toEqual({ role: 'MENTOR' });
    expect(normaliseParams('message', { subject: '  Hello ', body: 'Body text', role: 'ADMIN' })).toEqual({ subject: 'Hello', body: 'Body text' });
  });

  it('status actions: what each does from each state', () => {
    expect(statusDecision('suspend', 'ACTIVE')).toEqual({ toStatus: 'SUSPENDED' });
    expect(statusDecision('suspend', 'SUSPENDED')).toEqual({ skip: 'ALREADY_IN_STATE' });
    expect(statusDecision('suspend', 'ARCHIVED')).toEqual({ skip: 'NOT_APPLICABLE' });
    expect(statusDecision('deactivate', 'SUSPENDED')).toEqual({ skip: 'NOT_APPLICABLE' });
    expect(statusDecision('activate', 'DEACTIVATED')).toEqual({ toStatus: 'ACTIVE' });
    expect(statusDecision('activate', 'SUSPENDED')).toEqual({ toStatus: 'ACTIVE' });
    expect(statusDecision('activate', 'ARCHIVED')).toEqual({ skip: 'USE_RESTORE' });
    expect(statusDecision('restore', 'ARCHIVED')).toEqual({ toStatus: 'ACTIVE' });
    expect(statusDecision('restore', 'ACTIVE')).toEqual({ skip: 'ALREADY_IN_STATE' });
    expect(statusDecision('archive', 'DEACTIVATED')).toEqual({ toStatus: 'ARCHIVED' });
    expect(() => statusDecision('message', 'ACTIVE')).toThrow();
  });

  it('every action declares its reason rule and consequence; taking access away and restoring need a reason', () => {
    for (const a of BULK_ACTIONS) expect(ACTION_RULES[a].consequence.length).toBeGreaterThan(20);
    for (const a of ['deactivate', 'suspend', 'archive', 'restore'] as const) expect(ACTION_RULES[a].reason).toBe('required');
    expect(ACTION_RULES.message.permissions).toEqual(['email.bulkSend']);
  });

  it('final status: completed, completed with failures, failed', () => {
    expect(finalStatus({ succeeded: 3, failed: 0, skipped: 1, total: 4 })).toBe('COMPLETED');
    expect(finalStatus({ succeeded: 2, failed: 1, skipped: 0, total: 3 })).toBe('COMPLETED_WITH_FAILURES');
    expect(finalStatus({ succeeded: 0, failed: 2, skipped: 0, total: 2 })).toBe('FAILED');
    expect(finalStatus({ succeeded: 0, failed: 1, skipped: 1, total: 2 })).toBe('COMPLETED_WITH_FAILURES');
  });

  it('membership guard: the trigger covers exactly the User columns the list / bulk filters read', () => {
    // Every filter set at once; collect the column names the where clause reads (top level and the search OR).
    const where = userListWhere({
      role: 'STUDENT', divisionId: 'd', gradeLevel: 'S1', schoolId: 's', isApproved: true, isActive: true,
      accountStatus: 'ACTIVE', isActivated: true, search: 'x',
    } as never) as Record<string, unknown>;
    const cols = new Set<string>();
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') for (const o of v as Array<Record<string, unknown>>) for (const c of Object.keys(o)) cols.add(c);
      else cols.add(k);
    }
    expect([...cols].sort()).toEqual([...MEMBERSHIP_COLUMNS].sort());
    const sql = readFileSync('prisma/migrations/20261207000100_bulk_membership_guard/migration.sql', 'utf8');
    const guarded = [...sql.match(/UPDATE OF([\s\S]*?)\n\s*ON "User"/)![1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
    expect(guarded).toEqual([...MEMBERSHIP_COLUMNS].sort());
    // Sign-in columns are deliberately NOT guarded (a sign-in never waits for a bulk operation).
    for (const c of ['lastLoginAt', 'failedLoginCount', 'lockedUntil', 'tokensValidAfter', 'passwordHash']) expect(guarded).not.toContain(c);
  });
});
