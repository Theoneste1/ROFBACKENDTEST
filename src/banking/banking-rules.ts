/**
 * Banking information (owner 2026-11-25): Teachers, Coaches and Head Coaches give their personal and their school's
 * bank details before using the platform. One set of rules for the completion check (sign-in lock, GET /me, the
 * administrators' views) and for saving (PUT /me/banking). Pure (unit-tested); the frontend mirrors it.
 *
 *  - Teachers: both banks are Umwalimu SACCO (fixed, never chosen); the personal account number is exactly 12 digits.
 *  - Coaches and Head Coaches: the personal bank is chosen from BANKS; the school bank is Umwalimu SACCO (fixed).
 *  - Every other account number: digits only, 6 to 20 (never changed or cut).
 *  - Students, Administrators and Super Administrators: not asked.
 * A saved value that breaks the rules (e.g. another bank for a teacher, after a role change) is never overwritten by
 * the system: it is reported as NEEDS_CORRECTION until the user submits the form again.
 */

export const UMWALIMU_SACCO = 'Umwalimu SACCO';

/** The banks a Coach or Head Coach may choose (owner's list, 2026-11-25). */
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
  'Zigama Credit and Savings Bank (Zigama CSS)',
  UMWALIMU_SACCO,
] as const;

/** The roles that must give their banking information. */
export const BANKING_ROLES = ['TEACHER', 'MENTOR', 'HEAD_COACH'] as const;

export const BANKING_FIELDS = [
  'personalAccountName', 'personalBankName', 'personalAccountNumber',
  'schoolAccountName', 'schoolBankName', 'schoolAccountNumber',
] as const;
export type BankingField = (typeof BANKING_FIELDS)[number];

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
export const ACCOUNT_NUMBER_MESSAGE = 'Enter the account number with digits only (6 to 20 digits).';

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
    /** Exactly this many digits for the personal account number (teachers), else null (6 to 20 digits). */
    personalNumberDigits: teacher ? 12 : null,
  };
}

const filled = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim().length > 0;

/** Why a filled value breaks the role's rules (null: fine). Names 2–120 characters; numbers digits only. */
export function fieldProblem(role: string, field: BankingField, value: string): string | null {
  const rules = bankRules(role);
  switch (field) {
    case 'personalAccountName':
    case 'schoolAccountName':
      return value.trim().length < 2 || value.trim().length > 120 ? 'Enter the account name as the bank shows it (2 to 120 characters).' : null;
    case 'personalBankName':
      if (rules.personalBank === 'FIXED') return value === UMWALIMU_SACCO ? null : `Teachers' personal bank is ${UMWALIMU_SACCO}.`;
      return (BANKS as readonly string[]).includes(value) ? null : 'Choose your bank from the list.';
    case 'schoolBankName':
      return value === UMWALIMU_SACCO ? null : `The school bank is ${UMWALIMU_SACCO}.`;
    case 'personalAccountNumber':
      if (rules.personalNumberDigits) return /^\d{12}$/.test(value) ? null : TEACHER_NUMBER_MESSAGE;
      return /^\d{6,20}$/.test(value) ? null : ACCOUNT_NUMBER_MESSAGE;
    case 'schoolAccountNumber':
      return /^\d{6,20}$/.test(value) ? null : ACCOUNT_NUMBER_MESSAGE;
  }
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
  for (const f of BANKING_FIELDS) {
    const v = details?.[f];
    if (!filled(v)) missing.push(f);
    else if (fieldProblem(role, f, v)) invalid.push(f);
  }
  const status: BankingStatus = invalid.length ? 'NEEDS_CORRECTION'
    : missing.length === 0 ? 'COMPLETE'
    : missing.length === BANKING_FIELDS.length ? 'NOT_STARTED'
    : 'PARTIAL';
  return { required: true, status, missing, invalid };
}

/** Whether this user must still complete their banking information (the sign-in lock). */
export function bankingIncomplete(role: string, details: BankingDetails | null | undefined): boolean {
  const { status } = bankingSummary(role, details);
  return status !== null && status !== 'COMPLETE';
}

/**
 * A submission (all six fields, PUT /me/banking) checked against the role's rules. The fixed banks are set by the
 * backend whatever was sent; sending another bank for them is refused (never silently replaced). Returns the values to
 * save, or the problem of each field. Nothing is trimmed inside numbers or otherwise changed.
 */
export function checkSubmission(role: string, input: BankingDetails):
  { ok: true; values: Record<BankingField, string> } | { ok: false; errors: Partial<Record<BankingField, string>> } {
  const rules = bankRules(role);
  const errors: Partial<Record<BankingField, string>> = {};
  const values = {} as Record<BankingField, string>;
  for (const f of BANKING_FIELDS) {
    let v = input[f];
    const fixed = f === 'schoolBankName' || (f === 'personalBankName' && rules.personalBank === 'FIXED');
    if (fixed && !filled(v)) v = UMWALIMU_SACCO;
    if (!filled(v)) {
      errors[f] = f === 'personalAccountNumber' && rules.personalNumberDigits ? TEACHER_NUMBER_MESSAGE : `${FIELD_LABELS[f]} is required.`;
      continue;
    }
    const value = f.endsWith('AccountName') ? v.trim() : v;
    const problem = fieldProblem(role, f, value);
    if (problem) errors[f] = problem;
    else values[f] = value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

/** An account number for a summary: the last 4 digits only ("•••• 1234"); null stays null. */
export function maskAccountNumber(n: string | null | undefined): string | null {
  if (!filled(n)) return null;
  return n.length <= 4 ? '••••' : `•••• ${n.slice(-4)}`;
}
