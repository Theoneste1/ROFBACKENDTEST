import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateStudyGroupDto } from './dto/create-study-group.dto.js';
import { UpdateStudyGroupDto } from './dto/update-study-group.dto.js';
import { AddMemberDto } from './dto/add-member.dto.js';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto.js';
import type { CallerCtx } from '../submissions/submissions.service.js';

// ─── Shared selects ───────────────────────────────────────────────────────────

const GROUP_SUMMARY = {
  id:          true,
  name:        true,
  description: true,
  tags:        true,
  isActive:    true,
  createdAt:   true,
  updatedAt:   true,
  createdBy: { select: { id: true, username: true, firstName: true, lastName: true } },
  _count: { select: { members: true } },
} as const;

const MEMBER_SELECT = {
  id:        true,
  groupRole: true,
  joinedAt:  true,
  removedAt: true,
  user: {
    select: {
      id:        true,
      username:  true,
      firstName: true,
      lastName:  true,
      email:     true,
      role:      true,           // global role — for information only
      avatarUrl: true,
    },
  },
} as const;

@Injectable()
export class StudyGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ─── ADMIN: Create a study group ──────────────────────────────────────────
  async create(data: CreateStudyGroupDto, caller: CallerCtx) {
    const group = await this.prisma.studyGroup.create({
      data: {
        name:        data.name,
        description: data.description,
        tags:        data.tags ?? null,
        createdById: caller.id,
      },
      select: GROUP_SUMMARY,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'CREATE_STUDY_GROUP',
      entity:    'StudyGroup',
      entityId:  group.id,
      metadata:  { name: group.name },
    });

    return group;
  }

  // ─── ADMIN: Update name / description / tags / isActive ───────────────────
  async update(groupId: string, data: UpdateStudyGroupDto, caller: CallerCtx) {
    await this.requireGroup(groupId);

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update.');
    }

    const updated = await this.prisma.studyGroup.update({
      where:  { id: groupId },
      data:   {
        name:        data.name,
        description: data.description,
        tags:        data.tags,
        isActive:    data.isActive,
      },
      select: GROUP_SUMMARY,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UPDATE_STUDY_GROUP',
      entity:    'StudyGroup',
      entityId:  groupId,
      metadata:  { fields: Object.keys(data) },
    });

    return updated;
  }

  // ─── ADMIN: List all groups ────────────────────────────────────────────────
  async findAll() {
    return this.prisma.studyGroup.findMany({
      orderBy: { createdAt: 'desc' },
      select:  GROUP_SUMMARY,
    });
  }

  // ─── ADMIN / MEMBER: Get single group + active members ────────────────────
  async findOne(groupId: string, caller: CallerCtx) {
    const group = await this.prisma.studyGroup.findUnique({
      where:  { id: groupId },
      select: {
        ...GROUP_SUMMARY,
        members: {
          // Only return active (not soft-removed) members.
          where:   { removedAt: null },
          orderBy: { joinedAt: 'asc' },
          select:  MEMBER_SELECT,
        },
      },
    });

    if (!group) throw new NotFoundException('Study group not found.');

    // Non-admin callers must be active members to view group details.
    if (caller.role !== 'ADMIN') {
      const isMember = group.members.some((m) => m.user.id === caller.id);
      if (!isMember) throw new ForbiddenException('You are not a member of this group.');
    }

    return group;
  }

  // ─── MEMBER: Get own groups ────────────────────────────────────────────────
  async findMyGroups(userId: string) {
    return this.prisma.studyGroup.findMany({
      where: {
        isActive: true,
        members: { some: { userId, removedAt: null } },
      },
      orderBy: { name: 'asc' },
      select: {
        ...GROUP_SUMMARY,
        // Include the caller's own membership details.
        members: {
          where:  { userId, removedAt: null },
          select: { groupRole: true, joinedAt: true },
        },
      },
    });
  }

  // ─── ADMIN: Add a member with a group-scoped role ─────────────────────────
  async addMember(groupId: string, data: AddMemberDto, caller: CallerCtx) {
    await this.requireGroup(groupId);

    // Verify the user exists.
    const user = await this.prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) throw new NotFoundException('User not found.');

    // Prevent adding a global ADMIN as a group member (admins manage groups,
    // they don't participate as members — this keeps authorization clean).
    if (user.role === 'ADMIN') {
      throw new BadRequestException('Global Admins cannot be added as study group members.');
    }

    // Check for an existing membership (active or soft-removed).
    const existing = await this.prisma.studyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId: data.userId } },
    });

    if (existing) {
      if (existing.removedAt === null) {
        throw new BadRequestException('This user is already a member of this group.');
      }
      // Re-activate a previously removed membership.
      const reactivated = await this.prisma.studyGroupMember.update({
        where:  { groupId_userId: { groupId, userId: data.userId } },
        data:   { groupRole: data.groupRole, removedAt: null, removedById: null },
        select: MEMBER_SELECT,
      });

      await this.audit.log({
        actorId:   caller.id,
        actorRole: caller.role,
        action:    'READD_GROUP_MEMBER',
        entity:    'StudyGroupMember',
        entityId:  reactivated.id,
        metadata:  { groupId, userId: data.userId, groupRole: data.groupRole },
      });

      return reactivated;
    }

    const member = await this.prisma.studyGroupMember.create({
      data: {
        groupId,
        userId:    data.userId,
        groupRole: data.groupRole,
      },
      select: MEMBER_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'ADD_GROUP_MEMBER',
      entity:    'StudyGroupMember',
      entityId:  member.id,
      metadata:  {
        groupId,
        userId:        data.userId,
        username:      user.username,
        groupRole:     data.groupRole,
        // Explicitly note that global role is unchanged.
        globalRole:    user.role,
      },
    });

    return member;
  }

  // ─── ADMIN: Update a member's group-scoped role ───────────────────────────
  async updateMemberRole(
    groupId:  string,
    userId:   string,
    data:     UpdateMemberRoleDto,
    caller:   CallerCtx,
  ) {
    const membership = await this.requireActiveMembership(groupId, userId);

    const updated = await this.prisma.studyGroupMember.update({
      where:  { groupId_userId: { groupId, userId } },
      data:   { groupRole: data.groupRole },
      select: MEMBER_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UPDATE_GROUP_MEMBER_ROLE',
      entity:    'StudyGroupMember',
      entityId:  membership.id,
      metadata:  {
        groupId,
        userId,
        previousGroupRole: membership.groupRole,
        newGroupRole:      data.groupRole,
        // Reminder that this is group-scoped only.
        note: 'Group role change — global User.role is not affected.',
      },
    });

    return updated;
  }

  // ─── ADMIN: Soft-remove a member ──────────────────────────────────────────
  async removeMember(groupId: string, userId: string, caller: CallerCtx) {
    const membership = await this.requireActiveMembership(groupId, userId);

    await this.prisma.studyGroupMember.update({
      where: { groupId_userId: { groupId, userId } },
      data:  { removedAt: new Date(), removedById: caller.id },
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'REMOVE_GROUP_MEMBER',
      entity:    'StudyGroupMember',
      entityId:  membership.id,
      metadata:  { groupId, userId, groupRole: membership.groupRole },
    });

    return { message: 'Member removed from group.' };
  }

  // ─── ADMIN: View membership list (includes soft-removed for full history) ──
  async getMembershipHistory(groupId: string) {
    await this.requireGroup(groupId);

    return this.prisma.studyGroupMember.findMany({
      where:   { groupId },
      orderBy: { joinedAt: 'asc' },
      select:  { ...MEMBER_SELECT, removedById: true },
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async requireGroup(id: string) {
    const g = await this.prisma.studyGroup.findUnique({ where: { id } });
    if (!g) throw new NotFoundException('Study group not found.');
    return g;
  }

  private async requireActiveMembership(groupId: string, userId: string) {
    const m = await this.prisma.studyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!m || m.removedAt !== null) {
      throw new NotFoundException('Active membership not found.');
    }
    return m;
  }
}
