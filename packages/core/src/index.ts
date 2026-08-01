import { loadConfig } from './config'
import { createDaemon } from './daemon'
import { EnkakuError } from './util/errors'
import { createLogger } from './util/logger'

const log = createLogger('main')
const daemon = createDaemon(loadConfig())

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`terima ${signal}, shutdown...`)
  await daemon.stop()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await daemon.start()
} catch (err) {
  if (err instanceof EnkakuError) {
    log.error(`gagal start [${err.code}]: ${err.message}`)
  } else {
    log.error(`gagal start: ${String(err)}`)
  }
  process.exit(1)
}
