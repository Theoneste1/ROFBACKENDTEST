import { HttpStatus } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';

/** 403 for any change attempted while viewing as someone (ViewAsReadOnlyGuard; the database backstop says the same). */
export function viewAsReadOnly(targetName: string | null): AppError {
  const who = targetName ? targetName : 'another user';
  return new AppError(HttpStatus.FORBIDDEN, 'VIEW_AS_READ_ONLY',
    `You are viewing the platform as ${who}. Nothing can be changed in this view. Return to your own account to make changes.`);
}

/** 401 when a viewing token no longer works (30 minutes passed, ended, or the viewer's permission changed). */
export function viewAsEnded(): AppError {
  return new AppError(HttpStatus.UNAUTHORIZED, 'VIEW_AS_ENDED',
    'This viewing session has ended. It lasts 30 minutes, and it also ends when it is closed or your permission to view as other users changes. Close this tab.');
}

export function viewAsNotAllowed(message: string): AppError {
  return new AppError(HttpStatus.FORBIDDEN, 'VIEW_AS_NOT_ALLOWED', message);
}

/** The bearer token of a request, if any (not verified). */
export function bearerOf(req: { headers?: Record<string, unknown> }): string | undefined {
  const header = req.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1];
}

/**
 * True when the request's bearer token CLAIMS to be a viewing token (`va`), WITHOUT verifying it. Used only to refuse
 * more (a change attempted with it) or to answer VIEW_AS_ENDED instead of a plain 401 — never to allow anything.
 */
export function bearerClaimsViewAs(req: { headers?: Record<string, unknown> }): boolean {
  const token = bearerOf(req);
  const payload = token?.split('.')[1];
  if (!payload) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && 'va' in claims;
  } catch {
    return false;
  }
}
