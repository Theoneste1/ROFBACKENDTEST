import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { LiveSessionProvider, LiveSessionStatus } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { trim } from '../../auth/dto/password.rules.js';

const HTTPS_URL = { protocols: ['https'], require_protocol: true, require_valid_protocol: true };

export class CreateLiveSessionDto {
  @IsUUID()
  courseId: string;

  @IsUUID()
  divisionId: string;

  @IsString()
  @Length(3, 200)
  @Transform(trim)
  title: string;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  @Transform(trim)
  description?: string;

  @IsISO8601()
  startsAt: string;

  @IsISO8601()
  endsAt: string;

  @IsOptional()
  @IsEnum(LiveSessionProvider)
  provider?: LiveSessionProvider;

  /** External meeting link (Zoom, Google Meet, Teams …). https only. */
  @IsUrl(HTTPS_URL, { message: 'meetingUrl must be an https:// link.' })
  @Length(10, 2048)
  meetingUrl: string;
}

export class UpdateLiveSessionDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  @Transform(trim)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  @Transform(trim)
  description?: string;

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @IsOptional()
  @IsEnum(LiveSessionProvider)
  provider?: LiveSessionProvider;

  @IsOptional()
  @IsUrl(HTTPS_URL, { message: 'meetingUrl must be an https:// link.' })
  @Length(10, 2048)
  meetingUrl?: string;
}

export class CancelLiveSessionDto {
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  @Transform(trim)
  reason?: string;
}

export class ListLiveSessionsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() courseId?: string;
  /** Mentors/admins only. */
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsEnum(LiveSessionStatus) status?: LiveSessionStatus;

  /** Only sessions that have not ended yet (default true). */
  @IsOptional()
  @Transform(({ value }) => (value === 'false' ? false : value === 'true' ? true : value))
  @IsBoolean()
  upcoming?: boolean = true;
}
