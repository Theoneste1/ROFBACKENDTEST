import { IsEnum } from 'class-validator';
import { GroupRole } from '../../generated/prisma/client.js';

export class UpdateMemberRoleDto {
  @IsEnum(GroupRole)
  groupRole: GroupRole;
}
