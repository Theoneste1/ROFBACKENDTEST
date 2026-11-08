/**
 * Environment validation.
 *
 * Runs once at startup (ConfigModule `validate` hook). The application refuses
 * to boot when a required variable is missing or unsafe, instead of failing
 * later at request time.
 */
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/** An empty value (`KEY=` in .env) means "not set". */
const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Trims a value and removes quotes wrapped around all of it. Hosting
 * dashboards (Render, …) keep quotes literally, unlike .env files, so a value
 * pasted from .env as `"Name <a@b.org>"` would otherwise be sent with them.
 */
const unquoted = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  let v = value.trim();
  while (/^(["'“‘]).*(["'”’])$/s.test(v) && v.length >= 2) v = v.slice(1, -1).trim();
  return v === '' ? undefined : v;
};

/** "Name <address@domain>" or "address@domain" — what Resend accepts as a sender. */
export const SENDER_FORMAT = /^(?:[^<>"\r\n]+\s<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

export enum NodeEnv {
  Development = 'development',
  Test        = 'test',
  Production  = 'production',
}

export enum StorageDriverName {
  Local = 'local',
  S3    = 's3',
}

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  DATABASE_URL: string;

  /** HMAC secret for access tokens. At least 32 characters. */
  @IsString()
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters.' })
  JWT_SECRET: string;

  /** Access-token lifetime in seconds (default 15 minutes). */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL_SECONDS = 900;

  /** Refresh-token lifetime in days (default 30). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  REFRESH_TOKEN_TTL_DAYS = 30;

  /** Comma-separated list of browser origins allowed by CORS. */
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** Public URL of the frontend; used to build links in e-mails. */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  APP_URL?: string;

  /** IANA time zone for wall-clock dates (report and audit-log date filters). Default Africa/Kigali. */
  @IsOptional()
  @IsTimeZone()
  APP_TIMEZONE?: string;

  // ── Storage ────────────────────────────────────────────────────────────────
  @IsEnum(StorageDriverName)
  STORAGE_DRIVER: StorageDriverName = StorageDriverName.Local;

  @IsOptional()
  @IsString()
  UPLOAD_DIR?: string;

  @IsOptional() @IsString() S3_BUCKET?: string;
  @IsOptional() @IsString() S3_REGION?: string;
  @IsOptional() @IsString() S3_ENDPOINT?: string;
  @IsOptional() @IsString() S3_ACCESS_KEY_ID?: string;
  @IsOptional() @IsString() S3_SECRET_ACCESS_KEY?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  S3_FORCE_PATH_STYLE?: boolean;

  // ── E-mail ─────────────────────────────────────────────────────────────────
  // Delivered through Resend (https://resend.com). See docs/EMAIL.md.
  /** Resend API key ("re_…"). Without it e-mails are only logged (dry run, not allowed in production). */
  @IsOptional() @Transform(unquoted) @IsString() RESEND_API_KEY?: string;
  /** Sender, e.g. "Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>". Its domain must be verified in Resend. */
  @IsOptional() @Transform(unquoted) @IsString()
  @Matches(SENDER_FORMAT, { message: 'EMAIL_FROM must look like "Name <address@domain>" or "address@domain" (e.g. Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>).' })
  EMAIL_FROM?: string;
  /** Address replies go to (defaults to the EMAIL_FROM address). */
  @IsOptional() @Transform(unquoted) @IsEmail() EMAIL_REPLY_TO?: string;
  /** Testing safeguard: deliver EVERY e-mail to this address instead of the real recipient. */
  @IsOptional() @Transform(unquoted) @IsEmail() EMAIL_REDIRECT_TO?: string;
  @IsOptional() @Type(() => Number) @IsInt() EMAIL_BATCH_SIZE?: number;
  /** Most e-mails sent per second (Resend's default account limit is 2). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) EMAIL_MAX_PER_SECOND?: number;

  /** Proxy hops in front of the API (default 1); "false" when clients connect directly. */
  @IsOptional()
  @IsString()
  TRUST_PROXY?: string;

  /** Largest accepted request body in MB (uploads); default 100. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1024)
  MAX_UPLOAD_REQUEST_MB?: number;

  /** Set to "false" to stop the in-process background workers on this instance. */
  @IsOptional()
  @IsString()
  WORKERS_ENABLED?: string;

  // ── Rate limiting ──────────────────────────────────────────────────────────
  @Type(() => Number)
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT = 120;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  THROTTLE_TTL_SECONDS = 60;
}

export function validateEnv(config: Record<string, unknown>) {
  const env = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
    exposeDefaultValues:      true,
  });

  const errors = validateSync(env, { skipMissingProperties: false });
  const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));

  if (env.NODE_ENV === NodeEnv.Production) {
    if (!env.RESEND_API_KEY) {
      messages.push('RESEND_API_KEY is required in production (e-mail would otherwise be silently dropped).');
    }
    if (!env.EMAIL_FROM) {
      messages.push('EMAIL_FROM is required in production (a sender on a domain verified in Resend).');
    }
    if (!env.APP_URL) {
      messages.push('APP_URL is required in production (password-reset and activation links point to it).');
    }
    if (!env.CORS_ORIGINS) {
      messages.push('CORS_ORIGINS is required in production.');
    }
  }
  if (env.STORAGE_DRIVER === StorageDriverName.S3 && !env.S3_BUCKET) {
    messages.push('S3_BUCKET is required when STORAGE_DRIVER=s3.');
  }

  if (messages.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${messages.join('\n  - ')}`);
  }

  // Return the original record merged with typed defaults so ConfigService
  // still exposes every variable (including ones this class doesn't declare).
  return { ...config, ...env };
}
