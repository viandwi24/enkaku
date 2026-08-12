import { runtimeCheck } from './runtime'
import { dataDirCheck } from './data-dir'
import { configCheck } from './config'
import { portCheck } from './port'
import { dbCheck } from './db'
import { toolsCheck } from './tools'
import { adbServerCheck } from './adb-server'
import { devicesCheck } from './devices'
import { egressCheck } from './egress'
import { coreCheck } from './core'
import { streamsCheck } from './streams'
import { hostAdbCheck } from './host-adb'
import { adbHealthCheck } from './adb-health'
import type { Check } from '../types'

/**
 * Fixed order (plan 41 §4.3, extended by plan 85 §5 85.6, plan 88 §5 step
 * 88.7): runtime, data dir, config, port, db, tools, adb, devices, egress,
 * core, streams, host-adb, adb-health — the last four only meaningful once a
 * core is running, so they sit at the end next to `core`, which already has
 * that same shape.
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
  egressCheck,
  coreCheck,
  streamsCheck,
  hostAdbCheck,
  adbHealthCheck,
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
  egressCheck,
  coreCheck,
  streamsCheck,
  hostAdbCheck,
  adbHealthCheck,
}
