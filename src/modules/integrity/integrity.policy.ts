/**
 * SOUQNA — AR-2.5: Integrity Policy Configuration
 *
 * Declares which operations require device integrity evidence and how failures
 * are handled. Policy is defined server-side only — clients cannot override it.
 *
 * Enforcement modes:
 *   'enforce'  — REJECTED/INVALID blocks the operation; UNAVAILABLE blocks too
 *   'observe'  — Evidence is evaluated and logged, but operation is never blocked
 *   'soft'     — REJECTED/INVALID blocks; UNAVAILABLE is permitted with higher risk score
 */

export type IntegrityEnforcementMode = 'enforce' | 'soft' | 'observe';

export interface OperationIntegrityPolicy {
  /** Whether this operation requires integrity evidence. */
  required: boolean;
  /** Enforcement mode — defaults to 'soft' if required=true. */
  mode: IntegrityEnforcementMode;
  /** Human-readable description for audit logs. */
  description: string;
}

/**
 * Server-side map of operations to their integrity policies.
 * New operations must be explicitly declared here before being enforced.
 * Keys are the exact operation strings passed in integrity challenges.
 */
export const INTEGRITY_OPERATION_POLICY: Record<string, OperationIntegrityPolicy> = {
  // ── Financial ──────────────────────────────────────────────────────────────
  WALLET_WITHDRAWAL: {
    required: true,
    mode: (process.env.INTEGRITY_ENFORCEMENT_MODE as IntegrityEnforcementMode) ?? 'soft',
    description: 'Customer wallet withdrawal to external wallet provider',
  },
  WALLET_DEPOSIT: {
    required: false,
    mode: 'observe',
    description: 'Manual deposit request submission',
  },

  // ── Promotion abuse ────────────────────────────────────────────────────────
  FIRST_ORDER_PROMOTION: {
    required: true,
    mode: (process.env.INTEGRITY_ENFORCEMENT_MODE as IntegrityEnforcementMode) ?? 'soft',
    description: 'First-order free shipping / promotional benefit redemption',
  },
  VOUCHER_REDEMPTION: {
    required: false,
    mode: 'observe',
    description: 'Voucher / coupon redemption at checkout',
  },

  // ── Default fallback for unconfigured operations ───────────────────────────
  DEFAULT: {
    required: false,
    mode: 'observe',
    description: 'Default policy — observe only',
  },
};

/** Looks up the policy for an operation, falling back to DEFAULT. */
export function getOperationPolicy(operation: string): OperationIntegrityPolicy {
  return INTEGRITY_OPERATION_POLICY[operation] ?? INTEGRITY_OPERATION_POLICY['DEFAULT'];
}
