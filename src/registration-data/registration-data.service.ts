/**
 * Registration data (owner 2026-11-23): Super Administrators (registrationData.manage) list, filter, sort, export and
 * edit everything people entered when they registered — every eligible column of the account, the coach and teacher
 * applications, the school as the student entered it, and the school and Olympiad level the account points to.
 *
 *  - The fields come from the database (field-catalogue.service.ts) through the eligibility layer (field-policy.ts).
 *  - Filtering, sorting and paging happen in the database (query-compiler.ts); exports are streamed.
 *  - Editing: plain fields here (validated by their type, one audited transaction); fields with rules of their own go
 *    through the code that already enforces those rules (UsersService.update — in the same transaction), or are
 *    changed with their own dedicated action (account status, date of birth, Olympiad level: each needs a reason).
 *  - Audited: every change (field, old and new value — personal values masked), every export.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import ExcelJS from 'exceljs';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { csvBatchSize, idBatches, mapBatches } from '../reports/csv.js';
import { sendCsvExport } from '../reports/csv-stream.js';
import { UpdateUserDto } from '../users/dto/update-user.dto.js';
import { UsersService } from '../users/users.service.js';
import { FieldCatalogueService, type Field } from './field-catalogue.service.js';
import { CATEGORIES, CATEGORY_KEYS, type CategoryKey } from './field-policy.js';
import {
  compileFilter, compileSelect, compileSort, exportText, OPERATOR_LABELS, OPERATORS, QueryProblem, searchWhere, valueOf,
  type FilterGroup, type SortSpec,
} from './query-compiler.js';

export const EXPORT_MAX_ROWS = 200_000;
export const PAGE_MAX = 200;

/** The columns a category shows before anyone chooses (those of them that exist). */
const DEFAULT_COLUMNS: Readonly<Record<CategoryKey, readonly string[]>> = {
  STUDENTS: ['user.firstName', 'user.lastName', 'user.email', 'user.schoolId', 'user.gradeLevel', 'user.divisionId', 'user.accountStatus', 'user.createdAt'],
  TEACHERS: ['user.firstName', 'user.lastName', 'user.email', 'user.phone', 'teacherApplication.position', 'user.accountStatus', 'user.createdAt'],
  COACHES: ['user.firstName', 'user.lastName', 'user.email', 'coachApplication.occupation', 'coachApplication.educationLevel', 'user.olympiadInterests', 'user.accountStatus', 'user.createdAt'],
  HEAD_COACHES: ['user.firstName', 'user.lastName', 'user.email', 'coachApplication.occupation', 'user.olympiadInterests', 'user.accountStatus', 'user.createdAt'],
  ADMINS: ['user.firstName', 'user.lastName', 'user.email', 'user.role', 'user.accountStatus', 'user.lastLoginAt'],
  ALL: ['user.firstName', 'user.lastName', 'user.email', 'user.role', 'user.accountStatus', 'user.createdAt'],
};

/** account field → the PATCH /admin/users/:id property it is (UsersService.update). */
const ACCOUNT_PROPERTY: Readonly<Record<string, keyof UpdateUserDto>> = {
  'user.firstName': 'firstName', 'user.lastName': 'lastName', 'user.username': 'username', 'user.email': 'email', 'user.role': 'role',
  'user.gradeLevel': 'gradeLevel', 'user.schoolId': 'schoolId', 'user.gender': 'gender', 'user.country': 'homeCountry',
  'user.homeProvince': 'homeProvince', 'user.homeDistrict': 'homeDistrict', 'user.homeSector': 'homeSector',
  'user.olympiadInterests': 'olympiadInterests', 'user.olympiadInterestOther': 'olympiadInterestOther',
};

/** What to do instead, for a field changed by its own action. */
const OWN_ACTION: Readonly<Record<string, string>> = {
  status: 'Use "Change account status" on the account (a reason is required).',
  dateOfBirth: 'Use "Correct date of birth" on the account (a reason is required).',
  olympiadLevel: 'Use "Change Olympiad level" on the account (a reason is required).',
  none: 'It is kept by the system and cannot be changed.',
};

export function categoryOfRole(role: string): CategoryKey {
  return role === 'STUDENT' ? 'STUDENTS' : role === 'TEACHER' ? 'TEACHERS' : role === 'MENTOR' ? 'COACHES'
    : role === 'HEAD_COACH' ? 'HEAD_COACHES' : role === 'ADMIN' || role === 'SUPER_ADMIN' ? 'ADMINS' : 'ALL';
}

