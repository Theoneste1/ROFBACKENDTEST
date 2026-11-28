import { describe, expect, it } from 'vitest';

import { welcomeNextStep } from './account-emails.service.js';

describe('welcome e-mail: what the new account can do, by role (owner 2026-11-27)', () => {
  it('only students are told about courses, assignments and results; coaches are never', () => {
    expect(welcomeNextStep('STUDENT')).toBe('You can now log in to follow your courses, submit assignments and see your results.');
    for (const role of ['MENTOR', 'HEAD_COACH', 'TEACHER', 'ADMIN', 'SUPER_ADMIN']) {
      expect([role, welcomeNextStep(role)]).not.toEqual([role, expect.stringContaining('submit assignments')]);
    }
    expect(welcomeNextStep('MENTOR')).toBe("You can now log in to prepare assignments, review your students' work and mark tests. Your Head Coach gives you access to your courses.");
    expect(welcomeNextStep('HEAD_COACH')).toContain('manage your programme');
    expect(welcomeNextStep('TEACHER')).toContain('follow your students');
  });
});
