import { HttpStatus } from '@nestjs/common';
import { AppError } from '../common/errors/app-error.js';

export type TakenField = 'username' | 'email';

/**
 * 409 IDENTITY_TAKEN for an Administrator (QA 2026-11-24): says WHICH of the username and the e-mail address another
 * account already uses (details.fields), so the form marks the right field. Only for callers who may list every
 * account anyway (users.manage). Public sign-up and Head Coach invitations keep the single combined answer, so they
 * cannot be used to find out which usernames or addresses exist.
 */
export function identityTakenForAdmin(
  clashes: ReadonlyArray<{ username: string; email: string }>,
  username?: string,
  email?: string,
): AppError {
  const fields: TakenField[] = [];
  if (username && clashes.some((c) => c.username.toLowerCase() === username.toLowerCase())) fields.push('username');
  if (email && clashes.some((c) => c.email.toLowerCase() === email.toLowerCase())) fields.push('email');
  const message =
    fields.length === 2 ? 'This username and this e-mail address are already used by other accounts. Choose a different username and e-mail address.'
    : fields[0] === 'username' ? 'This username is already used by another account. Choose a different username.'
    : fields[0] === 'email' ? 'This e-mail address is already used by another account. Use a different e-mail address, or find the existing account in Users.'
    : 'Username or email is already in use.';
  return new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', message, { fields });
}