export interface QueryInput { category: CategoryKey; columns: string[]; filter?: FilterGroup | null; sort?: SortSpec[]; search?: string }

const invalid = (problems: string[]) =>
  new AppError(HttpStatus.BAD_REQUEST, 'INVALID_QUERY', problems[0] ?? 'This filter is not valid.', { problems });

function requireCategory(category: string): CategoryKey {
  if (!CATEGORY_KEYS.includes(category as CategoryKey)) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_CATEGORY', `Choose one of: ${CATEGORY_KEYS.map((k) => CATEGORIES[k].label).join(', ')}.`);
  }
  return category as CategoryKey;
}

// ─── Editing: plain values by type ───────────────────────────────────────────────

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A value for a plain field, checked against its type (and, by name, phone / e-mail / country formats). */
export function parsePlainValue(f: Field, raw: unknown): { value: unknown } | { problem: string } {
  const empty = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0 && f.type !== 'enumList' && f.type !== 'textList');
  if (empty) {
    if (f.type === 'enumList' || f.type === 'textList') return { value: [] };
    return f.nullable ? { value: null } : { problem: `${f.label} cannot be empty.` };
  }
  switch (f.type) {
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { problem: `${f.label} must be text.` };
      const s = String(raw).trim();
      const max = f.maxLength ?? 2000;
      if (s.length > max) return { problem: `${f.label} is too long (at most ${max} characters).` };
      if (/phone/i.test(f.column)) {
        const p = s.replace(/[\s()-]/g, '');
        return E164.test(p) ? { value: p } : { problem: `${f.label}: use the international format with the country code, e.g. +250788123456.` };
      }
      if (/email/i.test(f.column)) return EMAIL.test(s) ? { value: s.toLowerCase() } : { problem: `${f.label} is not a valid email address.` };
      if (/(^country$|countryCode$|Country$)/.test(f.column)) {
        const c = s.toUpperCase();
        return /^[A-Z]{2}$/.test(c) ? { value: c } : { problem: `${f.label}: choose a country (a two-letter code such as RW).` };
      }
      return { value: s };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { problem: `${f.label} must be a number.` };
      if (f.integer && !Number.isInteger(n)) return { problem: `${f.label} must be a whole number.` };
      if (/years/i.test(f.column) && (n < 0 || n > 80)) return { problem: `${f.label} must be between 0 and 80.` };
      if (f.integer && Math.abs(n) > 2_147_483_647) return { problem: `${f.label} is too large.` };
      return { value: n };
    }
    case 'boolean':
      if (typeof raw === 'boolean') return { value: raw };
      if (raw === 'true' || raw === 'false') return { value: raw === 'true' };
      return { problem: `${f.label} must be yes or no.` };
    case 'date': {
      const s = String(raw);
      const d = new Date(`${s}T00:00:00.000Z`);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) ? { value: d } : { problem: `${f.label} must be a date (YYYY-MM-DD).` };
    }
    case 'datetime': {
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? { problem: `${f.label} must be a date and time.` } : { value: d };
    }
    case 'enum':
      return typeof raw === 'string' && f.values!.includes(raw) ? { value: raw }
        : { problem: `${f.label}: choose one of ${f.values!.map((v) => f.valueLabels?.[v] ?? v).join(', ')}.` };
    case 'enumList':
    case 'textList': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) return { problem: `${f.label} must be a list.` };
      const list = [...new Set(raw.map((x: string) => x.trim()).filter(Boolean))];
      if (f.values && list.some((x) => !f.values!.includes(x))) return { problem: `${f.label}: choose only from ${f.values.map((v) => f.valueLabels?.[v] ?? v).join(', ')}.` };
      if (list.length > 100) return { problem: `${f.label} has too many entries.` };
      return { value: f.values ? f.values.filter((v) => list.includes(v)) : list };
    }
  }
}

