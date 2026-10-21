/**
 * Hook-local copy of the LIMITS values the hook uses (ARCHITECTURE.md §6.3).
 * The hook can't import shared/contracts.ts at runtime (it is TypeScript and ships outside the package).
 * hook.test.mjs imports shared/contracts.ts and asserts every key here matches LIMITS.
 */
export const HOOK_LIMITS = Object.freeze({
  /** §6.2: default heartbeat interval. */
  heartbeatMs: 15_000,
  /** §6.3: hook network timeout. */
  hookTimeoutMs: 1_500,
  /** §6.3: hook network timeout on SessionEnd. */
  sessionEndTimeoutMs: 800,
  /** §6.3: consecutive failures that open the circuit breaker. */
  breakerFailures: 3,
  /** §6.3: how long the open breaker skips the network. */
  breakerOpenMs: 60_000,
  /** §12: divergent paths sent at most. */
  maxDivergentPaths: 500,
});
