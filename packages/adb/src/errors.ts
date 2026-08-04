/** Coded errors for @enkaku/adb (convention 00-overview §4.2). */
export type AdbErrorCode =
  | 'E_ADB_FAIL'
  | 'E_ADB_UNAVAILABLE'
  | 'E_ADB_PROTOCOL'
  /** Could not reach the adb server within connectTimeoutMs (plan 22.1 §4.2). */
  | 'E_ADB_CONNECT_TIMEOUT'
  /** Connected, but no OKAY/FAIL within handshakeTimeoutMs. */
  | 'E_ADB_HANDSHAKE_TIMEOUT'
  /** Execution exceeded execTimeoutMs, measured from when the task started. */
  | 'E_ADB_TIMEOUT'
  /** Queue depth exceeded, or queueTimeoutMs elapsed while waiting for a turn. */
  | 'E_ADB_BUSY'
  /** Output exceeded maxOutputBytes. */
  | 'E_ADB_OUTPUT_LIMIT'
  /** The caller's AbortSignal fired, either while queued or mid-flight. */
  | 'E_ADB_ABORTED'
  /** A caller passed a non-finite or non-positive timeout. */
  | 'E_ADB_BAD_TIMEOUT'
  /** execStream rejected: maxStreamsPerDevice or maxStreams was already at capacity (plan 24 §3.2). */
  | 'E_ADB_STREAM_LIMIT'
  /** A stream's idle clock fired: no bytes at all within idleTimeoutMs (plan 24 §3.3). */
  | 'E_ADB_STREAM_IDLE'
  /** A stream's absolute clock fired: it outlived absoluteTimeoutMs (plan 24 §3.3). */
  | 'E_ADB_STREAM_DEADLINE'
  /** The sync peer answered FAIL to SEND/RECV/STAT (plan 39 §4.1). */
  | 'E_ADB_SYNC_FAIL'
  /** A pull's remote file exceeded the caller's `maxBytes` while streaming, after `statRemote` already cleared it (plan 39 §3.6). */
  | 'E_ADB_PULL_TOO_LARGE'
  /**
   * Internal only (plan 53 §3.4) — the service request for `shell,v2,raw`
   * itself FAILed, meaning this device/adb build has no framed shell.
   * `AdbClient.exec` catches this and falls back to plain `shell:`; it never
   * reaches a caller of `exec`.
   */
  | 'E_ADB_SHELL_FRAMED_UNSUPPORTED'

export class AdbError extends Error {
  constructor(
    public code: AdbErrorCode,
    message: string,
    public cause?: unknown,
  ) {
    super(message)
    this.name = 'AdbError'
  }
}
