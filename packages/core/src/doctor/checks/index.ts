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
import { coControlCheck } from './co-control'
import type { Check } from '../types'

/**
 * Fixed order (plan 41 §4.3, extended by plan 85 §5 85.6, plan 88 §5 step
 * 88.7, plan 91 §5 step 91.10, plan 89 §4.7, §5 step 89.4): runtime, data
 * dir, config, port, db, tools, adb, devices, labelling, egress, core,
 * streams, host-adb, adb-health, co-control. `labelling` sits right after
 * `devices` — it reads the SAME local database directly, no live core
 * required, same as `devices` itself — rather than down with the
 * core-only five at the end.
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
  coControlCheck,
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
  coControlCheck,
}
