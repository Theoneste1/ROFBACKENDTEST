/**
 * Super Admin operator commands (plan §8.2; P1-08). Used ONLY by the CLI
 * (src/super-admin/cli.ts → dist/super-admin/cli.js) — there is no HTTP endpoint, and neither command is
 * run by any deployment. Production use needs separate, recorded approval
 * (docs/operations/super-admin.md).
 *
 *  - bootstrap: the very first Super Admin. Refuses while any active
 *    SUPER_ADMIN exists. The target must be an existing, active, activated
 *    ADMIN that is NOT a shared seeded account; the operator re-types the
 *    username and gives a reason.
 *  - bootstrapPreview (--dry-run): what the bootstrap would see and decide, read only.
 *  - breakGlass (AS1), with a reason AND an approval reference:
 *      (a) reset-credentials — an existing SUPER_ADMIN gets a new one-time
 *          password (returned once to the operator) and all sessions end;
 *      (b) promote-admin — only while NO active SUPER_ADMIN exists, one named,
 *          existing, active ADMIN (not a shared seeded account) becomes SUPER_ADMIN.
 *
 * Hardening (owner approval 2026-11-15):
 *  - SHARED_ACCOUNT_REFUSED: the seeded shared account (`admin`, or SEED_ADMIN_USERNAME) is never
 *    promoted, by the bootstrap or by break-glass.
 *  - Both promotions take one transaction-scoped advisory lock (SUPER_ADMIN_PROMOTION_LOCK) before
 *    counting the active Super Admins, so concurrent runs are serialised: the second waits, sees the
 *    first Super Admin and is refused (SUPER_ADMIN_EXISTS). The target is re-read under the lock.
 *
 * Each change, its session revocation and its audit row (with before/after
 * values, never secrets) commit in ONE transaction — a refusal or failure changes nothing. Every
 * active Super Admin is e-mailed afterwards (a failed e-mail never undoes the change).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { AuditService } from '../audit/audit.service.js';
import { BCRYPT_COST } from '../auth/auth.service.js';
import { RoleAssignmentPolicy } from '../auth/role-assignment.policy.js';
import { SUPER_ADMIN_PROMOTION_LOCK } from '../auth/shared-accounts.js';
import { TokenService } from '../auth/token.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
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

/** What `bootstrap --dry-run` reports. Read only: nothing is written, locked or e-mailed. */
export interface BootstrapPreview {
  username:          string;
  found:             boolean;
  name:              string | null;
  role:              string | null;
  isActive:          boolean | null;
  activated:         boolean | null;
  activeSuperAdmins: number;
  /** null when the bootstrap would go ahead; otherwise the refusal code it would return. */
  wouldRefuse:       string | null;
}

/**
 * Refusal codes (all 409, nothing changed):
 *  OPERATOR_INPUT_REQUIRED · CONFIRMATION_MISMATCH · NOT_AN_ACTIVE_ADMIN · SHARED_ACCOUNT_REFUSED ·
 *  SUPER_ADMIN_EXISTS · NOT_A_SUPER_ADMIN (docs/operations/super-admin.md).
 */
const refuse = (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message);
const required = (value: string | undefined, name: string) => {
  if (!value || value.trim().length < 3) throw refuse('OPERATOR_INPUT_REQUIRED', `${name} is required.`);
  return value.trim();
};
const TARGET_SELECT = { id: true, username: true, firstName: true, lastName: true, role: true, isActive: true, activatedAt: true } as const;

