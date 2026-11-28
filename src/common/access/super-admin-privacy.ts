/**
 * Super Administrator privacy (owner decision 2026-11-28).
 *
 * A SUPER_ADMIN account is undiscoverable by every other role (ADMIN, HEAD_COACH, MENTOR, TEACHER, STUDENT, and any role
 * this file does not know): it is not listed, not counted, not found by id, not managed, and when it appears as the
 * author of something it is shown as the neutral "ROF Administration". Super Administrators see and manage one another;
 * everybody always sees their own account. Super Administrator authority over everyone else is unchanged.
 *
 * Enforcement lives in the services' queries and checks (these helpers); the SuperAdminPrivacyInterceptor masks any
 * Super Administrator that is still embedded in a JSON response (authors, actors, …) as a backstop.
 *
 * The decision is POSITIVE: only a viewer whose role is exactly SUPER_ADMIN sees Super Administrators; any other or
 * unknown role (or no viewer at all) does not — the least-privileged result.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { isSuperAdmin } from './roles.js';

type Viewer = { role: string } | null | undefined;

/** The role that is hidden. */
export const HIDDEN_ROLE = 'SUPER_ADMIN';

/** May this viewer see Super Administrator accounts? Only a Super Administrator. */
export function seesSuperAdmins(viewer: Viewer): boolean {
  return !!viewer && isSuperAdmin(viewer);
}

/**
 * The accounts this viewer may see, as a User where clause: every account for a Super Administrator; every account
 * except Super Administrators for anyone else (the viewer's own account is never a Super Administrator then). Combine
 * it with AND (it uses the `role` column — allowed in bulk selections, MEMBERSHIP_COLUMNS).
 */
export function visibleUsersWhere(viewer: Viewer): Prisma.UserWhereInput {
  if (seesSuperAdmins(viewer)) return {};
  return { role: { not: HIDDEN_ROLE } };
}

/**
 * Is this account hidden from the viewer (a Super Administrator, and the viewer is not one)? A service that loaded an
 * account by id then answers exactly as for an unknown id.
 */
export function isHiddenAccount(viewer: Viewer, target: { role: string } | null | undefined): boolean {
  if (!target || target.role !== HIDDEN_ROLE) return false;
  return !seesSuperAdmins(viewer);
}

/**
 * Accounts that are never counted in public or non-Super-Administrator statistics ("members", active users, accounts by
 * role): Super Administrators are excluded.
 */
export const NOT_SUPER_ADMIN: Prisma.UserWhereInput = { role: { not: HIDDEN_ROLE } };

/** A role filter value a viewer may not use: SUPER_ADMIN for anyone but a Super Administrator (matches nothing). */
export function hiddenRoleFilter(viewer: Viewer, role: string | null | undefined): boolean {
  return role === HIDDEN_ROLE && !seesSuperAdmins(viewer);
}

// ─── Masking embedded Super Administrators (the response backstop) ──────────────────────────────────────────────────

/** The neutral identity a Super Administrator is shown with to everyone else. */
export const ROF_ADMINISTRATION = {
  firstName: 'ROF',
  lastName: 'Administration',
  username: 'rof.administration',
  role: 'ADMIN',
} as const;

/** Fields that make a plain object look like a user record. */
const USER_SHAPE = ['username', 'firstName', 'lastName', 'email'] as const;
/** Identifying fields that are blanked (null) when present. */
const BLANKED = ['email', 'phone', 'avatarUrl', 'avatar', 'avatarFile', 'avatarKey', 'avatarUpdatedAt', 'dateOfBirth', 'homeLocation'] as const;
/** Combined display names some views carry next to the parts. */
const NAMES = ['name', 'fullName', 'displayName'] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

const looksLikeUser = (o: Record<string, unknown>): boolean =>
  typeof o.id === 'string' && USER_SHAPE.some((k) => Object.hasOwn(o, k));

/**
 * Does the body hold a user-shaped object (a plain object with an id and a user field)? Stops at the first one. A body too
 * large or deep to inspect within `limit` nodes counts as holding one (the masking then runs: never the other way round).
 */
