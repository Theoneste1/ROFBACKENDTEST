// Nest normally loads this polyfill; class-transformer needs it when the
// module is imported on its own.
import 'reflect-metadata';
import { validateEnv } from './env.validation.js';

const SECRET = 'x'.repeat(32);
const minimal = (overrides: Record<string, unknown> = {}) => ({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET:   SECRET,
  ...overrides,
});

describe('validateEnv', () => {
  it('accepts a minimal development config and applies defaults', () => {
    const env = validateEnv(minimal());
    expect(env).toMatchObject({
      NODE_ENV:               'development',
      PORT:                   3000,
      STORAGE_DRIVER:         'local',
      JWT_ACCESS_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
    });
  });

  it('converts numeric strings and keeps undeclared variables', () => {
    const env = validateEnv(minimal({ PORT: '8080', SOMETHING_ELSE: 'kept' }));
    expect(env.PORT).toBe(8080);
    expect((env as Record<string, unknown>)['SOMETHING_ELSE']).toBe('kept');
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => validateEnv(minimal({ JWT_SECRET: 'short' })))
      .toThrow('JWT_SECRET must be at least 32 characters.');
  });

  it('requires DATABASE_URL', () => {
    expect(() => validateEnv({ JWT_SECRET: SECRET })).toThrow(/DATABASE_URL/);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => validateEnv(minimal({ NODE_ENV: 'staging' }))).toThrow(/NODE_ENV/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => validateEnv(minimal({ PORT: '70000' }))).toThrow(/PORT/);
  });

  describe('production', () => {
    const prod = (o: Record<string, unknown> = {}) => minimal({
      NODE_ENV: 'production', RESEND_API_KEY: 're_test', EMAIL_FROM: 'ROF <info@rof.rw>',
      APP_URL: 'https://app.rof.rw', CORS_ORIGINS: 'https://app.rof.rw', ...o,
    });

    it('requires the Resend key, a sender, APP_URL and CORS_ORIGINS', () => {
      let message = '';
      try {
        validateEnv(minimal({ NODE_ENV: 'production' }));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('RESEND_API_KEY is required in production');
      expect(message).toContain('EMAIL_FROM is required in production');
      expect(message).toContain('APP_URL is required in production');
      expect(message).toContain('CORS_ORIGINS is required in production');
    });

    it.each(['RESEND_API_KEY', 'EMAIL_FROM', 'APP_URL', 'CORS_ORIGINS'])('fails without %s', (key) => {
      expect(() => validateEnv(prod({ [key]: undefined }))).toThrow(new RegExp(key));
    });

    it('passes with a complete configuration', () => {
      expect(() => validateEnv(prod())).not.toThrow();
    });
  });

  describe('e-mail', () => {
    it('treats empty values as not set', () => {
      expect(() => validateEnv(minimal({ RESEND_API_KEY: '', EMAIL_REPLY_TO: '', EMAIL_REDIRECT_TO: ' ' }))).not.toThrow();
      expect(() => validateEnv(minimal({ NODE_ENV: 'production', RESEND_API_KEY: '', EMAIL_FROM: 'x <a@b.rw>', APP_URL: 'https://a.rw', CORS_ORIGINS: 'https://a.rw' })))
        .toThrow(/RESEND_API_KEY is required/);
    });

    it('rejects an invalid reply-to or redirect address', () => {
      expect(() => validateEnv(minimal({ EMAIL_REPLY_TO: 'not-an-address' }))).toThrow(/EMAIL_REPLY_TO/);
      expect(() => validateEnv(minimal({ EMAIL_REDIRECT_TO: 'nope' }))).toThrow(/EMAIL_REDIRECT_TO/);
    });
  });

  describe('storage', () => {
    it('requires S3_BUCKET for the s3 driver', () => {
      expect(() => validateEnv(minimal({ STORAGE_DRIVER: 's3' })))
        .toThrow('S3_BUCKET is required when STORAGE_DRIVER=s3.');
    });

    it('accepts the s3 driver with a bucket and parses S3_FORCE_PATH_STYLE', () => {
      const env = validateEnv(minimal({ STORAGE_DRIVER: 's3', S3_BUCKET: 'rof', S3_FORCE_PATH_STYLE: 'true' }));
      expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    });

    it('rejects an unknown driver', () => {
      expect(() => validateEnv(minimal({ STORAGE_DRIVER: 'ftp' }))).toThrow(/STORAGE_DRIVER/);
    });
  });
});
