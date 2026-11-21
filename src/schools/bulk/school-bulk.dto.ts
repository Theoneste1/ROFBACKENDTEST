/** SCHOOL bulk actions — the selection and parameters (2026-11-20; validated by the generic routes). */
import { OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID, ValidateIf, ValidateNested } from 'class-validator';

import { DECISION_MAX_IDS } from '../../bulk/bulk-decisions.js';
import { ListAdminSchoolsDto } from '../dto/admin-school.dto.js';

/** The filters of GET /admin/schools (same names, rules and meaning; JSON booleans), without paging or sorting. */
export class SchoolBulkFilterDto extends OmitType(ListAdminSchoolsDto, ['page', 'limit', 'sort', 'order'] as const) {}

/** `{ mode: 'ids', ids }` (≤ 1000 schools) or `{ mode: 'filter', filter }` (every school matching, ≤ 10 000). */
export class SchoolBulkSelectionDto {
  @IsIn(['ids', 'filter']) mode: 'ids' | 'filter';

  @ValidateIf((o: SchoolBulkSelectionDto) => o.mode === 'ids')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(DECISION_MAX_IDS) @IsUUID('all', { each: true })
  ids?: string[];

  @ValidateIf((o: SchoolBulkSelectionDto) => o.mode === 'filter')
  @ValidateNested() @Type(() => SchoolBulkFilterDto)
  filter?: SchoolBulkFilterDto;
}
