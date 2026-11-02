import { HttpStatus, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { CallerCtx } from '../common/auth-user.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  isSettingKey,
  SETTINGS,
  validateSettingValue,
  type SettingKey,
  type SettingValue,
} from './settings.registry.js';

const CACHE_TTL_MS = 30_000;

@Injectable()
export class SettingsService {
  private cache: { at: number; values: Map<string, unknown> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const values = await this.load();
    return (values.has(key) ? values.get(key) : SETTINGS[key].default) as SettingValue<K>;
  }

  /** Every setting with its current value, default and description. */
  async getAll() {
    const values = await this.load();
    return Object.entries(SETTINGS).map(([key, def]) => ({
      key,
      value:       values.has(key) ? values.get(key) : def.default,
      default:     def.default,
      type:        def.type,
      description: def.description,
      ...('options' in def && { options: def.options }),
    }));
  }

  async update(changes: Record<string, unknown>, caller: CallerCtx) {
    const entries = Object.entries(changes);
    if (entries.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Provide at least one setting to change.');
    }

    const errors: string[] = [];
    for (const [key, value] of entries) {
      if (!isSettingKey(key)) {
        errors.push(`Unknown setting "${key}".`);
        continue;
      }
      const err = validateSettingValue(key, value);
      if (err) errors.push(err);
    }
    if (errors.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SETTINGS', 'Some settings are invalid.', errors);
    }

    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma.systemSetting.upsert({
          where:  { key },
          create: { key, value: value as Prisma.InputJsonValue, updatedById: caller.id },
          update: { value: value as Prisma.InputJsonValue, updatedById: caller.id },
        }),
      ),
    );
    this.cache = null;

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UPDATE_SETTINGS',
      entity:    'SystemSetting',
      metadata:  changes,
    });

    return this.getAll();
  }

  private async load(): Promise<Map<string, unknown>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.values;
    const rows   = await this.prisma.systemSetting.findMany();
    const values = new Map(rows.filter((r) => isSettingKey(r.key)).map((r) => [r.key, r.value as unknown]));
    this.cache = { at: Date.now(), values };
    return values;
  }
}
