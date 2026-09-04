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
       * Plan 206 §3.6, §4.4 — `requireScrcpy` was set (every base build, and
       * every control build) and scrcpy-server could not be started on this
       * device: `makeScrcpy` rejected/returned null, or the device's own
       * configured display engine is not scrcpy at all and the caller did not
       * pass `skipDevicePrep` room to fall back. This is a FAILED build, not a
       * degraded one — the always-on builder (`packages/session/src/always-on.ts`)
       * schedules a rebuild under backoff and reports it honestly
       * (`Recovering, attempt n`) rather than opening a screencap-loop session
       * under a wall label. For a `control` attach specifically,
       * `SessionManager.attachViewer` catches this and substitutes the wall
       * entry instead, saying so on the wire
       * (`StreamStartedMessage.payload.degradedReason`,
       * `packages/protocol/src/messages/stream.ts`) — never this function's
       * job to decide. Replaces the old control-fast-path-only code (plan
       * 100) that this code superseded; this plan applies the same code to
       * every build, not only that one case.
       */
      | 'E_SCRCPY_UNAVAILABLE',
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
