export { createSession, type DeviceSession, type CreateSessionOpts, type CreateSessionDeps } from './session'
export { createSessionManager, type SessionManager } from './manager'
export { createInspectorForSession, type InspectorHandle, type InspectorFactoryDeps } from './inspector-factory'
export { PortAllocator, parsePortRange } from './port-allocator'
export { createDeviceExecutor, DEFAULT_TIMING, type TimingSettings } from './device-executor'
export { createJobRunner, type JobRunner, type JobSpec, type ScriptFailure } from './runner/job-runner'
export { createJobLogger, type JobLogger, type JobLogEntry } from './runner/job-logger'
export {
  ChildToParentSchema,
  ParentToChildSchema,
  DeviceCallSchema,
  type ChildToParent,
  type ParentToChild,
  type DeviceCall,
} from './runner/ipc'
export {
  resolveIsolation,
  createChildProcessIsolation,
  createContainerIsolation,
  type IsolationProvider,
  type IsolationMode,
} from './runner/isolation'
export { SessionError } from './errors'
export type { Logger } from './logger'
export type { DeviceSnapshot, DeviceSnapshotSource, ArtifactSink, SavedArtifact } from './types'
export { probeDeviceIdentity, parseWmSize, parseWmDensity, pickStableId, type DeviceProbeResult } from './probe'
