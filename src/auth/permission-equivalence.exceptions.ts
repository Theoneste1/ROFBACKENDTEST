/**
 * Reviewed exceptions for the permission-equivalence test
 * (permission-equivalence.spec.ts).
 *
 * When a route moves from @Roles to @RequirePermission (P1-06), the permission
 * decision for STUDENT, MENTOR and ADMIN must equal the previous decision in the
 * P1-02 baseline (src/common/decorators/route-access-baseline.json). A difference
 * is allowed only if it is listed here, with the approval it implements (only the
 * C2 Super Admin boundary routes are expected). Unlisted differences fail, and so
 * do entries that no longer match a difference (no stale exceptions).
 *
 * Empty in P1-04: no route uses @RequirePermission yet.
 */
export type EquivalenceCaller = 'STUDENT' | 'MENTOR' | 'ADMIN';
export type EquivalenceDecision = 'allow' | '403';

export interface EquivalenceException {
  /** Baseline key: "<METHOD> <path>  <Controller>.<method>". */
  key:    string;
  caller: EquivalenceCaller;
  /** Decision in the P1-02 baseline. */
  from:   EquivalenceDecision;
  /** Decision under @RequirePermission. */
  to:     EquivalenceDecision;
  /** The approved decision this difference implements. */
  reason: string;
}

export const PERMISSION_EQUIVALENCE_EXCEPTIONS: readonly EquivalenceException[] = [];
