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
  'apply-screen-label': { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'skip',  mode: 'sync' },
  'clear-screen-label': { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'skip',  mode: 'sync' },
  'set-group':    { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  'set-labels':   { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
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

/**
 * The same bounded dispatch, for the `sync` verbs — and it is wider on
 * purpose.
 *
 * `ACTION_FANOUT_CONCURRENCY` above bounds the async verbs, which write to the
 * device: an install pushes an APK, a push moves a file, a prepare rewrites
 * settings. Four at once is the right ceiling for that, and it is not what
 * this number is for.
 *
 * The sync verbs are control gestures and database rows — `wake`, `sleep`,
 * `set-labels`, `block`, `forget`. Their per-device cost is one or two shell
 * round trips at most, and after plan 226 a sleep on a device with a session
 * open is one. They were nevertheless run STRICTLY ONE AT A TIME, in a plain
 * `for await` loop, inside the request the browser is holding open: selecting
 * a 66-device farm and pressing Sleep meant 66 sequential wakes of roughly two
 * seconds each, so the operator watched a spinner for two and a half minutes
 * while the competitor's farm went dark in one blink (owner, 2026-09-07). That
 * loop, not the adb commands underneath it, was the larger half of the wait.
 *
 * Sixteen rather than unbounded because the real floor is still adb's own
 * farm-wide semaphore (`adb.maxConcurrent`, 6 by default and pinnable to 2):
 * past that width this number stops buying anything and only makes the queue
 * behind it longer. It is deliberately a separate constant from the async one
 * so a future change to either cannot silently move the other.
 */
export const ACTION_SYNC_FANOUT_CONCURRENCY = 16
