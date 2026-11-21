import { BulkRegistry } from './bulk-registry.js';
import type { BulkEntityHandler } from './bulk-handler.js';
import { ACTION_RULES, BULK_ACTIONS } from '../users/bulk/bulk-rules.js';

const handler = (entityType: string) => ({ entityType, actions: { go: { permissions: [], reason: 'optional', consequence: 'x' } } }) as unknown as BulkEntityHandler;

describe('BulkRegistry', () => {
  it('registers a type once; a second, different handler for the same type is refused', () => {
    const r = new BulkRegistry();
    const h = handler('SCHOOL');
    r.register(h);
    r.register(h);
    expect(() => r.register(handler('SCHOOL'))).toThrow(/already registered/);
    expect(r.get('SCHOOL')).toBe(h);
    expect(r.all().map((x) => x.entityType)).toEqual(['SCHOOL']);
  });

  it('refuses names that are not upper-case identifiers', () => {
    expect(() => new BulkRegistry().register(handler('school'))).toThrow();
    expect(() => new BulkRegistry().register(handler('SCHOOL; DROP'))).toThrow();
  });

  it('unknown types → 404 BULK_ENTITY_UNKNOWN; unknown actions (also inherited object keys) → 400 BULK_ACTION_UNKNOWN', () => {
    const r = new BulkRegistry();
    r.register(handler('USER'));
    expect(() => r.get('NOPE')).toThrow(expect.objectContaining({ code: 'BULK_ENTITY_UNKNOWN' }));
    expect(r.action(r.get('USER'), 'go')).toMatchObject({ reason: 'optional' });
    for (const a of ['nope', 'toString', '__proto__', 'constructor']) {
      expect(() => r.action(r.get('USER'), a)).toThrow(expect.objectContaining({ code: 'BULK_ACTION_UNKNOWN' }));
    }
  });

  it('USER actions: users.bulkManage is never sufficient — each needs the single route permission(s)', () => {
    const ACCOUNT_ROUTE = ['activate', 'deactivate', 'suspend', 'archive', 'restore', 'assignRole', 'changeClassification'];
    for (const a of BULK_ACTIONS) {
      expect(ACTION_RULES[a].permissions.length, a).toBeGreaterThan(0);
      expect(ACTION_RULES[a].permissions, a).not.toContain('users.bulkManage');
      // /admin/users/:id/status-changes and PATCH /admin/users/:id need users.manage at the route.
      if (ACCOUNT_ROUTE.includes(a)) expect(ACTION_RULES[a].permissions, a).toContain('users.manage');
    }
    expect(ACTION_RULES.message.permissions).toEqual(['email.bulkSend']);
    expect(ACTION_RULES.reassignTeacher).toMatchObject({ permissions: ['users.manageTeachers'], reason: 'optional' });
  });
});
