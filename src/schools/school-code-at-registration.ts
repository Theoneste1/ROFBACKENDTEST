/**
 * A school without an official code, chosen at registration (owner 2026-11-23): the person registering MUST give the
 * school's 6-digit code, and the first valid one becomes the school's code at once — 6 digits, the first digit the
 * school's province, used by no other school. An Administrator corrects it later if needed (school edit, with a reason).
 *
 * Under the school's row lock (and the directory's shared lock, like every school write): when someone else gave the
 * code a moment earlier, that code stands and the one typed now is not needed (nothing is refused for it). Audited
 * (SCHOOL_CODE_SET_AT_REGISTRATION) with who gave it and through which form.
 */
import { HttpStatus } from '@nestjs/common';

import type { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { lockSchoolDirectory } from './school-locks.js';
import { codeProblems } from './school-rules.js';

type Tx = Prisma.TransactionClient;

export interface CodeGiver {
  via: 'STUDENT_REGISTRATION' | 'TEACHER_APPLICATION';
  /** The new student's account (a student registration); null for a teacher application (no account yet). */
  actorId: string | null;
  actorRole: string | null;
  /** The teacher application, when given through it. */
  applicationId?: string;
}

/** 400 SCHOOL_CODE_REQUIRED: the chosen school has no code and none was typed. */
export function schoolCodeRequired(schoolName: string) {
  return new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_CODE_REQUIRED',
    `${schoolName} has no official school code in our list yet. Enter its 6-digit code (the school's office has it), then send the form again.`,
    { field: 'newSchoolCode' });
}

/**
 * The code of the school after this registration: its own code, or the one typed (now set). Throws in plain words when
 * the school has no code and the typed one is missing, malformed, of another province, or already another school's.
 */
export async function settleSchoolCode(tx: Tx, audit: AuditService, schoolId: string, typed: string | undefined, giver: CodeGiver): Promise<string> {
  await lockSchoolDirectory(tx, 'shared');
  await tx.$queryRaw`SELECT 1 FROM "School" WHERE "id" = ${schoolId} FOR UPDATE`;
  const school = await tx.school.findUniqueOrThrow({ where: { id: schoolId }, select: { id: true, name: true, code: true, province: true } });
  if (school.code) return school.code;
  const code = typed?.trim();
  if (!code) throw schoolCodeRequired(school.name);
  const problems = codeProblems(code, school.province);
  if (problems.length) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SCHOOL_CODE', `${problems[0]} Check the code with the school, then try again.`, { field: 'newSchoolCode', problems });
  }
  const other = await tx.school.findUnique({ where: { code }, select: { id: true, name: true } });
  if (other) {
    throw new AppError(HttpStatus.CONFLICT, 'SCHOOL_CODE_TAKEN',
      `The code ${code} already belongs to ${other.name} in our list. Check the code with the school — or, if ${other.name} is your school, choose it instead.`,
      { field: 'newSchoolCode', schoolId: other.id });
  }
  try {
    await tx.school.update({ where: { id: school.id }, data: { code } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(HttpStatus.CONFLICT, 'SCHOOL_CODE_TAKEN', `The code ${code} was just given to another school. Check the code with the school, then try again.`, { field: 'newSchoolCode' });
    }
    throw e;
  }
  await audit.log({
    actorId: giver.actorId, actorRole: giver.actorRole, action: 'SCHOOL_CODE_SET_AT_REGISTRATION', entity: 'School', entityId: school.id,
    metadata: { code, via: giver.via, ...(giver.applicationId && { applicationId: giver.applicationId }) },
  }, tx);
  return code;
}
