import { fileURLToPath } from 'node:url'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { detectSupervisionMode, type SupervisionMode } from './supervision'
import type { DrainResult } from './adb-server-control'

export type { SupervisionMode }

/**
 * "Restart Enkaku" (plan 120) — the whole core process, not just the shared
 * adb server (`adb-server-control.ts`'s `cycle()`, spec §10.4, plan 88
 * §3.10). This is a materially bigger blast radius than that button: every
 * live session/stream drops, every in-flight job is interrupted, and for the
 * span of the restart the farm is unreachable — so this module is held to
 * at least the same safety discipline `cycle()` already established
 * (drain sessions/control activities/jobs BEFORE acting), and in the one mode where it
 * can (`bare`), to a stricter one still: never trade a working process for
 * one that might not come up.
 *
 * `restart()` never touches the adb server's own lifecycle — the workspace's
 * one `kill-server` call site stays exactly where plan 88 put it
 * (`adb-server-control.ts`'s `cycle()`), and a workspace-wide test asserts
 * that literal string appears in only that one implementation file. "Restart
 * everything" here means the CORE PROCESS restarts; whatever adb subsystem
 * state it had is torn down and rebuilt fresh by the new process's own boot
 * sequence, the same way it would be after any other restart of this
 * process (a crash, a manual Ctrl-C, a `systemctl restart`) — nothing new.
 *
 * Three deployment modes, three different safe actions — see
 * `supervision.ts`'s own doc comment for the full evidence and reasoning
 * behind each:
 *
 * - **`docker`**: drain, `daemon.stop()`, `process.exit(0)`. Docker's own
 *   `restart: unless-stopped` policy (`docker-compose.yml`) relaunches the
 *   container. A self-respawn is actively WRONG here (PID-1 sensitivity —
 *   see `supervision.ts`).
 * - **`systemd`**: drain, `daemon.stop()`, `process.exit(RESTART_SENTINEL_EXIT_CODE)`.
 *   `deploy/enkaku.service` declares that code as both `SuccessExitStatus`
 *   (so it is never misreported as a crash) and `RestartForceExitStatus`
 *   (so the unit restarts even though it is no longer classified as a
 *   failure) — systemd's own mechanism for a voluntary, non-crash restart
 *   request.
 * - **`bare`**: the only mode this function can PROVE succeeded before the
 *   original process ever stops. It releases the HTTP port, spawns a
 *   detached copy of the exact binary/entry currently running (never a
 *   downloaded or different version — this is "restart what is already
 *   running," not an updater), polls the new process's own `GET
 *   /api/health` with a bounded timeout, and only stops the original
 *   process once that comes back `ok: true`. If the new process never
 *   reports healthy in time, the attempt is refused: the half-started child
 *   is killed, the ORIGINAL process reopens the port it just released, and
 *   the caller gets a real `E_RESTART_FAILED` — never a silent "it probably
 *   worked," and never a working process traded for one that might not
 *   exist.
 *
 * For `docker`/`systemd`, the HTTP response has to be written and actually
 * flushed to the caller BEFORE the process exits — by the time a client
 * could receive a response confirming the exit already happened, the
 * process that would have sent it might already be gone. `restart()`
 * handles this by scheduling the actual stop-and-exit a beat AFTER it
 * returns its report (`deps.scheduleExit`), rather than exiting from inside
 * the call the route is awaiting — see that field's own doc comment for the
 * exact mechanism. `bare` mode has no such problem: success is defined as
 * "the original process is still here to answer," so it can simply return
 * its report normally once the handoff is proven.
 */

/**
 * systemd exit code, chosen deliberately outside the well-known ranges (not
 * `1`/`2` — generic failure/misuse; not `126`/`127` — "command not
 * executable"/"not found"; not `128+n` — "killed by signal n"; not `130` —
 * SIGINT). `75` is `EX_TEMPFAIL` in BSD's `sysexits.h` ("temporary failure,
 * indicating something that is not really an error"), which is close enough
 * in spirit to "this exit is intentional and not a crash" to read sensibly
 * in a log even to someone who has not read this comment. `deploy/enkaku.service`
 * must declare it as both `SuccessExitStatus=75` (systemd does not, on its
 * own, know this exit was voluntary — without this it is counted as a
 * failure in `systemctl status` and against `StartLimitBurst`) AND
 * `RestartForceExitStatus=75` (once it IS classified as a success,
 * `Restart=on-failure` alone would no longer restart it — this is what
 * forces the restart regardless of the `Restart=` policy).
 */
