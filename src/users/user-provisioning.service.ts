/**
 * Account provisioning by administrators: invitations, re-sending them,
 * admin-triggered password resets and CSV bulk import.
 *
 * Invited accounts have no password and cannot log in until the person opens
 * the e-mailed activation link and chooses one (ActivationService). Students
 * are placed in a division by grade and enrolled in the current academic year
 * in the same transaction that creates them.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AcademicYearsService } from '../academic-years/academic-years.service.js';
import { ActivationService, type IssuedActivation } from '../auth/activation.service.js';
import { AuthService, PROFILE_SELECT } from '../auth/auth.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { parseCsv } from '../common/csv-parse.js';
import { divisionCodeForGrade } from '../common/grade-levels.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import { InviteUserDto } from './dto/invite-user.dto.js';

export const IMPORT_MAX_ROWS  = 1000;
export const IMPORT_MAX_BYTES = 1024 * 1024;

const KNOWN_COLUMNS = [
  'firstName', 'lastName', 'email', 'username', 'role',
  'gradeLevel', 'schoolName', 'schoolLocation', 'homeLocation',
] as const;
const REQUIRED_COLUMNS = ['firstName', 'lastName', 'email'] as const;

const INVITED_SELECT = {
  ...PROFILE_SELECT,
  isActive: true, isApproved: true, activatedAt: true,
} as const;

type Tx = Prisma.TransactionClient;

export interface ImportRowError { row: number; email?: string; errors: string[] }

@Injectable()
export class UserProvisioningService {
  constructor(
    private readonly prisma:        PrismaService,
    private readonly audit:         AuditService,
    private readonly academicYears: AcademicYearsService,
    private readonly activation:    ActivationService,
    private readonly auth:          AuthService,
  ) {}

  // ─── Invitations ──────────────────────────────────────────────────────────

  async invite(dto: InviteUserDto, caller: CallerCtx) {
    await this.assertFree(dto.email, dto.username);
    const username = dto.username ?? (await this.generateUsername(dto.email));

    const { user, issued } = await this.prisma.$transaction(
      (tx) => this.createInvited(tx, { ...dto, username }, caller),
    );
    const invitation = await this.activation.send(issued);

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'INVITE_USER', entity: 'User', entityId: user.id,
      metadata: { role: user.role, username: user.username },
    });
    return { user, invitation };
  }

  /** Send a fresh invitation (the previous link stops working). */
  async resendInvitation(userId: string, caller: CallerCtx) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { id: true, activatedAt: true, isActive: true, passwordHash: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (user.activatedAt) throw invalidState('This account is already activated.');
    if (!user.isActive)   throw invalidState('Reactivate the account before re-sending the invitation.');

    const invitation = await this.activation.issueAndSend(
      userId, user.passwordHash ? 'EMAIL_VERIFICATION' : 'INVITATION', caller.id,
    );
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'RESEND_INVITATION', entity: 'User', entityId: userId,
    });
    return invitation;
  }

  /** E-mail the user a password-reset link (admins never see or set the password). */
  async sendPasswordReset(userId: string, caller: CallerCtx) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { id: true, activatedAt: true, isActive: true, provider: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.isActive)    throw invalidState('This account is suspended.');
    if (!user.activatedAt) throw invalidState('This account is not activated yet; re-send the invitation instead.');
    if (user.provider !== 'LOCAL') throw invalidState('This account signs in with an external provider.');

    await this.auth.sendPasswordResetLink(userId, caller.id);
    return { message: 'A password-reset link has been e-mailed to the user.' };
  }

  // ─── CSV import ───────────────────────────────────────────────────────────

  /**
   * Import users from CSV. Each valid row becomes an invited account (activation
   * e-mail sent); invalid rows are reported and skipped. With dryRun nothing is
   * created — use it to check a file first.
   *
   * Columns (header row, any order, case-sensitive names):
   *   firstName*, lastName*, email*, role (STUDENT|MENTOR|ADMIN, default STUDENT),
   *   gradeLevel (required for students), schoolName, schoolLocation,
   *   homeLocation, username (generated when empty)
   */
  async importCsv(file: Express.Multer.File | undefined, dryRun: boolean, caller: CallerCtx) {
    if (!file?.buffer?.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Upload a CSV file in the "file" field.');
    }
    if (file.size > IMPORT_MAX_BYTES) {
      throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'FILE_TOO_LARGE', 'The CSV file must be at most 1 MB.');
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'INVALID_CSV', 'The file is not UTF-8 text. Save it as "CSV UTF-8".');
    }

    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(text);
    } catch (err) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_CSV', (err as Error).message);
    }

    const missing = REQUIRED_COLUMNS.filter((c) => !parsed.headers.includes(c));
    const unknown = parsed.headers.filter((h) => !(KNOWN_COLUMNS as readonly string[]).includes(h));
    if (missing.length || unknown.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_CSV_HEADER', 'The header row is not valid.', {
        missing, unknown, expected: KNOWN_COLUMNS,
      });
    }
    if (parsed.records.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_CSV', 'The file has no data rows.');
    }
    if (parsed.records.length > IMPORT_MAX_ROWS) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_ROWS', `At most ${IMPORT_MAX_ROWS} rows per import.`);
    }

    // ── Validate every row ────────────────────────────────────────────────
    const errors: ImportRowError[] = [];
    const valid: Array<{ row: number; dto: InviteUserDto }> = [];
    const seenEmails = new Map<string, number>();
    const seenUsernames = new Map<string, number>();

    for (const rec of parsed.records) {
      const dto = plainToInstance(InviteUserDto, rec.values);
      const problems = (await validate(dto, { whitelist: true, forbidNonWhitelisted: false }))
        .flatMap((e) => Object.values(e.constraints ?? {}));

      if (dto.email) {
        const first = seenEmails.get(dto.email);
        if (first) problems.push(`email repeats row ${first}.`);
        else seenEmails.set(dto.email, rec.line);
      }
      if (dto.username) {
        const first = seenUsernames.get(dto.username);
        if (first) problems.push(`username repeats row ${first}.`);
        else seenUsernames.set(dto.username, rec.line);
      }

      if (problems.length) errors.push({ row: rec.line, email: rec.values['email'], errors: problems });
      else valid.push({ row: rec.line, dto });
    }

    // ── Against existing accounts ────────────────────────────────────────
    const existing = await this.prisma.user.findMany({
      where: {
        OR: [
          { email: { in: valid.map((v) => v.dto.email) } },
          { username: { in: valid.flatMap((v) => (v.dto.username ? [v.dto.username] : [])) } },
        ],
      },
      select: { email: true, username: true },
    });
    const takenEmails = new Set(existing.map((u) => u.email));
    const takenUsernames = new Set(existing.map((u) => u.username));
    const ready = valid.filter((v) => {
      const problems = [
        ...(takenEmails.has(v.dto.email) ? ['an account with this email already exists.'] : []),
        ...(v.dto.username && takenUsernames.has(v.dto.username) ? ['this username is already taken.'] : []),
      ];
      if (problems.length) errors.push({ row: v.row, email: v.dto.email, errors: problems });
      return problems.length === 0;
    });

    if (ready.length && !dryRun) await this.academicYears.current(); // fail fast if students can't be enrolled

    // ── Create ───────────────────────────────────────────────────────────
    const created: Array<{ row: number; id: string; username: string; email: string; role: string }> = [];
    if (!dryRun) {
      for (const v of ready) {
        try {
          const username = v.dto.username ?? (await this.generateUsername(v.dto.email));
          const { user, issued } = await this.prisma.$transaction(
            (tx) => this.createInvited(tx, { ...v.dto, username }, caller),
          );
          await this.activation.send(issued);
          created.push({ row: v.row, id: user.id, username: user.username, email: user.email, role: user.role });
        } catch (err) {
          errors.push({ row: v.row, email: v.dto.email, errors: [(err as Error).message] });
        }
      }
    }

    errors.sort((a, b) => a.row - b.row);
    const summary = {
      dryRun,
      totalRows: parsed.records.length,
      valid:     ready.length,
      created:   created.length,
      failed:    errors.length,
      errors,
      users:     created,
    };

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: dryRun ? 'IMPORT_USERS_DRY_RUN' : 'IMPORT_USERS', entity: 'User',
      metadata: {
        fileName: file.originalname, totalRows: summary.totalRows,
        created: summary.created, failed: summary.failed,
        createdUserIds: created.map((c) => c.id),
      },
    });
    return summary;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Create an invited (password-less, not activated) account and its activation token. */
  private async createInvited(
    tx: Tx, dto: InviteUserDto & { username: string }, caller: CallerCtx,
  ): Promise<{ user: Prisma.UserGetPayload<{ select: typeof INVITED_SELECT }>; issued: IssuedActivation }> {
    const role = dto.role ?? 'STUDENT';
    const isStudent = role === 'STUDENT';

    let schoolId: string | null = null;
    if (isStudent && dto.schoolId) {
      const school = await tx.school.findUnique({ where: { id: dto.schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException('School not found.');
      schoolId = school.id;
    } else if (isStudent && dto.schoolName) {
      const school = await tx.school.upsert({
        where:  { name: dto.schoolName },
        update: {},
        create: { name: dto.schoolName, location: dto.schoolLocation ?? 'Unknown' },
      });
      schoolId = school.id;
    }

    const division = isStudent
      ? await tx.division.findUniqueOrThrow({ where: { code: divisionCodeForGrade(dto.gradeLevel!) }, select: { id: true } })
      : null;

    const created = await tx.user.create({
      data: {
        firstName:    dto.firstName,
        lastName:     dto.lastName,
        email:        dto.email,
        username:     dto.username,
        role,
        passwordHash: null,
        activatedAt:  null,
        ...(isStudent && {
          gradeLevel:   dto.gradeLevel,
          divisionId:   division!.id,
          schoolId,
          homeLocation: dto.homeLocation ?? null,
        }),
      },
      select: { id: true },
    });

    if (isStudent) await this.academicYears.enrollInCurrentYear(tx, created.id, dto.gradeLevel!, schoolId);
    const issued = await this.activation.issue(created.id, 'INVITATION', caller.id, tx);
    const user = await tx.user.findUniqueOrThrow({ where: { id: created.id }, select: INVITED_SELECT });
    return { user, issued };
  }

  private async assertFree(email: string, username?: string) {
    const clash = await this.prisma.user.findFirst({
      where:  { OR: [{ email }, ...(username ? [{ username }] : [])] },
      select: { id: true },
    });
    if (clash) throw new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');
  }

  /** "Jean.Uwase+rof@x.org" → "jean.uwase", then "jean.uwase2", … if taken. */
  private async generateUsername(email: string): Promise<string> {
    let base = email.split('@')[0].toLowerCase().replace(/\+.*$/, '').replace(/[^a-z0-9._-]/g, '.')
      .replace(/\.{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 26);
    if (base.length < 3) base = `${base}user`.slice(0, 26);

    const taken = new Set(
      (await this.prisma.user.findMany({ where: { username: { startsWith: base } }, select: { username: true } }))
        .map((u) => u.username),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; i < 10_000; i++) {
      const candidate = `${base}${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new AppError(HttpStatus.CONFLICT, 'USERNAME_UNAVAILABLE', 'Could not generate a username; provide one.');
  }
}
