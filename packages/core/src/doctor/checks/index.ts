import { runtimeCheck } from './runtime'
import { dataDirCheck } from './data-dir'
import { configCheck } from './config'
import { portCheck } from './port'
import { dbCheck } from './db'
import { toolsCheck } from './tools'
import { adbServerCheck } from './adb-server'
import { devicesCheck } from './devices'
import { labellingCheck } from './labelling'
import { egressCheck } from './egress'
import { coreCheck } from './core'
import { streamsCheck } from './streams'
import { hostAdbCheck } from './host-adb'
import { adbHealthCheck } from './adb-health'
import { guestAgentCheck } from './guest-agent'
import { androidSdkCheck } from './android-sdk'
import type { Check } from '../types'

/**
 * Fixed order (plan 41 §4.3, extended by plan 85 §5 85.6, plan 88 §5 step
 * 88.7, plan 89 §4.7, §5 step 89.4, plan 401 §5.8): runtime, data dir, config, port, db,
 * tools, adb, devices, labelling, egress, core, streams, host-adb,
 * adb-health, guest-agent, android-sdk. `labelling` sits right after `devices` — it reads the SAME
 * local database directly, no live core required, same as `devices` itself
 * — rather than down with the core-only four at the end. The old
 * subordinate-grant observability check that used to sit last is gone
 * along with the subsystem it watched (plan 205 §4.9). `android-sdk` sits
 * last, beside `guest-agent` — both mirror a resolver's tiers without
 * provisioning anything (plan 400 D3).
 */
export const CHECKS: Check[] = [
  runtimeCheck,
  dataDirCheck,
  configCheck,
  portCheck,
  dbCheck,
  toolsCheck,
  adbServerCheck,
  devicesCheck,
  labellingCheck,
  egressCheck,
  coreCheck,
  streamsCheck,
  hostAdbCheck,
  adbHealthCheck,
  guestAgentCheck,
  androidSdkCheck,
]

export {
  runtimeCheck,
  dataDirCheck,
  configCheck,
  portCheck,
  dbCheck,
  toolsCheck,
  adbServerCheck,
  devicesCheck,
  labellingCheck,
  egressCheck,
  coreCheck,
  streamsCheck,
  hostAdbCheck,
  adbHealthCheck,
  guestAgentCheck,
  androidSdkCheck,
}
