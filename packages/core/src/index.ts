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

  /*
    Shutdown in three phases, and only the middle one can be skipped.

    It used to be one: `stop()` then `exit(0)`. `stop()` tears the subsystems
    down immediately, so a job running at that moment died with the process
    and came back on the next boot as `core restarted` — which is exactly
    what an operator pressing Ctrl+C found in their job list. A second Ctrl+C
    did nothing at all, because the handler returned early.

    Now: stop taking new work and WAIT, saying what is being waited for;
    a second Ctrl+C cancels that work; and either way the devices get their
    own screen behaviour back before the process leaves.

    The release is not skippable, and that is deliberate (CEO, 2026-09-07).
    Cancelling is a decision about WORK. Putting a phone back the way we
    found it is cleaning up after ourselves, and a force stop is not a
    licence to leave twenty screens burning. It is bounded per device
    instead, so one phone that has stopped answering cannot hold the farm.
  */
  const WAIT_LIMIT_MS = 120_000
  /** How long the shutdown sweep may go without a single device finishing before we accept adb is wedged and leave. */
  const RELEASE_STALL_MS = 30_000
  const TICK_MS = 2_000

  let phase: 'running' | 'draining' | 'cancelling' | 'leaving' = 'running'

  const banner = (lines: string[]): void => {
    const width = Math.max(...lines.map((l) => l.length)) + 4
    const rule = '─'.repeat(width)
    process.stderr.write(`\n┌${rule}┐\n`)
    for (const l of lines) process.stderr.write(`│  ${l.padEnd(width - 4)}  │\n`)
    process.stderr.write(`└${rule}┘\n\n`)
  }

  const describe = (w: { kind: string; jobId: string; deviceLabel: string | null; deviceId: string }): string =>
    `${w.kind} ${w.jobId.slice(0, 8)} on ${w.deviceLabel ?? w.deviceId.slice(0, 8)}`

  /** Wait, briefly, for cancelled runs to finish settling. */
  const settleWithin = async (ms: number): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until && daemon.inFlight().length > 0) {
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  const leave = async (): Promise<never> => {
    phase = 'leaving'
    // Always, on every path out of here.
    /*
      The sweep is bounded HERE, not inside the readiness manager, which owns
      no timers by design (a test asserts that against its own source). Each
      release is already bounded by adb's own command timeout; this bounds the
      sweep as a whole, so a farm that has gone unreachable can still let the
      process leave.
    */
    let settled = 0
    const { released, failed } = await Promise.race([
      daemon.releaseDevices(() => {
        settled++
      }),
      /*
        A STALL deadline, not a total one.

        A flat total is wrong here, and measurably so: each release is about
        1.4 s of adb round trips, so a 65-device farm needs longer than any
        fixed number an operator would accept, and the old flat 30 s simply
        abandoned the rest of the farm — pinned lit, with no core left running
        to undo it. This is the one step that must never be cut short while it
        is still working, so the clock only runs while nothing is finishing:
        every device that settles pushes it back. A farm of any size gets as
        long as it needs; a farm whose adb has genuinely wedged still lets the
        process leave.
      */
      new Promise<{ released: number; failed: number }>((resolve) => {
        let seen = -1
        const timer = setInterval(() => {
          if (settled !== seen) {
            seen = settled
            return
          }
          clearInterval(timer)
          resolve({ released: settled, failed: -1 })
        }, RELEASE_STALL_MS)
        timer.unref?.()
      }),
    ])
    if (failed === -1) {
      process.stderr.write(
        `\nstopped hearing back from devices — ${settled} handed back, the rest may still be held awake\n`,
      )
    } else if (released > 0 || failed > 0) {
      log.info(`handed ${released} device(s) back their own screen timeout${failed > 0 ? `, ${failed} did not answer` : ''}`)
    }
    await daemon.stop()
    process.exit(0)
  }

  const shutdown = async (signal: string): Promise<void> => {
    /*
      Once the devices are being handed back, no further Ctrl+C skips it.

      This used to `process.exit(130)` here, on the reasoning that reaching
      `leaving` meant two signals had already been spent. That is wrong on an
      IDLE farm: with no jobs running the FIRST signal goes straight through
      `draining` into `leave()`, so the SECOND one — the one an operator
      presses out of habit — killed the release mid-sweep. Measured on the
      owner's farm the same afternoon: `forced exit — devices may still be
      held awake`, and a phone left at `stay_on_while_plugged_in = 15` with no
      core running to undo it (2026-09-07).

      Force-stopping is for WORK. That is the `draining` → `cancelling`
      transition below, and it stays. The wake release is the one step that
      must always be waited for — the owner's own condition when this was
      designed — because there is nothing left afterwards to repair a phone it
      skipped. It cannot hang the process either: the sweep has its own stall
      deadline, and `kill -9` is still there for an operator who truly means it.
    */
    if (phase === 'cancelling' || phase === 'leaving') {
      process.stderr.write('\nstill handing the devices back — this step is not skipped, or phones stay lit. (kill -9 to override.)\n')
      return
    }

    if (phase === 'draining') {
      phase = 'cancelling'
      const aborted = daemon.cancelWork()
      banner([`Cancelling ${aborted} running job${aborted === 1 ? '' : 's'}.`, 'Devices are still handed back before exit.'])
      // Cancelling is asynchronous: the run settles, and only then does it
      // let go of the device it was holding. Leaving immediately meant the
      // release ran ten milliseconds later, found the hold still live, and
      // left the phone forced awake (owner, 2026-09-07). Bounded, because a
      // run that will not settle must not become a hang.
      await settleWithin(5_000)
      await leave()
      return
    }

    phase = 'draining'
    log.info(`received ${signal}, shutting down…`)
    const inFlight = daemon.quiesce()
    if (inFlight.length === 0) {
      await leave()
      return
    }

    banner([
      `WAITING FOR ${inFlight.length} RUNNING JOB${inFlight.length === 1 ? '' : 'S'}`,
      '',
      ...inFlight.slice(0, 6).map(describe),
      ...(inFlight.length > 6 ? [`…and ${inFlight.length - 6} more`] : []),
      '',
      'No new work is being started.',
      'Press Ctrl+C again to cancel them.',
    ])

    const deadline = Date.now() + WAIT_LIMIT_MS
    for (;;) {
      // `phase` moves under us when a second signal arrives — that path does
      // its own cancelling and leaving, so this loop simply stops.
      if (phase !== 'draining') return
      const left = daemon.inFlight()
      if (left.length === 0) {
        log.info('every job finished')
        break
      }
      if (Date.now() >= deadline) {
        banner([`Still running after ${WAIT_LIMIT_MS / 1000}s — cancelling ${left.length}.`])
        daemon.cancelWork()
        break
      }
      log.info(`waiting for ${left.length} job(s): ${left.slice(0, 3).map(describe).join(', ')}`)
      await new Promise((r) => setTimeout(r, TICK_MS))
    }
    await leave()
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
  // Which guest agent APK this core would install, said ONCE at boot.
  //
  // Nothing used to say it, and the silence cost an afternoon: a phone
  // running an August build with no `ui-tree` capability sent every script
  // back to `ui-server`'s ~32 s attach while two landed plans sat dormant
  // (2026-09-04). One line here answers "is the build I am working on the one
  // that reaches the phone?" before anyone has to ask it. `doctor` says the
  // same thing with a remedy; the status bar renders that.
  void import('./api/guest-agent')
    .then(({ describeGuestAgentApk }) => describeGuestAgentApk())
    .then(({ detail }) => log.info(`guest agent APK: ${detail}`))
    .catch(() => undefined)

  maybeOpenBrowser({
    url: buildStudioUrl(cfg),
    mode: process.env.ENKAKU_MODE,
    host: cfg.host,
    isTTY: process.stdout.isTTY === true,
    open: process.env.ENKAKU_OPEN,
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
  } else if (cmd === 'reset') {
    // The counterpart to `backup`, and the one the release binary was
    // missing: `bun run reset` at the repo root is an `rm -rf` of dev paths
    // that no shipped binary has (owner, 2026-09-05).
    const { runReset } = await import('./reset/index')
    const exitCode = await runReset(process.argv.slice(3))
    process.exit(exitCode)
  } else if (cmd === '--version' || cmd === '-v') {
    const pkg = await import('../package.json')
    console.log(pkg.version)
  } else {
    await startDaemon()
  }
}
