// werift (via tsyringe) needs the Reflect polyfill before its module
// initialisers run; in a compiled binary the bundler's module order no longer
// guarantees that, so the entrypoint imports it first.
import 'reflect-metadata'

/**
 * Starts the daemon and keeps the process alive until SIGINT/SIGTERM.
 * The default path — everything the entrypoint did before plan 41.
 */
async function startDaemon(): Promise<void> {
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

/**
 * A deliberately minimal CLI layer (plan 41 §3.4, §4.4) — three commands,
 * one if/else chain, on purpose: `doctor` is the diagnostic that must work
 * even when the daemon itself cannot start (a bad config, a busy port, a
 * missing data directory), so it cannot be an API endpoint and cannot depend
 * on `startDaemon()` succeeding. `entry-release.gen.ts` (the compiled
 * binary's entrypoint) ends with `await import('./index')`, so this exact
 * dispatch runs identically from source and from the compiled binary — a
 * `doctor` that only worked from source would miss its whole audience.
 */
if (process.argv.includes('--job-child')) {
  // A compiled binary cannot spawn `bun child-entry.ts`, so the job runner
  // re-executes this same binary with `--job-child <bundlePath>` and the
  // dispatch happens here, before any daemon code runs (see @enkaku/session
  // isolation.ts).
  await import('@enkaku/session/child-entry')
} else {
  const [, , cmd] = process.argv
  if (cmd === 'doctor') {
    const { runDoctor } = await import('./doctor/index')
    const exitCode = await runDoctor({ json: process.argv.includes('--json') })
    process.exit(exitCode)
  } else if (cmd === '--version' || cmd === '-v') {
    const pkg = await import('../package.json')
    console.log(pkg.version)
  } else {
    await startDaemon()
  }
}
