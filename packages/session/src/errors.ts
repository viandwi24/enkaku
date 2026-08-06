/** Coded errors for the session layer (used by both core and node). */
export class SessionError extends Error {
  constructor(
    public code:
      | 'device_not_found'
      | 'device_not_ready'
      | 'engine_not_found'
      | 'port_range_exhausted'
      | 'element_not_found'
      | 'waitfor_timeout'
      | 'artifact_too_large'
      | 'unknown_script',
    message: string,
    /**
     * Plan 74 §4.3 — carries a `FindOutcome`'s last non-ok reason/matches for
     * `waitfor_timeout`, so a `waitFor` that timed out because every match
     * was refused (rejected-oversized/ambiguous) can say so, rather than
     * reporting a bare timeout. Optional and untyped-by-code deliberately:
     * every other `SessionError` construction in the codebase predates this
     * and passes only `(code, message)`, which stays valid unchanged.
     */
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}
