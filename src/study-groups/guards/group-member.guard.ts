import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * GroupMemberGuard
 *
 * Ensures the authenticated caller is an **active member** of the study group
 * identified by the `:groupId` route parameter.
 *
 * ADMIN always passes (they manage groups, not participate as members).
 *
 * IMPORTANT: This guard runs after the global JwtAuthGuard and RolesGuard; it
 * adds the membership check on top of them.
 *
 * Authorization chain for member-only content:
 *   @UseGuards(GroupMemberGuard)
 *
 * This guard reads `StudyGroupMember.groupRole` only to let the handler
 * know the user's in-group role.  It never elevates or changes global Role.
 */
@Injectable()
export class GroupMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user    = request.user;

    if (!user) return false;

    // ADMINs pass unconditionally — they manage groups.
    if (user.role === 'ADMIN') return true;

    const groupId: string | undefined = request.params?.groupId ?? request.params?.id;
    if (!groupId) return false;

    const group = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
    });
    if (!group) throw new NotFoundException('Study group not found.');
    if (!group.isActive) throw new ForbiddenException('This study group is not active.');

    const membership = await this.prisma.studyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId: user.id } },
    });

    if (!membership || membership.removedAt !== null) {
      throw new ForbiddenException('You are not a member of this study group.');
    }

    // Attach the group-scoped role to the request for optional handler use.
    // This does NOT change the user's global role.
    request.groupMembership = {
      groupId,
      groupRole: membership.groupRole,
    };

    return true;
  }
}
