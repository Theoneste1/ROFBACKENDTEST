import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';

import { PickType } from '@nestjs/swagger';

import { PaginationQueryDto } from '../../common/pagination.js';
import { InviteUserDto } from '../../users/dto/invite-user.dto.js';

/** PUT /admin/programmes/:id/heads — the complete list of Head Coaches heading the programme. */
export class SetProgrammeHeadsDto {
  /** Users with the HEAD_COACH role. An empty list removes every head. */
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds: string[];
}

/** POST /admin/programmes/:id/members */
export class AddProgrammeMemberDto {
  /** A STUDENT (Head Coach or Administrator) or a Coach (Administrator only). */
  @IsUUID()
  userId: string;
}

/** POST /admin/programmes/:id/coach-invitations — a Coach (MENTOR) invited into the programme. */
export class InviteCoachDto extends PickType(InviteUserDto, ['firstName', 'lastName', 'email', 'username'] as const) {}

export const MEMBER_ROLES = ['STUDENT', 'MENTOR'] as const;

/** GET /admin/programmes/:id/members */
export class ListProgrammeMembersDto extends PaginationQueryDto {
  /** STUDENT or MENTOR (Coach). Default: both. */
  @IsOptional()
  @IsIn(MEMBER_ROLES)
  role?: (typeof MEMBER_ROLES)[number];

  /** Membership state. Default: active memberships only. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;
}
