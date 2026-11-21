import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, Length, ValidateIf } from 'class-validator';

import { OlympiadLevel } from '../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * PUT /admin/students/:id/olympiad-level (owner 2026-11-21): exactly one of
 *  - `{ level, reason }` — set the level by hand (it then no longer follows the grade);
 *  - `{ automatic: true, reason }` — return to the level the grade suggests (and follow the grade again).
 */
export class SetOlympiadLevelDto {
  /** JUNIOR, MIDDLE or SENIOR. Required unless `automatic` is true; refused with it. */
  @ValidateIf((o: SetOlympiadLevelDto) => o.automatic !== true)
  @IsEnum(OlympiadLevel, { message: 'level must be one of JUNIOR, MIDDLE, SENIOR.' })
  level?: OlympiadLevel;

  /** true: follow the grade again (the suggested level). Never together with a level (400 LEVEL_WITH_AUTOMATIC). */
  @IsOptional() @IsBoolean()
  automatic?: boolean;

  /** Why (3–500 characters): kept in the student's level history. */
  @Transform(trim) @IsString() @Length(3, 500)
  reason: string;
}
