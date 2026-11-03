import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AUDIT_CATEGORIES, categoryOf } from './audit-categories.js';
import { ModerationActionType } from '../generated/prisma/client.js';

/** Every `action: 'X'` literal recorded anywhere in the application source. */
function recordedActions(dir: string): Set<string> {
  const found = new Set<string>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'generated') for (const a of recordedActions(path)) found.add(a);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      const text = readFileSync(path, 'utf8');
      // Values only — not type declarations such as `action: 'HIDE' | 'DELETE'`.
      for (const m of text.matchAll(/action:\s*(?:dryRun \? )?'([A-Z_]+)'(?:\s*:\s*'([A-Z_]+)')?(?!\s*\|)/g)) {
        found.add(m[1]);
        if (m[2]) found.add(m[2]);
      }
    }
  }
  return found;
}

describe('audit categories', () => {
  it('every action the application records belongs to a category', () => {
    const uncategorised = [...recordedActions(join(__dirname, '..'))].filter((a) => categoryOf(a) === 'OTHER');
    expect(uncategorised).toEqual([]);
  });

  it('every moderation action is a MODERATION entry', () => {
    for (const action of Object.values(ModerationActionType)) expect(categoryOf(action), action).toBe('MODERATION');
  });

  it('no action is listed in two categories', () => {
    const all = Object.values(AUDIT_CATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
