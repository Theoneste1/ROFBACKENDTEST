/**
 * Super Admin operator commands (plan §8.2; P1-08). Used ONLY by the CLI
 * (src/super-admin/cli.ts → dist/super-admin/cli.js) — there is no HTTP endpoint, and neither command is
 * run by any deployment. Production use needs separate, recorded approval
 * (docs/operations/super-admin.md).
 *
 *  - bootstrap: the very first Super Admin. Refuses while any active
 *    SUPER_ADMIN exists. The target must be an existing, active, activated
 *    ADMIN; the operator re-types the username and gives a reason.
 *  - breakGlass (AS1), with a reason AND an approval reference:
 *      (a) reset-credentials — an existing SUPER_ADMIN gets a new one-time
 *          password (returned once to the operator) and all sessions end;
 *      (b) promote-admin — only while NO active SUPER_ADMIN exists, one named,
 *          existing, active ADMIN becomes SUPER_ADMIN.
 *
 * Each change, its session revocation and its audit row (with before/after
 * values, never secrets) commit in ONE transaction. Every active Super Admin is
 * e-mailed afterwards (a failed e-mail never undoes the change).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { AuditService } from '../audit/audit.service.js';
import { BCRYPT_COST } from '../auth/auth.service.js';
import { TokenService } from '../auth/token.service.js';
import { AppError } from '../common/errors/app-error.js';
import { AccountEmailsService } from '../notifications/account-emails.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface BootstrapInput { username: string; confirmUsername: string; reason: string }
export interface BreakGlassInput {
  mode:         'reset-credentials' | 'promote-admin';
  username:     string;
  reason:       string;
  approvalRef:  string;
  operatorNote?: string;
}

const refuse = (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message);
const required = (value: string | undefined, name: string) => {
  if (!value || value.trim().length < 3) throw refuse('OPERATOR_INPUT_REQUIRED', `${name} is required.`);
  return value.trim();
};

@Injectable()
export class SuperAdminOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly accountEmails: AccountEmailsService,
  ) {}

  async bootstrap(input: BootstrapInput): Promise<{ userId: string }> {
    const reason = required(input.reason, '--reason');
    if (!input.username || input.username !== input.confirmUsername) {
      throw refuse('CONFIRMATION_MISMATCH', '--confirm-username must repeat the target username exactly.');
    }
    const target = await this.requireActiveAdmin(input.username);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
      if (existing > 0) throw refuse('SUPER_ADMIN_EXISTS', 'An active Super Administrator already exists; bootstrap refused.');
      await tx.user.update({ where: { id: target.id }, data: { role: 'SUPER_ADMIN' } });
      await this.tokens.revokeAllForUser(target.id, tx);
      await this.audit.log({
        actorId: null, actorRole: 'OPERATOR', action: 'SUPER_ADMIN_BOOTSTRAP', entity: 'User', entityId: target.id,
        metadata: { reason, before: { role: 'ADMIN' }, after: { role: 'SUPER_ADMIN' } },
      }, tx);
    });
    await this.accountEmails.superAdminChanged({ action: 'Super Administrator bootstrap', targetUsername: target.username, actorUsername: null, reason });
    return { userId: target.id };
  }

  async breakGlass(input: BreakGlassInput): Promise<{ userId: string; temporaryPassword?: string }> {
    const reason = required(input.reason, '--reason');
    const approvalRef = required(input.approvalRef, '--approval-ref');
    const note = input.operatorNote?.trim() || null;

    if (input.mode === 'reset-credentials') {
      const target = await this.prisma.user.findUnique({ where: { username: input.username }, select: { id: true, username: true, role: true, isActive: true } });
      if (!target || target.role !== 'SUPER_ADMIN') throw refuse('NOT_A_SUPER_ADMIN', 'reset-credentials only applies to an existing Super Administrator.');
      const temporaryPassword = randomBytes(18).toString('base64url');
      const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: target.id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
        await this.tokens.revokeAllForUser(target.id, tx);
        await this.audit.log({
          actorId: null, actorRole: 'OPERATOR', action: 'SUPER_ADMIN_BREAK_GLASS', entity: 'User', entityId: target.id,
          metadata: { mode: input.mode, reason, approvalRef, operatorNote: note,
            before: { role: target.role, isActive: target.isActive }, after: { credentialsReset: true, sessionsEnded: true } },
        }, tx);
      });
      await this.accountEmails.superAdminChanged({ action: 'Break-glass credential reset', targetUsername: target.username, actorUsername: null, reason });
      return { userId: target.id, temporaryPassword };
    }

    if (input.mode === 'promote-admin') {
      const target = await this.requireActiveAdmin(input.username);
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
        if (existing > 0) throw refuse('SUPER_ADMIN_EXISTS', 'An active Super Administrator exists; promote-admin is only for when none does.');
        await tx.user.update({ where: { id: target.id }, data: { role: 'SUPER_ADMIN' } });
        await this.tokens.revokeAllForUser(target.id, tx);
        await this.audit.log({
          actorId: null, actorRole: 'OPERATOR', action: 'SUPER_ADMIN_BREAK_GLASS', entity: 'User', entityId: target.id,
          metadata: { mode: input.mode, reason, approvalRef, operatorNote: note, before: { role: 'ADMIN' }, after: { role: 'SUPER_ADMIN' } },
        }, tx);
      });
      await this.accountEmails.superAdminChanged({ action: 'Break-glass promotion to Super Administrator', targetUsername: target.username, actorUsername: null, reason });
      return { userId: target.id };
    }

    throw refuse('OPERATOR_INPUT_REQUIRED', 'Unknown break-glass mode.');
  }

  private async requireActiveAdmin(username: string) {
    const target = await this.prisma.user.findUnique({
      where: { username }, select: { id: true, username: true, role: true, isActive: true, activatedAt: true },
    });
    if (!target || target.role !== 'ADMIN' || !target.isActive || !target.activatedAt) {
      throw refuse('NOT_AN_ACTIVE_ADMIN', 'The target must be an existing, active, activated Administrator.');
    }
    return target;
  }
}
