/**
 * Banking information (owner 2026-11-25): Teachers, Coaches and Head Coaches give their personal and their school's
 * bank details before using the platform. One set of rules for the completion check (sign-in lock, GET /me, the
 * administrators' views) and for saving (PUT /me/banking). Pure (unit-tested); the frontend mirrors it.
 *
 * The agreed rules, and only those (final requirements, owner 2026-11-25):
 *  - Teachers give all six fields: personal and school. Both banks are Umwalimu SACCO (fixed, never chosen); both
 *    account numbers are exactly 12 digits, as every Umwalimu SACCO number ("Your Umwalimu SACCO account number must
 *    contain exactly 12 digits." / "The school's Umwalimu SACCO account number must contain exactly 12 digits.";
 *    owner 2026-11-25, after the release: the school number was accepted in any format).
 *  - Coaches and Head Coaches give the three PERSONAL fields only; the personal bank is chosen from BANKS. School bank
 *    details are neither asked nor required of them: never counted as missing, never checked, and any saved earlier
 *    are kept as they are (never deleted or overwritten).
 *  - Every required field is required.
 *  - Account names (personal and school, every role) contain no digit (owner 2026-11-25).
 *  - No other format is imposed: other account numbers, and names otherwise, are kept exactly as given (ROF agreed no
 *    rule for them). The request caps lengths (200 characters for names, 40 for numbers: SaveBankingDto) only as a
 *    technical guard against oversized input, far above any real account name or number.
 *  - Students, Administrators and Super Administrators: not asked.
 *
 * A saved value that breaks the current rules (e.g. a Coach's bank kept after the account became a Teacher) is never
 * replaced by the system. It is reported (NEEDS_CORRECTION, the field named), shown to the user, and replaced by
 * Umwalimu SACCO only when the user explicitly confirms it for that field (`confirmReplace`).
 */

export const UMWALIMU_SACCO = 'Umwalimu SACCO';

/** The banks a Coach or Head Coach may choose: the owner's agreed list (2026-11-25), names exactly as agreed. */
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

/** The bank fields that may be fixed to Umwalimu SACCO (and so may need a confirmed replacement). */
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

export const TEACHER_NUMBER_MESSAGE = 'Your Umwalimu SACCO account number must contain exactly 12 digits.';
export const SCHOOL_NUMBER_MESSAGE = "The school's Umwalimu SACCO account number must contain exactly 12 digits.";
/** An account name with a digit (owner 2026-11-25: names contain no digit). */
export const NAME_DIGIT_MESSAGES = {
  personalAccountName: 'The bank account name must not contain numbers. Write the name exactly as on the account.',
  schoolAccountName: "The school's bank account name must not contain numbers. Write the name exactly as on the account.",
} as const;

export type BankingStatus = 'COMPLETE' | 'PARTIAL' | 'NOT_STARTED' | 'NEEDS_CORRECTION';

export function bankingRequiredFor(role: string | null | undefined): boolean {
  return (BANKING_ROLES as readonly string[]).includes(role ?? '');
}

/** How this role's banks are given: FIXED (always Umwalimu SACCO) or LIST (chosen from BANKS). */
export function bankRules(role: string) {
  const teacher = role === 'TEACHER';
  return {
    personalBank: teacher ? ('FIXED' as const) : ('LIST' as const),
    schoolBank: 'FIXED' as const,
    fixedBank: UMWALIMU_SACCO,
    banks: teacher ? [UMWALIMU_SACCO] : [...BANKS],
    /** Exactly this many digits for the personal account number (teachers); null: no format rule. */
    personalNumberDigits: teacher ? 12 : null,
    /** Exactly this many digits for the school account number (Teachers: Umwalimu SACCO); null: not asked. */
    schoolNumberDigits: teacher ? 12 : null,
    /** Whether the school's bank details are asked (Teachers only). */
    schoolRequired: teacher,
    /** The fields this role gives, in form order. */
    fields: [...requiredFields(role)],
  };
}

const filled = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim().length > 0;

/** Whether this bank field is fixed to Umwalimu SACCO for the role (a school bank only where school details are asked). */
export function isFixedBank(role: string, field: BankingField): field is FixableBankField {
  const teacher = role === 'TEACHER';
  return (field === 'schoolBankName' && teacher) || (field === 'personalBankName' && teacher);
}

