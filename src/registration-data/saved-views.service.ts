/**
 * Registration data: saved filters and column layouts (owner 2026-11-23).
 *
 *  - A saved filter: a name, a category, the filter, the columns in order and the sort. Its owner may change or delete
 *    it; shared, the other holders of registrationData.manage may apply it (and save a copy), not change it.
 *  - A column layout per category and person: the columns in order. Stored in TableLayout as "registration.<CATEGORY>"
 *    (string keys). A column that no longer exists is dropped when read; a new column is offered, not added.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FieldCatalogueService } from './field-catalogue.service.js';
import { CATEGORIES, CATEGORY_KEYS, type CategoryKey } from './field-policy.js';
import { compileFilter, compileSort, QueryProblem, type FilterGroup, type SortSpec } from './query-compiler.js';
import { RegistrationDataService } from './registration-data.service.js';

export interface SavedFilterInput { name: string; category: string; filter: FilterGroup; columns: string[]; sort?: SortSpec[]; shared?: boolean }

const OWNER = { select: { id: true, firstName: true, lastName: true } } as const;
const layoutTable = (c: CategoryKey) => `registration.${c}`;

function category(c: string): CategoryKey {
  if (!CATEGORY_KEYS.includes(c as CategoryKey)) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_CATEGORY', `Choose one of: ${CATEGORY_KEYS.map((k) => CATEGORIES[k].label).join(', ')}.`);
  }
  return c as CategoryKey;
}

@Injectable()
export class SavedViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: FieldCatalogueService,
    private readonly data: RegistrationDataService,
  ) {}

  /** The filter, columns and sort are checked against today's fields of the category; every problem is reported. */
  private async assertValid(input: SavedFilterInput) {
    const cat = category(input.category);
    const fields = await this.catalogue.forCategory(cat);
    const keys = new Set(fields.map((f) => f.key));
    const problems: string[] = [];
    if (!input.columns?.length) problems.push('Choose at least one column.');
    for (const c of input.columns ?? []) if (!keys.has(c)) problems.push(`The column "${c}" is not available for ${CATEGORIES[cat].label}.`);
    try {
      compileFilter(input.filter, fields);
      compileSort(input.sort, fields);
    } catch (e) {
      if (e instanceof QueryProblem) problems.push(...e.problems);
      else throw e;
    }
    if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_QUERY', problems[0], { problems });
    return cat;
  }

  private view(r: Prisma.RegistrationSavedFilterGetPayload<{ include: { owner: typeof OWNER } }>, viewer: AuthUser) {
    return {
      id: r.id, name: r.name, category: r.category, filter: r.filter, columns: r.columns, sort: r.sort, shared: r.shared,
      owner: { id: r.owner.id, name: `${r.owner.firstName} ${r.owner.lastName}`.trim() }, mine: r.ownerId === viewer.id,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }

  /** The caller's saved filters and those shared by others; optionally of one category. */
  async list(viewer: AuthUser, cat?: string) {
    const rows = await this.prisma.registrationSavedFilter.findMany({
      where: { OR: [{ ownerId: viewer.id }, { shared: true }], ...(cat && { category: category(cat) }) },
      include: { owner: OWNER }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.view(r, viewer));
  }

  private async own(id: string, viewer: AuthUser) {
    const r = await this.prisma.registrationSavedFilter.findUnique({ where: { id }, include: { owner: OWNER } });
    if (!r || (r.ownerId !== viewer.id && !r.shared)) throw new NotFoundException('This saved filter was not found. It may have been deleted.');
    if (r.ownerId !== viewer.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_YOUR_SAVED_FILTER',
        `Only ${r.owner.firstName} ${r.owner.lastName} can change this saved filter. Save a copy under a new name instead.`);
    }
    return r;
  }

  private nameTaken(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(HttpStatus.CONFLICT, 'NAME_TAKEN', 'You already have a saved filter with this name. Choose another name.');
    }
    throw e;
  }

  async create(input: SavedFilterInput, viewer: AuthUser) {
    const cat = await this.assertValid(input);
    const r = await this.prisma.registrationSavedFilter.create({
      data: { ownerId: viewer.id, name: input.name, category: cat, filter: input.filter as never, columns: input.columns, sort: (input.sort ?? []) as never, shared: !!input.shared },
      include: { owner: OWNER },
    }).catch((e: unknown) => this.nameTaken(e));
    return this.view(r, viewer);
  }

  async update(id: string, input: SavedFilterInput, viewer: AuthUser) {
    await this.own(id, viewer);
    const cat = await this.assertValid(input);
    const r = await this.prisma.registrationSavedFilter.update({
      where: { id },
      data: { name: input.name, category: cat, filter: input.filter as never, columns: input.columns, sort: (input.sort ?? []) as never, shared: !!input.shared },
      include: { owner: OWNER },
    }).catch((e: unknown) => this.nameTaken(e));
    return this.view(r, viewer);
  }

  async remove(id: string, viewer: AuthUser) {
    await this.own(id, viewer);
    await this.prisma.registrationSavedFilter.delete({ where: { id } });
    return { id, deleted: true };
  }

  // ─── Column layouts ─────────────────────────────────────────────────────────

  /** The caller's columns for a category (or the default ones), and where they come from. */
  async layout(cat: string, viewer: AuthUser) {
    const c = category(cat);
    const { fields, defaultColumns } = await this.data.fields(c);
    const keys = new Set(fields.map((f) => f.key));
    const row = await this.prisma.tableLayout.findUnique({ where: { owner_table: { owner: viewer.id, table: layoutTable(c) } } });
    const stored = Array.isArray(row?.columns) ? (row.columns as unknown[]).filter((k): k is string => typeof k === 'string' && keys.has(k)) : [];
    return { category: c, columns: stored.length ? stored : defaultColumns, source: stored.length ? 'USER' as const : 'DEFAULT' as const, defaultColumns };
  }

  async saveLayout(cat: string, columns: string[], viewer: AuthUser) {
    const c = category(cat);
    const keys = new Set((await this.catalogue.forCategory(c)).map((f) => f.key));
    const problems = [
      ...(columns.length ? [] : ['Choose at least one column.']),
      ...columns.filter((k) => !keys.has(k)).map((k) => `The column "${k}" is not available for ${CATEGORIES[c].label}.`),
      ...(new Set(columns).size !== columns.length ? ['A column is listed twice.'] : []),
    ];
    if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_LAYOUT', problems[0], { problems });
    await this.prisma.tableLayout.upsert({
      where: { owner_table: { owner: viewer.id, table: layoutTable(c) } },
      create: { owner: viewer.id, table: layoutTable(c), columns, updatedById: viewer.id },
      update: { columns, updatedById: viewer.id },
    });
    return this.layout(c, viewer);
  }

  async resetLayout(cat: string, viewer: AuthUser) {
    const c = category(cat);
    await this.prisma.tableLayout.deleteMany({ where: { owner: viewer.id, table: layoutTable(c) } });
    return this.layout(c, viewer);
  }
}
