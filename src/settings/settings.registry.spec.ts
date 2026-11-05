import { SETTINGS, defaultValue, isSettingKey, validateSettingValue } from './settings.registry.js';

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

  describe('integer settings', () => {
    const key = 'submissions.resubmissionRequestDays';

    it.each([1, 7, 60])('accepts %d', (value) => {
      expect(validateSettingValue(key, value)).toBeNull();
    });

    it('rejects values outside the limits', () => {
      expect(validateSettingValue(key, 0)).toBe(`${key} must be at least 1.`);
      expect(validateSettingValue(key, 61)).toBe(`${key} must be at most 60.`);
    });

    it.each([1.5, '7', true, null])('rejects %j', (value) => {
      expect(validateSettingValue(key, value)).not.toBeNull();
    });
  });

  describe('e-mail and link settings', () => {
    it('validates e-mail addresses', () => {
      expect(validateSettingValue('platform.supportEmail', 'not-an-email')).toBe('platform.supportEmail must be an e-mail address.');
    });

    it('requires https links', () => {
      expect(validateSettingValue('support.helpUrl', 'https://help.rof.rw/guide')).toBeNull();
      expect(validateSettingValue('support.helpUrl', 'http://help.rof.rw')).toBe('support.helpUrl must be an https:// link.');
      expect(validateSettingValue('support.helpUrl', 'javascript:alert(1)')).toBe('support.helpUrl must be an https:// link.');
    });

    it('rejects blank text (null clears a value)', () => {
      expect(validateSettingValue('support.phone', '   ')).toBe('support.phone cannot be empty (use null to clear it).');
      expect(validateSettingValue('support.phone', null)).toBeNull();
    });
  });

  it('e-mail verification is on by default in production only', () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(defaultValue('registration.requireEmailVerification')).toBe(true);
      process.env.NODE_ENV = 'development';
      expect(defaultValue('registration.requireEmailVerification')).toBe(false);
      expect(defaultValue('platform.name')).toBe('ROF Learning Platform');
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it('every setting has a category', () => {
    for (const def of Object.values(SETTINGS)) expect(def.category).toBeTruthy();
  });

  it('every default value passes its own validation', () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      expect(validateSettingValue(key as keyof typeof SETTINGS, def.default)).toBeNull();
    }
  });
});
