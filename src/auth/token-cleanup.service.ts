import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * TokenCleanupService
 *
 * Hourly removal of rows that can never be used again:
 *   - TokenBlacklist entries whose access token has expired anyway.
 *   - Refresh tokens that expired, or were revoked/rotated more than a day ago
 *     (kept briefly so reuse detection still works for recently rotated tokens).
 *   - Password-reset tokens that expired or were used.
 *
 * `deleteMany` with time filters never removes a still-meaningful record.
 */
@Injectable()
export class TokenCleanupService {
  private readonly logger = new Logger(TokenCleanupService.name);

  constructor(
    private readonly prisma:  PrismaService,
    private readonly config:  ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'token-cleanup' })
  async cleanupExpiredTokens(): Promise<void> {
    if (this.config.get('WORKERS_ENABLED') === 'false') return;

    const now     = new Date();
    const dayAgo  = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [blacklist, refresh, resets] = await this.prisma.$transaction([
      this.prisma.tokenBlacklist.deleteMany({ where: { expiresAt: { lt: now } } }),
      this.prisma.refreshToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: now } },
            { revokedAt: { lt: dayAgo } },
            { rotatedAt: { lt: dayAgo } },
          ],
        },
      }),
      this.prisma.passwordResetToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
      }),
    ]);

    const total = blacklist.count + refresh.count + resets.count;
    if (total > 0) {
      this.logger.log(
        `Cleaned up ${blacklist.count} blacklisted, ${refresh.count} refresh and ${resets.count} reset token(s).`,
      );
    }
  }
}
