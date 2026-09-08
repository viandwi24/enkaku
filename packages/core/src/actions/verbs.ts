import type { ActivityKind, ActionVerb } from '@enkaku/protocol'
import type { Permission } from '../auth/acl'
import { ACTION_FANOUT_MAX, ACTION_SOCKET_FANOUT, ACTION_SYNC_FANOUT_MAX } from '../config/constants'
import { computeAsyncFanout, computeSyncFanout } from '../device/adb-scaling'

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
  /**
   * Which queue this verb's per-device work actually joins, and therefore
   * what its fan-out width should follow (plan 227 §3.2).
   *
   * `'adb'` (the default, and every verb that does not say otherwise) means
   * the work goes through adb's counted semaphore, so the width follows that
   * semaphore's live value. `'socket'` means it does not touch adb at all —
   * `screen-off`/`screen-on` write two bytes to a scrcpy control socket this
   * process already holds open — so bounding it by the adb lane would be
   * bounding it by a queue it never joins.
   *
   * This field exists so the answer is written on the verb rather than
   * inferred. When plan 226 Q1 lands and `sleep` stops needing its
   * `stay_on_while_plugged_in` write, `sleep` becomes a one-word change here.
   */
  lane?: 'adb' | 'socket'
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
  // `device.view`, the same gate `wake`/`sleep` carry: darkening the panel a
  // viewer is watching is a viewing gesture, and the mirror keeps working
  // either way. `lane: 'socket'` because the whole operation is two bytes on
  // a control socket this process already holds — it never joins adb's queue,
  // so it must not be bounded by adb's width (plan 227 §3.2, §3.3).
  'screen-off':   { gate: { permission: 'device.view' },        policyKind: null,            offline: 'skip',  mode: 'sync', lane: 'socket' },
  'screen-on':    { gate: { permission: 'device.view' },        policyKind: null,            offline: 'skip',  mode: 'sync', lane: 'socket' },
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
 * How wide one action fans out over its selection.
 *
 * This used to be two bare `export const`s here — `ACTION_FANOUT_CONCURRENCY
 * = 4` and `ACTION_SYNC_FANOUT_CONCURRENCY = 16` — with no override and no
 * awareness of how big the farm is. Plan 227 §3.2 records what that cost: on
 * 73 devices a bulk screenshot ran four at a time, nineteen waves of it, and
 * the sync constant's own comment justified 16 against "adb's own farm-wide
 * semaphore, 6 by default" while `computeAutoConcurrency` was returning 24 for
 * that farm. The number's stated reason had stopped describing the farm it was
 * bounding, and nobody could have widened it without a build.
 *
 * The width is now derived per call from the lane the work joins
 * (`device/adb-scaling.ts`), bounded by an `ENKAKU_*` override
 * (`config/constants.ts`). Both floors are the old values, so no farm gets
 * narrower than it was.
 *
 * Plan 207 §11's recorded `GREP_207_CONSOLE` `fanout` hit moves here with the
 * concept; it is still the one place the term cannot be avoided, and it is
 * still a compiled-in default rather than a console setting.
 */
export function actionFanout(spec: VerbSpec, adbConcurrency: number): number {
  if (spec.lane === 'socket') return ACTION_SOCKET_FANOUT
  return spec.mode === 'sync' ? computeSyncFanout(adbConcurrency, ACTION_SYNC_FANOUT_MAX) : computeAsyncFanout(adbConcurrency, ACTION_FANOUT_MAX)
}
