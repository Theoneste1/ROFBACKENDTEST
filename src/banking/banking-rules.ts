/**
 * Banking information: Teachers, Coaches and Head Coaches give their bank details before using the platform. One set of
 * rules for the completion check (sign-in lock, GET /me, the administrators' views) and for saving (PUT /me/banking and an
 * administrator's edit). Pure (unit-tested); the frontend mirrors it.
 *
 * Rules (owner 2026-11-25, revised 2026-11-27):
 *  - Teachers give all six fields (personal and school); Coaches and Head Coaches the three PERSONAL fields only (school
 *    details are neither asked nor required of them; any saved earlier are kept as they are).
 *  - Every bank is CHOSEN from the bank list, which the Super Administrator manages (SystemSetting `banking.banks`,
 *    banking-banks.ts). Teachers are no longer fixed to Umwalimu SACCO (owner 2026-11-27).
 *  - Account numbers follow the CHOSEN bank's rule: Umwalimu SACCO always exactly 12 digits ("Umwalimu SACCO account
 *    numbers must contain exactly 12 digits."); another bank its configured digits rule (exactly N, or N to M), or, with
 *    no rule, the general check (5–40 characters: digits, letters, spaces or hyphens, at least one digit).
 *  - Account names contain no digit.
 *  - Students, Administrators and Super Administrators: not asked.
 *
 * Completion (the sign-in lock) uses only rules that cannot change under anyone's feet: every required field filled,
 * names without digits, Umwalimu SACCO numbers of exactly 12 digits. The configurable bank rules apply when details are
 * SAVED, and a value the person leaves unchanged is never refused — so editing the bank list never locks anyone out.
 */

export const UMWALIMU_SACCO = 'Umwalimu SACCO';
export const SACCO_DIGITS = 12;
export const SACCO_NUMBER_MESSAGE = 'Umwalimu SACCO account numbers must contain exactly 12 digits.';
/** @deprecated kept for compatibility: the 12-digit message now follows the bank, not the role. */
export const TEACHER_NUMBER_MESSAGE = SACCO_NUMBER_MESSAGE;
export const SCHOOL_NUMBER_MESSAGE = SACCO_NUMBER_MESSAGE;
export const GENERAL_NUMBER_MESSAGE = 'An account number has 5 to 40 characters: digits, letters, spaces or hyphens, with at least one digit.';

/** The banks agreed on 2026-11-25: the starting list until the Super Administrator changes it. */
export const BANKS = [
  'Access Bank Rwanda Plc',
  'Bank of Kigali Plc',
  'Bank of Africa Rwanda Plc',
  'BPR Bank Rwanda Plc',
  'Ecobank Rwanda Plc',
  'Equity Bank Rwanda Plc',
  'Guaranty Trust Bank Rwanda Plc (GT Bank)',
  'I&M Bank Rwanda Plc',
  'NCBA Bank Rwanda Plc',
  'Rwanda Development Bank (BRD)',
  'Zigama Credit and Savings Bank',
  UMWALIMU_SACCO,
] as const;

/** One bank of the list: its name, whether it can be chosen, and its account-number digits rule (null: general check). */
export interface BankOption {
  name: string;
  active: boolean;
  minDigits: number | null;
  maxDigits: number | null;
}

const isSacco = (name: string | null | undefined) => (name ?? '').trim().toLowerCase() === UMWALIMU_SACCO.toLowerCase();

/** The starting list: the agreed banks, Umwalimu SACCO with its 12-digit rule, the others with the general check. */
export const DEFAULT_BANKS: readonly BankOption[] = BANKS.map((name) => ({
  name, active: true, minDigits: isSacco(name) ? SACCO_DIGITS : null, maxDigits: isSacco(name) ? SACCO_DIGITS : null,
}));

/**
 * A bank list made safe: names trimmed, duplicates (any case) dropped, digit rules sane, and Umwalimu SACCO always
 * present, always available and always exactly 12 digits (the owner's fixed rule).
 */