export const RESTART_SENTINEL_EXIT_CODE = 75

export interface AppRestartOpts {
  /** Same meaning as `adb-server-control.ts`'s `AdbCycleOpts.force` — the caller (the route) already decided to proceed despite running jobs / live control markers; threaded through to `drain` so it, not this function, decides whether a still-running job gets force-failed. Sessions and control activities are always drained regardless. */
  force?: boolean
}

export interface AppRestartReport {
  mode: SupervisionMode
  /** `'verified'` only for `bare` — see this file's own header. `'initiated'` for `docker`/`systemd`, where the process cannot outlive its own confirmation. */
  outcome: 'initiated' | 'verified'
  durationMs: number
  sessionsClosed: number
  controlsEnded: number
  jobsFailed: string[]
}

export interface AppRestartDeps {
  /** Injectable for tests; defaults to the real `detectSupervisionMode()`. */
  detectMode?: () => SupervisionMode
  /**
   * Drain live sessions, control activities, and (if the caller already
   * decided to proceed despite them) running jobs — BEFORE anything else happens.
   * Mirrors `adb-server-control.ts`'s own `drainSessions` dep exactly
   * (same `DrainResult` shape, reused rather than redefined) rather than
   * inventing a second, divergent draining discipline for an action with a
   * BIGGER blast radius than the one that already has one.
   */
  drain: (opts: { force: boolean }) => Promise<DrainResult>
  /**
   * The same `daemon.stop()` every mode eventually calls — closes sessions,
   * the plugin host, the database, releases the data-dir lock. Called
   * exactly once per successful restart, always the last thing before the
   * process that calls it exits.
   */
  stopDaemon: () => Promise<void>
  /**
   * `bare` mode ONLY. Closes the HTTP/WS listener WITHOUT touching anything
   * else (db, adb, sessions all keep running) — see `daemon.ts`'s
   * `closeHttpPort()`, which uses a GRACEFUL stop (`server.stop(false)`,
   * not the forced `server.stop(true)` `daemon.stop()` itself uses for a
   * real shutdown): the in-flight HTTP request that triggered this restart
   * must be allowed to finish and send its own response, even though the
   * listening socket stops accepting NEW connections immediately (which is
   * what frees the port for the child to bind).
   */
  closeHttpPort: () => void
  /**
   * `bare` mode's rollback path — reopens the SAME listener on THIS
   * still-alive process (re-runs the exact bind `daemon.ts`'s `start()`
   * used, reusing its already-built handler closures) when the child never
   * became healthy. Never a no-op failure: if this itself throws, that is
   * the one true "cannot make this safe" case — see `restart()`'s own
   * handling.
   */
  reopenHttpPort: () => Promise<void>
  /**
   * `bare` mode ONLY. Spawns a detached copy of the exact binary/entry this
   * process is currently running — same `process.execPath`, same argv
   * shape, same `env`/`cwd` (config precedence is env > file > default;
   * the child must see the identical environment the parent had, never a
   * stripped-down default set). Injectable so a test never spawns a real
   * process. Defaults to `defaultSpawnChild` below.
   */
  spawnChild?: () => AppRestartChildHandle
  /**
   * `bare` mode ONLY. Polls the child's own `GET /api/health` until it
   * reports `ok: true` or `timeoutMs` elapses. Injectable so a test proves
   * both branches (success, timeout) against a fake HTTP server rather than
   * a real spawned process. Defaults to `defaultPollHealth` below.
   */
  pollHealth?: (opts: { host: string; port: number; timeoutMs: number }) => Promise<boolean>
  /** The port/host the child must come up healthy on — the daemon's own, from `cfg`. */
  port: number
  host: string
  /**
   * `docker`/`systemd` ONLY — defers the actual stop-and-exit until AFTER
   * `restart()` has already returned its report, so the HTTP route can send
   * that report and let Bun/Hono flush it over the socket before the
   * process disappears out from under the connection. Injectable so a test
   * can capture the deferred function instead of letting it run (and
   * instead of waiting on a real timer). The default schedules it a short
   * beat out (`setTimeout(..., 150)`) — long enough for a same-machine HTTP
   * response to leave the process, nowhere near long enough to matter to an
   * operator watching a "restarting…" toast.
   */
  scheduleExit?: (run: () => Promise<void>) => void
  /** Defaults to the real `process.exit` — injectable so a test can observe an exit call without actually ending the test process. */
  exit?: (code: number) => void
  log: Logger
}

