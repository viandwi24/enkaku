// No static import remains in this file (every dependency below is a dynamic
// `import()`, deliberately, to keep `--version`/`--json` fast) — this empty
// export is only so TypeScript treats the file as a module, which top-level
// `await` requires.
export {}

/**
 * Starts the daemon and keeps the process alive until SIGINT/SIGTERM.
 * The default path — everything the entrypoint did before plan 41.
 */
async function startDaemon(): Promise<void> {
  const { EnkakuError } = await import('./util/errors')
  const { createLogger } = await import('./util/logger')
  const { maybeOpenBrowser, buildStudioUrl } = await import('./util/open-browser')

  const log = createLogger('main')

  // `./config` imports `./config/constants` as its first import (plan 212
  // §4.4), and both a support override read at module load and `loadConfig()`
  // itself can throw `E_BAD_CONFIG`. Either failure prints the code and
  // message and exits 1 rather than an unhandled-rejection stack.
  let cfg: import('./config').CoreConfig
  let createDaemon: typeof import('./daemon').createDaemon
  try {
    const configModule = await import('./config')
    cfg = configModule.loadConfig()
    createDaemon = (await import('./daemon')).createDaemon
  } catch (err) {
    if (err instanceof EnkakuError) log.error(`failed to start [${err.code}]: ${err.message}`)
    else log.error(`failed to start: ${String(err)}`)
    process.exit(1)
  }

  const daemon = createDaemon(cfg)

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
  // Plan 85 §3.4, §5 step 85.3: on Windows, closing the terminal window (or a
  // logoff) does not deliver SIGTERM the way it does on POSIX — Node/Bun's
  // own docs describe `SIGHUP` as exactly the event that DOES fire there
  // (paraphrased: emitted on Windows when the terminal window is closed, and
  // on other platforms under various similar conditions), so it gets the
  // same clean shutdown SIGINT/SIGTERM already get, on every platform.
  process.on('SIGHUP', () => void shutdown('SIGHUP'))
  // Best-effort belt-and-suspenders for any OTHER quiet-exit path neither
  // signal covers: `beforeExit` fires once the event loop has nothing left
  // to do, before the process actually exits, which is late enough to still
  // reach `daemon.stop()` → `hostAdb.killAll()` (F12) rather than leaving a
  // per-device `adb.exe` behind. It never fires on a forceful kill, hence
  // "best-effort" — SIGHUP/SIGTERM/SIGINT above remain the real coverage.
  process.on('beforeExit', () => void shutdown('beforeExit'))

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

  // Spec §2/§5.1, plan 87 §4.11 — "Studio opens in the browser," but only
  // now: `daemon.start()` resolving without throwing is the confirmation
  // that `Bun.serve()` already succeeded and Studio is being served (true in
  // every mode, including orchestrator's early return, which still happens
  // after `listen`). Suppressed by default for anything that is not an
  // interactive desktop session — see `shouldOpenBrowser`'s own doc comment.
  maybeOpenBrowser({
    url: buildStudioUrl(cfg),
    mode: process.env.ENKAKU_MODE,
    host: cfg.host,
    isTTY: process.stdout.isTTY === true,
    noOpen: process.env.ENKAKU_NO_OPEN,
    log,
  })
}

/**
 * A deliberately minimal CLI layer (plan 41 §3.4, §4.4) — four commands,
 * one if/else chain, on purpose: `doctor` is the diagnostic that must work
 * even when the daemon itself cannot start (a bad config, a busy port, a
 * missing data directory), so it cannot be an API endpoint and cannot depend
 * on `startDaemon()` succeeding. `backup` (`packages/core/src/backup/index.ts`)
 * has the same requirement for a related reason: an operator reaching for a
 * backup is often already worried something is wrong with the daemon, so it
 * must not depend on `startDaemon()` succeeding either, and must not share a
 * process with a daemon whose live `enkaku.db` it reads out from under it.
 * `entry-release.gen.ts` (the compiled binary's entrypoint) ends with
 * `await import('./index')`, so this exact dispatch runs identically from
 * source and from the compiled binary — a `doctor` or `backup` that only
 * worked from source would miss its whole audience.
 */
if (process.argv.includes('--job-child')) {
  // A compiled binary cannot spawn `bun child-entry.ts`, so the job runner
  // re-executes this same binary with `--job-child <bundlePath>` and the
  // dispatch happens here, before any daemon code runs (see @enkaku/session
  // isolation.ts).
  await import('@enkaku/session/child-entry')
} else if (process.argv.includes('--plugin-verify')) {
  // Plan 82 §3.7 — the SAME re-exec trick as `--job-child`, for the bounded
  // throwaway child that imports a staged plugin bundle and reports its
  // shape (`plugins/verify-child.ts`).
  await import('./plugins/verify-child-entry')
} else {
  const [, , cmd] = process.argv
  if (cmd === 'doctor') {
    const { runDoctor } = await import('./doctor/index')
    const exitCode = await runDoctor({ json: process.argv.includes('--json') })
    process.exit(exitCode)
  } else if (cmd === 'backup') {
    const { runBackup } = await import('./backup/index')
    const exitCode = await runBackup(process.argv.slice(3))
    process.exit(exitCode)
  } else if (cmd === '--version' || cmd === '-v') {
    const pkg = await import('../package.json')
    console.log(pkg.version)
  } else {
    await startDaemon()
  }
}
