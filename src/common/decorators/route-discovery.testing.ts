/**
 * Finds every route handler in the code (all *.controller.ts under src/),
 * registered or not. Shared by the route-declaration / guard-decision test
 * (route-declarations.spec.ts, P1-02) and the permission-equivalence test
 * (src/auth/permission-equivalence.spec.ts, P1-04). Test-only: excluded from
 * the build (tsconfig.build.json).
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

export const SRC = resolve(__dirname, '../..');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
const API_PREFIX = /export const API_PREFIX = '([^']+)'/.exec(readFileSync(join(SRC, 'main.ts'), 'utf8'))![1];
const PREFIX_EXCLUDED = ['health'];   // main.ts: setGlobalPrefix(API_PREFIX, { exclude: ['health'] })

export interface RouteHandler {
  /** e.g. "GET /api/v1/courses/:id" */
  route:      string;
  /** e.g. "CoursesController.findOne" */
  name:       string;
  file:       string;
  cls:        Function;
  handler:    Function;
  methodName: string;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'generated' ? [] : controllerFiles(path);
    return path.endsWith('.controller.ts') ? [path] : [];
  });
}

const joinPath = (...parts: Array<string | undefined>) =>
  '/' + parts.flatMap((p) => (p ?? '').split('/')).filter(Boolean).join('/');

export async function discoverHandlers(): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  for (const file of controllerFiles(SRC).sort()) {
    const mod = (await import(file)) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      const cls = value as Function;
      const base: unknown = Reflect.getMetadata(PATH_METADATA, cls);
      if (base === undefined) continue;
      const basePath = Array.isArray(base) ? base[0] : (base as string);
      for (const methodName of Object.getOwnPropertyNames(cls.prototype)) {
        if (methodName === 'constructor') continue;
        const handler = (cls.prototype as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        const verb: number | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
        if (verb === undefined) continue;
        const sub: unknown = Reflect.getMetadata(PATH_METADATA, handler);
        const subPath = Array.isArray(sub) ? sub[0] : (sub as string | undefined);
        const prefixed = !PREFIX_EXCLUDED.includes(basePath.replace(/^\/+/, ''));
        const path = prefixed ? joinPath(API_PREFIX, basePath, subPath) : joinPath(basePath, subPath);
        handlers.push({
          route: `${HTTP_METHODS[verb]} ${path}`,
          name:  `${exportName}.${methodName}`,
          file:  relative(resolve(SRC, '..'), file).replace(/\\/g, '/'),
          cls, handler: handler as Function, methodName,
        });
      }
    }
  }
  return handlers.sort((a, b) => a.route.localeCompare(b.route) || a.name.localeCompare(b.name));
}

/** Key used in the baseline: route plus handler, so two handlers can never collide. */
export const keyOf = (h: RouteHandler) => `${h.route}  ${h.name}`;
