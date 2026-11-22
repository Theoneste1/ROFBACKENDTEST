import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * PUT /admin/students/:id/olympiad-level (owner 2026-11-21/22): exactly one of
 *  - `{ divisionId, reason }` — set the student's division (Olympiad level) by hand; it then no longer follows the grade;
 *  - `{ automatic: true, reason }` — return to the division the grade suggests (and follow the grade again).
 */
export class SetOlympiadLevelDto {
  /** An active division. Required unless `automatic` is true; refused with it (400 LEVEL_WITH_AUTOMATIC). */
  @ValidateIf((o: SetOlympiadLevelDto) => o.automatic !== true)
  @IsUUID('all', { message: 'divisionId must be a division id.' })
  divisionId?: string;

  /** true: follow the grade again (the suggested division). */
  @IsOptional() @IsBoolean()
  automatic?: boolean;

  /** Why (3–500 characters): kept in the student's level history. */
  @Transform(trim) @IsString() @Length(3, 500)
  reason: string;
}
