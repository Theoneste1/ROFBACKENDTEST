import { ACCOUNT_STATUSES, allowedTargets, checkTransition, confirmationRequired, loginRefusal, permissionFor, reasonRequired, stillBlockedBy } from './account-status.js';

const REASON = 'Left the programme';

describe('account states — transitions (the documented table)', () => {
  // from → to: 'ok', or the refusal code with a valid reason.
  const MATRIX: Record<string, Record<string, string>> = {
    ACTIVE:      { ACTIVE: 'STATUS_UNCHANGED',          DEACTIVATED: 'ok',                        SUSPENDED: 'ok',                        ARCHIVED: 'ok' },
    DEACTIVATED: { ACTIVE: 'ok',                        DEACTIVATED: 'STATUS_UNCHANGED',          SUSPENDED: 'ok',                        ARCHIVED: 'ok' },
    SUSPENDED:   { ACTIVE: 'ok',                        DEACTIVATED: 'INVALID_STATUS_TRANSITION', SUSPENDED: 'STATUS_UNCHANGED',          ARCHIVED: 'ok' },
    ARCHIVED:    { ACTIVE: 'ok',                        DEACTIVATED: 'INVALID_STATUS_TRANSITION', SUSPENDED: 'INVALID_STATUS_TRANSITION', ARCHIVED: 'STATUS_UNCHANGED' },
  };

  it.each(ACCOUNT_STATUSES.flatMap((from) => ACCOUNT_STATUSES.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    expect(checkTransition(from, to, REASON)?.code ?? 'ok').toBe(MATRIX[from][to]);
  });

  it('allowedTargets matches the table', () => {
    for (const from of ACCOUNT_STATUSES) {
      expect([...allowedTargets(from)].sort()).toEqual(ACCOUNT_STATUSES.filter((to) => MATRIX[from][to] === 'ok').sort());
    }
  });

  it('a reason (3–500 characters) is needed to take access away and to restore an archived account', () => {
    expect(reasonRequired('ACTIVE', 'DEACTIVATED')).toBe(true);
    expect(reasonRequired('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(reasonRequired('DEACTIVATED', 'ARCHIVED')).toBe(true);
    expect(reasonRequired('ARCHIVED', 'ACTIVE')).toBe(true);
    expect(reasonRequired('SUSPENDED', 'ACTIVE')).toBe(false);
    expect(reasonRequired('DEACTIVATED', 'ACTIVE')).toBe(false);
    expect(checkTransition('ACTIVE', 'SUSPENDED', null)?.code).toBe('REASON_REQUIRED');
    expect(checkTransition('ACTIVE', 'SUSPENDED', '  ab  ')?.code).toBe('REASON_REQUIRED');
    expect(checkTransition('ACTIVE', 'SUSPENDED', 'x'.repeat(501))?.code).toBe('REASON_REQUIRED');
    expect(checkTransition('ACTIVE', 'SUSPENDED', 'abc')).toBeNull();
    expect(checkTransition('ARCHIVED', 'ACTIVE', '')?.code).toBe('REASON_REQUIRED');
    expect(checkTransition('SUSPENDED', 'ACTIVE', undefined)).toBeNull();
  });

  it('each transition needs its own permission', () => {
    expect(permissionFor('ACTIVE', 'DEACTIVATED')).toBe('users.changeStatus');
    expect(permissionFor('DEACTIVATED', 'ACTIVE')).toBe('users.changeStatus');
    expect(permissionFor('ACTIVE', 'SUSPENDED')).toBe('users.suspend');
    expect(permissionFor('DEACTIVATED', 'SUSPENDED')).toBe('users.suspend');
    expect(permissionFor('SUSPENDED', 'ACTIVE')).toBe('users.suspend');
    expect(permissionFor('ACTIVE', 'ARCHIVED')).toBe('users.archive');
    expect(permissionFor('SUSPENDED', 'ARCHIVED')).toBe('users.archive');
    expect(permissionFor('ARCHIVED', 'ACTIVE')).toBe('users.archive');
  });

  it('login refuses each blocked state with its own code', () => {
    expect(loginRefusal('ACTIVE')).toBeNull();
    expect(loginRefusal('DEACTIVATED')?.code).toBe('ACCOUNT_DEACTIVATED');
    expect(loginRefusal('SUSPENDED')?.code).toBe('ACCOUNT_SUSPENDED');
    expect(loginRefusal('ARCHIVED')?.code).toBe('ACCOUNT_ARCHIVED');
  });

  it('restoring an archived account (only) needs an explicit confirmation', () => {
    expect(confirmationRequired('ARCHIVED', 'ACTIVE')).toBe(true);
    for (const from of ['DEACTIVATED', 'SUSPENDED'] as const) expect(confirmationRequired(from, 'ACTIVE')).toBe(false);
    expect(confirmationRequired('ACTIVE', 'ARCHIVED')).toBe(false);
  });

  it('stillBlockedBy reports every independent condition a restore never clears', () => {
    const now = new Date('2026-11-16T10:00:00Z');
    const ok = { activatedAt: now, isApproved: true, lockedUntil: null };
    expect(stillBlockedBy(ok, true, now)).toEqual([]);
    expect(stillBlockedBy({ ...ok, activatedAt: null }, true, now)).toEqual(['NOT_ACTIVATED']);
    expect(stillBlockedBy({ ...ok, isApproved: false }, true, now)).toEqual(['PENDING_APPROVAL']);
    expect(stillBlockedBy({ ...ok, lockedUntil: new Date('2026-11-16T10:15:00Z') }, true, now)).toEqual(['LOCKED']);
    expect(stillBlockedBy({ ...ok, lockedUntil: new Date('2026-11-16T09:59:59Z') }, true, now)).toEqual([]);   // expired lock
    expect(stillBlockedBy(ok, false, now)).toEqual(['ROLE_DISABLED']);
    expect(stillBlockedBy({ activatedAt: null, isApproved: false, lockedUntil: new Date('2027-01-01') }, false, now))
      .toEqual(['NOT_ACTIVATED', 'PENDING_APPROVAL', 'LOCKED', 'ROLE_DISABLED']);
  });
});
