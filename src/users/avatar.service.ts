/**
 * Profile pictures (capability `profilePictures`).
 *
 *  - A user sets, replaces or removes their OWN picture (PUT / DELETE /api/v1/me/avatar).
 *  - An Administrator with users.manage does the same for an account whose current role they may
 *    manage (PUT / DELETE /api/v1/admin/users/:id/avatar; RoleAssignmentPolicy.assertCanManage, so an
 *    ADMIN never touches a SUPER_ADMIN).
 *  - Any signed-in user may view a picture (GET /api/v1/users/:id/avatar): pictures already appear next to
 *    names in the leaderboard and discussions. No anonymous access.
 *
 * Files go through the existing StorageService (FilePurpose AVATAR: JPEG, PNG or WebP by their bytes, at most
 * 2 MB). The account references its current picture (User.avatarFileId), which keeps it out of the nightly
 * orphan cleanup; a replaced or removed picture loses the reference and is cleaned like any other orphan.
 * User.avatarUrl is the versioned link `/api/v1/users/{id}/avatar?v={fileId}`, so caches never show an old
 * picture. Every change is audited (AVATAR_SET / AVATAR_REMOVED: actor, account and file ids only).
 *
 * Protections for minors: pictures are never public (GET needs a signed-in user); the link and the storage key
 * carry only ids and a random UUID, never a name, username or e-mail; the uploaded file name is discarded.
 */
import { StudentOverviewService } from './student-overview.service.js';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { PROFILE_WITH_STEPS_SELECT, withProfileSteps } from '../auth/auth.service.js';
import { RoleAssignmentPolicy } from '../auth/role-assignment.policy.js';
import type { AuthUser, CallerCtx } from '../common/auth-user.js';
import { PermissionService } from '../auth/permission.service.js';
import { AppError } from '../common/errors/app-error.js';
import { StorageService } from '../common/storage/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

/** The link stored in User.avatarUrl for the picture with this file id. */
import { avatarUrlOf } from './avatar-url.js';
export { avatarUrlOf };

/** Pictures are versioned by their link, so a day of private caching is safe. */
export const AVATAR_CACHE_CONTROL = 'private, max-age=86400';
/** A student's picture is never kept in a browser cache: losing access to the student applies at once. */
export const STUDENT_AVATAR_CACHE_CONTROL = 'private, no-store';

@Injectable()
export class AvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly roles: RoleAssignmentPolicy,
    private readonly users: UsersService,
    private readonly permissions: PermissionService,
    private readonly overview: StudentOverviewService,
  ) {}

  // ─── Own picture (/me) ──────────────────────────────────────────────────────

  async setOwn(caller: CallerCtx, file: Express.Multer.File | undefined) {
    await this.set(caller.id, file, caller);
    return this.profile(caller.id);
  }

  async removeOwn(caller: CallerCtx) {
    await this.remove(caller.id, caller);
    return this.profile(caller.id);
  }

  // ─── Another account's picture (Administrators) ─────────────────────────────

  async setFor(targetId: string, caller: CallerCtx, file: Express.Multer.File | undefined) {
    await this.assertCanManage(targetId, caller);
    await this.set(targetId, file, caller);
    return this.users.findOne(targetId);
  }

  async removeFor(targetId: string, caller: CallerCtx) {
    await this.assertCanManage(targetId, caller);
    await this.remove(targetId, caller);
    return this.users.findOne(targetId);
  }

  // ─── Serve ──────────────────────────────────────────────────────────────────

  /** Stream the account's current picture (404 when it has none). Callers are signed in (controller). */
  /**
   * GET /users/:id/avatar. Staff pictures: every signed-in user (unchanged). A STUDENT's picture (owner 2026-11-22,
   * replacing the 2026-11-18 rule): everyone who may view the student's profile overview — the student, Administrators,
   * other students (active students), the Teachers of the student's school, the Coaches and Head Coaches of the student's
   * programmes or divisions (StudentOverviewService.mayView). Anyone else gets the same 404 as "no picture", so the answer
   * never reveals whether a student has one.
   */
  async send(userId: string, viewer: AuthUser, res: Response) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, avatarFile: { select: { storageKey: true, mimeType: true, originalName: true, size: true } } },
    });
    const notFound = () => new NotFoundException('This account has no profile picture.');
    if (!user?.avatarFile) throw notFound();
    if (user.role !== 'STUDENT') {
      await this.storage.send(res, user.avatarFile, { cacheControl: AVATAR_CACHE_CONTROL });
      return;
    }
    if (!(await this.maySeeStudentPicture(viewer, userId))) throw notFound();
    await this.storage.send(res, user.avatarFile, { cacheControl: STUDENT_AVATAR_CACHE_CONTROL });
  }

  /** Whether this viewer may see this student's picture: whoever may view the student's profile overview (see send). */
  async maySeeStudentPicture(viewer: AuthUser, studentId: string): Promise<boolean> {
    const s = await this.prisma.user.findUnique({ where: { id: studentId }, select: { id: true, accountStatus: true, divisionId: true } });
    return !!s && this.overview.mayView(viewer, s);
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** Store the picture (type and size are checked from its bytes), then point the account at it. */
  private async set(targetId: string, file: Express.Multer.File | undefined, caller: CallerCtx) {
    if (!file?.buffer?.length) {
      // Same code as the other upload endpoints.
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Upload an image in the "file" field.');
    }
    const exists = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!exists) throw new NotFoundException(`User ${targetId} not found.`);

    // Stored before the transaction (as for every upload): if the update below fails, the file is an orphan
    // and the nightly cleanup removes it.
    // The uploaded file name is not kept (it may contain a child's name): the stored name is the generic
    // "file.<ext>" and the storage key is random (StorageService).
    const stored = await this.storage.store({ ...file, originalname: '' }, 'AVATAR', caller.id);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUniqueOrThrow({ where: { id: targetId }, select: { avatarFileId: true } });
      await tx.user.update({
        where: { id: targetId },
        data:  { avatarFileId: stored.id, avatarUrl: avatarUrlOf(targetId, stored.id) },
      });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'AVATAR_SET', entity: 'User', entityId: targetId,
        // Ids only (no names, e-mail or file contents).
        metadata: { fileId: stored.id, previousFileId: before.avatarFileId },
      }, tx);
    });
  }

  /** Clear the account's picture. Idempotent: no picture → nothing to do (and nothing audited). */
  private async remove(targetId: string, caller: CallerCtx) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id: targetId }, select: { avatarFileId: true, avatarUrl: true } });
      if (!before) throw new NotFoundException(`User ${targetId} not found.`);
      if (before.avatarFileId === null && before.avatarUrl === null) return;
      await tx.user.update({ where: { id: targetId }, data: { avatarFileId: null, avatarUrl: null } });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'AVATAR_REMOVED', entity: 'User', entityId: targetId,
        metadata: { fileId: before.avatarFileId },
      }, tx);
    });
  }

  private async assertCanManage(targetId: string, caller: CallerCtx) {
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { role: true } });
    if (!target) throw new NotFoundException(`User ${targetId} not found.`);
    await this.roles.assertCanManage(caller, target.role);
  }

  private async profile(userId: string) {
    // The same shape as GET /me (including dateOfBirthRequired).
    return withProfileSteps(await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PROFILE_WITH_STEPS_SELECT }));
  }
}
