import { SetMetadata } from '@nestjs/common';

export const IS_AUTHENTICATED_KEY = 'isAuthenticated';

/**
 * Declares, explicitly, that a route is open to **any signed-in user**.
 *
 * METADATA ONLY — no guard reads it, and it does not enforce anything by
 * itself. Authentication is enforced by the global JwtAuthGuard (every route
 * not marked @Public), and RolesGuard already lets any signed-in user through
 * a route without @Roles. This marker makes that existing decision visible
 * and testable: every route must declare exactly one of @Public, @Roles or
 * @Authenticated (see route-declarations.spec.ts).
 *
 * Use it on individual handlers only, never on a controller class, so that a
 * route added later always needs its own deliberate declaration.
 * (Phase 1 plan, Step 2 / P1-02; routes move to permission checks in Step 6.)
 */
export const Authenticated = () => SetMetadata(IS_AUTHENTICATED_KEY, true);
