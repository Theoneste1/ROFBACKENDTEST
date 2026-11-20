/** SCHOOL_AFFILIATION bulk actions — the selection (2026-11-20; validated by the generic routes). */
import { OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID, ValidateIf, ValidateNested } from 'class-validator';

import { DECISION_MAX_IDS } from '../../../bulk/bulk-decisions.js';
import { ListAffiliationsDto } from '../school-affiliation.dto.js';

/** The filters of GET /admin/school-affiliations (same names, rules and meaning; JSON booleans), without paging. */
export class AffiliationBulkFilterDto extends OmitType(ListAffiliationsDto, ['page', 'limit'] as const) {}

/** `{ mode: 'ids', ids }` (≤ 1000 claims) or `{ mode: 'filter', filter }` (every claim matching, ≤ 10 000). */
export class AffiliationBulkSelectionDto {
  @IsIn(['ids', 'filter']) mode: 'ids' | 'filter';

  @ValidateIf((o: AffiliationBulkSelectionDto) => o.mode === 'ids')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(DECISION_MAX_IDS) @IsUUID('all', { each: true })
  ids?: string[];

  @ValidateIf((o: AffiliationBulkSelectionDto) => o.mode === 'filter')
  @ValidateNested() @Type(() => AffiliationBulkFilterDto)
  filter?: AffiliationBulkFilterDto;
}
