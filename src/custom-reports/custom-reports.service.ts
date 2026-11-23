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
 *  - Exports (CSV, Excel) are capped and audited; changes to a report and its grants are audited.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { PermissionService } from '../auth/permission.service.js';
import { APP_ROLES } from '../auth/permissions.js';
import { schoolStudentsWhere } from '../common/access/access.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { isAdmin, isCoach, isHeadCoach, isTeacher } from '../common/access/roles.js';
import { AppError } from '../common/errors/app-error.js';
import type { Prisma, Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toCsv } from '../reports/csv.js';
import { activeSchoolsOf } from '../teachers/teacher-scope.js';
import {
  cells, definitionOrder, definitionProblems, definitionWhere, FILTER_OPS, ROW_SELECT, SOURCES, type ReportDefinition, type Row,
} from './report-sources.js';
import type { ReportGrantDto, SaveReportDto } from './custom-reports.dto.js';

export const EXPORT_MAX_ROWS = 20_000;
const PERSON = { select: { id: true, firstName: true, lastName: true, username: true } } as const;

export interface Levels { view: boolean; download: boolean; edit: boolean; manage: boolean }
const NONE: Levels = { view: false, download: false, edit: false, manage: false };
const ALL: Levels = { view: true, download: true, edit: true, manage: true };

const notFound = () => new NotFoundException('Report not found.');
const forbidden = (level: string) => new AppError(HttpStatus.FORBIDDEN, 'REPORT_ACCESS_DENIED', `You may not ${level} this report.`);

