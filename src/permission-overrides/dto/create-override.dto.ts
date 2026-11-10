import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateOverrideDto {
  /** A permission name from the catalogue (GET /admin/permissions/catalogue). */
  @IsString()
  @Length(3, 100)
  permission!: string;

  /** GRANT adds a permission (approved list only); DENY removes a default one. */
  @IsIn(['GRANT', 'DENY'])
  effect!: 'GRANT' | 'DENY';

  /** Why the override is needed (kept in the audit trail). */
  @IsString()
  @Length(3, 500)
  @Transform(trim)
  reason!: string;

  /** When it stops applying (ISO 8601, in the future). Omit for no expiry. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  /** GRANT only: the course × division it applies to (must be within the user's existing scope). */
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsUUID()
  divisionId?: string;
}
