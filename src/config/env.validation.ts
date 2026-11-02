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
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

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
  @IsOptional() @IsString() SMTP_HOST?: string;
  @IsOptional() @Type(() => Number) @IsInt() SMTP_PORT?: number;
  @IsOptional() @IsString() SMTP_SECURE?: string;
  @IsOptional() @IsString() SMTP_USER?: string;
  @IsOptional() @IsString() SMTP_PASS?: string;
  @IsOptional() @IsString() EMAIL_FROM?: string;
  @IsOptional() @Type(() => Number) @IsInt() EMAIL_BATCH_SIZE?: number;

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
    if (!env.SMTP_HOST) {
      messages.push('SMTP_HOST is required in production (e-mail would otherwise be silently dropped).');
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
