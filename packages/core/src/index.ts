// werift (via tsyringe) needs the Reflect polyfill before its module
// initialisers run; in a compiled binary the bundler's module order no longer
// guarantees that, so the entrypoint imports it first.
import 'reflect-metadata'

// Job-child mode: a compiled binary cannot spawn `bun child-entry.ts`, so the
// job runner re-executes this same binary with `--job-child <bundlePath>` and
// the dispatch happens here, before any daemon code runs (see
// @enkaku/session isolation.ts).
if (process.argv.includes('--job-child')) {
  await import('@enkaku/session/child-entry')
} else {
  const { loadConfig } = await import('./config')
  const { createDaemon } = await import('./daemon')
  const { EnkakuError } = await import('./util/errors')
  const { createLogger } = await import('./util/logger')

  const log = createLogger('main')
  const daemon = createDaemon(loadConfig())

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`received ${signal}, shutting down…`)
    await daemon.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  try {
    await daemon.start()
  } catch (err) {
    if (err instanceof EnkakuError) {
      log.error(`failed to start [${err.code}]: ${err.message}`)
    } else {
      log.error(`failed to start: ${String(err)}`)
    }
    process.exit(1)
  }
}
