/**
 * Banking information (owner 2026-11-25; rules in banking-rules.ts).
 *  - GET /me/banking: the caller's own details, what is missing or to correct, and how their banks are given.
 *  - PUT /me/banking: all six fields at once; checked here (the frontend only mirrors it). The fixed banks are set
 *    here; another bank for them is refused. Saving ends the sign-in lock on the next request.
 *  - GET /admin/users/:id/banking (users.manage): the status and the details with account numbers masked; ?reveal=true
 *    shows them in full and is audited (BANK_DETAILS_VIEWED).
 * Account numbers never appear in the audit log, an error message or a URL.
 */
import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  BANK_DETAILS_SELECT, BANKING_FIELDS, bankConflicts, bankingRequiredFor, bankingSummary, bankRules, checkSubmission, FIELD_LABELS, maskAccountNumber,
  type BankingDetails,
} from './banking-rules.js';
import type { SaveBankingDto } from './banking.dto.js';

const DETAILS_SELECT = BANK_DETAILS_SELECT;

@Injectable()
export class BankingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async detailsOf(userId: string): Promise<BankingDetails | null> {
    return this.prisma.userBankDetails.findUnique({ where: { userId }, select: { ...DETAILS_SELECT, updatedAt: true } });
  }

  /** The caller's own banking information (full numbers: their own data). */
  async mine(user: AuthUser) {
    if (!bankingRequiredFor(user.role)) {
      return { required: false, status: null, missing: [], invalid: [], conflicts: [], rules: null, details: null, fieldLabels: FIELD_LABELS };
    }
    const details = await this.detailsOf(user.id);
    // `conflicts`: saved banks this role may not use — shown, and replaced only when the user confirms it (confirmReplace).
    return { ...bankingSummary(user.role, details), conflicts: bankConflicts(user.role, details), rules: bankRules(user.role), details, fieldLabels: FIELD_LABELS };
  }

  /** Save all six fields (the caller's own row only). 400 BANKING_INVALID with the problem of each field. */
  async save(user: AuthUser, dto: SaveBankingDto) {
    if (!bankingRequiredFor(user.role)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'BANKING_NOT_APPLICABLE', 'Banking information is asked only of Teachers, Coaches and Head Coaches.');
    }
    const before = await this.detailsOf(user.id);
    const { confirmReplace = [], ...input } = dto;
    const checked = checkSubmission(user.role, input, before, confirmReplace);
    if (!checked.ok) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BANKING_INVALID', 'Check the highlighted fields and try again.',
        { fields: checked.errors, confirmationNeeded: checked.confirmationNeeded });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.userBankDetails.upsert({ where: { userId: user.id }, create: { userId: user.id, ...checked.values }, update: checked.values });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'BANK_DETAILS_SAVED', entity: 'User', entityId: user.id,
        // Which fields changed — never their values.
        metadata: { changed: BANKING_FIELDS.filter((f) => (before?.[f] ?? null) !== checked.values[f]), first: before === null },
      }, tx);
    });
    return this.mine(user);
  }

  /** An administrator's view of one person's banking information: masked unless revealed (audited). */
  async forAdmin(userId: string, reveal: boolean, actor: AuthUser) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!u) throw new AppError(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'User not found.');
    const details = bankingRequiredFor(u.role) ? await this.detailsOf(u.id) : null;
    const summary = bankingSummary(u.role, details);
    if (reveal && details) {
      await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: 'BANK_DETAILS_VIEWED', entity: 'User', entityId: u.id, metadata: {} });
    }
    return {
      ...summary,
      missingLabels: summary.missing.map((f) => FIELD_LABELS[f]),
      invalidLabels: summary.invalid.map((f) => FIELD_LABELS[f]),
      details: details && {
        personalAccountName: details.personalAccountName ?? null,
        personalBankName: details.personalBankName ?? null,
        personalAccountNumber: reveal ? details.personalAccountNumber ?? null : maskAccountNumber(details.personalAccountNumber),
        schoolAccountName: details.schoolAccountName ?? null,
        schoolBankName: details.schoolBankName ?? null,
        schoolAccountNumber: reveal ? details.schoolAccountNumber ?? null : maskAccountNumber(details.schoolAccountNumber),
        revealed: reveal,
      },
    };
  }

  /**
   * The banking status of many users at once (the Users list: one query per page). Users of other roles: absent.
   */
  async statusOf(users: Array<{ id: string; role: string }>) {
    const ids = users.filter((u) => bankingRequiredFor(u.role)).map((u) => u.id);
    const rows = ids.length ? await this.prisma.userBankDetails.findMany({ where: { userId: { in: ids } }, select: { userId: true, ...DETAILS_SELECT } }) : [];
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    const out = new Map<string, { status: string; missing: string[]; invalid: string[] }>();
    for (const u of users) {
      if (!bankingRequiredFor(u.role)) continue;
      const s = bankingSummary(u.role, byUser.get(u.id));
      out.set(u.id, { status: s.status!, missing: s.missing, invalid: s.invalid });
    }
    return out;
  }

  /**
   * The ids of Teachers / Coaches / Head Coaches (optionally of one role) whose banking status is one of `statuses`
   * (the Users list filter). The status depends on the role, so it is computed, not stored.
   */
  async idsWithStatus(statuses: string[], role?: string) {
    const users = await this.prisma.user.findMany({
      where: { role: role && bankingRequiredFor(role) ? (role as 'TEACHER') : { in: ['TEACHER', 'MENTOR', 'HEAD_COACH'] } },
      select: { id: true, role: true, bankDetails: { select: DETAILS_SELECT } },
    });
    return users.filter((u) => statuses.includes(bankingSummary(u.role, u.bankDetails).status ?? '')).map((u) => u.id);
  }
}
