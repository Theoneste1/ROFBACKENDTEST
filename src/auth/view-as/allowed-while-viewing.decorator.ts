import { SetMetadata } from '@nestjs/common';

export const ALLOWED_WHILE_VIEWING_KEY = 'allowedWhileViewing';

/**
 * The only non-GET routes a viewing ("view as") token may call: ending the viewing session, signing out of the
 * viewing tab, and exchanging a ticket. Everything else is refused by ViewAsReadOnlyGuard (view-as-read-only.spec.ts
 * lists exactly these routes).
 */
export const AllowedWhileViewing = () => SetMetadata(ALLOWED_WHILE_VIEWING_KEY, true);