export function containsUserShape(body: unknown, limit = 200_000): boolean {
  let seen = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 32 || ++seen > limit) return true;
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    if (!isPlainObject(v)) return false;
    if (looksLikeUser(v)) return true;
    return Object.keys(v).some((k) => walk(v[k], depth + 1));
  };
  return walk(body, 0);
}

/** One embedded Super Administrator, masked: the id is kept (opaque; looking it up answers 404). */
export function maskedUser(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  if (Object.hasOwn(o, 'firstName')) out.firstName = ROF_ADMINISTRATION.firstName;
  if (Object.hasOwn(o, 'lastName')) out.lastName = ROF_ADMINISTRATION.lastName;
  if (Object.hasOwn(o, 'username')) out.username = ROF_ADMINISTRATION.username;
  if (Object.hasOwn(o, 'role')) out.role = ROF_ADMINISTRATION.role;
  for (const k of BLANKED) if (Object.hasOwn(o, k)) out[k] = null;
  for (const k of NAMES) if (Object.hasOwn(o, k) && typeof o[k] === 'string') out[k] = 'ROF Administration';
  return out;
}

/**
 * A copy of the response body where every plain object whose id is one of `hidden` (Super Administrator ids) and that
 * looks like a user is replaced by its masked form. Other values are returned unchanged (same references where nothing
 * changed). Non-plain objects (Dates, Buffers, streams, class instances) are left alone.
 */
export function maskSuperAdmins<T>(body: T, hidden: ReadonlySet<string>): T {
  if (hidden.size === 0) return body;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64) return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => { const y = walk(x, depth + 1); if (y !== x) changed = true; return y; });
      return changed ? out : v;
    }
    if (!isPlainObject(v)) return v;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const y = walk(v[k], depth + 1);
      if (y !== v[k]) changed = true;
      out[k] = y;
    }
    const base = changed ? out : v;
    return looksLikeUser(v) && hidden.has(v.id as string) ? maskedUser(base) : base;
  };
  return walk(body, 0) as T;
}

// ─── Masking actor fields (audit-style rows: { actorUsername, actorRole: 'SUPER_ADMIN' }) ────────────────────────────

/**
 * A key that names the role of whoever acted, with its prefix: "actorRole" → "actor", "byRole" → "by", and the
 * registration timeline's plain "actor" (whose value is a role). The user's own `role` is not one (users are masked by id).
 */
function actorRolePrefix(key: string): string | null {
  if (key === 'actor') return 'actor';
  const m = /^([a-z][A-Za-z]*)Role$/.exec(key);
  return m ? m[1] : null;
}

/**
 * A copy of the body where every audit-style actor that was a Super Administrator is shown as "ROF Administration":
 * `<prefix>Role` (or `actor`) 'SUPER_ADMIN' → 'ADMIN'; `<prefix>Username` → 'rof.administration'; `<prefix>Name`,
 * `<prefix>FullName` → 'ROF Administration'; `<prefix>Email` → null; a plain-string `<prefix>` (e.g. `by: "Ada U."`) →
 * 'ROF Administration'. Needs no lookup (the role is in the row). Objects keyed by id are handled by maskSuperAdmins.
 */
export function maskSuperAdminActors<T>(body: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64) return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => { const y = walk(x, depth + 1); if (y !== x) changed = true; return y; });
      return changed ? out : v;
    }
    if (!isPlainObject(v)) return v;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const y = walk(v[k], depth + 1);
      if (y !== v[k]) changed = true;
      out[k] = y;
    }
    for (const k of Object.keys(out)) {
      const prefix = actorRolePrefix(k);
      if (prefix === null || out[k] !== HIDDEN_ROLE) continue;
      changed = true;
      out[k] = ROF_ADMINISTRATION.role;
      if (k !== 'actor' && typeof out[prefix] === 'string') out[prefix] = 'ROF Administration';
      for (const [suffix, value] of [['Username', ROF_ADMINISTRATION.username], ['Name', 'ROF Administration'], ['FullName', 'ROF Administration'], ['Email', null]] as const) {
        if (Object.hasOwn(out, prefix + suffix)) out[prefix + suffix] = value;
      }
    }
    return changed ? out : v;
  };
  return walk(body, 0) as T;
}
