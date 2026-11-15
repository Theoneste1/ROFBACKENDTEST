import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';

import { PRINTABLE } from '../../dto/admin-school.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const KINDS = ['CREATE_SCHOOL', 'FILL_EMPTY', 'CHANGE', 'NAME_RESTORE', 'NEW_PLACE', 'ADD_CONTACT', 'ADD_LEVEL', 'ADD_PROGRAMME', 'RESOLVE_CONFLICT'];

export class ChangeDecisionDto {
  @IsUUID() changeId: string;
  /** PENDING withdraws an earlier decision. */
  @IsIn(['APPROVED', 'REJECTED', 'PENDING']) decision: 'APPROVED' | 'REJECTED' | 'PENDING';
}

export class CategoryApprovalDto {
  /** FILL_EMPTY, ADD_LEVEL, ADD_PROGRAMME, CREATE_SCHOOL or NAME_RESTORE. */
  @IsIn(KINDS) kind: string;
  /** From GET …/categories: the digest of exactly the list reviewed. */
  @IsString() @Length(64, 64) listDigest: string;
}

/** POST /admin/school-sync/runs/:id/decisions */
export class SyncDecisionsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => ChangeDecisionDto)
  decisions?: ChangeDecisionDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => CategoryApprovalDto)
  categories?: CategoryApprovalDto[];

  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) @Matches(PRINTABLE) note?: string;
}

/** POST /admin/school-sync/runs/:id/items/:itemId/proposal */
export class ProposeResolutionDto {
  /** LINK: this row is an existing school; CREATE: a new school (before apply only). */
  @IsIn(['LINK', 'CREATE']) action: 'LINK' | 'CREATE';
  /** LINK only: the school (for a possible duplicate, one of its listed candidates). */
  @IsOptional() @IsUUID() schoolId?: string;
  /** An official code the reviewer verified (6 digits; the province's first digit). Before apply only. */
  @IsOptional() @Transform(trim) @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits.' }) code?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) @Matches(PRINTABLE) note?: string;
}

/** POST /admin/school-sync/runs/:id/apply */
export class ApplySyncRunDto {
  /** From POST …/approve. */
  @IsString() @Length(20, 4000) token: string;
}

/** POST /admin/school-sync/runs/:id/items/:itemId/resolve — after apply: link the row to a school. */
export class ResolveAfterApplyDto {
  @IsUUID() schoolId: string;
  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) @Matches(PRINTABLE) note?: string;
}
