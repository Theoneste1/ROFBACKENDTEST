import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../common/storage/storage.service.js';
import { Public } from '../common/decorators/public.decorator.js';

/**
 * Liveness/readiness probe for load balancers and container orchestrators.
 * Served at /health (outside the /api/v1 prefix).
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma:  PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  @HttpCode(200)
  async check() {
    const checks: Record<string, 'up' | 'down'> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks['database'] = 'up';
    } catch {
      checks['database'] = 'down';
    }

    try {
      await this.storage.ping();
      checks['storage'] = 'up';
    } catch {
      checks['storage'] = 'down';
    }

    const healthy = Object.values(checks).every((s) => s === 'up');
    const body = { status: healthy ? 'ok' : 'degraded', checks, timestamp: new Date().toISOString() };
    if (!healthy) throw new ServiceUnavailableException(body);
    return body;
  }
}
