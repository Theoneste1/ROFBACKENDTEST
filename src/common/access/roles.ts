/**
 * Positive role checks (Phase 1, P1-03).
 *
 * Every decision based on the CALLER's role names the roles it serves and
 * refuses anything else. There is no implicit "otherwise admin" and no
 * "not a student, so staff": a role these helpers do not know (for example a
 * role added to the database before its access has been designed) gets least
 * privilege — 404 for a specific record, 403 ROLE_NOT_SUPPORTED for a
 * role-dependent list or view.
 *
 * src/common/access/role-checks.spec.ts scans the code for caller-role
 * decisions that fall through to a non-refusing default.
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../errors/app-error.js';

type Caller = { role: string };

/**
 * Administrator authority: ADMIN, or SUPER_ADMIN (which holds every administrative
 * permission, plan §8.1). Never a grading path — grading requires isCoach, the
 * reviews.grade permission and the RS1 guard rule, none of which administrators pass.
 */
export const isAdmin   = (u: Caller): boolean => u.role === 'ADMIN' || u.role === 'SUPER_ADMIN';
/** Only the Super Administrator (P1-08): managing ADMIN / SUPER_ADMIN accounts, step-up promotion. */
export const isSuperAdmin = (u: Caller): boolean => u.role === 'SUPER_ADMIN';
export const isCoach   = (u: Caller): boolean => u.role === 'MENTOR';
export const isStudent = (u: Caller): boolean => u.role === 'STUDENT';
/** Head Coach (P1-10): programme-scoped authority only (plan §7.2, HC-A). */
export const isHeadCoach = (u: Caller): boolean => u.role === 'HEAD_COACH';
/** Staff = ADMIN or MENTOR, named explicitly — never "not a student". */
export const isStaff   = (u: Caller): boolean => isAdmin(u) || isCoach(u);

/** 403 for a role that has no access to a role-dependent list or view. */
export const unsupportedRole = (): AppError =>
  new AppError(HttpStatus.FORBIDDEN, 'ROLE_NOT_SUPPORTED', 'Your account type does not have access to this resource yet.');
