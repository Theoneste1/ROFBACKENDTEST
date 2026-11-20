/** ASSIGNMENT bulk actions — the selection (2026-11-20; validated by the generic routes). */
import { OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID, ValidateIf, ValidateNested } from 'class-validator';

import { DECISION_MAX_IDS } from '../../bulk/bulk-decisions.js';
import { ListAssignmentsDto } from '../dto/create-assignment.dto.js';

/** The filters of GET /assignments (same names, rules and meaning), without paging. */
export class AssignmentBulkFilterDto extends OmitType(ListAssignmentsDto, ['page', 'limit'] as const) {}

/** `{ mode: 'ids', ids }` (≤ 1000 assignments) or `{ mode: 'filter', filter }` (every assignment matching, ≤ 10 000). */
export class AssignmentBulkSelectionDto {
  @IsIn(['ids', 'filter']) mode: 'ids' | 'filter';

  @ValidateIf((o: AssignmentBulkSelectionDto) => o.mode === 'ids')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(DECISION_MAX_IDS) @IsUUID('all', { each: true })
  ids?: string[];

  @ValidateIf((o: AssignmentBulkSelectionDto) => o.mode === 'filter')
  @ValidateNested() @Type(() => AssignmentBulkFilterDto)
  filter?: AssignmentBulkFilterDto;
}
