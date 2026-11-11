import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { SchoolSyncChangeKind, SchoolSyncDecision, SchoolSyncItemOutcome, SchoolSyncRunStatus } from '../../generated/prisma/client.js';
import { PRINTABLE } from '../dto/admin-school.dto.js';
import { SYNC_DATASET_KEYS } from './sync-datasets.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** POST /admin/school-sync/runs — always a dry run (nothing is written to the directory). */
export class CreateSyncRunQueryDto {
  /** The dataset (trusted server configuration), e.g. NESA:ACCREDITED_SCHOOLS. */
  @IsIn(SYNC_DATASET_KEYS, { message: `dataset must be one of: ${SYNC_DATASET_KEYS.join(', ')}` })
  dataset: string;

  /** A label for this run (default: the dataset name and the file name). */
  @IsOptional() @Transform(trim) @IsString() @Length(3, 200) @Matches(PRINTABLE) label?: string;
}

/** GET /admin/school-sync/runs */
export class ListSyncRunsDto extends PaginationQueryDto {
  @IsOptional() @IsIn(SYNC_DATASET_KEYS) datasetKey?: string;
  @IsOptional() @IsEnum(SchoolSyncRunStatus) status?: SchoolSyncRunStatus;
}

/** GET /admin/school-sync/runs/:id/items */
export class SyncItemsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(SchoolSyncItemOutcome) outcome?: SchoolSyncItemOutcome;
}

/** GET /admin/school-sync/runs/:id/changes */
export class SyncChangesQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(SchoolSyncChangeKind) kind?: SchoolSyncChangeKind;
  @IsOptional() @IsEnum(SchoolSyncDecision) decision?: SchoolSyncDecision;
}
