import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';

const bool = ({ value }: { value: unknown }) => (value === true || value === 'true' || value === '1' ? true : value === false || value === 'false' || value === '0' ? false : value);

/** POST /admin/schools/import */
export class ImportSchoolsQueryDto {
  /** Validate and report only; create nothing. */
  @IsOptional() @Transform(bool) @IsBoolean() dryRun?: boolean;

  /** Import rows that have possible duplicates — requires the reviewToken of the dry run that showed them. */
  @IsOptional() @Transform(bool) @IsBoolean() confirmPossibleDuplicates?: boolean;

  /** From the dry run (or a 409 response): binds the confirmation to this file, these candidates and this Administrator. */
  @IsOptional() @IsString() @Length(1, 2000) reviewToken?: string;
}

/** GET /admin/schools/import-template */
export class ImportTemplateQueryDto {
  /** csv (default) or xlsx. */
  @IsOptional() @IsIn(['csv', 'xlsx']) format?: 'csv' | 'xlsx';
}