export function normalizeBanks(list: readonly Partial<BankOption>[] | null | undefined): BankOption[] {
  const out: BankOption[] = [];
  const seen = new Set<string>();
  for (const b of list ?? []) {
    const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    let min = Number.isInteger(b.minDigits) && (b.minDigits as number) > 0 ? (b.minDigits as number) : null;
    let max = Number.isInteger(b.maxDigits) && (b.maxDigits as number) > 0 ? (b.maxDigits as number) : null;
    if (min !== null && max === null) max = min;
    if (max !== null && min === null) min = max;
    if (min !== null && max !== null && min > max) [min, max] = [max, min];
    out.push(isSacco(name)
      ? { name: UMWALIMU_SACCO, active: true, minDigits: SACCO_DIGITS, maxDigits: SACCO_DIGITS }
      : { name, active: b.active !== false, minDigits: min, maxDigits: max });
  }
  if (!seen.has(UMWALIMU_SACCO.toLowerCase())) out.push({ name: UMWALIMU_SACCO, active: true, minDigits: SACCO_DIGITS, maxDigits: SACCO_DIGITS });
  return out;
}

/** The instruction shown for a bank's account number (and the message when it is not followed). */
export function numberInstruction(bank: BankOption | null | undefined): string {
  if (!bank || bank.minDigits === null || bank.maxDigits === null) return GENERAL_NUMBER_MESSAGE;
  if (isSacco(bank.name)) return SACCO_NUMBER_MESSAGE;
  return bank.minDigits === bank.maxDigits
    ? `${bank.name} account numbers must contain exactly ${bank.minDigits} digits.`
    : `${bank.name} account numbers must contain between ${bank.minDigits} and ${bank.maxDigits} digits.`;
}

/** Why an account number does not suit the chosen bank (null: fine). */
export function numberProblem(bank: BankOption | null | undefined, value: string): string | null {
  if (bank && bank.minDigits !== null && bank.maxDigits !== null) {
    return /^\d+$/.test(value) && value.length >= bank.minDigits && value.length <= bank.maxDigits ? null : numberInstruction(bank);
  }
  return /^[0-9A-Za-z -]{5,40}$/.test(value) && /\d/.test(value) ? null : GENERAL_NUMBER_MESSAGE;
}

/** The roles that must give their banking information. */
export const BANKING_ROLES = ['TEACHER', 'MENTOR', 'HEAD_COACH'] as const;

export const BANKING_FIELDS = [
  'personalAccountName', 'personalBankName', 'personalAccountNumber',
  'schoolAccountName', 'schoolBankName', 'schoolAccountNumber',
] as const;
export type BankingField = (typeof BANKING_FIELDS)[number];

export const PERSONAL_FIELDS = ['personalAccountName', 'personalBankName', 'personalAccountNumber'] as const;

/** The fields this role must give: all six for Teachers, the three personal ones for Coaches and Head Coaches. */
export function requiredFields(role: string): readonly BankingField[] {
  return role === 'TEACHER' ? BANKING_FIELDS : PERSONAL_FIELDS;
}

/** The bank-name fields (both chosen from the list). */
export const FIXABLE_BANK_FIELDS = ['personalBankName', 'schoolBankName'] as const;
export type FixableBankField = (typeof FIXABLE_BANK_FIELDS)[number];

/** Prisma select of the six fields (the sign-in check reads them with the user). */
export const BANK_DETAILS_SELECT = {
  personalAccountName: true, personalBankName: true, personalAccountNumber: true,
  schoolAccountName: true, schoolBankName: true, schoolAccountNumber: true,
} as const;
export type BankingDetails = Partial<Record<BankingField, string | null>>;

/** Words for each field (messages, the administrators' "missing" list). */
export const FIELD_LABELS: Record<BankingField, string> = {
  personalAccountName: 'Bank account name',
  personalBankName: 'Bank name',
  personalAccountNumber: 'Bank account number',
  schoolAccountName: 'School bank account name',
  schoolBankName: 'School bank name',
  schoolAccountNumber: 'School bank account number',
};

