/**
 * The OpenAPI document, shared by the Swagger UI (main.ts) and the
 * documentation generator (scripts/generate-api-docs.mjs).
 *
 * Each operation is annotated with who may call it (`x-roles`, and a line in
 * its description), read from the same @Roles / @RequirePermission / @Public
 * metadata the guards enforce, so the documentation cannot drift from the real
 * authorization. For a permission route, `x-roles` lists the roles holding the
 * permission in the catalogue (administrators never for grading, RS1) and
 * `x-permission` names it. A permission no role holds by default (a P1-11
 * teacher delegation) lists the roles it can be granted to, and says so. A route
 * whose service serves fewer roles than hold its permission declares them with
 * `@ApiExtension('x-served-roles', [...])`; `x-roles` is then narrowed to those.
 */
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

import { ROLES_KEY } from './auth/decorators/roles.decorator.js';
import { REQUIRED_PERMISSION_KEY } from './auth/decorators/require-permission.decorator.js';
import { ADMINISTRATIVE_ROLES, ADMIN_PROHIBITED, APP_ROLES, ROLE_GRANTS, type AppRole, type Permission } from './auth/permissions.js';
import { GRANTABLE, TEACHER_DELEGATIONS } from './auth/override-policy.js';
import { IS_PUBLIC_KEY } from './common/decorators/public.decorator.js';

export interface RouteAccess {
  /** Swagger's default operationId: `${Controller}_${method}`. */
  operationId: string;
  public:      boolean;
  /** Roles allowed; empty = any signed-in user. */
  roles:       string[];
  /** The permission required (@RequirePermission), if any. */
  permission?: string;
  /** True when no role holds the permission by default and `roles` are those it can be granted to. */
  grantOnly?:  boolean;
}

/** Roles holding a permission (catalogue order); never ADMIN / SUPER_ADMIN for grading or authoring (RS1). */
export function rolesHolding(permission: Permission): string[] {
  return APP_ROLES.filter((r) => permission in ROLE_GRANTS[r]
    && !(ADMINISTRATIVE_ROLES.includes(r) && ADMIN_PROHIBITED.includes(permission)));
}

/** Roles an individual GRANT override can give a permission to (the approved list). */
export function rolesGrantable(permission: Permission): string[] {
  return APP_ROLES.filter((r) => (GRANTABLE[r as AppRole] ?? []).includes(permission));
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ROF LMS API')
    .setDescription(
      'Rwanda Olympiad Foundation Learning Management System — Mathematics.\n\n' +
      'Authenticate with POST /api/v1/auth/login, then send `Authorization: Bearer <access_token>`.\n' +
      'Errors always have the shape `{ statusCode, error, code, message, details?, requestId }`.\n\n' +
      'Every operation states who may call it (`x-roles`). Beyond the role, records are scoped: students see ' +
      'their own work and their division\'s published content; mentors their assigned course × division scopes ' +
      'and the submissions assigned to them.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // Every route needs the bearer token unless marked @Public().
  document.security = [{ bearer: [] }];

  const access = new Map(routeAccess(app).map((r) => [r.operationId, r]));
  for (const item of Object.values(document.paths)) {
    for (const op of Object.values(item) as Array<Record<string, unknown>>) {
      if (!op || typeof op !== 'object' || !('operationId' in op)) continue;
      const a = access.get(op.operationId as string);
      if (!a) continue;
      const served = op['x-served-roles'] as string[] | undefined;
      const roles = served ? a.roles.filter((r) => served.includes(r)) : a.roles;
      const delegation = a.permission && (TEACHER_DELEGATIONS as readonly string[]).includes(a.permission)
        ? ' — granted individually by an Administrator or Super Admin; applies only to students of the teacher\'s active school assignments'
        : '';
      const who = a.public ? 'Public (no token)'
        : a.permission ? `permission \`${a.permission}\` (${roles.join(', ') || 'nobody'}${a.grantOnly ? ', by individual grant only' : ''})${delegation}`
        : roles.length ? roles.join(', ') : 'Any signed-in user';
      // A permission route lists exactly its callers (never the "any signed-in user" fallback).
      op['x-roles'] = a.public ? ['PUBLIC'] : roles.length || a.permission ? roles : ['STUDENT', 'MENTOR', 'ADMIN'];
      if (a.permission) op['x-permission'] = a.permission;
      op.description = `**Access:** ${who}${op.description ? `\n\n${op.description as string}` : ''}`;
      if (a.public) op.security = [];
    }
  }
  return document;
}

/** Roles and public flag of every route handler, as the guards see them (method overrides class). */
export function routeAccess(app: INestApplication): RouteAccess[] {
  const reflector = new Reflector();
  const out: RouteAccess[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
      if (!ctrl || Reflect.getMetadata(PATH_METADATA, ctrl) === undefined) continue;
      const proto = ctrl.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        const targets = [handler as () => unknown, ctrl];
        const permission = reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION_KEY, targets);
        const holders = permission ? rolesHolding(permission) : [];
        const grantOnly = !!permission && holders.length === 0;
        out.push({
          operationId: `${ctrl.name}_${name}`,
          public:      !!reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets),
          roles:       permission ? (grantOnly ? rolesGrantable(permission) : holders) : reflector.getAllAndOverride<string[]>(ROLES_KEY, targets) ?? [],
          ...(permission && { permission }),
          ...(grantOnly && { grantOnly }),
        });
      }
    }
  }
  return out;
}
