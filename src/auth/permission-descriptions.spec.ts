import { GRANTABLE } from './override-policy.js';
import { GRANTED_PERMISSION_DESCRIPTIONS, describeGrantedPermission, grantablePermissions } from './permission-descriptions.js';
import { NEVER_GRANTABLE, PERMISSIONS } from './permissions.js';

describe('plain-language names of grantable permissions', () => {
  it('every permission that can be granted to anyone has a label and a one-sentence explanation', () => {
    const grantable = grantablePermissions();
    expect(grantable.length).toBeGreaterThan(0);
    for (const role of Object.keys(GRANTABLE)) {
      for (const permission of GRANTABLE[role as keyof typeof GRANTABLE] ?? []) expect(grantable).toContain(permission);
    }
    for (const permission of grantable) {
      const entry = GRANTED_PERMISSION_DESCRIPTIONS[permission];
      expect(entry, permission).toBeDefined();
      expect(entry!.label.trim().length, permission).toBeGreaterThan(2);
      // Plain language: never the technical name.
      expect(entry!.label).not.toContain('.');
      expect(entry!.description).not.toContain(permission);
      // One sentence, ending with a full stop.
      expect(entry!.description.trim()).toMatch(/^[A-Z][^.!?]*[.]$/);
    }
  });

  it('describes only real, grantable permissions (no stale entries)', () => {
    for (const permission of Object.keys(GRANTED_PERMISSION_DESCRIPTIONS)) {
      expect(PERMISSIONS as readonly string[]).toContain(permission);
      expect(NEVER_GRANTABLE as readonly string[]).not.toContain(permission);
      expect(grantablePermissions()).toContain(permission);
    }
  });

  it('refuses to describe a permission without an entry (never falls back to the technical name)', () => {
    expect(describeGrantedPermission('students.viewProfile').label).toBe('View student profiles');
    expect(() => describeGrantedPermission('users.manageAdmins')).toThrow(/No plain-language description/);
  });
});
