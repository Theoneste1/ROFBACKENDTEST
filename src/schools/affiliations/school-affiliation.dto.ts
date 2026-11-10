import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsISO31661Alpha2, IsOptional, IsString, IsUUID, Length } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { SchoolAffiliationStatus } from '../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** GET /admin/school-affiliations */
export class ListAffiliationsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(SchoolAffiliationStatus) status?: SchoolAffiliationStatus;
  @IsOptional() @IsUUID() schoolId?: string;
  @IsOptional() @IsUUID() studentId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2()
  country?: string;

  /** Current claims only (default true); false includes superseded history. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  current?: boolean;
}

/** POST …/verify — an optional internal note. */
export class VerifyAffiliationDto {
  @IsOptional()
  @IsString()
  @Length(3, 500)
  @Transform(trim)
  note?: string;
}

/** POST …/reject and …/revoke — the reason is required and shown to the student. */
export class AffiliationReasonDto {
  @IsString()
  @Length(3, 500)
  @Transform(trim)
  reason: string;
}