export interface AppRestartChildHandle {
  pid: number | null
  kill: () => void
}

const HEALTH_TIMEOUT_MS = 15_000
const HEALTH_POLL_INTERVAL_MS = 300
const DEFER_EXIT_MS = 150

/** True inside a `bun build --compile` executable — mirrors `@enkaku/session`'s `isolation.ts#isCompiledBinary` (kept as a local copy rather than a cross-package import, the SAME precedent `plugins/verify-child.ts`'s own identical helper already established: that helper is not part of `@enkaku/session`'s public export list, and duplicating two lines is cheaper and safer than widening that package's surface for one more caller). */
function isCompiledBinary(): boolean {
  return Bun.main.includes('$bunfs') || Bun.main.includes('~BUN')
}

/**
 * The command to relaunch THIS exact running process — never a downloaded
 * or different version, an updater is a different feature entirely. Mirrors
 * `plugins/verify-child.ts`'s own `cmd` construction: inside a compiled
 * binary, `process.execPath` already points at the binary itself, so no
 * extra script-path argument is needed — and unlike that file's
 * `--plugin-verify` flag (which puts ITS child into a special isolated
 * mode), this child gets no special flag at all, because the goal here is
 * an ordinary, full daemon boot (`index.ts`'s own dispatch falls through to
 * `startDaemon()` when no recognised flag is present). Outside a compiled
 * binary, `process.execPath` is the `bun` executable, so the entrypoint's
 * own path has to be supplied explicitly, resolved the same
 * `fileURLToPath(new URL(...))` way `verify-child.ts` resolves its own
 * entry.
 */
function childCommand(): string[] {
  if (isCompiledBinary()) return [process.execPath]
  const entryPath = fileURLToPath(new URL('../index.ts', import.meta.url))
  return [process.execPath, entryPath]
}

const defaultSpawnChild = (): AppRestartChildHandle => {
  const proc = Bun.spawn(childCommand(), {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
    // Detached so the child survives the parent's own exit a moment later
    // (this process is about to stop, not the child) — mirrors the
    // `detached: true, stdio: 'ignore'` shape named in plan 120's own brief.
    // `.unref()` below is Bun's equivalent: it stops THIS process's event
    // loop from waiting on the child, without which `process.exit()` a few
    // lines later in `restart()` would never fire on its own.
  })
  proc.unref()
  return {
    pid: proc.pid,
    kill: () => {
      try {
        proc.kill()
      } catch {
        // Already gone — nothing left to kill.
      }
    },
  }
}

/** Exported for `app-restart-control.test.ts`'s own direct exercise of the real polling logic against a fake HTTP server — every other test in that file injects a fake `pollHealth` instead, since only this one cares about the real implementation. */
export const defaultPollHealth: NonNullable<AppRestartDeps['pollHealth']> = async ({ host, port, timeoutMs }) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(HEALTH_POLL_INTERVAL_MS) })
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
        if (body?.ok === true) return true
      }
    } catch {
      // Not up yet (connection refused, still booting, still binding) — keep polling.
    }
    if (Date.now() >= deadline) return false
    await Bun.sleep(Math.min(HEALTH_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
  }
}

const defaultScheduleExit: NonNullable<AppRestartDeps['scheduleExit']> = (run) => {
  setTimeout(() => void run(), DEFER_EXIT_MS)
}

export interface AppRestartControl {
  restart(opts: AppRestartOpts): Promise<AppRestartReport>
  /** Whether a restart is currently being attempted — a second click can never interleave with the first. */
  busy(): boolean
}

