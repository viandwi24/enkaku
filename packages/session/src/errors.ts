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
      | 'unknown_script'
      /** Plan 91 §3.3, §4.1 — the input arbiter's bounded queue refused an action; the message names the blocking action. */
      | 'E_INPUT_BUSY'
      /**
       * Plan 100 §3.2, §3.7 item 2, §4.2, §4.4 — the fast-path `control`
       * entry (a second, concurrent scrcpy session beside an already-open
       * `wall` entry) could not be built: `makeScrcpy` rejected/returned
       * null, or the device's own configured engine is not scrcpy at all.
       * `SessionManager.acquire` throws this INSTEAD of silently falling
       * back to screencap-loop under the Control label (§3.7's "two tiers,
       * no silent fallback" rule) or handing back the wall entry disguised
       * as control. `ws-handlers.ts`'s `stream.start` catches this specific
       * code and decides whether to substitute the wall entry's own frames
       * — saying so on the wire (`StreamStartedMessage.payload.degradedReason`,
       * `packages/protocol/src/messages/stream.ts`) — never this function's
       * job to decide.
       */
      | 'E_CONTROL_SESSION_UNAVAILABLE',
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
