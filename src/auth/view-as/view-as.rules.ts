/**
 * Who may view the platform as whom ("view as", read only; owner decision 2026-11-23). Lower roles only:
 *
 *   STUDENT < TEACHER ≈ COACH (MENTOR) < HEAD_COACH < ADMIN < SUPER_ADMIN
 *
 *   SUPER_ADMIN  may view STUDENT, TEACHER, MENTOR, HEAD_COACH, ADMIN
 *   ADMIN        may view STUDENT, TEACHER, MENTOR, HEAD_COACH
 *   HEAD_COACH   may view STUDENT, TEACHER, MENTOR   (only while holding users.impersonate by an individual GRANT)
 *   anyone else  may view nobody
 *
 * Nobody views a SUPER_ADMIN, nobody views themselves. The account's state does not matter (a suspended, archived or
 * not yet activated account can be viewed). The permission (users.impersonate) is checked separately.
 */
import { ROLE_LABELS, type AppRole } from '../permissions.js';

/** The roles each role may view (a positive list: a role not named here views nobody). */
export const VIEWABLE_ROLES: Readonly<Partial<Record<AppRole, readonly AppRole[]>>> = {
  SUPER_ADMIN: ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN'],
  ADMIN:       ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH'],
  HEAD_COACH:  ['STUDENT', 'TEACHER', 'MENTOR'],
};

const labelOf = (role: string): string => (Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role as AppRole] : 'user');
const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/** Why `actor` may not view the platform as `target` (a plain sentence), or null when the rank rule allows it. */
export function viewAsRefusal(actor: { id: string; role: string }, target: { id: string; role: string }): string | null {
  if (actor.id === target.id) return 'You cannot view the platform as yourself.';
  if (target.role === 'SUPER_ADMIN') return 'Nobody can view the platform as a Super Administrator.';
  const allowed: readonly string[] = Object.hasOwn(VIEWABLE_ROLES, actor.role) ? VIEWABLE_ROLES[actor.role as AppRole] ?? [] : [];
  if (allowed.includes(target.role)) return null;
  const who = labelOf(target.role).toLowerCase();
  return `You can only view the platform as users with a lower role than yours, so not as ${article(who)} ${who}.`;
}
