import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { LiveSessionProvider, LiveSessionStatus } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { trim } from '../../auth/dto/password.rules.js';
import { DATE_PATTERN, TIME_PATTERN } from '../../common/time/zoned-time.js';

const HTTPS_URL = { protocols: ['https'], require_protocol: true, require_valid_protocol: true };

/**
 * When a session takes place, in either form (not both):
 *   date + startTime + endTime — wall-clock time in APP_TIMEZONE (e.g. Africa/Kigali);
 *   startsAt + endsAt          — ISO 8601 instants.
 */
class SessionTimesDto {
  /** Day of the session, YYYY-MM-DD (programme time zone). */
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'date must be YYYY-MM-DD.' })
  date?: string;

  /** Start time, HH:mm (24-hour, programme time zone). */
  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'startTime must be HH:mm (24-hour).' })
  startTime?: string;

  /** End time, HH:mm (24-hour) on the same day. */
  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'endTime must be HH:mm (24-hour).' })
  endTime?: string;

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;
}

export class CreateLiveSessionDto extends SessionTimesDto {
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

  /** Detected from the link when omitted; must match the link when given. */
  @IsOptional()
  @IsEnum(LiveSessionProvider)
  provider?: LiveSessionProvider;

  /** External meeting link (Zoom, Google Meet, Teams …). https only. */
  @IsUrl(HTTPS_URL, { message: 'meetingUrl must be an https:// link.' })
  @Length(10, 2048)
  meetingUrl: string;
}

export class UpdateLiveSessionDto extends SessionTimesDto {
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

  /**
   * Calendar range: sessions overlapping [from, to]. A plain date (YYYY-MM-DD)
   * means that whole day in the programme time zone. When either is given,
   * `upcoming` is ignored.
   */
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;

  /** Only sessions that have not ended yet (default true). */
  @IsOptional()
  @Transform(({ value }) => (value === 'false' ? false : value === 'true' ? true : value))
  @IsBoolean()
  upcoming?: boolean = true;
}