export function createAppRestartControl(deps: AppRestartDeps): AppRestartControl {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const scheduleExit = deps.scheduleExit ?? defaultScheduleExit

  async function restartImpl(opts: AppRestartOpts): Promise<AppRestartReport> {
    const started = Date.now()
    const mode = (deps.detectMode ?? detectSupervisionMode)()
    const log = deps.log

    log.warn(`app restart requested (mode: ${mode}) — draining sessions/control activities${opts.force ? '/jobs' : ''} first`)
    const { sessionsClosed, controlsEnded, jobsFailed } = await deps.drain({ force: Boolean(opts.force) })

    if (mode === 'docker' || mode === 'systemd') {
      const exitCode = mode === 'docker' ? 0 : RESTART_SENTINEL_EXIT_CODE
      log.warn(
        mode === 'docker'
          ? 'app restart: docker mode — stopping and exiting 0; the container restart policy (docker-compose.yml) relaunches it'
          : `app restart: systemd mode — stopping and exiting ${exitCode} (declared as SuccessExitStatus + RestartForceExitStatus in deploy/enkaku.service) so the unit relaunches it`,
      )
      // Deferred: `daemon.stop()` and `exit()` run AFTER this function
      // returns, so the route calling `restart()` can send its report and
      // let it actually leave the process before the process disappears —
      // see this file's own header for why exiting from inside the call
      // the route is awaiting would race the HTTP response.
      // `restart()`'s own `inFlight` mutex clears the instant THIS promise
      // resolves, which is before the deferred stop-and-exit above ever
      // runs — a second `POST` in that ~150ms window is not refused by the
      // mutex. Accepted deliberately rather than engineered around: the
      // process is exiting within that same window regardless, so a second
      // request either arrives at a route that is about to vanish (refused
      // by the connection dropping, not by this mutex) or never arrives at
      // all. Not true for `bare` below, where the process may run for a
      // while longer if the child never becomes healthy — that path's
      // mutex protection is the one that actually matters and IS airtight
      // (`inFlight` stays set for the whole poll).
      scheduleExit(async () => {
        await deps.stopDaemon()
        exit(exitCode)
      })
      return { mode, outcome: 'initiated', durationMs: Date.now() - started, sessionsClosed, controlsEnded, jobsFailed }
    }

    // `bare` — the only mode this function can prove succeeded before the
    // original process ever stops.
    const spawnChild = deps.spawnChild ?? defaultSpawnChild
    const pollHealth = deps.pollHealth ?? defaultPollHealth

    log.warn('app restart: bare mode — releasing the HTTP port for a health-verified handoff')
    deps.closeHttpPort()

    const child = spawnChild()
    log.info(`app restart: spawned child pid=${child.pid ?? 'unknown'} — polling its health on ${deps.host}:${deps.port}`)

    const healthy = await pollHealth({ host: deps.host, port: deps.port, timeoutMs: HEALTH_TIMEOUT_MS })

    if (!healthy) {
      log.error(
        `app restart: the new process never answered GET /api/health with ok:true within ${HEALTH_TIMEOUT_MS}ms — killing it and staying up on this process`,
      )
      child.kill()
      try {
        await deps.reopenHttpPort()
      } catch (err) {
        // This is the one case named in plan 120 §4's "named refusal" — the
        // port could not be released back to THIS process either. There is
        // no safe next step left to take automatically: thrown loudly
        // rather than silently leaving the farm with no listener at all.
        log.error(`app restart: FAILED TO REOPEN THE HTTP PORT after an unhealthy child — the farm may be unreachable: ${String(err)}`)
        throw new EnkakuError(
          'E_RESTART_FAILED',
          `the new process never became healthy, AND this process could not reopen its own port afterward: ${String(err)}`,
        )
      }
      throw new EnkakuError(
        'E_RESTART_FAILED',
        `the new process did not report healthy within ${HEALTH_TIMEOUT_MS}ms — it was killed, and this process kept running`,
      )
    }

    log.warn('app restart: the new process is healthy — stopping this one')
    await deps.stopDaemon()
    exit(0)
    return { mode, outcome: 'verified', durationMs: Date.now() - started, sessionsClosed, controlsEnded, jobsFailed }
  }

  let inFlight: Promise<AppRestartReport> | null = null

  return {
    async restart(opts) {
      if (inFlight) throw new EnkakuError('E_TOOL_IN_USE', 'a restart is already in progress')
      const run = restartImpl(opts)
      inFlight = run
      try {
        return await run
      } finally {
        if (inFlight === run) inFlight = null
      }
    },
    busy: () => inFlight !== null,
  }
}
