/**
 * Optional profile picture at registration (REG-02, 2026-11-18): the picture is NEVER required — registration,
 * application and activation work without it. A registration answer carries a 30-minute token
 * (common/registration-avatar-token.ts) that allows setting the FIRST picture of exactly that new student account, or
 * of exactly that pending Teacher / Coach application; on approval the application's picture becomes the account's.
 * Files go through the same upload rules as every avatar (type checked from the bytes, size limit, random storage key,
 * no original file name kept). Later changes: My Profile (PUT / DELETE /me/avatar).
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../common/storage/storage.service.js';
import { AppError } from '../common/errors/app-error.js';
import { issueRegistrationAvatarToken, verifyRegistrationAvatarToken, type RegistrationAvatarKind } from '../common/registration-avatar-token.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { avatarUrlOf } from './avatar-url.js';

const invalidToken = () =>
  new AppError(HttpStatus.UNAUTHORIZED, 'REGISTRATION_AVATAR_TOKEN_INVALID',
    'This picture upload is no longer possible (the link expired or is not valid). Add your picture later in My Profile.');
const alreadySet = () =>
  new AppError(HttpStatus.CONFLICT, 'AVATAR_ALREADY_SET', 'A picture was already added. Change it later in My Profile.');

@Injectable()
export class RegistrationAvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    return this.config.getOrThrow<string>('JWT_SECRET');
  }

  /** The token returned with a registration / application (it never blocks or changes the registration itself). */
  /**
   * The picture sent with an application, for the Administrator reviewing it (picture moderation, owner approval
   * 2026-11-18). The caller has already been authorised for that application. 404 when there is none.
   */
  async sendApplicationAvatar(kind: 'TEACHER' | 'COACH', id: string, res: Response) {
    const select = { avatarFile: { select: { storageKey: true, mimeType: true, originalName: true, size: true } } } as const;
    const row = kind === 'TEACHER'
      ? await this.prisma.teacherApplication.findUnique({ where: { id }, select })
      : await this.prisma.mentorRequest.findUnique({ where: { id }, select });
    if (!row?.avatarFile) throw new NotFoundException('This application has no picture.');
    await this.storage.send(res, row.avatarFile, { cacheControl: 'private, no-store' });
  }

  issue(kind: RegistrationAvatarKind, id: string): string {
    return issueRegistrationAvatarToken(this.secret(), kind, id);
  }

  /** PUT /auth/register/avatar: the first picture of the new account or pending application. */
  async upload(token: unknown, file: Express.Multer.File | undefined) {
    const t = verifyRegistrationAvatarToken(this.secret(), token);
    if (!t) throw invalidToken();
    if (!file?.buffer?.length) throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Upload an image in the "file" field.');

    // A new account (a student, or a teacher who registered with a listed school): the picture is the account's.
    if (t.kind === 'STUDENT' || t.kind === 'TEACHER') {
      const u = await this.prisma.user.findUnique({ where: { id: t.id }, select: { id: true, role: true, avatarFileId: true } });
      if (!u || u.role !== t.kind) throw new NotFoundException('Account not found.');
      if (u.avatarFileId) throw alreadySet();
      const stored = await this.storage.store({ ...file, originalname: '' }, 'AVATAR', u.id);
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.user.updateMany({ where: { id: u.id, avatarFileId: null }, data: { avatarFileId: stored.id, avatarUrl: avatarUrlOf(u.id, stored.id) } });
        if (count === 0) throw alreadySet();   // a concurrent upload won; this file stays an orphan (nightly cleanup)
        await this.audit.log({ actorId: u.id, actorRole: u.role, action: 'AVATAR_SET', entity: 'User', entityId: u.id, metadata: { fileId: stored.id, previousFileId: null, at: 'registration' } }, tx);
      });
      return { avatar: true as const };
    }

    const teacher = t.kind === 'TEACHER_APPLICATION';
    const app = teacher
      ? await this.prisma.teacherApplication.findUnique({ where: { id: t.id }, select: { status: true, avatarFileId: true } })
      : await this.prisma.mentorRequest.findUnique({ where: { id: t.id }, select: { status: true, avatarFileId: true } });
    if (!app) throw new NotFoundException('Application not found.');
    if (app.status !== 'PENDING') throw invalidToken();
    if (app.avatarFileId) throw alreadySet();
    const stored = await this.storage.store({ ...file, originalname: '' }, 'AVATAR', null);
    await this.prisma.$transaction(async (tx) => {
      const where = { id: t.id, status: 'PENDING' as const, avatarFileId: null };
      const { count } = teacher
        ? await tx.teacherApplication.updateMany({ where, data: { avatarFileId: stored.id } })
        : await tx.mentorRequest.updateMany({ where, data: { avatarFileId: stored.id } });
      if (count === 0) throw alreadySet();
      await this.audit.log({
        actorId: null, actorRole: 'ANONYMOUS', action: 'APPLICATION_AVATAR_SET',
        entity: teacher ? 'TeacherApplication' : 'MentorRequest', entityId: t.id, metadata: { fileId: stored.id },
      }, tx);
    });
    return { avatar: true as const };
  }
}

/** On approval, inside its transaction: the application's picture (if any) becomes the new account's. */
export async function carryApplicationAvatar(tx: Prisma.TransactionClient, userId: string, avatarFileId: string | null | undefined) {
  if (!avatarFileId) return;
  await tx.user.update({ where: { id: userId }, data: { avatarFileId, avatarUrl: avatarUrlOf(userId, avatarFileId) } });
}
