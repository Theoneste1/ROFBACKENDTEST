/**
 * Generic bulk routes — request shapes (2026-11-19; capability bulkOperationsGeneric). The outer shape is the same for
 * every record type; `selection` and `params` are then validated with the record type's own DTOs (for USER exactly
 * those of /admin/users/bulk), so the generic routes accept nothing the type-specific ones would refuse.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Min,
  ValidateIf, ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../common/pagination.js';
import { BulkItemOutcome, BulkOperationStatus } from '../generated/prisma/client.js';

/** The largest ids selection any record type accepts (each type may accept fewer). */
const MAX_IDS_ANY = 1000;

export class GenericBulkSelectionDto {
  @IsIn(['ids', 'filter']) mode: 'ids' | 'filter';

  /** mode 'ids': the records chosen one by one (or the current page). */
  @ValidateIf((o: GenericBulkSelectionDto) => o.mode === 'ids')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_IDS_ANY) @IsUUID('all', { each: true })
  ids?: string[];

  /** mode 'filter': the record type's list filters (same names and meaning as its list endpoint). */
  @ValidateIf((o: GenericBulkSelectionDto) => o.mode === 'filter')
  @IsObject()
  filter?: Record<string, unknown>;
}

export class GenericBulkPreviewDto {
  /** One of the record type's actions (GET /admin/bulk/actions). */
  @IsString() @Length(1, 64) action: string;

  /** The action's parameters (validated with the record type's parameter rules). */
  @IsOptional() @IsObject()
  params?: Record<string, unknown>;

  @ValidateNested() @Type(() => GenericBulkSelectionDto)
  selection: GenericBulkSelectionDto;
}

export class GenericBulkExecuteDto extends GenericBulkPreviewDto {
  /** The confirmation from the preview (opaque; 15 minutes; bound to you, the action, its parameters and the exact records). */
  @IsString() @Length(10, 200) selectionToken: string;
  /** The total the administrator confirmed (secondary check). */
  @IsInt() @Min(0) expectedTotal: number;
  /** Must be true: the administrator confirmed the action. */
  @IsBoolean() confirm: boolean;
  /** The same key returns the same operation; nothing is done twice. */
  @IsString() @Length(8, 128) idempotencyKey: string;
  /** Required (3–500 characters) when the action's requiresReason is true. */
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
  /** Required when the preview said requiresStepUp (checked, never stored). */
  @IsOptional() @IsString() @Length(1, 200) currentPassword?: string;
}

export class GenericBulkExportDto {
  @ValidateNested() @Type(() => GenericBulkSelectionDto)
  selection: GenericBulkSelectionDto;
}

export class EntityTypeParam {
  /** A record type (GET /admin/bulk/actions), e.g. USER. */
  @Matches(/^[A-Z][A-Z_]{0,39}$/) entityType: string;
}

export class GenericListBulkOperationsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(BulkOperationStatus) status?: BulkOperationStatus;
  @IsOptional() @Matches(/^[A-Z][A-Z_]{0,39}$/) entityType?: string;
}

export class GenericListBulkItemsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(BulkItemOutcome) outcome?: BulkItemOutcome;
}
