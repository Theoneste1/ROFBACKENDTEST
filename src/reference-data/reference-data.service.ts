import { HttpStatus, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { auditChanges } from '../audit/audit-changes.js';
import { AppError } from '../common/errors/app-error.js';
import type { CallerCtx } from '../common/auth-user.js';
import { UpdateCountryDto } from './dto/reference-data.dto.js';

const COUNTRY_SELECT = { code: true, name: true, phonePrefix: true } as const;

/**
 * Countries (design area 1 as simplified by the owner, 2026-11-19). ROF is a global Olympiad platform: one common structure
 * (S1–S6; S1–S3 Junior, S4–S6 Senior) for every country; a country only identifies where someone or a school is, and
 * no country is ever blocked from registration. Everyone reads the list; Administrators and Super Admins
 * (reference.manage) correct a name or calling code, audited in the same transaction (COUNTRY_UPDATED) — never notified.
 */
@Injectable()
export class ReferenceDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  /** Every country by name: { code, name, phonePrefix }. */
  countries() {
    return this.prisma.country.findMany({ select: COUNTRY_SELECT, orderBy: { name: 'asc' } });
  }

  /** The administrators' list: every country (search by name or code) with its number of schools and last change. */
  adminCountries(q?: string) {
    const search = q?.trim();
    return this.prisma.country.findMany({
      where: search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { code: { equals: search.toUpperCase() } }] } : {},
      select: { ...COUNTRY_SELECT, updatedAt: true, _count: { select: { schools: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async updateCountry(code: string, dto: UpdateCountryDto, actor: CallerCtx) {
    const fields = (['name', 'phonePrefix'] as const).filter((f) => dto[f] !== undefined);
    if (fields.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Provide at least one field to change.');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.country.findUnique({ where: { code }, select: COUNTRY_SELECT });
      if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'COUNTRY_NOT_FOUND', `Country "${code}" not found.`);
      const changes = auditChanges(before, dto, [...fields]);
      if (Object.keys(changes).length === 0) return before;
      const after = await tx.country.update({
        where: { code }, data: Object.fromEntries(fields.map((f) => [f, dto[f]])), select: COUNTRY_SELECT,
      });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'COUNTRY_UPDATED', entity: 'Country', entityId: code,
        metadata: { country: code, changes },
      }, tx);
      return after;
    });
  }
}
