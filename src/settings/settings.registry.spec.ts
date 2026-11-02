import { SETTINGS, isSettingKey, validateSettingValue } from './settings.registry.js';

describe('isSettingKey', () => {
  it('accepts declared keys', () => {
    for (const key of Object.keys(SETTINGS)) expect(isSettingKey(key)).toBe(true);
  });

  it.each(['unknown.key', '', 'toString', '__proto__', 'constructor'])('rejects %j', (key) => {
    expect(isSettingKey(key)).toBe(false);
  });
});

describe('validateSettingValue', () => {
  describe('boolean settings', () => {
    it('accepts true and false', () => {
      expect(validateSettingValue('leaderboard.visibleToStudents', true)).toBeNull();
      expect(validateSettingValue('leaderboard.visibleToStudents', false)).toBeNull();
    });

    it.each(['true', 1, 0, {}, undefined])('rejects %j', (value) => {
      expect(validateSettingValue('registration.studentSelfSignup', value))
        .toBe('registration.studentSelfSignup must be true or false.');
    });

    it('rejects null', () => {
      expect(validateSettingValue('registration.studentSelfSignup', null))
        .toBe('registration.studentSelfSignup cannot be null.');
    });
  });

  describe('enum settings', () => {
    const key = 'submissions.defaultDistributionStrategy';

    it.each(['BALANCED', 'ROUND_ROBIN'])('accepts %s', (value) => {
      expect(validateSettingValue(key, value)).toBeNull();
    });

    it.each(['balanced', 'RANDOM', 3])('rejects %j', (value) => {
      expect(validateSettingValue(key, value)).toBe(`${key} must be one of: BALANCED, ROUND_ROBIN.`);
    });
  });

  describe('string settings', () => {
    it('accepts text within the limit', () => {
      expect(validateSettingValue('platform.name', 'ROF')).toBeNull();
      expect(validateSettingValue('platform.name', 'x'.repeat(100))).toBeNull();
    });

    it('rejects text over maxLength', () => {
      expect(validateSettingValue('platform.name', 'x'.repeat(101))).toBe('platform.name is too long (max 100).');
    });

    it('rejects non-strings', () => {
      expect(validateSettingValue('platform.name', 42)).toBe('platform.name must be text.');
    });

    it('rejects null for a non-nullable string', () => {
      expect(validateSettingValue('platform.name', null)).toBe('platform.name cannot be null.');
    });

    it('accepts null for a nullable string', () => {
      expect(validateSettingValue('platform.supportEmail', null)).toBeNull();
      expect(validateSettingValue('platform.supportEmail', 'help@rof.rw')).toBeNull();
    });
  });

  it('every default value passes its own validation', () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      expect(validateSettingValue(key as keyof typeof SETTINGS, def.default)).toBeNull();
    }
  });
});