/** Why a filled value breaks the role's rules (null: fine). Only the agreed rules (see the top of this file). */
export function fieldProblem(role: string, field: BankingField, value: string): string | null {
  const rules = bankRules(role);
  switch (field) {
    case 'personalBankName':
      if (rules.personalBank === 'FIXED') return value === UMWALIMU_SACCO ? null : `Teachers' personal bank is ${UMWALIMU_SACCO}.`;
      return (BANKS as readonly string[]).includes(value) ? null : 'Choose your bank from the list.';
    case 'schoolBankName':
      return value === UMWALIMU_SACCO ? null : `The school bank is ${UMWALIMU_SACCO}.`;
    case 'personalAccountNumber':
      if (rules.personalNumberDigits) return /^\d{12}$/.test(value) ? null : TEACHER_NUMBER_MESSAGE;
      return null;
    case 'schoolAccountNumber':
      if (rules.schoolNumberDigits) return /^\d{12}$/.test(value) ? null : SCHOOL_NUMBER_MESSAGE;
      return null;
    case 'personalAccountName':
    case 'schoolAccountName':
      return /\d/.test(value) ? NAME_DIGIT_MESSAGES[field] : null;
    default:
      return null;
  }
}

export interface BankingConflict {
  field: FixableBankField;
  /** The bank saved earlier, which this role may not use. */
  saved: string;
}

/** Saved banks this role may not use, which only an explicit confirmation replaces with Umwalimu SACCO. */
export function bankConflicts(role: string, saved: BankingDetails | null | undefined): BankingConflict[] {
  const out: BankingConflict[] = [];
  for (const f of FIXABLE_BANK_FIELDS) {
    const v = saved?.[f];
    if (isFixedBank(role, f) && filled(v) && v !== UMWALIMU_SACCO) out.push({ field: f, saved: v });
  }
  return out;
}

export interface BankingSummary {
  required: boolean;
  status: BankingStatus | null;
  /** Fields not given yet. */
  missing: BankingField[];
  /** Fields given but breaking the role's rules (to correct; never changed by the system). */
  invalid: BankingField[];
}

/** The completion of one user's saved details under their current role. */
export function bankingSummary(role: string, details: BankingDetails | null | undefined): BankingSummary {
  if (!bankingRequiredFor(role)) return { required: false, status: null, missing: [], invalid: [] };
  const missing: BankingField[] = [];
  const invalid: BankingField[] = [];
  const fields = requiredFields(role);
  // Only the role's required fields count (a coach's saved school details are neither missing nor checked).
  for (const f of fields) {
    const v = details?.[f];
    if (!filled(v)) missing.push(f);
    else if (fieldProblem(role, f, v)) invalid.push(f);
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
 * A submission (PUT /me/banking: the role's required fields — six for Teachers, the three personal ones for Coaches and
 * Head Coaches) checked against the role's rules and what is already saved. Fields the role does not give are ignored
 * (never saved), so a coach's saved school details stay as they are.
 *  - A fixed bank not sent is Umwalimu SACCO; another bank sent for it is refused (never silently replaced).
 *  - A conflicting SAVED bank (bankConflicts) is replaced only if `confirmReplace` names that field; otherwise the
 *    field is refused with confirmReplaceMessage, and nothing is saved.
 * Account names are trimmed at their ends; nothing else is changed. Returns the values to save, or the problem of
 * each field (and the fields still needing a confirmation).
 */
export function checkSubmission(
  role: string,
  input: BankingDetails,
  saved: BankingDetails | null | undefined = null,
  confirmReplace: readonly string[] = [],
): { ok: true; values: Partial<Record<BankingField, string>> }
  | { ok: false; errors: Partial<Record<BankingField, string>>; confirmationNeeded: FixableBankField[] } {
  const rules = bankRules(role);
  const errors: Partial<Record<BankingField, string>> = {};
  const values: Partial<Record<BankingField, string>> = {};
  const conflicts = bankConflicts(role, saved);
  const confirmationNeeded: FixableBankField[] = [];
  for (const f of requiredFields(role)) {
    let v = input[f];
    if (isFixedBank(role, f)) {
      const conflict = conflicts.find((c) => c.field === f);
      if (conflict && !confirmReplace.includes(f) && (!filled(v) || v === UMWALIMU_SACCO)) {
        errors[f] = confirmReplaceMessage(conflict.saved);
        confirmationNeeded.push(f);
        continue;
      }
      if (!filled(v)) v = UMWALIMU_SACCO;
    }
    if (!filled(v)) {
      errors[f] = f === 'personalAccountNumber' && rules.personalNumberDigits ? TEACHER_NUMBER_MESSAGE
        : f === 'schoolAccountNumber' && rules.schoolNumberDigits ? SCHOOL_NUMBER_MESSAGE
        : `${FIELD_LABELS[f]} is required.`;
      continue;
    }
    const value = f.endsWith('AccountName') ? v.trim() : v;
    const problem = fieldProblem(role, f, value);
    if (problem) errors[f] = problem;
    else values[f] = value;
  }
  return Object.keys(errors).length ? { ok: false, errors, confirmationNeeded } : { ok: true, values };
}

/** An account number for a summary: the last 4 characters only ("•••• 1234"); null stays null. */
export function maskAccountNumber(n: string | null | undefined): string | null {
  if (!filled(n)) return null;
  return n.length <= 4 ? '••••' : `•••• ${n.slice(-4)}`;
}
