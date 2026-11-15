import { HttpStatus, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { FormAvailabilityService } from '../forms/form-availability.service.js';
import type { FormKey } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { CallerCtx } from '../common/auth-user.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  defaultValue,
  isSettingKey,
  SETTINGS,
  validateSettingValue,
  type SettingDefinition,
  type SettingKey,
  type SettingValue,
} from './settings.registry.js';

const CACHE_TTL_MS = 30_000;

/**
 * The old registration switches now live in their forms (FormAvailability, the single source of truth):
 * reading one reports whether the form is open right now; writing true opens the form (no closing date) and false
 * closes it, audited as a form change. Their SystemSetting rows are no longer read or written.
 */
const FORM_SWITCHES: Readonly<Partial<Record<string, FormKey>>> = {
  'registration.studentSelfSignup': 'STUDENT_REGISTRATION',
  'registration.teacherSelfSignup': 'TEACHER_REGISTRATION',
};

@Injectable()
export class SettingsService {
  private cache: { at: number; values: Map<string, unknown> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
    private readonly forms:  FormAvailabilityService,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const form = FORM_SWITCHES[key];
    if (form) return (await this.forms.openSwitch(form)) as SettingValue<K>;
    const values = await this.load();
    return (values.has(key) ? values.get(key) : defaultValue(key)) as SettingValue<K>;
  }

  /** Every setting with its current value, default, type, limits and who last changed it. */
  async getAll() {
    const rows = await this.prisma.systemSetting.findMany({
      select: { key: true, value: true, updatedAt: true, updatedBy: { select: { id: true, username: true, firstName: true, lastName: true } } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const switches = new Map<string, unknown>();
    for (const [key, form] of Object.entries(FORM_SWITCHES)) switches.set(key, await this.forms.openSwitch(form!));
    return Object.entries(SETTINGS).map(([key, d]) => {
      const def: SettingDefinition = d;
      // A form switch reports its form; who changed it last is on the form (GET /admin/forms).
      const row = FORM_SWITCHES[key] ? undefined : byKey.get(key);
      return {
        key,
        category:    def.category,
        value:       switches.has(key) ? switches.get(key) : row ? row.value : defaultValue(key as SettingKey),
        default:     defaultValue(key as SettingKey),
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
      current.set(key, values.has(key) ? values.get(key) : defaultValue(key as SettingKey));
    }
    const next = new Map(current);
    for (const [key, value] of entries) next.set(key, value);
    this.assertConsistent(next);

    for (const [key, form] of Object.entries(FORM_SWITCHES)) current.set(key, await this.forms.openSwitch(form!));
    const changed = entries.filter(([key, value]) => JSON.stringify(current.get(key)) !== JSON.stringify(value));
    const formChanges = changed.filter(([key]) => FORM_SWITCHES[key]);
    const settingChanges = changed.filter(([key]) => !FORM_SWITCHES[key]);
    if (changed.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        // A form switch: open (true) or close (false) the form, audited as FORM_AVAILABILITY_CHANGED.
        for (const [key, value] of formChanges) {
          await this.forms.setOpenSwitch(FORM_SWITCHES[key]!, value === true, caller, tx as never);
        }
        for (const [key, value] of settingChanges) {
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
      if (formChanges.length) this.forms.invalidate();
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
