/**
 * Account states and their transitions (2026-11-16). Pure; unit-tested; the single source of the rules
 * (docs/operations/account-states.md has the same table).
 *
 *   from \ to     ACTIVE                DEACTIVATED   SUSPENDED   ARCHIVED
 *   ACTIVE        —                     deactivate    suspend     archive
 *   DEACTIVATED   reactivate            —             suspend     archive
 *   SUSPENDED     lift the suspension   —             —           archive
 *   ARCHIVED      restore               —             —           —
 *
 * Every state but ACTIVE blocks sign-in and ends all sessions. Nothing is ever deleted: an archived account keeps
 * its submissions, results, discussions, enrolments, school affiliations, notifications and audit history.
 * A reason (3–500 characters) is required for DEACTIVATED, SUSPENDED and ARCHIVED, and for restoring from ARCHIVED.
 */
import type { AccountStatus } from '../generated/prisma/client.js';
import type { Permission } from '../auth/permissions.js';

export const ACCOUNT_STATUSES = ['ACTIVE', 'DEACTIVATED', 'SUSPENDED', 'ARCHIVED'] as const satisfies readonly AccountStatus[];

const ALLOWED: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  ACTIVE:      ['DEACTIVATED', 'SUSPENDED', 'ARCHIVED'],
  DEACTIVATED: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'],
  SUSPENDED:   ['ACTIVE', 'ARCHIVED'],
  ARCHIVED:    ['ACTIVE'],
};

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export type TransitionRefusal =
  | { code: 'STATUS_UNCHANGED'; message: string }
  | { code: 'INVALID_STATUS_TRANSITION'; message: string }
  | { code: 'REASON_REQUIRED'; message: string };

/** The permission a transition needs (on top of managing the account's role). */
export function permissionFor(from: AccountStatus, to: AccountStatus): Permission {
  if (to === 'ARCHIVED' || from === 'ARCHIVED') return 'users.archive';
  if (to === 'SUSPENDED' || from === 'SUSPENDED') return 'users.suspend';
  return 'users.changeStatus';
}

/** A reason is needed when access is taken away, and when an archived account comes back. */
export function reasonRequired(from: AccountStatus, to: AccountStatus): boolean {
  return to !== 'ACTIVE' || from === 'ARCHIVED';
}

export function allowedTargets(from: AccountStatus): readonly AccountStatus[] {
  return ALLOWED[from];
}

/** null when the transition may happen; otherwise why not. */
export function checkTransition(from: AccountStatus, to: AccountStatus, reason: string | null | undefined): TransitionRefusal | null {
  if (from === to) return { code: 'STATUS_UNCHANGED', message: `The account is already ${to.toLowerCase()}.` };
  if (!ALLOWED[from].includes(to)) {
    return { code: 'INVALID_STATUS_TRANSITION', message: `An account cannot go from ${from.toLowerCase()} to ${to.toLowerCase()}.` };
  }
  const r = reason?.trim() ?? '';
  if (reasonRequired(from, to) && (r.length < REASON_MIN || r.length > REASON_MAX)) {
    return { code: 'REASON_REQUIRED', message: `Give a reason (${REASON_MIN}–${REASON_MAX} characters).` };
  }
  return null;
}

/**
 * Independent conditions that keep blocking sign-in after an account is (re)activated or restored — restoring sets
 * accountStatus only and never clears them:
 *   NOT_ACTIVATED     the account was never activated (activatedAt null): it still needs its activation link;
 *   PENDING_APPROVAL  not approved (isApproved false): it still waits for an administrator's approval;
 *   LOCKED            locked after failed sign-ins (lockedUntil in the future): it unlocks when that time passes;
 *   ROLE_DISABLED     its role is switched off by a feature flag (TEACHERS_ENABLED / HEAD_COACHES_ENABLED).
 * (Super Admin boundary rules decide who may manage the account, not whether it can sign in; they are enforced
 * before any change.)
 */
export type SignInBlock = 'NOT_ACTIVATED' | 'PENDING_APPROVAL' | 'LOCKED' | 'ROLE_DISABLED';

export function stillBlockedBy(
  u: { activatedAt: Date | null; isApproved: boolean; lockedUntil: Date | null },
  roleEnabled: boolean,
  now: Date = new Date(),
): SignInBlock[] {
  const out: SignInBlock[] = [];
  if (!u.activatedAt) out.push('NOT_ACTIVATED');
  if (!u.isApproved) out.push('PENDING_APPROVAL');
  if (u.lockedUntil && u.lockedUntil > now) out.push('LOCKED');
  if (!roleEnabled) out.push('ROLE_DISABLED');
  return out;
}

/**
 * "Activate now" (owner 2026-11-24): an administrator activates an account that is still "Awaiting setup" (activatedAt
 * null) on the person's behalf, so they can sign in without confirming their e-mail. Only for a person who chose their
 * own password (self-registered students, teachers and coaches); an invited person without a password must use the
 * invitation link. An account that is not ACTIVE is reactivated, lifted or restored first. null = may be activated.
 */
export type ActivateNowRefusalCode = 'ACCOUNT_NOT_ACTIVE' | 'ALREADY_ACTIVATED' | 'NO_PASSWORD_YET';

const NOT_ACTIVE_NEXT_STEP: Readonly<Record<Exclude<AccountStatus, 'ACTIVE'>, string>> = {
  DEACTIVATED: 'This account is deactivated. Reactivate it first, then use Activate now.',
  SUSPENDED:   'This account is suspended. Lift the suspension first, then use Activate now.',
  ARCHIVED:    'This account is archived. Restore it first, then use Activate now.',
};

export const ACTIVATE_NOW_MESSAGES = {
  ALREADY_ACTIVATED: 'This account is already active. The person can sign in.',
  NO_PASSWORD_YET:   'This person has not set a password yet. Resend the invitation instead; they choose a password from its link.',
} as const;

export function activateNowRefusal(
  u: { accountStatus: AccountStatus; activatedAt: Date | null; hasPassword: boolean },
): { code: ActivateNowRefusalCode; message: string } | null {
  if (u.accountStatus !== 'ACTIVE') return { code: 'ACCOUNT_NOT_ACTIVE', message: NOT_ACTIVE_NEXT_STEP[u.accountStatus] };
  if (u.activatedAt) return { code: 'ALREADY_ACTIVATED', message: ACTIVATE_NOW_MESSAGES.ALREADY_ACTIVATED };
  if (!u.hasPassword) return { code: 'NO_PASSWORD_YET', message: ACTIVATE_NOW_MESSAGES.NO_PASSWORD_YET };
  return null;
}

/** Restoring an archived account needs an explicit confirmation (and a reason — checkTransition). */
export const confirmationRequired = (from: AccountStatus, to: AccountStatus) => from === 'ARCHIVED' && to === 'ACTIVE';

/** The login refusal for a blocked state (a distinct code per state; ACCOUNT_SUSPENDED is the existing one). */
export function loginRefusal(status: AccountStatus): { code: string; message: string } | null {
  switch (status) {
    case 'DEACTIVATED': return { code: 'ACCOUNT_DEACTIVATED', message: 'This account has been deactivated.' };
    case 'SUSPENDED':   return { code: 'ACCOUNT_SUSPENDED', message: 'This account has been suspended.' };
    case 'ARCHIVED':    return { code: 'ACCOUNT_ARCHIVED', message: 'This account has been archived.' };
    default:            return null;
  }
}
