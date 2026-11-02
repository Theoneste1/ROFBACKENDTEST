import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import { DIVISION_GRADES, divisionCodeForGrade } from '../common/grade-levels.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { DivisionCode, GradeLevel } from '../generated/prisma/client.js';
import { UpdateDivisionDto } from './dto/update-division.dto.js';

@Injectable()
export class DivisionsService {
  private idsByCode: Map<DivisionCode, string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  async findAll(includeCounts = false) {
    const divisions = await this.prisma.division.findMany({
      orderBy: { code: 'asc' },
      select: {
        id: true, code: true, name: true, description: true, isActive: true,
        ...(includeCounts && {
          _count: { select: { students: true, mentorAssignments: true } },
        }),
      },
    });
    return divisions.map((d) => ({ ...d, gradeLevels: DIVISION_GRADES[d.code] }));
  }

  /** The division id a grade level belongs to (cached — divisions are fixed). */
  async idForGrade(grade: GradeLevel): Promise<string> {
    return this.idForCode(divisionCodeForGrade(grade));
  }

  async idForCode(code: DivisionCode): Promise<string> {
    if (!this.idsByCode) {
      const rows = await this.prisma.division.findMany({ select: { id: true, code: true } });
      this.idsByCode = new Map(rows.map((r) => [r.code, r.id]));
    }
    const id = this.idsByCode.get(code);
    if (!id) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'DIVISIONS_NOT_SEEDED',
        'Divisions are not configured. Run the database seed.',
      );
    }
    return id;
  }

  async requireDivision(id: string) {
    const d = await this.prisma.division.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Division not found.');
    return d;
  }

  /** Admin: edit name/description/active flag. Divisions cannot be created or deleted. */
  async update(id: string, dto: UpdateDivisionDto, caller: CallerCtx) {
    await this.requireDivision(id);
    const updated = await this.prisma.division.update({ where: { id }, data: dto });
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'UPDATE_DIVISION', entity: 'Division', entityId: id, metadata: { ...dto },
    });
    return { ...updated, gradeLevels: DIVISION_GRADES[updated.code] };
  }
}