@Injectable()
export class RegistrationDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalogue: FieldCatalogueService,
    private readonly users: UsersService,
  ) {}

  /** The categories, a category's fields, the conditions of each type, and the default columns. */
  async fields(category: string) {
    const key = requireCategory(category);
    const fields = await this.catalogue.forCategory(key);
    const keys = new Set(fields.map((f) => f.key));
    return {
      category: key,
      categories: CATEGORY_KEYS.map((k) => ({ key: k, label: CATEGORIES[k].label })),
      fields: fields.map((f) => ({ ...f, editable: f.editVia === 'direct' || f.editVia === 'account', operators: OPERATORS[f.type] })),
      operators: Object.fromEntries(Object.entries(OPERATOR_LABELS).map(([k, label]) => [k, { label, needsValue: !['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'].includes(k), range: k === 'between' }])),
      defaultColumns: DEFAULT_COLUMNS[key].filter((c) => keys.has(c)),
    };
  }

  /** The where clause of a query: the category's accounts, the search box and the filter. */
  private async compile(input: QueryInput) {
    const category = requireCategory(input.category);
    const fields = await this.catalogue.forCategory(category);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const unknown = (input.columns ?? []).filter((c) => !byKey.has(c));
    if (unknown.length) throw invalid(unknown.map((c) => `The column "${c}" is not available for ${CATEGORIES[category].label}.`));
    const chosen = [...new Set(input.columns ?? [])].map((c) => byKey.get(c)!);
    if (!chosen.length) throw invalid(['Choose at least one column.']);
    try {
      const roles = CATEGORIES[category].roles;
      const where: Prisma.UserWhereInput = { AND: [roles ? { role: { in: roles as never } } : {}, searchWhere(input.search), compileFilter(input.filter, fields)] };
      return { category, fields, chosen, where, orderBy: compileSort(input.sort, fields) };
    } catch (e) {
      if (e instanceof QueryProblem) throw invalid(e.problems);
      throw e;
    }
  }

  /** One page of rows. */
  async query(input: QueryInput, page = 1, limit = 50) {
    const q = await this.compile(input);
    const take = Math.min(Math.max(1, Math.trunc(limit) || 50), PAGE_MAX);
    const p = Math.max(1, Math.trunc(page) || 1);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where: q.where, orderBy: q.orderBy, select: compileSelect(q.chosen), skip: (p - 1) * take, take }),
      this.prisma.user.count({ where: q.where }),
    ]);
    return {
      category: q.category,
      columns: q.chosen.map((f) => ({ key: f.key, label: f.label, type: f.type, valueLabels: f.valueLabels })),
      rows: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string, version: (r.updatedAt as Date).toISOString(),
        values: Object.fromEntries(q.chosen.map((f) => [f.key, valueOf(f, r)])),
      })),
      meta: { page: p, limit: take, total, totalPages: Math.max(1, Math.ceil(total / take)) },
    };
  }

  /** The filtered rows as CSV or Excel, the chosen columns in order. Streamed; audited. */
  async export(input: QueryInput, format: 'csv' | 'xlsx', viewer: AuthUser, res: Response) {
    const q = await this.compile(input);
    const total = await this.prisma.user.count({ where: q.where });
    if (total > EXPORT_MAX_ROWS) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'EXPORT_TOO_LARGE',
        `This export would have ${total.toLocaleString('en')} rows; the limit is ${EXPORT_MAX_ROWS.toLocaleString('en')}. Add a filter to narrow it down, then try again.`,
        { total, max: EXPORT_MAX_ROWS });
    }
    // The whole order once (one query), then each batch by primary key in that order (csv.ts idBatches).
    const ids = (await this.prisma.user.findMany({ where: q.where, orderBy: q.orderBy, select: { id: true } })).map((r) => r.id);
    const select = compileSelect(q.chosen);
    const batches = () => mapBatches(
      idBatches(ids, (chunk) => this.prisma.user.findMany({ where: { id: { in: chunk } }, select }) as unknown as Promise<Array<{ id: string } & Record<string, unknown>>>, csvBatchSize()),
      (rows) => rows.map((r) => q.chosen.map((f) => exportText(f, valueOf(f, r)))),
    );
    const headers = q.chosen.map((f) => f.label);
    const base = `registration-data-${CATEGORIES[q.category].label.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}`;
    await this.audit.log({
      actorId: viewer.id, actorRole: viewer.role, action: 'REGISTRATION_DATA_EXPORTED', entity: 'User', entityId: null,
      metadata: {
        category: q.category, format, rows: ids.length, columns: q.chosen.map((f) => f.key),
        personalColumns: q.chosen.filter((f) => f.personal).map((f) => f.key), filtered: !!input.filter?.conditions?.length || !!input.search,
      },
    });
    if (format === 'csv') {
      await sendCsvExport(res, `${base}.csv`, { headers, batches: batches() });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const ws = wb.addWorksheet(CATEGORIES[q.category].label.slice(0, 31));
    ws.columns = headers.map((h) => ({ header: h, width: Math.min(40, Math.max(14, h.length + 4)) }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();
    try {
      // Each value is written as a plain value (a text cell is never a formula in an .xlsx file): no apostrophes needed.
      for await (const rows of batches()) for (const row of rows) ws.addRow(row).commit();
      ws.commit();
      await wb.commit();
    } catch (err) {
      res.destroy(err as Error);
    }
  }

  /** One account's registration record: every field of its category, its value, and whether / how it can be changed. */
  async record(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('This account was not found. It may have been removed.');
    const category = categoryOfRole(user.role);
    const fields = await this.catalogue.forCategory(category);
    // The chosen columns, plus each application's id (merged into its select: whether the account has one at all).
    const select = compileSelect(fields) as Record<string, unknown>;
    for (const rel of ['mentorRequest', 'teacherApplication']) {
      const sub = (select[rel] as { select?: Record<string, true> } | undefined)?.select ?? {};
      select[rel] = { select: { ...sub, id: true } };
    }
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id }, select: { ...select, firstName: true, lastName: true } as Prisma.UserSelect,
    }) as unknown as Record<string, unknown>;
    const has = { coachApplication: !!row.mentorRequest, teacherApplication: !!row.teacherApplication };
    return {
      id, role: user.role, category, version: (row.updatedAt as Date).toISOString(),
      name: `${row.firstName as string} ${row.lastName as string}`.trim(),
      hasCoachApplication: has.coachApplication, hasTeacherApplication: has.teacherApplication,
      fields: fields.map((f) => {
        const missingRecord = (f.source === 'coachApplication' || f.source === 'teacherApplication') && !has[f.source];
        const editable = (f.editVia === 'direct' || f.editVia === 'account') && !missingRecord;
        return {
          key: f.key, label: f.label, group: f.group, type: f.type, values: f.values, valueLabels: f.valueLabels, nullable: f.nullable,
          integer: f.integer, maxLength: f.maxLength, personal: f.personal, reference: f.reference, editVia: f.editVia, editable,
          note: missingRecord ? `This account has no ${f.source === 'coachApplication' ? 'coach' : 'teacher'} application on record (it was created by an administrator).`
            : editable ? null : OWN_ACTION[f.editVia] ?? null,
          value: valueOf(f, row),
        };
      }),
    };
  }

  /**
   * Change fields of one account's registration record: { changes: { "<field key>": value }, version?, currentPassword? }.
   * Every value is checked first (all problems reported together); then one transaction applies them — the account rules
   * (UsersService.update) and the plain fields — and writes one audit entry with each field's old and new value.
   */
  async update(id: string, body: { changes: Record<string, unknown>; version?: string; currentPassword?: string }, caller: AuthUser) {
    const current = await this.prisma.user.findUnique({
      where: { id }, select: { id: true, role: true, updatedAt: true, country: true, homeProvince: true, homeDistrict: true, homeSector: true },
    });
    if (!current) throw new NotFoundException('This account was not found. It may have been removed.');
    const category = categoryOfRole(current.role);
    const fields = await this.catalogue.forCategory(category);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const entries = Object.entries(body.changes ?? {});
    if (!entries.length) throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Nothing was changed. Edit at least one field, then save.');
    if (body.version && body.version !== current.updatedAt.toISOString()) throw changedMeanwhile();

    const problems: Array<{ field: string; message: string }> = [];
    const account: Record<string, unknown> = {};
    const plain: Array<{ f: Field; value: unknown }> = [];
    for (const [key, raw] of entries) {
      const f = byKey.get(key);
      if (!f) {
        problems.push({ field: key, message: `The field "${key}" is not part of a ${CATEGORIES[category].label.toLowerCase().replace(/s$/, '')}'s record.` });
        continue;
      }
      if (f.editVia === 'account') account[ACCOUNT_PROPERTY[key]] = raw === '' ? null : raw;
      else if (f.editVia === 'direct') {
        const r = parsePlainValue(f, raw);
        if ('problem' in r) problems.push({ field: key, message: r.problem });
        else plain.push({ f, value: r.value });
      } else problems.push({ field: key, message: `${f.label} cannot be changed here. ${OWN_ACTION[f.editVia] ?? ''}`.trim() });
    }

    // Home place: the rules need the country with the place; complete what was not sent from the stored values.
    if (['homeCountry', 'homeProvince', 'homeDistrict', 'homeSector'].some((k) => k in account)) {
      const country = (account.homeCountry as string | undefined) ?? current.country ?? undefined;
      if (!country) problems.push({ field: 'user.country', message: 'Choose the country first: the home province, district and sector are only asked for Rwanda.' });
      else {
        account.homeCountry = String(country).toUpperCase();
        if (account.homeCountry === 'RW') {
          for (const [k, stored] of [['homeProvince', current.homeProvince], ['homeDistrict', current.homeDistrict], ['homeSector', current.homeSector]] as const) {
            if (!(k in account) && stored) account[k] = stored;
          }
        } else for (const k of ['homeProvince', 'homeDistrict', 'homeSector']) if (account[k] === null) delete account[k];
      }
    }
    let dto: UpdateUserDto | null = null;
    if (Object.keys(account).length) {
      dto = plainToInstance(UpdateUserDto, { ...account, ...(body.currentPassword && { currentPassword: body.currentPassword }) });
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      const back = Object.fromEntries(Object.entries(ACCOUNT_PROPERTY).map(([k, v]) => [v, k]));
      for (const e of errors) {
        const f = byKey.get(back[e.property]);
        for (const m of Object.values(e.constraints ?? {})) problems.push({ field: back[e.property] ?? e.property, message: `${f?.label ?? e.property}: ${m.startsWith(`${e.property} `) ? m.slice(e.property.length + 1) : m}` });
      }
    }
    if (problems.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_VALUES',
        problems.length === 1 ? problems[0].message : `${problems[0].message} (and ${problems.length - 1} more problem${problems.length === 2 ? '' : 's'} — check the form)`,
        { problems });
    }

    const writePlain = async (tx: Prisma.TransactionClient) => {
      if (body.version) {
        const locked = await tx.user.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
        if (dto === null && locked.updatedAt.toISOString() !== body.version) throw changedMeanwhile();
      }
      const changes: Array<Record<string, unknown>> = [];
      const bySource = new Map<string, Array<{ f: Field; value: unknown }>>();
      for (const p of plain) bySource.set(p.f.source, [...(bySource.get(p.f.source) ?? []), p]);
      for (const [source, list] of bySource) {
        const data = Object.fromEntries(list.map((p) => [p.f.column, p.value]));
        const select = Object.fromEntries(list.map((p) => [p.f.column, true]));
        let before: Record<string, unknown> | null;
        if (source === 'user') {
          before = await tx.user.findUniqueOrThrow({ where: { id }, select });
          await tx.user.update({ where: { id }, data });
        } else if (source === 'coachApplication') {
          before = await tx.mentorRequest.findUnique({ where: { userId: id }, select });
          if (!before) throw noApplication('coach');
          await tx.mentorRequest.update({ where: { userId: id }, data });
        } else if (source === 'teacherApplication') {
          before = await tx.teacherApplication.findUnique({ where: { userId: id }, select });
          if (!before) throw noApplication('teacher');
          await tx.teacherApplication.update({ where: { userId: id }, data });
        } else throw new AppError(HttpStatus.BAD_REQUEST, 'FIELD_NOT_EDITABLE', 'This field cannot be changed here.');
        for (const p of list) {
          const from = before[p.f.column] ?? null;
          const same = JSON.stringify(from instanceof Date ? from.toISOString() : from) === JSON.stringify(p.value instanceof Date ? p.value.toISOString() : p.value);
          if (same) continue;
          changes.push(p.f.personal ? { field: p.f.key, label: p.f.label, changed: true }
            : { field: p.f.key, label: p.f.label, from, to: p.value });
        }
      }
      const throughAccountRules = Object.keys(account).length ? entries.map(([k]) => k).filter((k) => byKey.get(k)?.editVia === 'account') : [];
      if (changes.length || throughAccountRules.length) {
        await this.audit.log({
          actorId: caller.id, actorRole: caller.role, action: 'REGISTRATION_DATA_UPDATED', entity: 'User', entityId: id,
          // The account-rule fields are audited by those rules too (USER_UPDATED, with their old and new values).
          metadata: { category, changes, ...(throughAccountRules.length && { throughAccountRules }) },
        }, tx);
      }
    };

    if (dto) {
      await this.users.update(id, dto, caller, { inTransaction: writePlain, interestsAnyRole: true });
    } else {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${id} FOR UPDATE`;
        await writePlain(tx);
      });
    }
    return this.record(id);
  }
}

const changedMeanwhile = () => new AppError(HttpStatus.CONFLICT, 'RECORD_CHANGED',
  'Someone changed this record after you opened it. Reload it to see their changes, then make yours again.');

const noApplication = (kind: 'coach' | 'teacher') => new AppError(HttpStatus.CONFLICT, 'NO_APPLICATION_RECORD',
  `This account has no ${kind} application on record (it was created by an administrator), so its application details cannot be set.`);