/** An account name with a digit (owner 2026-11-25: names contain no digit). */
export const NAME_DIGIT_MESSAGES = {
  personalAccountName: 'The bank account name must not contain numbers. Write the name exactly as on the account.',
  schoolAccountName: "The school's bank account name must not contain numbers. Write the name exactly as on the account.",
} as const;

export type BankingStatus = 'COMPLETE' | 'PARTIAL' | 'NOT_STARTED' | 'NEEDS_CORRECTION';

export function bankingRequiredFor(role: string | null | undefined): boolean {
  return (BANKING_ROLES as readonly string[]).includes(role ?? '');
}

/** The bank field of an account-number field. */
const bankFieldOf = (f: 'personalAccountNumber' | 'schoolAccountNumber'): FixableBankField =>
  f === 'personalAccountNumber' ? 'personalBankName' : 'schoolBankName';

/** How this role gives its banks: chosen from the (active) list, with each bank's account-number instruction. */
export function bankRules(role: string, banks: readonly BankOption[] = DEFAULT_BANKS) {
  const teacher = role === 'TEACHER';
  const list = normalizeBanks(banks).filter((b) => b.active);
  return {
    personalBank: 'LIST' as const,
    schoolBank: 'LIST' as const,
    /** The suggested bank (Teachers: Umwalimu SACCO, as before). */
    fixedBank: UMWALIMU_SACCO,
    banks: list.map((b) => b.name),
    /** Each bank's digits rule and instruction, for the form (changes as soon as the bank changes). */
    bankOptions: list.map((b) => ({ ...b, instruction: numberInstruction(b) })),
    generalInstruction: GENERAL_NUMBER_MESSAGE,
    /** @deprecated digits now follow the chosen bank (bankOptions). */
    personalNumberDigits: null,
    schoolNumberDigits: null,
    /** Whether the school's bank details are asked (Teachers only). */
    schoolRequired: teacher,
    /** The fields this role gives, in form order. */
    fields: [...requiredFields(role)],
  };
}

const filled = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim().length > 0;

/** No bank is fixed any more (owner 2026-11-27: Teachers choose their banks too). */
export function isFixedBank(_role: string, _field: BankingField): _field is FixableBankField {
  return false;
}

/**
 * Why a SAVED value breaks the stable rules (null: fine) — the completion check. Names without digits; a number kept with
 * Umwalimu SACCO has exactly 12 digits. Bank names and other banks' digit rules are checked on saving only.
 */
export function fieldProblem(_role: string, field: BankingField, value: string, details?: BankingDetails | null): string | null {
  switch (field) {
    case 'personalAccountName':
    case 'schoolAccountName':
      return /\d/.test(value) ? NAME_DIGIT_MESSAGES[field] : null;
    case 'personalAccountNumber':
    case 'schoolAccountNumber':
      return isSacco(details?.[bankFieldOf(field)]) && !/^\d{12}$/.test(value) ? SACCO_NUMBER_MESSAGE : null;
    default:
      return null;
  }
}

export interface BankingConflict {
  field: FixableBankField;
  saved: string;
}

/** No saved bank conflicts any more: every bank is chosen (kept for the API's `conflicts`, always empty). */
export function bankConflicts(_role: string, _saved: BankingDetails | null | undefined): BankingConflict[] {
  return [];
}

export interface BankingSummary {
  required: boolean;
  status: BankingStatus | null;
  /** Fields not given yet. */
  missing: BankingField[];
  /** Fields given but breaking the stable rules (to correct; never changed by the system). */
  invalid: BankingField[];
}

/** The completion of one user's saved details under their current role (stable rules only; see the top). */
export function bankingSummary(role: string, details: BankingDetails | null | undefined): BankingSummary {
  if (!bankingRequiredFor(role)) return { required: false, status: null, missing: [], invalid: [] };
  const missing: BankingField[] = [];
  const invalid: BankingField[] = [];
  const fields = requiredFields(role);
  for (const f of fields) {
    const v = details?.[f];
    if (!filled(v)) missing.push(f);
    else if (fieldProblem(role, f, v, details)) invalid.push(f);
  }
  const status: BankingStatus = invalid.length ? 'NEEDS_CORRECTION'
    : missing.length === 0 ? 'COMPLETE'
    : missing.length === fields.length ? 'NOT_STARTED'
    : 'PARTIAL';
  return { required: true, status, missing, invalid };
}

