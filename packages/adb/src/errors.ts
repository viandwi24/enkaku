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
