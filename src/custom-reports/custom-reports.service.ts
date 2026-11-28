/**
 * Custom reports (owner 2026-11-22): Administrators build reports from live records — a source, its columns in
 * order, filters, sort — preview them, save them, and share each one with users or roles, each grant with its own
 * levels: view, download, edit ("all" = the three).
 *
 *  - Building (create, preview, any report, any grant): reports.build (Administrators). The creator of a report has
 *    every level on it and manages its grants.
 *  - Shared: a user's levels on a report are the union of their own grant and their role's grant. Students never
 *    receive reports (a grant to a student or to STUDENT is refused).
 *  - Every level is enforced here, on every call (view: open and run; download: export; edit: change and preview).
 *  - Rows stay within the viewer's own scope (an Administrator: every account; a Head Coach: the members of the
 *    programmes they head; a Coach: the students of their programmes or taught divisions; a Teacher: the students of
 *    their schools) — sharing a report never widens what someone may see. Sensitive fields do not exist in any source.
 *  - Exports (CSV, Excel, PDF with ROF formatting) are capped and audited; changes to a report and its grants are audited.
 *  - Sharing (owner 2026-11-28): a grant names a user, a role or a SCHOOL (its teachers with an active assignment), may
 *    EXPIRE, and is REVOKED rather than deleted (kept for the history; granting again clears it). An expired or revoked
 *    grant gives nothing. Every view and download is recorded (access log). A grant never widens the rows: the source's
 *    scope still applies (test submissions: Coaches never, for blind marking).
 */

/** A grant as the access rules read it. */
type GrantRow = { userId: string | null; role: Role | null; schoolId?: string | null; canView: boolean; canDownload: boolean; canEdit: boolean; expiresAt?: Date | null; revokedAt?: Date | null };
/** A grant gives something: not revoked, not expired. */
export const grantLive = (g: { expiresAt?: Date | null; revokedAt?: Date | null }, now = Date.now()) =>
  !g.revokedAt && (!g.expiresAt || g.expiresAt.getTime() > now);
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { PermissionService } from '../auth/permission.service.js';
import { APP_ROLES } from '../auth/permissions.js';
import { schoolStudentsWhere } from '../common/access/access.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { isAdmin, isCoach, isHeadCoach, isTeacher } from '../common/access/roles.js';
import { HIDDEN_ROLE, isHiddenAccount, seesSuperAdmins, visibleUsersWhere } from '../common/access/super-admin-privacy.js';
import { AppError } from '../common/errors/app-error.js';
import type { Prisma, Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toCsv } from '../reports/csv.js';
import { activeSchoolsOf } from '../teachers/teacher-scope.js';

/** The SystemSetting key holding the ids of the reports saved as templates (owner 2026-11-25). */
const TEMPLATES_KEY = 'reports.templateIds';

/** The part of a Prisma delegate a report uses (every source's table has these). */
interface ReportTable {
  findMany(args: { where: object; select: object; orderBy: object[]; skip?: number; take?: number }): Promise<unknown[]>;
  count(args: { where: object }): Promise<number>;
}
import {
  cells, definitionOrder, definitionProblems, definitionWhere, FILTER_OPS, SOURCES, usesProtected, type ReportDefinition, type SourceDef,
} from './report-sources.js';
import type { ReportGrantDto, SaveReportDto } from './custom-reports.dto.js';
import { cellText, documentCell, renderPdf, renderXlsx, type Cell, type ReportDocument, type SummaryGroup } from './report-documents.js';

export const EXPORT_MAX_ROWS = 20_000;
const PERSON = { select: { id: true, firstName: true, lastName: true, username: true } } as const;

export interface Levels { view: boolean; download: boolean; edit: boolean; manage: boolean }
const NONE: Levels = { view: false, download: false, edit: false, manage: false };
const ALL: Levels = { view: true, download: true, edit: true, manage: true };

const notFound = () => new NotFoundException('Report not found.');

/** Administrators' sources whose rows are about one person, and that person's relation (Super Administrator privacy). */
const PERSON_RELATION: Readonly<Record<string, string>> = { ACTIVITY: 'user', PROGRAMME_MEMBERS: 'user' };