/** Whether this user must still complete their banking information (the sign-in lock). */
export function bankingIncomplete(role: string, details: BankingDetails | null | undefined): boolean {
  const { status } = bankingSummary(role, details);
  return status !== null && status !== 'COMPLETE';
}

export const confirmReplaceMessage = (saved: string) =>
  `Your saved bank “${saved}” cannot be used here. Confirm that ${UMWALIMU_SACCO} replaces it.`;

/**
 * A submission (the role's required fields) checked against the bank list and what is already saved. Fields the role
 * does not give are ignored (never saved). A bank must be one of the list's available banks — or the one already saved
 * (a bank later switched off stays valid for whoever has it). An account number follows its chosen bank's rule; a number
 * left unchanged with an unchanged bank is never refused. Names are trimmed at their ends; nothing else is changed.
 */
export function checkSubmission(
  role: string,
  input: BankingDetails,
  saved: BankingDetails | null | undefined = null,
  _confirmReplace: readonly string[] = [],
  banks: readonly BankOption[] = DEFAULT_BANKS,
): { ok: true; values: Partial<Record<BankingField, string>> }
  | { ok: false; errors: Partial<Record<BankingField, string>>; confirmationNeeded: FixableBankField[] } {
  const list = normalizeBanks(banks);
  const find = (name: string) => list.find((b) => b.name.toLowerCase() === name.trim().toLowerCase());
  const errors: Partial<Record<BankingField, string>> = {};
  const values: Partial<Record<BankingField, string>> = {};
  const fields = requiredFields(role);
  for (const f of fields) {
    const v = input[f];
    if (!filled(v)) {
      errors[f] = f.endsWith('BankName') ? 'Choose the bank from the list.' : `${FIELD_LABELS[f]} is required.`;
      continue;
    }
    if (f === 'personalBankName' || f === 'schoolBankName') {
      const bank = find(v);
      const keptAsSaved = filled(saved?.[f]) && saved![f]!.trim().toLowerCase() === v.trim().toLowerCase();
      if (!bank && !keptAsSaved) { errors[f] = 'Choose the bank from the list.'; continue; }
      if (bank && !bank.active && !keptAsSaved) { errors[f] = `${bank.name} can no longer be chosen. Choose another bank from the list.`; continue; }
      values[f] = bank ? bank.name : v.trim();
      continue;
    }
    if (f === 'personalAccountName' || f === 'schoolAccountName') {
      const value = v.trim();
      if (/\d/.test(value)) errors[f] = NAME_DIGIT_MESSAGES[f];
      else values[f] = value;
      continue;
    }
    // An account number, against the bank chosen in this submission.
    const bankField = bankFieldOf(f);
    const chosen = input[bankField] ?? saved?.[bankField] ?? null;
    const bank = chosen ? find(chosen) : undefined;
    const unchanged = saved?.[f] === v && (saved?.[bankField] ?? '').trim().toLowerCase() === (chosen ?? '').trim().toLowerCase();
    const problem = isSacco(chosen) ? (/^\d{12}$/.test(v) ? null : SACCO_NUMBER_MESSAGE)
      : unchanged ? null
      : numberProblem(bank, v);
    if (problem) errors[f] = problem;
    else values[f] = v;
  }
  return Object.keys(errors).length ? { ok: false, errors, confirmationNeeded: [] } : { ok: true, values };
}

/** An account number for a summary: the last 4 characters only ("•••• 1234"); null stays null. */
export function maskAccountNumber(n: string | null | undefined): string | null {
  if (!filled(n)) return null;
  return n.length <= 4 ? '••••' : `•••• ${n.slice(-4)}`;
}