@Injectable()
export class SuperAdminOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly accountEmails: AccountEmailsService,
    private readonly roles: RoleAssignmentPolicy,
  ) {}

  /** `bootstrap --dry-run`: the target and the Super Admin count, and the refusal the bootstrap would give. Reads only. */
  async bootstrapPreview(username: string): Promise<BootstrapPreview> {
    const name = (username ?? '').trim();
    const [target, activeSuperAdmins] = await Promise.all([
      name ? this.prisma.user.findUnique({ where: { username: name }, select: TARGET_SELECT }) : Promise.resolve(null),
      this.prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } }),
    ]);
    let wouldRefuse: string | null = null;
    try { this.assertPromotable(target, name); } catch (err) { wouldRefuse = (err as AppError).code; }
    if (!wouldRefuse && activeSuperAdmins > 0) wouldRefuse = 'SUPER_ADMIN_EXISTS';
    return {
      username: name,
      found: !!target,
      name: target ? `${target.firstName} ${target.lastName}`.trim() : null,
      role: target?.role ?? null,
      isActive: target?.isActive ?? null,
      activated: target ? !!target.activatedAt : null,
      activeSuperAdmins,
      wouldRefuse,
    };
  }

  async bootstrap(input: BootstrapInput): Promise<{ userId: string }> {
    const reason = required(input.reason, '--reason');
    if (!input.username || input.username !== input.confirmUsername) {
      throw refuse('CONFIRMATION_MISMATCH', '--confirm-username must repeat the target username exactly.');
    }
    // Early, friendly refusal; the decisive checks are repeated under the lock below.
    const early = await this.prisma.user.findUnique({ where: { username: input.username }, select: TARGET_SELECT });
    this.assertPromotable(early, input.username);

    const target = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockAndCheck(tx, input.username, 'An active Super Administrator already exists; bootstrap refused.');
      await tx.user.update({ where: { id: t.id }, data: { role: 'SUPER_ADMIN' } });
      await this.tokens.revokeAllForUser(t.id, tx);
      await this.audit.log({
        actorId: null, actorRole: 'OPERATOR', action: 'SUPER_ADMIN_BOOTSTRAP', entity: 'User', entityId: t.id,
        metadata: { reason, before: { role: 'ADMIN' }, after: { role: 'SUPER_ADMIN' } },
      }, tx);
      return t;
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
      const early = await this.prisma.user.findUnique({ where: { username: input.username }, select: TARGET_SELECT });
      this.assertPromotable(early, input.username);
      const target = await this.prisma.$transaction(async (tx) => {
        const t = await this.lockAndCheck(tx, input.username, 'An active Super Administrator exists; promote-admin is only for when none does.');
        await tx.user.update({ where: { id: t.id }, data: { role: 'SUPER_ADMIN' } });
        await this.tokens.revokeAllForUser(t.id, tx);
        await this.audit.log({
          actorId: null, actorRole: 'OPERATOR', action: 'SUPER_ADMIN_BREAK_GLASS', entity: 'User', entityId: t.id,
          metadata: { mode: input.mode, reason, approvalRef, operatorNote: note, before: { role: 'ADMIN' }, after: { role: 'SUPER_ADMIN' } },
        }, tx);
        return t;
      });
      await this.accountEmails.superAdminChanged({ action: 'Break-glass promotion to Super Administrator', targetUsername: target.username, actorUsername: null, reason });
      return { userId: target.id };
    }

    throw refuse('OPERATOR_INPUT_REQUIRED', 'Unknown break-glass mode.');
  }

  /**
   * Inside the promotion transaction: take the promotion lock (waits for any concurrent promotion
   * to commit or roll back), then re-check that no active Super Admin exists and that the target is
   * still a promotable Administrator. Throws a refusal (the transaction then rolls back).
   */
  private async lockAndCheck(tx: Prisma.TransactionClient, username: string, existsMessage: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPER_ADMIN_PROMOTION_LOCK})`;
    const existing = await tx.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
    if (existing > 0) throw refuse('SUPER_ADMIN_EXISTS', existsMessage);
    const target = await tx.user.findUnique({ where: { username }, select: TARGET_SELECT });
    return this.assertPromotable(target, username);
  }

  /** An existing, active, activated ADMIN that is not a shared seeded account. */
  private assertPromotable<T extends { role: string; isActive: boolean; activatedAt: Date | null; username: string }>(target: T | null, username: string): T {
    if (this.roles.isSharedAccount(target?.username ?? username ?? '')) {
      throw refuse('SHARED_ACCOUNT_REFUSED', 'This is the shared seeded administrator account; it can never become a Super Administrator. Name a personal Administrator account.');
    }
    if (!target || target.role !== 'ADMIN' || !target.isActive || !target.activatedAt) {
      throw refuse('NOT_AN_ACTIVE_ADMIN', 'The target must be an existing, active, activated Administrator.');
    }
    return target;
  }
}
