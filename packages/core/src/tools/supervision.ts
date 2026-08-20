import { existsSync } from 'node:fs'
import type { SupervisionMode } from '@enkaku/protocol'

export type { SupervisionMode }

/**
 * "Restart Enkaku" (plan 120 §3, §4) needs to know, before it does anything
 * else, which of three genuinely different situations it is running in —
 * because a clean `process.exit()` and a self-respawn are each safe in
 * exactly one of them, not all three. This is what makes the wrong branch a
 * silent failure rather than a loud one: picking the wrong mechanism does
 * not throw, it just leaves the farm dark with no supervisor watching to
 * bring it back.
 *
 * The evidence, read directly from the files in this repo rather than
 * assumed:
 *
 * - **Docker** (`docker-compose.yml`: `restart: unless-stopped`) — a clean
 *   exit is caught and relaunched by Docker's own restart policy. The
 *   container is PID-1-sensitive: if the main process spawns a detached
 *   child and exits, Docker considers the container's main process gone and
 *   tears the whole cgroup down (the detached child included), because
 *   `Dockerfile`'s `CMD` never installs an init that would keep the cgroup
 *   alive for an orphaned grandchild. A self-respawn is therefore NOT safe
 *   here — the correct action is: drain, stop, `process.exit(0)`, and trust
 *   the restart policy already declared in `docker-compose.yml`.
 * - **systemd** (`deploy/enkaku.service`: `Type=simple`, `Restart=on-failure`)
 *   — `Restart=on-failure` does not fire on a clean `exit(0)`; it fires on a
 *   non-zero exit, a signal death, or a failed start. A voluntary restart
 *   therefore has to exit with a distinct, documented sentinel code
 *   (`RESTART_SENTINEL_EXIT_CODE` in `app-restart-control.ts`) that the unit
 *   file declares as BOTH `SuccessExitStatus` (so it is not misreported as a
 *   crash) and `RestartForceExitStatus` (so it restarts even though it is no
 *   longer classified as a failure) — systemd's own mechanism for exactly
 *   this: a service voluntarily signalling "please relaunch me, this was not
 *   a crash." A self-respawn was considered and rejected for this mode: it
 *   would run the new process OUTSIDE systemd's cgroup and tracking, so
 *   `systemctl stop`/`restart`/`status` would stop controlling the actually-
 *   running process, `systemctl stop` would leave an orphan running, and any
 *   FUTURE crash of that orphan would never trigger `Restart=on-failure`
 *   again — a real regression for that deployment mode, not a shortcut.
 * - **Bare process** — `docs/guide/install.md`'s own "1. Local (easiest)"
 *   path (`bun install && bun run dev`, the owner's own current, actual
 *   setup) and a downloaded release binary run directly (`./enkaku`, no
 *   systemd unit). There is no external process watching this one at all —
 *   the ONLY way "restart" can mean anything here is a self-respawn: spawn a
 *   detached child of the exact same binary/entry, verify it is genuinely
 *   healthy, and only THEN stop the original. This is the default when
 *   neither of the other two signals is present, matching the fact that it
 *   is also the actual default deployment shape this repo ships (`bun run
 *   dev` needs no config at all).
 *
 * **Detection, in the order checked:**
 *
 * 1. `/.dockerenv` exists — the standard, widely-relied-on signal a process
 *    is running inside a Docker container. Checked as a runtime file rather
 *    than a `Dockerfile`-baked build-time env flag: it needs no `Dockerfile`
 *    change (this repo's `Dockerfile` sets no such flag today — checked this
 *    session, zero hits), it survives an operator's own custom image built
 *    `FROM` this repo's image without having to remember to re-declare a
 *    flag, and Docker itself is the one that creates the file, so there is
 *    nothing here to keep in sync with a build step. The known gap: an
 *    operator running under a DIFFERENT container runtime that does not
 *    create `/.dockerenv` (Podman, by default, does not) is mis-detected as
 *    `bare` — which still degrades safely (bare mode's self-respawn still
 *    works, it simply does not get Docker's own restart-policy framing) —
 *    recorded as an open question in plan 120 §9 rather than silently
 *    assumed away.
 * 2. `process.env.INVOCATION_ID` is set — systemd sets this for every unit
 *    it manages, `Type=simple` included (verified against systemd's own
 *    documented behaviour: `INVOCATION_ID` is exported into a unit's own
 *    execution environment for the whole lifetime of that specific
 *    invocation, regardless of service `Type=`), so a process can always
 *    tell "I am running under systemd" from its own environment with no
 *    extra wiring.
 * 3. Otherwise, `bare` — the explicit default, not a fallback assumed by
 *    omission.
 *
 * A pure function taking its two real-world signals through injectable
 * seams, so every branch is unit-tested directly (`supervision.test.ts`)
 * without actually running inside Docker or under systemd.
 */
export interface DetectSupervisionModeDeps {
  /** Defaults to `existsSync('/.dockerenv')`. */
  dockerEnvExists?: () => boolean
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
}

export function detectSupervisionMode(deps: DetectSupervisionModeDeps = {}): SupervisionMode {
  const dockerEnvExists = deps.dockerEnvExists ?? (() => existsSync('/.dockerenv'))
  const env = deps.env ?? process.env
  if (dockerEnvExists()) return 'docker'
  if (env.INVOCATION_ID) return 'systemd'
  return 'bare'
}
