import { readFileSync } from 'node:fs';

import { getMetadataStorage } from 'class-validator';

import { Prisma } from '../../generated/prisma/client.js';
import { ListUsersQueryDto } from '../dto/update-user.dto.js';
import { userListWhere } from '../users.service.js';
import { BulkFilterDto } from './bulk.dto.js';
import {
  ACTION_RULES, activateNowBreakdown, BULK_ACTIONS, finalStatus, MEMBERSHIP_COLUMNS, normaliseParams, normaliseSelection, SKIP_CODES, selectionToken,
  statusDecision,
} from './bulk-rules.js';

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

  describe('membership guard: the trigger covers every User column any list / bulk filter reads', () => {
    // The filter keys come from the DTOs themselves (class-validator metadata), so a filter added later without a
    // sample value — and so without trigger coverage — fails here instead of passing silently.
    const NOT_FILTERS: Record<string, string> = {
      page:  'pagination only (PaginationQueryDto); never reaches the where clause',
      limit: 'pagination only (PaginationQueryDto); never reaches the where clause',
      sort:  'the order of the list only (userListOrder, 2026-11-22); never reaches the where clause',
      order: 'the order of the list only (userListOrder, 2026-11-22); never reaches the where clause',
      banking: 'computed from the bank details and the role (UsersService.findAll matches ids, 2026-11-25); bulk actions refuse it (BULK_BANKING_FILTER)',
    };
    const keysOf = (cls: new () => object) =>
      [...new Set(getMetadataStorage().getTargetValidationMetadatas(cls, '', true, false).map((m) => m.propertyName))].sort();
    const listKeys = keysOf(ListUsersQueryDto).filter((k) => !(k in NOT_FILTERS));
    const bulkKeys = keysOf(BulkFilterDto);
    // One value per filter key (each must make userListWhere read at least one column).
    const SAMPLE: Record<string, unknown> = {
      role: 'STUDENT', divisionId: 'd', gradeLevel: 'S1', schoolId: 's', isApproved: true, isActive: true,
      accountStatus: 'ACTIVE', isActivated: true, search: 'x',
    };
    const USER_SCALARS = new Set<string>(Object.values(Prisma.UserScalarFieldEnum));
    const LOGICAL = new Set(['AND', 'OR', 'NOT']);
    /** The User columns a where clause reads, recursively through AND / OR / NOT; a relation filter is refused. */
    function columnsOf(where: unknown, out = new Set<string>()): Set<string> {
      if (Array.isArray(where)) { for (const w of where) columnsOf(w, out); return out; }
      if (where === null || typeof where !== 'object') return out;
      for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (LOGICAL.has(k)) columnsOf(v, out);
        else if (USER_SCALARS.has(k)) out.add(k);      // its value is a scalar filter ({ contains }, { not: null }…)
        else throw new Error(`the where clause filters on "${k}", which is not a scalar User column (a relation filter): the related table also needs the bulk membership guard trigger, or the filter must not be offered for bulk selection`);
      }
      return out;
    }
    const triggerColumns = () => {
      const sql = readFileSync('prisma/migrations/20261207000100_bulk_membership_guard/migration.sql', 'utf8');
      return [...sql.match(/UPDATE OF([\s\S]*?)\n\s*ON "User"/)![1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
    };

    it('derives the filter keys from the DTOs; the bulk filters are a subset of the list filters', () => {
      expect(listKeys.length).toBeGreaterThan(0);
      for (const k of bulkKeys) expect(listKeys, `BulkFilterDto.${k} is not a ListUsersQueryDto filter`).toContain(k);
    });

    it('has a sample value for every filter key, and every key reaches the where clause', () => {
      for (const k of new Set([...listKeys, ...bulkKeys])) {
        if (!(k in SAMPLE)) throw new Error(`add a sample value and trigger coverage for ${k}`);
        const cols = columnsOf(userListWhere({ [k]: SAMPLE[k] } as never));
        expect(cols.size, `filter ${k} reads no User column`).toBeGreaterThan(0);
      }
      for (const k of Object.keys(SAMPLE)) expect(listKeys, `sample key ${k} is not a filter any more`).toContain(k);
    });

    it('the columns read = MEMBERSHIP_COLUMNS = the trigger UPDATE OF list; sign-in columns are not guarded', () => {
      const cols = [...columnsOf(userListWhere(SAMPLE as never))].sort();
      const guarded = triggerColumns();
      for (const c of cols) if (!guarded.includes(c)) throw new Error(`column ${c} is read by a filter but not covered by the guard trigger (UPDATE OF list)`);
      expect(cols).toEqual([...MEMBERSHIP_COLUMNS].sort());
      expect(guarded).toEqual([...MEMBERSHIP_COLUMNS].sort());
      for (const c of ['lastLoginAt', 'failedLoginCount', 'lockedUntil', 'tokensValidAfter', 'passwordHash']) expect(guarded).not.toContain(c);
    });
  });
});

