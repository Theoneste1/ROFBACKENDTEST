import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * TokenCleanupService
 *
 * Periodically removes expired rows from the TokenBlacklist table.
 *
 * Why this is needed:
 *   On logout we write the JWT's jti into TokenBlacklist with its expiry time.
 *   Once a token's expiresAt is in the past, the JWT itself would be rejected
 *   by Passport/JWT before the blacklist is even checked, so those rows are
 *   permanently dead weight. Without cleanup the table grows unboundedly.
 *
 * Schedule: every hour (CronExpression.EVERY_HOUR).
 *   Tokens expire after 1 day (configured in JwtModule). In the worst case
 *   the table holds at most (activeUsers × logoutsPerDay) rows.  Hourly
 *   cleanup keeps this bounded to roughly 1 hour's worth of stale records.
 *
 * Safety: `deleteMany` with a `expiresAt < now()` filter is purely additive-
 *   safe — it never removes a still-valid blacklist entry.
 */
@Injectable()
export class TokenCleanupService {
  private readonly logger = new Logger(TokenCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredTokens(): Promise<void> {
    const now = new Date();
    const result = await this.prisma.tokenBlacklist.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} expired token blacklist record(s).`);
    }
  }
}
