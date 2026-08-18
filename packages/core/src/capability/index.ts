import { AGENT_TREE_CAPABILITIES } from './agent'
import { NOTIFY_CAPABILITIES } from './notify'
import { DEVICE_APP_CAPABILITIES } from './device-app'
import { DEVICE_CLIPBOARD_CAPABILITIES } from './device-clipboard'
import { DEVICE_FILES_CAPABILITIES } from './device-files'
import { DEVICE_INPUT_CAPABILITIES } from './device-input'
import { DEVICE_INSPECT_CAPABILITIES } from './device-inspect'
import { DEVICE_NETWORK_CAPABILITIES } from './device-network'
import { DEVICE_STATE_CAPABILITIES } from './device-state'
import { FILE_TOOLS_CAPABILITIES } from './file-tools'
import { FS_CAPABILITIES } from './fs'
import { JOB_CAPABILITIES } from './job'
import { buildCapabilityRegistry, type CapabilityRegistry, type CapabilitySource } from './registry'
import { SCRIPT_CAPABILITIES } from './script'
import { SKILLS_CAPABILITIES } from './skills'
import type { AnyCoreCapability } from './types'

const SOURCES: { file: string; caps: AnyCoreCapability[] }[] = [
  { file: 'capability/device-input.ts', caps: DEVICE_INPUT_CAPABILITIES },
  { file: 'capability/device-inspect.ts', caps: DEVICE_INSPECT_CAPABILITIES },
  { file: 'capability/device-app.ts', caps: DEVICE_APP_CAPABILITIES },
  { file: 'capability/device-files.ts', caps: DEVICE_FILES_CAPABILITIES },
  { file: 'capability/device-clipboard.ts', caps: DEVICE_CLIPBOARD_CAPABILITIES },
  { file: 'capability/device-state.ts', caps: DEVICE_STATE_CAPABILITIES },
  { file: 'capability/device-network.ts', caps: DEVICE_NETWORK_CAPABILITIES },
  { file: 'capability/script.ts', caps: SCRIPT_CAPABILITIES },
  { file: 'capability/job.ts', caps: JOB_CAPABILITIES },
  { file: 'capability/fs.ts', caps: FS_CAPABILITIES },
  { file: 'capability/file-tools.ts', caps: FILE_TOOLS_CAPABILITIES },
  { file: 'capability/skills.ts', caps: SKILLS_CAPABILITIES },
  { file: 'capability/agent.ts', caps: AGENT_TREE_CAPABILITIES },
  { file: 'capability/notify.ts', caps: NOTIFY_CAPABILITIES },
]

/** Every capability the farm declares, assembled into `{ cap, file }` pairs
 * so `buildCapabilityRegistry`'s duplicate-id check can name both files
 * (plan 63 §6.2). Add a capability by adding one entry to its own file's
 * array and nothing else (plan 63 §4.3). */
export function allCapabilitySources(): CapabilitySource[] {
  return SOURCES.flatMap(({ file, caps }) => caps.map((cap) => ({ cap, file })))
}

/** Builds the registry from every declared capability — called once at
 * boot (`daemon.ts`); a duplicate id or an unconvertible schema throws and
 * the process does not start (plan 63 §4.2, acceptance #1–3). */
export function buildCoreCapabilityRegistry(): CapabilityRegistry {
  return buildCapabilityRegistry(allCapabilitySources())
}

export { invoke, extractDeviceId, type InvokeDeps } from './invoke'
export {
  createCapabilityContext,
  type CapabilityActor,
  type CapabilityContext,
  type CapabilityContextDeps,
  type ScriptCapabilityService,
  type AgentTreeOps,
  type AgentSpawnInput,
  type AgentSpawnResult,
  type AgentStatusResult,
  type AgentCancelResult,
} from './context'
export { createDeviceNetworkService, type DeviceNetworkCapabilityService } from './device-network'
export { buildCapabilityRegistry, type CapabilityRegistry, type CapabilitySource } from './registry'
export { defineCapability, type AnyCoreCapability, type CoreCapability } from './types'
