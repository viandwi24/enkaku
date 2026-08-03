export {
  AdbClient,
  StreamLane,
  type AdbClientOptions,
  type AdbExecOptions,
  type AdbMetric,
  type AdbStreamEndReason,
  type AdbStreamOptions,
  type AdbStreamHandle,
} from './client'
export {
  DeviceTracker,
  parseSnapshot,
  diffSnapshots,
  type AdbDeviceState,
  type TrackedDevice,
  type TrackerEvent,
} from './tracker'
export { Semaphore, PerDeviceQueue, type QueueRunOptions } from './queue'
export { shellQuote } from './shell-quote'
export { AdbSocket, encodeRequest, type AdbSocketOptions } from './socket'
export { AdbError, type AdbErrorCode } from './errors'
export {
  ADB_TIMEOUTS,
  resolveExecTimeout,
  MAX_EXEC_TIMEOUT_MS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_BYTES,
  DEFAULT_MAX_STREAMS_PER_DEVICE,
  DEFAULT_MAX_STREAMS,
  type AdbTimeoutProfile,
} from './timeouts'
// The local adb endpoint shim (plan 27) — an adbd-protocol impersonator so a
// lease holder's own `adb connect` can reach a farm device directly.
export { createAdbdShim, type AdbdShimDeps, type AdbdShimHandlers } from './transport/adbd-shim'
export { buildDeviceBanner, ADBD_SHIM_FEATURES, type BannerInfo } from './transport/banner'
export { createStreamMux, type RawStream, type StreamMux, type StreamMuxDeps } from './transport/stream-mux'
export {
  MAX_MAXDATA as ADBD_MAX_MAXDATA,
  MIN_MAXDATA as ADBD_MIN_MAXDATA,
  CONNECT_VERSION as ADBD_CONNECT_VERSION,
} from './transport/wire'
// The sync protocol (plan 39 §4.1) — push/pull/stat over an `openRaw(serial,
// 'sync:')` stream, no adb CLI involved.
export { pushFile, pullFile, statRemote, type PushFileOptions, type PullFileOptions, type RemoteStat, type SyncTransfer } from './transport/sync'