describe('activateNow (owner 2026-11-24)', () => {
  it('needs the single route\'s permissions (users.manage, users.changeStatus); no reason required; no parameters', () => {
    expect(ACTION_RULES.activateNow).toMatchObject({ permissions: ['users.manage', 'users.changeStatus'], reason: 'optional' });
    expect(ACTION_RULES.activateNow.toStatus).toBeUndefined();
    expect(normaliseParams('activateNow', { role: 'ADMIN', subject: 'x' })).toEqual({});
  });

  it('the service\'s refusals are skips, not failures', () => {
    for (const c of ['ALREADY_ACTIVATED', 'NO_PASSWORD_YET', 'ACCOUNT_NOT_ACTIVE']) expect(SKIP_CODES.has(c)).toBe(true);
  });

  it('preview breakdown: how many will be activated and each skip reason, in the item\'s order (rank, state, activated, password)', () => {
    const g = (role: string, accountStatus: 'ACTIVE' | 'DEACTIVATED' | 'SUSPENDED' | 'ARCHIVED', activated: boolean, hasPassword: boolean, n: number) =>
      ({ role, accountStatus, activated, hasPassword, n });
    const groups = [
      g('STUDENT', 'ACTIVE', false, true, 5),      // activated
      g('TEACHER', 'ACTIVE', false, true, 2),      // activated
      g('MENTOR', 'ACTIVE', false, false, 3),      // invited, no password yet
      g('STUDENT', 'ACTIVE', true, true, 4),       // already active
      g('STUDENT', 'SUSPENDED', false, true, 1),   // not active
      g('STUDENT', 'ARCHIVED', true, false, 1),    // not active (the state is checked first)
      g('ADMIN', 'ACTIVE', false, true, 2),        // rank: the caller may not manage Administrators
    ];
    const r = activateNowBreakdown(groups, (role) => role !== 'ADMIN', false);
    expect(r).toEqual({ willActivate: 7, skipped: { SELF: 0, ROLE_NOT_MANAGEABLE: 2, ACCOUNT_NOT_ACTIVE: 2, ALREADY_ACTIVATED: 4, NO_PASSWORD_YET: 3 } });
    const total = groups.reduce((n, x) => n + x.n, 0);
    expect(r.willActivate + Object.values(r.skipped).reduce((n, x) => n + x, 0)).toBe(total);
  });

  it('the caller\'s own (activated) account is counted once, as SELF', () => {
    const r = activateNowBreakdown([{ role: 'ADMIN', accountStatus: 'ACTIVE', activated: true, hasPassword: true, n: 1 },
      { role: 'STUDENT', accountStatus: 'ACTIVE', activated: false, hasPassword: true, n: 1 }], () => true, true);
    expect(r).toEqual({ willActivate: 1, skipped: { SELF: 1, ROLE_NOT_MANAGEABLE: 0, ACCOUNT_NOT_ACTIVE: 0, ALREADY_ACTIVATED: 0, NO_PASSWORD_YET: 0 } });
  });

  it('an empty selection activates nobody', () => {
    expect(activateNowBreakdown([], () => true, false).willActivate).toBe(0);
  });
});
