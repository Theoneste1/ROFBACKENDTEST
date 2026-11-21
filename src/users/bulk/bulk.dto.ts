/** Bulk user operations — request shapes (2026-11-17; capability bulkUserOperations). */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min,
  ValidateIf, ValidateNested,
} from 'class-validator';
import { TEACHER_DELEGATIONS } from '../../auth/override-policy.js';

import { AccountStatus, BulkItemOutcome, BulkOperationStatus, GradeLevel, Role } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { BULK_ACTIONS, MAX_IDS, type BulkAction } from './bulk-rules.js';

/** The filters of GET /api/v1/admin/users (same names and meaning; JSON booleans). */
export class BulkFilterDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsEnum(GradeLevel) gradeLevel?: GradeLevel;
  @IsOptional() @IsUUID() schoolId?: string;
  @IsOptional() @IsBoolean() isApproved?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsEnum(AccountStatus) accountStatus?: AccountStatus;
  @IsOptional() @IsBoolean() isActivated?: boolean;
  @IsOptional() @IsString() @Length(1, 100) search?: string;
}

/**
 * Which accounts: `{ mode: 'ids', ids }` — up to 1000 accounts chosen one by one (or the current page) — or
 * `{ mode: 'filter', filter }` — every account matching the filters, across all pages (at most 50 000).
 */
export class BulkSelectionDto {
  @IsIn(['ids', 'filter']) mode: 'ids' | 'filter';

  @ValidateIf((o: BulkSelectionDto) => o.mode === 'ids')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_IDS) @IsUUID('all', { each: true })
  ids?: string[];

  @ValidateIf((o: BulkSelectionDto) => o.mode === 'filter')
  @ValidateNested() @Type(() => BulkFilterDto)
  filter?: BulkFilterDto;
}

/** The action's parameters: assignRole → role; changeClassification → gradeLevel; message → subject and body; setOlympiadLevel → olympiadLevel. */
export class BulkParamsDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(GradeLevel) gradeLevel?: GradeLevel;
  @IsOptional() @IsString() @Length(2, 200) subject?: string;
  @IsOptional() @IsString() @Length(5, 10_000) body?: string;
  /** assignTeacher, unassignTeacher, grantDelegation, revokeDelegation: the Teacher. */
  @IsOptional() @IsUUID() teacherId?: string;
  /** grantDelegation, revokeDelegation: the delegation. */
  @IsOptional() @IsIn(TEACHER_DELEGATIONS as unknown as string[]) permission?: string;
  /** reassignTeacher: the students' current Teacher. */
  @IsOptional() @IsUUID() fromTeacherId?: string;
  /** reassignTeacher: the Teacher the students move to. */
  @IsOptional() @IsUUID() toTeacherId?: string;
  /** setOlympiadLevel: JUNIOR, MIDDLE, SENIOR, or AUTOMATIC (the level the grade suggests). */
  @IsOptional() @IsIn(['JUNIOR', 'MIDDLE', 'SENIOR', 'AUTOMATIC']) olympiadLevel?: 'JUNIOR' | 'MIDDLE' | 'SENIOR' | 'AUTOMATIC';
}

export class BulkPreviewDto {
  @IsIn(BULK_ACTIONS as unknown as string[]) action: BulkAction;

  @IsOptional() @ValidateNested() @Type(() => BulkParamsDto)
  params?: BulkParamsDto;

  @ValidateNested() @Type(() => BulkSelectionDto)
  selection: BulkSelectionDto;
}

export class BulkExecuteDto extends BulkPreviewDto {
  /** From the preview: binds this request to exactly the previewed accounts. */
  @IsString() @Length(10, 200) selectionToken: string;
  /** The total the administrator confirmed (secondary check). */
  @IsInt() @Min(0) expectedTotal: number;
  /** Must be true: the administrator confirmed the action. */
  @IsBoolean() confirm: boolean;
  /** The same key returns the same operation; nothing is done twice. */
  @IsString() @Length(8, 128) idempotencyKey: string;
  /** Required (3–500 characters) for deactivate, suspend, archive and restore. */
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
  /** Required when the action touches Administrator or Super Administrator accounts or roles (checked, never stored). */
  @IsOptional() @IsString() @Length(1, 200) currentPassword?: string;
}

export class BulkExportDto {
  @ValidateNested() @Type(() => BulkSelectionDto)
  selection: BulkSelectionDto;
}

export class ListBulkOperationsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(BulkOperationStatus) status?: BulkOperationStatus;
}

export class ListBulkItemsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(BulkItemOutcome) outcome?: BulkItemOutcome;
}
