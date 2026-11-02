import { IsEnum, IsUUID } from 'class-validator';
import { GroupRole } from '../../generated/prisma/client.js';

export class AddMemberDto {
  @IsUUID()
  userId: string;

  /**
   * Role within this group only.
   * MENTOR here means "group facilitator" — it does NOT grant global Mentor
   * privileges.  The user's global role (User.role) is unaffected.
   */
  @IsEnum(GroupRole)
  groupRole: GroupRole;
}
