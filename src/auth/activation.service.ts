/**
 * Account activation.
 *
 *   INVITATION         — an administrator creates the account without a
 *                        password and sends a link; the person chooses a
 *                        password and the account is activated (7 days).
 *   EMAIL_VERIFICATION — when `registration.requireEmailVerification` is on, a
 *                        self-registered student confirms their e-mail before
 *                        they can log in (48 hours).
 *
 * Tokens are random, single-use and stored as SHA-256 only. Issuing a new
 * token revokes the user's earlier unused tokens.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AccountEmailsService } from '../notifications/account-emails.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import type { ActivationPurpose, Prisma } from '../generated/prisma/client.js';
import { hashToken } from './token.service.js';

export const ACTIVATION_TTL_MS: Record<ActivationPurpose, number> = {
  INVITATION:         7 * 24 * 60 * 60 * 1000,
  EMAIL_VERIFICATION: 48 * 60 * 60 * 1000,
};

const BCRYPT_COST = 12;

type Tx = Prisma.TransactionClient;

export interface IssuedActivation {
  token:     string;
  expiresAt: Date;
  purpose:   ActivationPurpose;
  userId:    string;
  email:     string;
  firstName: string;
}

@Injectable()
export class ActivationService {
  constructor(
    private readonly prisma:        PrismaService,
    private readonly audit:         AuditService,
    private readonly notifications: NotificationsService,
    private readonly accountEmails: AccountEmailsService,
  ) {}

  /**
   * Create a token for the user (may run inside the caller's transaction).
   * Pass the result to send() AFTER the transaction commits.
   */
  async issue(userId: string, purpose: ActivationPurpose, createdById: string | null, tx: Tx | PrismaService = this.prisma): Promise<IssuedActivation> {
    const user = await tx.user.findUniqueOrThrow({
      where:  { id: userId },
      select: { id: true, email: true, firstName: true, activatedAt: true },
    });
    if (user.activatedAt) throw invalidState('This account is already activated.');

    const now = new Date();
    await tx.accountActivationToken.updateMany({
      where: { userId, usedAt: null, revokedAt: null },
      data:  { revokedAt: now },
    });

    const token     = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + ACTIVATION_TTL_MS[purpose]);
    await tx.accountActivationToken.create({
      data: { userId, purpose, tokenHash: hashToken(token), expiresAt, createdById },
    });

    return { token, expiresAt, purpose, userId: user.id, email: user.email, firstName: user.firstName };
  }

  /** Queue the activation e-mail (outbox). */
  async send(issued: IssuedActivation) {
    const invitation = issued.purpose === 'INVITATION';
    const link = `/activate?token=${encodeURIComponent(issued.token)}`;
    await this.notifications.queueEmail(
      issued.email,
      invitation ? 'Activate your account' : 'Confirm your e-mail address',
      invitation
        ? 'An account has been created for you on the learning platform of the Rwanda Olympiad Foundation. ' +
          'Click the button below to choose your password and activate your account.'
        : 'Thank you for registering. Please confirm your e-mail address to activate your account.',
      invitation
        ? {
            firstName: issued.firstName, recipientId: issued.userId, link, actionLabel: 'Activate my account',
            note: 'This link is valid for 7 days and can be used once. If you were not expecting this invitation, you can ignore this e-mail.',
          }
        : {
            firstName: issued.firstName, recipientId: issued.userId, link, actionLabel: 'Confirm my e-mail address',
            note: 'This link is valid for 48 hours and can be used once. If you did not create an account, you can ignore this e-mail.',
          },
    );
    return { expiresAt: issued.expiresAt, purpose: issued.purpose };
  }

  /** issue() + send() outside any transaction. */
  async issueAndSend(userId: string, purpose: ActivationPurpose, createdById: string | null) {
    return this.send(await this.issue(userId, purpose, createdById));
  }

  /** Check a link before showing the activation form (public). */
  async inspect(token: string) {
    const record = await this.findUsable(token);
    return {
      purpose:          record.purpose,
      requiresPassword: record.purpose === 'INVITATION',
      expiresAt:        record.expiresAt,
      firstName:        record.user.firstName,
      email:            maskEmail(record.user.email),
      username:         record.user.username,
    };
  }

  /**
   * Activate the account. Invitations require a new password; e-mail
   * verification keeps the password chosen at registration.
   */
  async activate(token: string, password?: string) {
    const record = await this.findUsable(token);
    if (record.purpose === 'INVITATION' && !password) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'PASSWORD_REQUIRED', 'Choose a password to activate your account.');
    }
    const passwordHash = password ? await bcrypt.hash(password, BCRYPT_COST) : undefined;

    await this.prisma.$transaction(async (tx) => {
      // Claim the token: only one concurrent activation can succeed.
      const { count } = await tx.accountActivationToken.updateMany({
        where: { id: record.id, usedAt: null, revokedAt: null },
        data:  { usedAt: new Date() },
      });
      if (count === 0) throw invalidLink();

      await tx.user.update({
        where: { id: record.userId },
        data:  { activatedAt: new Date(), ...(passwordHash && { passwordHash }) },
      });
      await this.audit.log({
        actorId: record.userId, actorRole: record.user.role,
        action: 'ACTIVATE_ACCOUNT', entity: 'User', entityId: record.userId,
        metadata: { purpose: record.purpose },
      }, tx);
    });

    await this.accountEmails.welcome(record.userId);
    return {
      message:  'Your account is active. You can now log in.',
      username: record.user.username,
    };
  }

  /**
   * Public "resend my activation e-mail". Always answers the same way, so it
   * cannot be used to discover which addresses have accounts.
   */
  async resendForEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where:  { email },
      select: { id: true, activatedAt: true, isActive: true, passwordHash: true },
    });
    if (user && !user.activatedAt && user.isActive) {
      await this.issueAndSend(user.id, user.passwordHash ? 'EMAIL_VERIFICATION' : 'INVITATION', null);
    }
    return { message: 'If an account is waiting for activation, a new link has been sent.' };
  }

  private async findUsable(token: string) {
    const record = await this.prisma.accountActivationToken.findUnique({
      where:   { tokenHash: hashToken(token) },
      include: { user: { select: { id: true, firstName: true, email: true, username: true, role: true, isActive: true, activatedAt: true } } },
    });
    if (!record || record.usedAt || record.revokedAt || record.expiresAt < new Date()) throw invalidLink();
    if (!record.user.isActive) throw new NotFoundException('Account not found.');
    if (record.user.activatedAt) throw invalidState('This account is already activated.');
    return record;
  }
}

function invalidLink() {
  return new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ACTIVATION_TOKEN', 'This activation link is invalid or has expired.');
}

/** "jean.uwase@example.com" → "j***e@example.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const shown = local.length <= 2 ? local[0] : `${local[0]}***${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}
