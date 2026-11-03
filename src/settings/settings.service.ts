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
  type SettingDefinition,
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

  /** Every setting with its current value, default, type, limits and who last changed it. */
  async getAll() {
    const rows = await this.prisma.systemSetting.findMany({
      select: { key: true, value: true, updatedAt: true, updatedBy: { select: { id: true, username: true, firstName: true, lastName: true } } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return Object.entries(SETTINGS).map(([key, d]) => {
      const def: SettingDefinition = d;
      const row = byKey.get(key);
      return {
        key,
        category:    def.category,
        value:       row ? row.value : def.default,
        default:     def.default,
        type:        def.type,
        description: def.description,
        ...(def.options   && { options: def.options }),
        ...(def.nullable  && { nullable: true }),
        ...(def.min !== undefined && { min: def.min }),
        ...(def.max !== undefined && { max: def.max }),
        ...(def.maxLength && { maxLength: def.maxLength }),
        ...(def.unit      && { unit: def.unit }),
        updatedAt:   row?.updatedAt ?? null,
        updatedBy:   row?.updatedBy ?? null,
      };
    });
  }

  /** Help and support details for everyone (shown on the help page and login screen). */
  async supportInfo() {
    const [name, email, phone, hours, helpUrl, message] = await Promise.all([
      this.get('platform.name'), this.get('platform.supportEmail'), this.get('support.phone'),
      this.get('support.hours'), this.get('support.helpUrl'), this.get('support.message'),
    ]);
    return { platformName: name, email, phone, hours, helpUrl, message };
  }

  /**
   * Change one or more settings. Every changed setting is recorded in the
   * audit log with its old and new value, in the same transaction.
   */
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

    const current = new Map(Object.keys(SETTINGS).map((k) => [k, undefined as unknown]));
    const values = await this.load(true);
    for (const key of current.keys()) {
      current.set(key, values.has(key) ? values.get(key) : SETTINGS[key as SettingKey].default);
    }
    const next = new Map(current);
    for (const [key, value] of entries) next.set(key, value);
    this.assertConsistent(next);

    const changed = entries.filter(([key, value]) => JSON.stringify(current.get(key)) !== JSON.stringify(value));
    if (changed.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const [key, value] of changed) {
          await tx.systemSetting.upsert({
            where:  { key },
            create: { key, value: value as Prisma.InputJsonValue, updatedById: caller.id },
            update: { value: value as Prisma.InputJsonValue, updatedById: caller.id },
          });
          await this.audit.log({
            actorId: caller.id, actorRole: caller.role,
            action:  'UPDATE_SETTING', entity: 'SystemSetting', entityId: key,
            metadata: { from: current.get(key) ?? null, to: value },
          }, tx);
        }
      });
      this.cache = null;
    }
    return this.getAll();
  }

  /** Rules that involve more than one setting. */
  private assertConsistent(values: Map<string, unknown>) {
    if (values.get('assignments.defaultAllowResubmission') === false && (values.get('assignments.defaultMaxResubmissions') as number) > 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SETTINGS', 'Some settings are invalid.', [
        'assignments.defaultMaxResubmissions only applies when assignments.defaultAllowResubmission is true.',
      ]);
    }
  }

  private async load(fresh = false): Promise<Map<string, unknown>> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.values;
    const rows   = await this.prisma.systemSetting.findMany();
    const values = new Map(rows.filter((r) => isSettingKey(r.key)).map((r) => [r.key, r.value as unknown]));
    this.cache = { at: Date.now(), values };
    return values;
  }
}
