import { IsEnum, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { ReportReason, ReportStatus, ThreadStatus } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { trim } from '../../auth/dto/password.rules.js';

export class CreateThreadDto {
  @IsString()
  @Length(3, 200)
  @Transform(trim)
  title: string;

  /** The opening message. */
  @IsString()
  @Length(1, 5000)
  @Transform(trim)
  content: string;

  /** Course threads posted by mentors/admins: which division. Ignored for students. */
  @IsOptional()
  @IsUUID()
  divisionId?: string;
}

export class UpdateThreadDto {
  @IsString()
  @Length(3, 200)
  @Transform(trim)
  title: string;
}

export class ListThreadsDto extends PaginationQueryDto {
  /** Course threads: which division (students: always their own). */
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsEnum(ThreadStatus) status?: ThreadStatus;
}

export class ReportContentDto {
  @IsEnum(ReportReason)
  reason: ReportReason;

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  @Transform(trim)
  details?: string;
}

export class ListReportsDto extends PaginationQueryDto {
  /** Default OPEN. */
  @IsOptional() @IsEnum(ReportStatus) status?: ReportStatus;
}

export class ResolveReportDto {
  /** HIDE the item, DELETE a comment, LOCK a thread, or NONE to dismiss the report. */
  @IsIn(['HIDE', 'DELETE', 'LOCK', 'NONE'])
  action: 'HIDE' | 'DELETE' | 'LOCK' | 'NONE';

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  @Transform(trim)
  note?: string;
}

export class ModerationReasonDto {
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  @Transform(trim)
  reason?: string;
}
