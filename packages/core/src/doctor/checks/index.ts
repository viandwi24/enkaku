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
import type { Check } from '../types'

/** Fixed order (plan 41 §4.3): runtime, data dir, config, port, db, tools, adb, devices, egress, core (only when running). */
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
}
