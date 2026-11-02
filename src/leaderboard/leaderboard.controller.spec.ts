import { Reflector } from '@nestjs/core';
import { LeaderboardController } from './leaderboard.controller.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';

const reflector = new Reflector();

function effective(method: string, key: string) {
  const handler = (LeaderboardController.prototype as unknown as Record<string, Function>)[method];
  return reflector.getAllAndOverride(key, [handler, LeaderboardController]);
}

describe('LeaderboardController authorization metadata', () => {
  it('has no class-level roles', () => {
    expect(Reflect.getMetadata(ROLES_KEY, LeaderboardController)).toBeUndefined();
  });

  it('findMine is STUDENT only', () => {
    expect(effective('findMine', ROLES_KEY)).toEqual(['STUDENT']);
  });

  it.each(['findGeneral', 'findSchoolSummary'])(
    '%s is open to any authenticated role (the service scopes the division)',
    (method) => {
      expect(effective(method, ROLES_KEY)).toBeUndefined();
    },
  );

  it.each(['findGeneral', 'findMine', 'findSchoolSummary'])('%s is not public', (method) => {
    expect(effective(method, IS_PUBLIC_KEY)).toBeUndefined();
  });
});