/** A field's fixed values as offered to this viewer: the SUPER_ADMIN role only to a Super Administrator. */
function visibleValues(values: readonly string[] | undefined, viewer: AuthUser): readonly string[] | null {
  if (!values) return null;
  return seesSuperAdmins(viewer) ? values : values.filter((v) => v !== HIDDEN_ROLE);
}
const forbidden = (level: string) => new AppError(HttpStatus.FORBIDDEN, 'REPORT_ACCESS_DENIED', `You may not ${level} this report.`);

@Injectable()
export class CustomReportsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly permissions: PermissionService) {}

  private builds(viewer: AuthUser) {
    return this.permissions.has(viewer, 'reports.build');
  }

  /** The viewer's levels on a report: everything for a builder or its creator; else their grants (user and role). */
  levels(report: { createdById: string | null; grants: GrantRow[] }, viewer: AuthUser, schools: ReadonlySet<string> = new Set()): Levels {
    if (this.builds(viewer) || report.createdById === viewer.id) return ALL;
    // Live grants only (not revoked, not expired): the viewer's own, their role's, or (a Teacher) one of their schools'.
    const mine = report.grants.filter((g) => grantLive(g)
      && (g.userId === viewer.id || g.role === viewer.role || (!!g.schoolId && viewer.role === 'TEACHER' && schools.has(g.schoolId))));
    if (!mine.length || viewer.role === 'STUDENT') return NONE;
    const edit = mine.some((g) => g.canEdit);
    return { view: edit || mine.some((g) => g.canView || g.canDownload), download: mine.some((g) => g.canDownload), edit, manage: false };
  }

  /**
   * Which rows of the source the viewer may see (see the file header). Administrators' sources (schools, learning,
   * applications, administration): Administrators only — anyone else sees none, even of a report shared with them;
   * banking information: the Super Admin only.
   */
  private async scopeFor(viewer: AuthUser, src: SourceDef): Promise<object> {
    if (src.superAdminOnly) return viewer.role === 'SUPER_ADMIN' ? {} : { [src.idField ?? 'id']: { in: [] } };
    if (src.scope === 'admin') {
      const rows = isAdmin(viewer) ? {} : { [src.idField ?? 'id']: { in: [] } };
      // Super Administrator privacy (owner 2026-11-28): a source whose rows are about a person never shows a Super
      // Administrator to anyone else.
      const person = Object.hasOwn(PERSON_RELATION, src.key) ? PERSON_RELATION[src.key] : null;
      return person ? { AND: [rows, { [person]: visibleUsersWhere(viewer) }] } : rows;
    }
    if (src.scope === 'submissions') return this.submissionScope(viewer);
    return this.peopleScope(viewer);
  }

  /**
   * Which test answers the viewer may see (owner 2026-11-28): Administrators every one; a Head Coach those of the
   * subjects of their programmes; a Teacher those of the students of their schools; nobody else — a Coach never (blind
   * marking: a marker must not learn whose paper is whose), a Student never.
   */
  private async submissionScope(viewer: AuthUser): Promise<Prisma.TestSubmissionWhereInput> {
    if (isAdmin(viewer)) return { student: visibleUsersWhere(viewer) };
    if (isHeadCoach(viewer)) {
      const ids = (await this.prisma.programmeMembership.findMany({ where: { userId: viewer.id, isActive: true }, select: { disciplineId: true } })).map((m) => m.disciplineId);
      return ids.length ? { test: { disciplineId: { in: ids } } } : { id: { in: [] } };
    }
    if (isTeacher(viewer)) return { student: schoolStudentsWhere(await activeSchoolsOf(this.prisma, viewer.id)) };
    return { id: { in: [] } };
  }

  /** The schools whose grants apply to the viewer (a Teacher's active schools; nobody else's). */
  private async schoolsOf(viewer: AuthUser): Promise<Set<string>> {
    return new Set(viewer.role === 'TEACHER' ? await activeSchoolsOf(this.prisma, viewer.id) : []);
  }

  /** Which accounts the viewer may see in a people report (a Super Administrator: only for a Super Administrator). */
  private async peopleScope(viewer: AuthUser): Promise<Prisma.UserWhereInput> {
    if (isAdmin(viewer)) return visibleUsersWhere(viewer);
    if (isHeadCoach(viewer) || isCoach(viewer)) {
      const [programmes, taught] = await Promise.all([
        // A Coach: only programmes where seeing the students was not taken away (owner 2026-11-23).
        this.prisma.programmeMembership.findMany({
          where: { userId: viewer.id, isActive: true, ...(viewer.role === 'MENTOR' && { discipline: { coachRestrictions: { none: { coachId: viewer.id, capability: 'STUDENTS', liftedAt: null } } } }) },
          select: { disciplineId: true },
        }),
        this.prisma.mentorAssignment.findMany({ where: { mentorId: viewer.id, isActive: true }, select: { divisionId: true } }),
      ]);
      const ids = programmes.map((p) => p.disciplineId);
      const members: Prisma.UserWhereInput = { programmeMemberships: { some: { isActive: true, disciplineId: { in: ids } } } };
      // A Head Coach: the members of their programmes; a Coach: the students of them, or of the divisions they teach.
      if (isHeadCoach(viewer)) return ids.length ? members : { id: { in: [] } };
      return { role: 'STUDENT', OR: [members, { divisionId: { in: taught.map((t) => t.divisionId) } }] };
    }
    if (isTeacher(viewer)) return schoolStudentsWhere(await activeSchoolsOf(this.prisma, viewer.id));
    return { id: { in: [] } };
  }

  private async load(id: string, viewer: AuthUser) {
    const r = await this.prisma.customReport.findFirst({
      where: { id, deletedAt: null },
      include: { grants: true, createdBy: PERSON },
    });
    if (!r) throw notFound();
    const levels = this.levels(r, viewer, await this.schoolsOf(viewer));
    if (!levels.view) throw notFound();
    return { r, levels };
  }

  private assertDefinition(d: ReportDefinition, viewer: AuthUser) {
    const problems = definitionProblems(d, viewer.role);
    if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_REPORT', 'This report cannot be saved as it is. Check the chosen columns and filters, then save again.', { problems });
  }

  private definitionOf(r: { source: string; columns: unknown; filters: unknown; sort: unknown }): ReportDefinition {
    return { source: r.source, columns: r.columns as string[], filters: r.filters as ReportDefinition['filters'], sort: r.sort as ReportDefinition['sort'] };
  }

  private view(r: Prisma.CustomReportGetPayload<{ include: { grants: true; createdBy: typeof PERSON } }>, levels: Levels, templates: ReadonlySet<string>) {
    return {
      id: r.id, name: r.name, description: r.description, source: r.source, columns: r.columns, filters: r.filters, sort: r.sort,
      createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt, myAccess: levels,
      // A template (owner 2026-11-25): every Administrator may start a report from it; only the Super Admin changes it.
      isTemplate: templates.has(r.id),
    };
  }

  /** The reports saved as templates (SystemSetting reports.templateIds; no table of their own). */
  private async templateIds(): Promise<Set<string>> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: TEMPLATES_KEY } });
    return new Set(Array.isArray(row?.value) ? (row.value as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  }

  /** Marks or unmarks a report as a template (the Super Admin only), audited. */
  private async setTemplate(id: string, on: boolean, viewer: AuthUser, tx: Prisma.TransactionClient) {
    const row = await tx.systemSetting.findUnique({ where: { key: TEMPLATES_KEY } });
    const ids = new Set(Array.isArray(row?.value) ? (row.value as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    if (ids.has(id) === on) return;
    if (on) ids.add(id); else ids.delete(id);
    await tx.systemSetting.upsert({
      where: { key: TEMPLATES_KEY }, create: { key: TEMPLATES_KEY, value: [...ids], updatedById: viewer.id }, update: { value: [...ids], updatedById: viewer.id },
    });
    await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: on ? 'REPORT_TEMPLATE_SET' : 'REPORT_TEMPLATE_UNSET', entity: 'CustomReport', entityId: id, metadata: {} }, tx);
  }

  /** Only the Super Admin marks templates or changes one. */
  private assertTemplateRights(viewer: AuthUser, wantTemplate: boolean | undefined, isTemplateNow: boolean) {
    if (viewer.role === 'SUPER_ADMIN') return;
    if (wantTemplate === true || isTemplateNow) {
      throw new AppError(HttpStatus.FORBIDDEN, 'REPORT_TEMPLATE_SUPER_ADMIN_ONLY',
        isTemplateNow ? 'Only the Super Admin can change a template. Start a new report from it instead.' : 'Only the Super Admin can save a report as a template.');
    }
  }

  /**
   * The sources this viewer may build reports from (grouped), their fields (label, type, values, filterable, sortable,
   * protected — protected ones for the Super Admin only) and the filter conditions.
   */
  catalogue(viewer: AuthUser) {
    const superAdmin = viewer.role === 'SUPER_ADMIN';
    return {
      sources: Object.values(SOURCES)
        .filter((s) => (s.superAdminOnly ? superAdmin : s.scope === 'admin' ? isAdmin(viewer) : true))
        .map((s) => ({
          key: s.key, label: s.label, group: s.group, superAdminOnly: !!s.superAdminOnly,
          fields: s.fields.filter((f) => superAdmin || !f.protected)
            .map((f) => ({ key: f.key, label: f.label, type: f.type, values: visibleValues(f.values, viewer), filterable: !!f.where, sortable: !!f.orderBy, protected: !!f.protected })),
        })),
      operators: FILTER_OPS,
    };
  }

  /** The reports the viewer may open, with their levels on each. */
  async list(viewer: AuthUser) {
    const builder = this.builds(viewer);
    const schools = await this.schoolsOf(viewer);
    const rows = await this.prisma.customReport.findMany({
      where: {
        deletedAt: null,
        ...(!builder && { OR: [{ createdById: viewer.id }, { grants: { some: { OR: [
          { userId: viewer.id },
          // A role grant only for a known role (an unsupported role matches none).
          ...((APP_ROLES as readonly string[]).includes(viewer.role) ? [{ role: viewer.role as Role }] : []),
          ...(schools.size ? [{ schoolId: { in: [...schools] } }] : []),
        ] } } }] }),
      },
      include: { grants: true, createdBy: PERSON }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const templates = await this.templateIds();
    return rows.map((r) => ({ r, levels: this.levels(r, viewer, schools) })).filter((x) => x.levels.view).map((x) => this.view(x.r, x.levels, templates));
  }

  async get(id: string, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    return this.view(r, levels, await this.templateIds());
  }

  async create(dto: SaveReportDto, viewer: AuthUser) {
    const d = { source: dto.source, columns: dto.columns, filters: dto.filters ?? [], sort: dto.sort ?? [] };
    this.assertDefinition(d, viewer);
    this.assertTemplateRights(viewer, dto.isTemplate, false);
    const r = await this.prisma.$transaction(async (tx) => {
      const created = await tx.customReport.create({
        data: { name: dto.name, description: dto.description ?? null, ...d, filters: d.filters as never, sort: d.sort as never, createdById: viewer.id, updatedById: viewer.id },
      });
      await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_CREATED', entity: 'CustomReport', entityId: created.id, metadata: { name: dto.name, source: dto.source, columns: dto.columns } }, tx);
      if (dto.isTemplate) await this.setTemplate(created.id, true, viewer, tx);
      return created;
    });
    return this.get(r.id, viewer);
  }

  async update(id: string, dto: SaveReportDto, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.edit) throw forbidden('edit');
    const d = { source: dto.source, columns: dto.columns, filters: dto.filters ?? [], sort: dto.sort ?? [] };
    this.assertDefinition(d, viewer);
    this.assertTemplateRights(viewer, dto.isTemplate, (await this.templateIds()).has(id));
    await this.prisma.$transaction(async (tx) => {
      if (dto.isTemplate !== undefined) await this.setTemplate(id, dto.isTemplate, viewer, tx);
      await tx.customReport.update({
        where: { id }, data: { name: dto.name, description: dto.description ?? null, ...d, filters: d.filters as never, sort: d.sort as never, updatedById: viewer.id },
      });
      await this.audit.log({
        actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_UPDATED', entity: 'CustomReport', entityId: id,
        metadata: { from: { name: r.name, source: r.source, columns: r.columns }, to: { name: dto.name, source: dto.source, columns: dto.columns } },
      }, tx);
    });
    return this.get(id, viewer);
  }

  /** Kept for history (with its grants); it no longer appears or runs. The creator or a builder. */
  async remove(id: string, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.manage) throw forbidden('delete');
    this.assertTemplateRights(viewer, undefined, (await this.templateIds()).has(id));
    await this.prisma.$transaction(async (tx) => {
      await tx.customReport.update({ where: { id }, data: { deletedAt: new Date(), updatedById: viewer.id } });
      await this.setTemplate(id, false, viewer, tx);
      await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_DELETED', entity: 'CustomReport', entityId: id, metadata: { name: r.name } }, tx);
    });
    return { id, deleted: true };
  }

  /** The table of a source (its Prisma delegate). */
  private table(src: SourceDef): ReportTable {
    return (this.prisma as unknown as Record<string, ReportTable>)[src.model];
  }

  /** Column headers; a protected column that this viewer may not see says so. */
  private headers(d: ReportDefinition, viewer: AuthUser) {
    const src = SOURCES[d.source];
    return d.columns.map((c) => {
      const f = src.fields.find((x) => x.key === c)!;
      return { key: c, label: f.protected && viewer.role !== 'SUPER_ADMIN' ? `${f.label} (hidden: personal data)` : f.label };
    });
  }

  /** Personal data shown (the Super Admin): recorded in the audit log, which report and which fields — never values. */
  private async auditPersonal(d: ReportDefinition, viewer: AuthUser, reportId: string | null, what: string) {
    if (viewer.role !== 'SUPER_ADMIN' || !usesProtected(d)) return;
    const src = SOURCES[d.source];
    const fields = [...d.columns, ...d.filters.map((f) => f.field)].filter((k) => src.fields.find((f) => f.key === k)?.protected);
    await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_PERSONAL_DATA_SHOWN', entity: 'CustomReport', entityId: reportId ?? undefined,
      metadata: { source: d.source, fields: [...new Set(fields)], what } });
  }

  /** One page of rows for a definition, within the viewer's scope. */
  private async page(d: ReportDefinition, viewer: AuthUser, page: number, limit: number, reportId: string | null = null) {
    const src = SOURCES[d.source];
    const where = definitionWhere(d, await this.scopeFor(viewer, src));
    const t = this.table(src);
    const [rows, total] = await Promise.all([
      t.findMany({ where, select: src.select, orderBy: definitionOrder(d), skip: (page - 1) * limit, take: limit }),
      t.count({ where }),
    ]);
    await this.auditPersonal(d, viewer, reportId, 'view');
    return {
      columns: this.headers(d, viewer),
      rows: rows.map((r) => cells(d, r, viewer.role === 'SUPER_ADMIN')),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** Preview an unsaved definition (builders). */
  async preview(dto: Omit<SaveReportDto, 'name'>, viewer: AuthUser, page = 1, limit = 25) {
    const d = { source: dto.source, columns: dto.columns, filters: dto.filters ?? [], sort: dto.sort ?? [] };
    this.assertDefinition(d, viewer);
    return this.page(d, viewer, page, limit);
  }

  /** Preview a changed definition of an existing report (edit level). */
  async previewFor(id: string, dto: Omit<SaveReportDto, 'name'>, viewer: AuthUser, page = 1, limit = 25) {
    const { levels } = await this.load(id, viewer);
    if (!levels.edit) throw forbidden('edit');
    return this.preview(dto, viewer, page, limit);
  }

  /** Run a saved report (view level). */
  async run(id: string, viewer: AuthUser, page = 1, limit = 50) {
    const { r } = await this.load(id, viewer);
    const result = await this.page(this.definitionOf(r), viewer, page, limit, r.id);
    // The access log (owner 2026-11-28): every view, by whom, which page and how many rows they could see.
    await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_VIEWED', entity: 'CustomReport', entityId: id, metadata: { name: r.name, page, total: result.meta.total } });
    return { report: { id: r.id, name: r.name }, ...result };
  }

  /** The rows of a saved report for a document (capped; within the viewer's scope). */
  private async allRows(id: string, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    const d = this.definitionOf(r);
    const src = SOURCES[d.source];
    const where = definitionWhere(d, await this.scopeFor(viewer, src));
    const t = this.table(src);
    const total = await t.count({ where });
    if (total > EXPORT_MAX_ROWS) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'EXPORT_TOO_LARGE', `This report has ${total} rows; add filters to download at most ${EXPORT_MAX_ROWS}.`, { total, max: EXPORT_MAX_ROWS });
    }
    const raw = await t.findMany({ where, select: src.select, orderBy: definitionOrder(d) });
    return { r, levels, d, src, raw };
  }

  /** Counts by the source's summary fields (its rows as the viewer may see them). */
  private summarize(src: SourceDef, raw: unknown[]): SummaryGroup[] {
    return (src.summary ?? []).map((key) => {
      const f = src.fields.find((x) => x.key === key)!;
      const counts = new Map<string, number>();
      for (const row of raw) { const v = cellText(documentCell(f.type, f.value(row) as Cell)); counts.set(v, (counts.get(v) ?? 0) + 1); }
      return { key, label: f.label, counts: [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)) };
    });
  }

  /** The filters of a definition as people read them ("Subject is Mathematics"). */
  private filterTexts(d: ReportDefinition): string[] {
    const src = SOURCES[d.source];
    const OPS: Record<string, string> = { eq: 'is', neq: 'is not', in: 'is one of', contains: 'contains', gte: 'from', lte: 'until', isEmpty: 'is empty', isNotEmpty: 'is not empty' };
    return d.filters.map((f) => {
      const label = src.fields.find((x) => x.key === f.field)?.label ?? f.field;
      const v = Array.isArray(f.value) ? f.value.join(', ') : f.value === undefined || f.value === null ? '' : String(f.value);
      return `${label} ${OPS[f.op] ?? f.op}${v ? ` ${v}` : ''}`;
    });
  }

  /** Summary statistics of a saved report (view level): the row count and the counts by its source's summary fields. */
  async summary(id: string, viewer: AuthUser) {
    const { r, src, raw } = await this.allRows(id, viewer);
    return { report: { id: r.id, name: r.name }, total: raw.length, groups: this.summarize(src, raw) };
  }

  /** Download a saved report as CSV, Excel or PDF (download level), with ROF formatting. Capped at EXPORT_MAX_ROWS; audited. */
  async export(id: string, format: 'csv' | 'xlsx' | 'pdf', viewer: AuthUser, res: Response) {
    const { r, levels, d, src, raw } = await this.allRows(id, viewer);
    if (!levels.download) throw forbidden('download');
    const headers = this.headers(d, viewer).map((h) => h.label);
    const data = raw.map((x) => cells(d, x, viewer.role === 'SUPER_ADMIN'));
    await this.auditPersonal(d, viewer, id, `export ${format}`);
    const base = `${r.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'report'}-${new Date().toISOString().slice(0, 10)}`;
    await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_EXPORTED', entity: 'CustomReport', entityId: id, metadata: { name: r.name, format, rows: data.length } });
    res.setHeader('Cache-Control', 'private, no-store');
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      res.send(toCsv(headers, data.map((row) => row.map((v) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v)))));
      return;
    }
    const me = await this.prisma.user.findUnique({ where: { id: viewer.id }, select: { firstName: true, lastName: true, username: true } });
    const document: ReportDocument = {
      title: r.name, description: r.description, source: src.label, filters: this.filterTexts(d),
      generatedBy: me ? `${me.firstName} ${me.lastName}`.trim() || me.username : viewer.username, generatedAt: new Date(),
      // Dates as dates (Kigali time), codes as words: the documents are read by people.
      headers, rows: data.map((row) => row.map((v, i) => documentCell(src.fields.find((f) => f.key === d.columns[i])?.type ?? 'text', v as Cell))),
      summary: this.summarize(src, raw),
    };
    if (format === 'pdf') {
      const buffer = await renderPdf(document);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
      res.send(buffer);
      return;
    }
    const buffer = await renderXlsx(document);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    res.send(buffer);
  }

  /**
   * The access log of a report (who may manage its access): every view, download and change of access, newest first
   * (from the audit log; at most 500).
   */
  async accessLog(id: string, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.manage) throw forbidden('see the access log of');
    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'CustomReport', entityId: id, action: { in: ['REPORT_VIEWED', 'REPORT_EXPORTED', 'REPORT_GRANTS_SET', 'REPORT_GRANT_REVOKED'] } },
      orderBy: { createdAt: 'desc' }, take: 500,
      select: { id: true, createdAt: true, action: true, actorRole: true, metadata: true, actor: { select: { id: true, firstName: true, lastName: true, username: true } } },
    });
    return { report: { id: r.id, name: r.name }, entries: rows.map((e) => {
      const m = (e.metadata ?? {}) as Record<string, unknown>;
      return { id: e.id, at: e.createdAt, action: e.action, actor: e.actor, actorRole: e.actorRole, format: m.format ?? null, rows: m.rows ?? m.total ?? null };
    }) };
  }

  /** Who has access, with their levels (the creator or a builder). */
  async grants(id: string, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.manage) throw forbidden('manage access to');
    const rows = await this.prisma.customReportGrant.findMany({
      where: { reportId: id }, orderBy: { createdAt: 'asc' },
      select: {
        id: true, role: true, canView: true, canDownload: true, canEdit: true, createdAt: true, updatedAt: true, expiresAt: true, revokedAt: true,
        user: { select: { id: true, firstName: true, lastName: true, username: true, role: true } }, school: { select: { id: true, name: true, code: true } },
      },
    });
    // A grant to a Super Administrator (account or role) is not shown to anyone else (Super Administrator privacy).
    const shown = rows.filter((g) => !isHiddenAccount(viewer, g.user) && !(g.role === HIDDEN_ROLE && !seesSuperAdmins(viewer)));
    const now = Date.now();
    return {
      report: { id: r.id, name: r.name, createdBy: r.createdBy, source: r.source },
      grants: shown.map((g) => ({ ...g, state: g.revokedAt ? 'REVOKED' : g.expiresAt && g.expiresAt.getTime() <= now ? 'EXPIRED' : 'ACTIVE' })),
    };
  }

  /**
   * Replace who has access (the creator or a builder): each grant names a user or a role and its levels; a grant with
   * no level is removed. Students and the STUDENT role are refused. Audited with what was added, changed and removed.
   */
  async setGrants(id: string, wanted: ReportGrantDto[], viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.manage) throw forbidden('manage access to');
    // Test submissions (blind marking, owner 2026-11-28): never shared with Coaches, who mark papers without names.
    const blind = SOURCES[r.source]?.scope === 'submissions';
    const now = Date.now();
    for (const g of wanted) {
      if ((g.userId ? 1 : 0) + (g.role ? 1 : 0) + (g.schoolId ? 1 : 0) !== 1) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_GRANTEE', 'Each grant names exactly one user, one role or one school.');
      if (g.role === 'STUDENT') throw new AppError(HttpStatus.BAD_REQUEST, 'GRANTEE_NOT_ALLOWED', 'Reports are never shared with students.');
      if (blind && g.role === 'MENTOR') throw new AppError(HttpStatus.BAD_REQUEST, 'GRANTEE_NOT_ALLOWED', 'Submission reports are never shared with Coaches: they mark papers without knowing whose they are.');
      if (g.expiresAt && new Date(g.expiresAt).getTime() <= now) throw new AppError(HttpStatus.BAD_REQUEST, 'EXPIRY_IN_PAST', 'The expiry date has already passed. Choose a later date, or no expiry.');
    }
    const schoolIds = wanted.flatMap((g) => (g.schoolId ? [g.schoolId] : []));
    const schools = schoolIds.length ? await this.prisma.school.findMany({ where: { id: { in: schoolIds } }, select: { id: true } }) : [];
    for (const sid of schoolIds) if (!schools.some((x) => x.id === sid)) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_GRANTEE', 'A chosen school does not exist.', { schoolId: sid });
    const userIds = wanted.flatMap((g) => (g.userId ? [g.userId] : []));
    // A Super Administrator is, for anyone else, a user that does not exist (UNKNOWN_GRANTEE).
    const users = await this.prisma.user.findMany({ where: { AND: [{ id: { in: userIds } }, visibleUsersWhere(viewer)] }, select: { id: true, role: true } });

    for (const id2 of userIds) {
      const u = users.find((x) => x.id === id2);
      if (!u) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_GRANTEE', 'A chosen user does not exist.', { userId: id2 });
      if (u.role === 'STUDENT') throw new AppError(HttpStatus.BAD_REQUEST, 'GRANTEE_NOT_ALLOWED', 'Reports are never shared with students.', { userId: id2 });
      if (blind && u.role === 'MENTOR') throw new AppError(HttpStatus.BAD_REQUEST, 'GRANTEE_NOT_ALLOWED', 'Submission reports are never shared with Coaches: they mark papers without knowing whose they are.', { userId: id2 });
    }
    const keyOf = (g: { userId?: string | null; role?: string | null; schoolId?: string | null }) =>
      (g.userId ? `user:${g.userId}` : g.schoolId ? `school:${g.schoolId}` : `role:${g.role}`);
    const next = new Map(wanted.filter((g) => g.canView || g.canDownload || g.canEdit).map((g) => [keyOf(g), g]));
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.customReportGrant.findMany({ where: { reportId: id }, include: { user: { select: { role: true } } } });
      // Grants the viewer cannot see (a Super Administrator's) are kept as they are.
      // Removed = revoked (owner 2026-11-28): kept for the history, gives nothing.
      const removed = current.filter((c) => !c.revokedAt && !next.has(c.grantee) && !isHiddenAccount(viewer, c.user) && !(c.role === HIDDEN_ROLE && !seesSuperAdmins(viewer)));
      if (removed.length) await tx.customReportGrant.updateMany({ where: { id: { in: removed.map((c) => c.id) } }, data: { revokedAt: new Date(), revokedById: viewer.id } });
      const changes: Array<Record<string, unknown>> = [];
      for (const [grantee, g] of next) {
        const expiresAt = g.expiresAt ? new Date(g.expiresAt) : null;
        const data = { canView: !!(g.canView || g.canDownload || g.canEdit), canDownload: !!g.canDownload, canEdit: !!g.canEdit, expiresAt };
        const before = current.find((c) => c.grantee === grantee);
        if (before && !before.revokedAt && before.canView === data.canView && before.canDownload === data.canDownload && before.canEdit === data.canEdit
          && (before.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null)) continue;
        await tx.customReportGrant.upsert({
          where: { reportId_grantee: { reportId: id, grantee } },
          create: { reportId: id, grantee, userId: g.userId ?? null, role: (g.role as Role) ?? null, schoolId: g.schoolId ?? null, ...data, grantedById: viewer.id },
          // Granting again after a revocation restores it (grantedById and updatedAt record the new grant).
          update: { ...data, revokedAt: null, revokedById: null, grantedById: viewer.id },
        });
        changes.push({ grantee, ...data, before: before ? { canView: before.canView, canDownload: before.canDownload, canEdit: before.canEdit, expiresAt: before.expiresAt, revoked: !!before.revokedAt } : null });
      }
      if (changes.length || removed.length) {
        await this.audit.log({
          actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_GRANTS_SET', entity: 'CustomReport', entityId: id,
          metadata: { name: r.name, changed: changes, revoked: removed.map((c) => c.grantee) },
        }, tx);
      }
    });
    return this.grants(id, viewer);
  }
  /** Revoke one grant now (who may manage access): kept for the history, gives nothing from now on. Audited. */
  async revokeGrant(id: string, grantId: string, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.manage) throw forbidden('manage access to');
    const g = await this.prisma.customReportGrant.findFirst({ where: { id: grantId, reportId: id }, include: { user: { select: { id: true, role: true } } } });
    if (!g || isHiddenAccount(viewer, g.user) || (g.role === HIDDEN_ROLE && !seesSuperAdmins(viewer))) {
      throw new AppError(HttpStatus.NOT_FOUND, 'GRANT_NOT_FOUND', 'That access was not found. Reload the page.');
    }
    if (!g.revokedAt) {
      await this.prisma.$transaction(async (tx) => {
        await tx.customReportGrant.update({ where: { id: g.id }, data: { revokedAt: new Date(), revokedById: viewer.id } });
        await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_GRANT_REVOKED', entity: 'CustomReport', entityId: id, metadata: { name: r.name, grantee: g.grantee } }, tx);
      });
    }
    return this.grants(id, viewer);
  }
}
