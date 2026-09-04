export { createSession, type DeviceSession, type CreateSessionOpts, type CreateSessionDeps } from './session'
export {
  CONTROL_PRESETS,
  WALL_PRESETS,
  WALL_VIDEO_BUDGET_BPS,
  resolveVideoProfile,
  sameVideoNumbers,
  computeAutoTiles,
  resolveWallTransport,
  resolveWallBandwidthBps,
  type VideoProfile,
  type VideoSource,
  type WallBudget,
  type WallTransport,
} from './video-profile'
export {
  createSessionManager,
  createRateMeter,
  RateMeter,
  CONTROL_LINGER_MS,
  type SessionManager,
  type SessionManagerDeps,
  type SessionState,
  type PrepStep,
  type ViewerAttach,
  type ViewerHooks,
  type EncoderState,
  type EncoderReport,
  type FrameSink,
  type ForwardRecord,
} from './manager'
export {
  createAlwaysOn,
  noopActivityPort,
  buildSentence,
  usbRootOf,
  rebuildDelayMs,
  prepLabel,
  recoveringLabel,
  PREP_QUEUED_LABEL,
  PREP_STEP_COUNT,
  REBUILD_BACKOFF_MS,
  DEFAULT_BUILDS_PER_USB_ROOT,
  SESSION_BUILD_FARM_CEILING,
  SCRCPY_FALLBACK_AFTER_FAILURES,
  INSPECTOR_PREWARM_DELAY_MS,
  USB_ROOT_CACHE_MS,
  NETWORK_ROOT,
  UNKNOWN_ROOT,
  ALWAYS_ON_ACTOR,
  type ActivityPort,
  type AlwaysOn,
  type AlwaysOnDeps,
  type DeviceBuildState,
} from './always-on'
export { createInspectorForSession, type InspectorHandle, type InspectorFactoryDeps } from './inspector-factory'
export { PortAllocator, parsePortRange, isPortFree } from './port-allocator'
export { createDeviceExecutor, DEFAULT_TIMING, INSPECTOR_METHODS, needsInspector, type TimingSettings } from './device-executor'
export {
  createInputArbiter,
  type InputArbiter,
  type InputLane,
  type InputSource,
  type LaneStats,
  type CreateInputArbiterOpts,
} from './input-arbiter'
export {
  createJobRunner,
  type JobRunner,
  type JobRunnerDeps,
  type JobSpec,
  type ScriptFailure,
  type AbortReason,
  type KvRunnerDeps,
  type JobsRunnerDeps,
  type FarmRunnerDeps,
  type TraceStoreDeps,
} from './runner/job-runner'
// Plan 128 §3.1, step 128.3 — the job-trace tee. `TraceEventInput` is the
// shape the host's recorder receives (`id`/`seq` are the recorder's to
// assign); the rest is exported for the host that builds a frame store.
export {
  createTraceTee,
  createNoopTraceTee,
  resolveFramePolicy,
  redactArgs,
  ARG_REDACTION,
  MAX_ARG_BYTES,
  reusableTree,
  TRACE_TREE_REUSE_MS,
  type TraceTee,
  type TraceTeeDeps,
  type TraceToken,
  type TraceOutcome,
  type TraceEventInput,
  type TraceCaptureRequest,
  type TraceCaptureResult,
  type TraceCaptureMode,
  type FramePolicy,
  type ArgRedaction,
  type TracePhase,
} from './runner/trace'
export { resetDevice, parseForegroundPackages, type ResetPolicy, type ResetPlan, type ResetOutcome } from './reset'
export { createJobLogger, type JobLogger, type JobLogEntry } from './runner/job-logger'
export {
  ChildToParentSchema,
  ParentToChildSchema,
  DeviceCallSchema,
  KvCallSchema,
  KvScopeSchema,
  JobsCallSchema,
  FarmCallSchema,
  type ChildToParent,
  type ParentToChild,
  type DeviceCall,
  type KvCall,
  type KvScopeKind,
  type JobsCall,
  type FarmCall,
} from './runner/ipc'
export { createKvApiFor, type KvApiClient, type KvListItem, type KvListResult, type KvSetResult } from './runner/kv-client'
/**
 * Plan 109 (M74) step 109.1 — the ONE `PluginContext` builder, shared by the
 * job child and the core. See `plugin-context.ts`'s header for why it lives
 * in this package rather than in `@enkaku/sdk` or `packages/core`.
 */
export {
  buildPluginContext,
  createChildPluginContext,
  noDeviceScopeError,
  foreignDeviceScopeError,
  type PluginContextPorts,
  type PluginStorageTarget,
  type ChildPluginContextDeps,
} from './plugin-context'
export { createJobsApiFor, type JobsApiClient, type JobsListResult } from './runner/jobs-client'
export {
  resolveIsolation,
  createChildProcessIsolation,
  createContainerIsolation,
  type IsolationProvider,
  type IsolationMode,
} from './runner/isolation'
export { SessionError } from './errors'
export type { Logger } from './logger'
export type { DeviceSnapshot, DeviceSnapshotSource, ArtifactSink, SavedArtifact, TransferPort } from './types'
export { probeDeviceIdentity, parseWmSize, parseWmDensity, pickStableId, type DeviceProbeResult } from './probe'
export { wakeDevice, STAYON, type WakeDeviceOpts } from './wake'
/**
 * Plan 125 (M90) step 125.1 — the transport-level awake policy: the two
 * PERSISTED device settings that keep a boxed phone awake and the read-only
 * screen probe. `packages/core/src/device/awake-policy.ts` is the device-scoped
 * caller that owns the capture persistence, exactly as `labelling.ts` is to
 * `screen-label.ts` above.
 */
export {
  readPowerState,
  applyScreenOffTimeout,
  applyStayOn,
  restoreStayOn,
  observeScreen,
  satisfiesStayOn,
  firstPowerReason,
  type PowerReadback,
  type PowerWrite,
} from './power'
/**
 * Plan 85 §3.7 — the rotation lock's own types. `applyRotation` itself stays
 * internal to this package (`session.ts` is its only caller); the two TYPES
 * are exported because `SessionManager.setRotation` hands a `RotationOutcome`
 * straight out to `packages/core`'s `PATCH /api/devices/:id`, which reports it
 * to the operator who asked for the lock.
 */
export type { RotationLock, RotationOutcome } from './orientation'
// Plan 89 (M54 — device identity and physical labelling), step 89.6/89.7 —
// tier 0's device-scoped, sessionless functions (`packages/core/src/device/labelling.ts`
// is the caller; unlike `applyRotation`/`applyFarmTag` above, these are never
// wired into `session.ts`'s own start/close — §3.6's deliberate departure).
export {
  readLockScreenLabel,
  writeLockScreenLabel,
  restoreLockScreenLabel,
  clearLockScreenLabelToDefault,
  type LockScreenLabel,
} from './screen-label'
export {
  resolveTextRoute,
  applyTextInput,
  ENKAKU_IME_COMPONENT_ID,
  type TextRung,
  type TextRouteDecision,
  type TextInputSetup,
} from './text-input'
