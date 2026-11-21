/** COACH_APPLICATION bulk actions — the selection (2026-11-20; validated by the generic routes). */
import { OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID, ValidateIf, ValidateNested } from 'class-validator';

import { DECISION_MAX_IDS } from '../../bulk/bulk-decisions.js';
import { ListMentorRequestsDto } from '../dto/create-mentor-request.dto.js';

/** The filter of GET /mentor-requests (status), without paging. */
export class CoachApplicationBulkFilterDto extends OmitType(ListMentorRequestsDto, ['page', 'limit'] as const) {}

/** `{ mode: 'ids', ids }` (≤ 1000 applications) or `{ mode: 'filter', filter }` (every application matching, ≤ 10 000). */
export class CoachApplicationBulkSelectionDto {
  @IsIn(['ids', 'filter']) mode: 'ids' | 'filter';

  @ValidateIf((o: CoachApplicationBulkSelectionDto) => o.mode === 'ids')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(DECISION_MAX_IDS) @IsUUID('all', { each: true })
  ids?: string[];

  @ValidateIf((o: CoachApplicationBulkSelectionDto) => o.mode === 'filter')
  @ValidateNested() @Type(() => CoachApplicationBulkFilterDto)
  filter?: CoachApplicationBulkFilterDto;
}
