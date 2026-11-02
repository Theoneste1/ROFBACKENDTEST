import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Every route requires a valid access token by default (JwtAuthGuard is
 * registered globally). Use this only for login, registration, password
 * reset, health checks and similar.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
