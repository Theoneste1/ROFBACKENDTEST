import { isSharedAdminAccount, sharedAdminUsernames, SUPER_ADMIN_PROMOTION_LOCK } from './shared-accounts.js';

describe('shared seeded administrator accounts', () => {
  it('always includes the default seed username `admin`', () => {
    expect([...sharedAdminUsernames(undefined)]).toEqual(['admin']);
    expect(isSharedAdminAccount('admin', undefined)).toBe(true);
    expect(isSharedAdminAccount(' Admin ', '')).toBe(true);
  });

  it('adds SEED_ADMIN_USERNAME when configured, case-insensitively', () => {
    expect(isSharedAdminAccount('rof.ops', 'ROF.Ops')).toBe(true);
    expect(isSharedAdminAccount('admin', 'rof.ops')).toBe(true);   // the default stays refused too
    expect([...sharedAdminUsernames('  rof.ops ')].sort()).toEqual(['admin', 'rof.ops']);
  });

  it('never matches a personal account', () => {
    expect(isSharedAdminAccount('theoneste.n', 'rof.ops')).toBe(false);
    expect(isSharedAdminAccount('admin2', undefined)).toBe(false);
    expect(isSharedAdminAccount('administrator', undefined)).toBe(false);
  });

  it('uses one fixed 64-bit advisory lock key', () => {
    expect(typeof SUPER_ADMIN_PROMOTION_LOCK).toBe('bigint');
    expect(SUPER_ADMIN_PROMOTION_LOCK).toBeLessThan(2n ** 63n);
  });
});
