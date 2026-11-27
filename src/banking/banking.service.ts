/**
 * Banking information (owner 2026-11-25; rules in banking-rules.ts).
 *  - GET /me/banking: the caller's own details, what is missing or to correct, and how their banks are given.
 *  - PUT /me/banking: the role's fields at once (six for Teachers, the three personal ones for Coaches and Head
 *    Coaches); checked here (the frontend only mirrors it). Only those are written: a coach's saved school details are
 *    kept. The fixed banks are set here; another bank for them is refused. Saving ends the sign-in lock on the next
 *    request.
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
  BANK_DETAILS_SELECT, BANKING_FIELDS, DEFAULT_BANKS, UMWALIMU_SACCO, bankConflicts, bankingRequiredFor, requiredFields, bankingSummary, bankRules,
  checkSubmission, FIELD_LABELS, maskAccountNumber, normalizeBanks, numberProblem, numberInstruction,
  type BankOption, type BankingDetails,
} from './banking-rules.js';
import type { SaveBankingDto, SetBanksDto } from './banking.dto.js';

/** SystemSetting key of the bank list the Super Administrator manages (no table of its own). */
export const BANKS_KEY = 'banking.banks';

const DETAILS_SELECT = BANK_DETAILS_SELECT;

@Injectable()
export class BankingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** The bank list: as the Super Administrator set it, else the agreed starting list (always with Umwalimu SACCO, 12 digits). */
  async banks(): Promise<BankOption[]> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: BANKS_KEY } });
    return normalizeBanks(Array.isArray(row?.value) ? (row.value as Partial<BankOption>[]) : DEFAULT_BANKS);
  }

  /**
   * The Super Administrator's view of the bank list: each bank with its instruction, how many people use it, and how many
   * of their saved account numbers do not follow its rule (they are not locked out; they are asked when they next save).
   */
  async adminBanks() {
    const banks = await this.banks();
    return { banks: await this.withUsage(banks), fixedBank: UMWALIMU_SACCO };
  }

  private async withUsage(banks: BankOption[]) {
    const rows = await this.prisma.userBankDetails.findMany({ select: { personalBankName: true, personalAccountNumber: true, schoolBankName: true, schoolAccountNumber: true } });
    return banks.map((b) => {
      const key = b.name.toLowerCase();
      let people = 0;
      let notFollowing = 0;
      for (const r of rows) {
        for (const [bank, number] of [[r.personalBankName, r.personalAccountNumber], [r.schoolBankName, r.schoolAccountNumber]] as const) {
          if ((bank ?? '').trim().toLowerCase() !== key) continue;
          people++;
          if (number && numberProblem(b, number)) notFollowing++;
        }
      }
      return { ...b, instruction: numberInstruction(b), accounts: people, accountsNotFollowingRule: notFollowing };
    });
  }

  /**
   * The Super Administrator sets the bank list (owner 2026-11-27). Umwalimu SACCO always stays, available, exactly 12
   * digits. A bank someone uses cannot be removed (switch it off instead: it then can no longer be chosen, and whoever has
   * it keeps it). Audited with the reason, before and after. Saved details are never changed.
   */
  async setBanks(dto: SetBanksDto, actor: AuthUser) {
    if (actor.role !== 'SUPER_ADMIN') {
      throw new AppError(HttpStatus.FORBIDDEN, 'SUPER_ADMIN_REQUIRED', 'Only a Super Administrator can change the bank list.');
    }
    const next = normalizeBanks(dto.banks);
    const before = await this.banks();
    const kept = new Set(next.map((b) => b.name.toLowerCase()));
    const usage = await this.withUsage(before);
    const removedInUse = usage.filter((b) => !kept.has(b.name.toLowerCase()) && b.accounts > 0);
    if (removedInUse.length) {
      throw new AppError(HttpStatus.CONFLICT, 'BANK_IN_USE',
        `${removedInUse.map((b) => b.name).join(', ')} ${removedInUse.length === 1 ? 'is' : 'are'} used by saved bank details and cannot be removed. Switch ${removedInUse.length === 1 ? 'it' : 'them'} off instead.`,
        { banks: removedInUse.map((b) => ({ name: b.name, accounts: b.accounts })) });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: BANKS_KEY },
        create: { key: BANKS_KEY, value: next as unknown as object, updatedById: actor.id },
        update: { value: next as unknown as object, updatedById: actor.id },
      });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'BANKING_BANKS_UPDATED', entity: 'SystemSetting', entityId: BANKS_KEY,
        metadata: { reason: dto.reason.trim(), before, after: next },
      }, tx);
    });
    return this.adminBanks();
  }

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
    return { ...bankingSummary(user.role, details), conflicts: bankConflicts(user.role, details), rules: bankRules(user.role, await this.banks()), details, fieldLabels: FIELD_LABELS };
  }

  /** Save the role's fields (the caller's own row only). 400 BANKING_INVALID with the problem of each field. */
  async save(user: AuthUser, dto: SaveBankingDto) {
    if (!bankingRequiredFor(user.role)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'BANKING_NOT_APPLICABLE', 'Banking information is asked only of Teachers, Coaches and Head Coaches.');
    }
    const before = await this.detailsOf(user.id);
    const { confirmReplace = [], ...input } = dto;
    const checked = checkSubmission(user.role, input, before, confirmReplace, await this.banks());
    if (!checked.ok) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BANKING_INVALID', 'Check the highlighted fields and try again.',
        { fields: checked.errors, confirmationNeeded: checked.confirmationNeeded });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.userBankDetails.upsert({ where: { userId: user.id }, create: { userId: user.id, ...checked.values }, update: checked.values });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'BANK_DETAILS_SAVED', entity: 'User', entityId: user.id,
        // Which of the role's fields changed — never their values.
        metadata: { changed: BANKING_FIELDS.filter((f) => f in checked.values && (before?.[f] ?? null) !== checked.values[f]), first: before === null },
      }, tx);
    });
    return this.mine(user);
  }

  /**
   * An administrator changes one person's banking information (users.manage; owner 2026-11-25): the same rules as the
   * person's own form, for the person's role; only that role's fields are written (a coach's saved school details
   * stay). Audited: which fields changed, never their values. Answers the masked view.
   */
  async saveForAdmin(userId: string, dto: SaveBankingDto, actor: AuthUser) {
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!target) throw new AppError(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'User not found.');
    if (!bankingRequiredFor(target.role)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BANKING_NOT_APPLICABLE', 'Banking information is kept only for Teachers, Coaches and Head Coaches.');
    }
    const before = await this.detailsOf(target.id);
    const { confirmReplace = [], ...input } = dto;
    const checked = checkSubmission(target.role, input, before, confirmReplace, await this.banks());
    if (!checked.ok) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BANKING_INVALID', 'Check the highlighted fields and try again.',
        { fields: checked.errors, confirmationNeeded: checked.confirmationNeeded });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.userBankDetails.upsert({ where: { userId: target.id }, create: { userId: target.id, ...checked.values }, update: checked.values });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'BANK_DETAILS_UPDATED_BY_ADMIN', entity: 'User', entityId: target.id,
        metadata: { changed: BANKING_FIELDS.filter((f) => f in checked.values && (before?.[f] ?? null) !== checked.values[f]), first: before === null },
      }, tx);
    });
    return this.forAdmin(target.id, false, actor);
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
      // The fields this person's role gives (six for a Teacher, three personal ones for a Coach or Head Coach).
      requiredFields: bankingRequiredFor(u.role) ? requiredFields(u.role) : [],
      // How this person's banks are chosen (the administrator's edit form uses the same list and rules).
      rules: bankingRequiredFor(u.role) ? bankRules(u.role, await this.banks()) : null,
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