@Injectable()
export class CustomReportsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly permissions: PermissionService) {}

  private builds(viewer: AuthUser) {
    return this.permissions.has(viewer, 'reports.build');
  }

  /** The viewer's levels on a report: everything for a builder or its creator; else their grants (user and role). */
  levels(report: { createdById: string | null; grants: Array<{ userId: string | null; role: Role | null; canView: boolean; canDownload: boolean; canEdit: boolean }> }, viewer: AuthUser): Levels {
    if (this.builds(viewer) || report.createdById === viewer.id) return ALL;
    const mine = report.grants.filter((g) => g.userId === viewer.id || g.role === viewer.role);
    if (!mine.length || viewer.role === 'STUDENT') return NONE;
    const edit = mine.some((g) => g.canEdit);
    return { view: edit || mine.some((g) => g.canView || g.canDownload), download: mine.some((g) => g.canDownload), edit, manage: false };
  }

  /** Which accounts the viewer may see in any report (see the file header). */
  private async scopeFor(viewer: AuthUser): Promise<Prisma.UserWhereInput> {
    if (isAdmin(viewer)) return {};
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
    const levels = this.levels(r, viewer);
    if (!levels.view) throw notFound();
    return { r, levels };
  }

  private assertDefinition(d: ReportDefinition) {
    const problems = definitionProblems(d);
    if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_REPORT', 'This report definition is not valid.', { problems });
  }

  private definitionOf(r: { source: string; columns: unknown; filters: unknown; sort: unknown }): ReportDefinition {
    return { source: r.source, columns: r.columns as string[], filters: r.filters as ReportDefinition['filters'], sort: r.sort as ReportDefinition['sort'] };
  }

  private view(r: Prisma.CustomReportGetPayload<{ include: { grants: true; createdBy: typeof PERSON } }>, levels: Levels) {
    return {
      id: r.id, name: r.name, description: r.description, source: r.source, columns: r.columns, filters: r.filters, sort: r.sort,
      createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt, myAccess: levels,
    };
  }

  /** The sources, their fields (label, type, values, filterable, sortable) and the filter conditions. */
  catalogue() {
    return {
      sources: Object.values(SOURCES).map((s) => ({
        key: s.key, label: s.label,
        fields: s.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, values: f.values ?? null, filterable: !!f.where, sortable: !!f.orderBy })),
      })),
      operators: FILTER_OPS,
    };
  }

  /** The reports the viewer may open, with their levels on each. */
  async list(viewer: AuthUser) {
    const builder = this.builds(viewer);
    const rows = await this.prisma.customReport.findMany({
      where: {
        deletedAt: null,
        ...(!builder && { OR: [{ createdById: viewer.id }, { grants: { some: { OR: [
          { userId: viewer.id },
          // A role grant only for a known role (an unsupported role matches none).
          ...((APP_ROLES as readonly string[]).includes(viewer.role) ? [{ role: viewer.role as Role }] : []),
        ] } } }] }),
      },
      include: { grants: true, createdBy: PERSON }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ r, levels: this.levels(r, viewer) })).filter((x) => x.levels.view).map((x) => this.view(x.r, x.levels));
  }

  async get(id: string, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    return this.view(r, levels);
  }

  async create(dto: SaveReportDto, viewer: AuthUser) {
    const d = { source: dto.source, columns: dto.columns, filters: dto.filters ?? [], sort: dto.sort ?? [] };
    this.assertDefinition(d);
    const r = await this.prisma.$transaction(async (tx) => {
      const created = await tx.customReport.create({
        data: { name: dto.name, description: dto.description ?? null, ...d, filters: d.filters as never, sort: d.sort as never, createdById: viewer.id, updatedById: viewer.id },
      });
      await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_CREATED', entity: 'CustomReport', entityId: created.id, metadata: { name: dto.name, source: dto.source, columns: dto.columns } }, tx);
      return created;
    });
    return this.get(r.id, viewer);
  }

  async update(id: string, dto: SaveReportDto, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.edit) throw forbidden('edit');
    const d = { source: dto.source, columns: dto.columns, filters: dto.filters ?? [], sort: dto.sort ?? [] };
    this.assertDefinition(d);
    await this.prisma.$transaction(async (tx) => {
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
    await this.prisma.$transaction(async (tx) => {
      await tx.customReport.update({ where: { id }, data: { deletedAt: new Date(), updatedById: viewer.id } });
      await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_DELETED', entity: 'CustomReport', entityId: id, metadata: { name: r.name } }, tx);
    });
    return { id, deleted: true };
  }

  /** One page of rows for a definition, within the viewer's scope. */
  private async page(d: ReportDefinition, viewer: AuthUser, page: number, limit: number) {
    const where = definitionWhere(d, await this.scopeFor(viewer));
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: ROW_SELECT, orderBy: definitionOrder(d), skip: (page - 1) * limit, take: limit }),
      this.prisma.user.count({ where }),
    ]);
    const src = SOURCES[d.source];
    return {
      columns: d.columns.map((c) => ({ key: c, label: src.fields.find((f) => f.key === c)!.label })),
      rows: (rows as unknown as Row[]).map((r) => cells(d, r)),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** Preview an unsaved definition (builders). */
  async preview(dto: Omit<SaveReportDto, 'name'>, viewer: AuthUser, page = 1, limit = 25) {
    const d = { source: dto.source, columns: dto.columns, filters: dto.filters ?? [], sort: dto.sort ?? [] };
    this.assertDefinition(d);
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
    return { report: { id: r.id, name: r.name }, ...(await this.page(this.definitionOf(r), viewer, page, limit)) };
  }

  /** Download a saved report as CSV or Excel (download level). Capped at EXPORT_MAX_ROWS; audited. */
  async export(id: string, format: 'csv' | 'xlsx', viewer: AuthUser, res: Response) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.download) throw forbidden('download');
    const d = this.definitionOf(r);
    const where = definitionWhere(d, await this.scopeFor(viewer));
    const total = await this.prisma.user.count({ where });
    if (total > EXPORT_MAX_ROWS) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'EXPORT_TOO_LARGE', `This report has ${total} rows; add filters to download at most ${EXPORT_MAX_ROWS}.`, { total, max: EXPORT_MAX_ROWS });
    }
    const rows = (await this.prisma.user.findMany({ where, select: ROW_SELECT, orderBy: definitionOrder(d) })) as unknown as Row[];
    const src = SOURCES[d.source];
    const headers = d.columns.map((c) => src.fields.find((f) => f.key === c)!.label);
    const data = rows.map((x) => cells(d, x));
    const base = `${r.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'report'}-${new Date().toISOString().slice(0, 10)}`;
    await this.audit.log({ actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_EXPORTED', entity: 'CustomReport', entityId: id, metadata: { name: r.name, format, rows: data.length } });
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(toCsv(headers, data.map((row) => row.map((v) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v)))));
      return;
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(r.name.slice(0, 31) || 'Report');
    ws.addRow(headers).font = { bold: true };
    for (const row of data) ws.addRow(row.map((v) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v)));
    ws.columns.forEach((c) => { c.width = 22; });
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  /** Who has access, with their levels (the creator or a builder). */
  async grants(id: string, viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.manage) throw forbidden('manage access to');
    const rows = await this.prisma.customReportGrant.findMany({
      where: { reportId: id }, orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, canView: true, canDownload: true, canEdit: true, createdAt: true, user: { select: { id: true, firstName: true, lastName: true, username: true, role: true } } },
    });
    return { report: { id: r.id, name: r.name, createdBy: r.createdBy }, grants: rows };
  }

  /**
   * Replace who has access (the creator or a builder): each grant names a user or a role and its levels; a grant with
   * no level is removed. Students and the STUDENT role are refused. Audited with what was added, changed and removed.
   */
  async setGrants(id: string, wanted: ReportGrantDto[], viewer: AuthUser) {
    const { r, levels } = await this.load(id, viewer);
    if (!levels.manage) throw forbidden('manage access to');
    for (const g of wanted) {
      if ((g.userId ? 1 : 0) + (g.role ? 1 : 0) !== 1) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_GRANTEE', 'Each grant names exactly one user or one role.');
      if (g.role === 'STUDENT') throw new AppError(HttpStatus.BAD_REQUEST, 'GRANTEE_NOT_ALLOWED', 'Reports are never shared with students.');
    }
    const userIds = wanted.flatMap((g) => (g.userId ? [g.userId] : []));
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, role: true } });
    for (const id2 of userIds) {
      const u = users.find((x) => x.id === id2);
      if (!u) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_GRANTEE', 'A chosen user does not exist.', { userId: id2 });
      if (u.role === 'STUDENT') throw new AppError(HttpStatus.BAD_REQUEST, 'GRANTEE_NOT_ALLOWED', 'Reports are never shared with students.', { userId: id2 });
    }
    const keyOf = (g: { userId?: string | null; role?: string | null }) => (g.userId ? `user:${g.userId}` : `role:${g.role}`);
    const next = new Map(wanted.filter((g) => g.canView || g.canDownload || g.canEdit).map((g) => [keyOf(g), g]));
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.customReportGrant.findMany({ where: { reportId: id } });
      const removed = current.filter((c) => !next.has(c.grantee));
      if (removed.length) await tx.customReportGrant.deleteMany({ where: { id: { in: removed.map((c) => c.id) } } });
      const changes: Array<Record<string, unknown>> = [];
      for (const [grantee, g] of next) {
        const data = { canView: !!(g.canView || g.canDownload || g.canEdit), canDownload: !!g.canDownload, canEdit: !!g.canEdit };
        const before = current.find((c) => c.grantee === grantee);
        if (before && before.canView === data.canView && before.canDownload === data.canDownload && before.canEdit === data.canEdit) continue;
        await tx.customReportGrant.upsert({
          where: { reportId_grantee: { reportId: id, grantee } },
          create: { reportId: id, grantee, userId: g.userId ?? null, role: (g.role as Role) ?? null, ...data, grantedById: viewer.id },
          update: { ...data, grantedById: viewer.id },
        });
        changes.push({ grantee, ...data, before: before ? { canView: before.canView, canDownload: before.canDownload, canEdit: before.canEdit } : null });
      }
      if (changes.length || removed.length) {
        await this.audit.log({
          actorId: viewer.id, actorRole: viewer.role, action: 'REPORT_GRANTS_SET', entity: 'CustomReport', entityId: id,
          metadata: { name: r.name, changed: changes, removed: removed.map((c) => c.grantee) },
        }, tx);
      }
    });
    return this.grants(id, viewer);
  }
}
