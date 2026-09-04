import type { ActivityKind, ActionVerb } from '@enkaku/protocol'
import type { Permission } from '../auth/acl'

/** `shell`: `canUseShell(role, shell.mode)`; `files`: `canUseFiles(role, shell.mode)` plus `transfer.enabled`. */
export type VerbGate = { permission: Permission } | { gate: 'shell' } | { gate: 'files' }

export interface VerbSpec {
  gate: VerbGate
  /** The row of MVP 04 §1.3 evaluated before dispatch; null means the implementation's own refusals are the only guard. */
  policyKind: ActivityKind | null
  /** Whether an offline or quarantined device is dispatched (`allow`) or reported `skipped` (`skip`). */
  offline: 'allow' | 'skip'
  /** `sync` answers `done` in the 202; `async` answers `accepted` and settles on the operation. */
  mode: 'sync' | 'async'
}

export const VERBS: Record<ActionVerb, VerbSpec> = {
  'run-script':   { gate: { permission: 'job.run' },            policyKind: null,            offline: 'skip',  mode: 'sync' },
  'run-workflow': { gate: { permission: 'job.run' },            policyKind: null,            offline: 'skip',  mode: 'sync' },
  install:        { gate: { gate: 'files' },                    policyKind: 'install',       offline: 'skip',  mode: 'async' },
  push:           { gate: { gate: 'files' },                    policyKind: 'transfer',      offline: 'skip',  mode: 'async' },
  pull:           { gate: { gate: 'files' },                    policyKind: 'transfer',      offline: 'skip',  mode: 'async' },
  adb:            { gate: { gate: 'shell' },                    policyKind: 'command',       offline: 'skip',  mode: 'async' },
  wake:           { gate: { permission: 'device.view' },        policyKind: null,            offline: 'skip',  mode: 'sync' },
  sleep:          { gate: { permission: 'device.view' },        policyKind: null,            offline: 'skip',  mode: 'sync' },
  reconnect:      { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  disconnect:     { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'skip',  mode: 'sync' },
  cutover:        { gate: { permission: 'device.enroll' },      policyKind: null,            offline: 'allow', mode: 'sync' },
  forget:         { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  block:          { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  unquarantine:   { gate: { permission: 'device.quarantine' },  policyKind: null,            offline: 'allow', mode: 'sync' },
  'set-network':  { gate: { permission: 'device.network' },     policyKind: 'network-apply', offline: 'allow', mode: 'async' },
  'set-label':    { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'skip',  mode: 'sync' },
  'clear-label':  { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'skip',  mode: 'sync' },
  'set-group':    { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  'set-tags':     { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  prepare:        { gate: { permission: 'device.settings' },    policyKind: 'prep',          offline: 'skip',  mode: 'async' },
  'retry-prepare':{ gate: { permission: 'device.settings' },    policyKind: 'prep',          offline: 'skip',  mode: 'async' },
  reprofile:      { gate: { permission: 'device.settings' },    policyKind: 'wake',          offline: 'skip',  mode: 'sync' },
  // Both take minutes on a slow phone and both write an APK, so: `async`
  // (the operator gets an operation to watch, not a hung request), `prep`
  // (the same policy row every other provisioning step evaluates), and
  // `device.settings` (installing the agent is a device-configuration act,
  // not a control gesture).
  'install-agent':  { gate: { permission: 'device.settings' },  policyKind: 'prep',          offline: 'skip',  mode: 'async' },
  'uninstall-agent':{ gate: { permission: 'device.settings' },  policyKind: 'prep',          offline: 'skip',  mode: 'async' },
  screenshot:     { gate: { permission: 'device.view' },        policyKind: null,            offline: 'skip',  mode: 'async' },
  'clear-cache':  { gate: { permission: 'device.control' },     policyKind: 'command',       offline: 'skip',  mode: 'async' },
  settings:       { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
}

/**
 * Bounded async dispatch width per operation (plan 207 §3.2 item 6). This
 * constant's name is the one place `GREP_207_CONSOLE`'s `fanout` term
 * cannot be avoided: it replaces the console's five fan-out settings with a
 * single compiled-in number, exactly what MVP 12 §3 asks for ("such numbers
 * constants"). Recorded as a known, intentional grep hit in plan 207 §11.
 */
export const ACTION_FANOUT_CONCURRENCY = 4
