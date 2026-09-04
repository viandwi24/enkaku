import { isLoopback } from '../config'
import type { Logger } from './logger'

/**
 * Zero-config browser auto-open (spec §2, §5.1, plan 87 §4.11 / step
 * 87.12) — "Double-click → the core starts → Studio opens in the browser."
 * This is the ONE place that ever spawns a browser; the decision
 * (`shouldOpenBrowser`), the per-platform command (`browserOpenCommand`) and
 * the orchestration (`maybeOpenBrowser`) are kept separate so each is
 * independently testable without ever spawning a real process.
 */

/**
 * Injectable so tests never launch a real browser — mirrors the
 * `WindowsCommandRunner` pattern `doctor/context.ts` already uses for the
 * same reason ("your Windows code paths will run on this macOS dev box
 * during tests").
 */
export type BrowserSpawner = (command: string, args: string[]) => { exited: Promise<number> }

const defaultSpawn: BrowserSpawner = (command, args) =>
  Bun.spawn([command, ...args], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })

export interface BrowserCommand {
  command: string
  args: string[]
}

/**
 * The platform argv that opens `url` in the system's default browser.
 * Windows gets its own branch, the same explicit `win32` special-case style
 * `util/paths.ts` (`resolveDataDir`) and `doctor/context.ts`
 * (`findPortHolder`) already use.
 *
 * `cmd /c start` has a well-known quoting pitfall: `start`'s FIRST quoted
 * argument is taken as the new window's TITLE, not the target — so
 * `cmd /c start "http://host/?a=b&c=d"` can silently swallow the URL as a
 * title instead of opening it. The fix (the same one Node's own ecosystem
 * `open` tooling uses) is to always pass an explicit empty title ahead of
 * the URL: `cmd /c start "" <url>`.
 */
export function browserOpenCommand(url: string, platform: typeof process.platform = process.platform): BrowserCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] }
  return { command: 'xdg-open', args: [url] }
}

/** Truthy the same way every other boolean-shaped env var in this codebase is read: unset/anything else is falsy. */
function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export interface ShouldOpenBrowserInput {
  /** `process.env.ENKAKU_MODE` — `'orchestrator'` is the cloud control plane (spec §5.3): a headless split control-plane process, never a desktop. */
  mode: string | undefined
  /** The resolved bind host (`cfg.host`). */
  host: string
  /** `process.stdout.isTTY` — `false` when this process was spawned by systemd, Docker, or CI, none of which attach a controlling terminal. */
  isTTY: boolean
  /** `process.env.ENKAKU_OPEN` — opt IN to a spawned browser. Absent or falsy means no browser, which is the default (CEO, 2026-09-04). */
  open: string | undefined
  /** Injectable for the same reason `browserOpenCommand`'s platform is — defaults to the real `isLoopback` from `../config`. */
  isLoopbackHost?: (host: string) => boolean
}

/**
 * Whether to spawn a browser at boot. **The default is no.**
 *
 * It used to be yes for anything that looked like a person double-clicking
 * the binary on a desktop. In practice the people who actually run this
 * command are developers restarting the core dozens of times an hour, and
 * every restart stole focus with a new tab. The CEO set the default to off on
 * 2026-09-04: opening someone's browser is a side effect, and a side effect
 * belongs behind an explicit request.
 *
 * `ENKAKU_OPEN=1` opts in, and the three headless guards still apply on top
 * of it, because they exist to stop a server from trying to launch a browser
 * on a machine with no display — a mistake an explicit opt-in in a shared
 * `.env` could otherwise still make:
 *  - `ENKAKU_MODE=orchestrator` is the cloud control plane, always headless.
 *  - A non-loopback bind is what `docker-compose.yml` and
 *    `deploy/enkaku.service` both set (`ENKAKU_BIND=0.0.0.0`) to describe
 *    themselves as headless.
 *  - A missing TTY catches what the other two do not: a CI job, or a
 *    sandboxed run that never overrides the loopback default.
 */
export function shouldOpenBrowser(input: ShouldOpenBrowserInput): boolean {
  if (!isTruthyEnv(input.open)) return false
  if (input.mode === 'orchestrator') return false
  const loopback = (input.isLoopbackHost ?? isLoopback)(input.host)
  if (!loopback) return false
  return input.isTTY === true
}

/** `http://host:port/` (or `https://` in self-signed TLS mode) — root always serves Studio (or the "no build found" placeholder page), never a 404, so it is always a safe URL to open. Brackets an IPv6 literal host so the result is a valid URL. */
export function buildStudioUrl(cfg: { host: string; port: number; tls: { mode: string } }): string {
  const scheme = cfg.tls.mode === 'self' ? 'https' : 'http'
  const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host
  return `${scheme}://${host}:${cfg.port}/`
}

export interface MaybeOpenBrowserOptions {
  /** Built by `buildStudioUrl` — the URL to print, and to open when this run qualifies. */
  url: string
  mode: string | undefined
  host: string
  isTTY: boolean
  open: string | undefined
  log: Logger
  platform?: typeof process.platform
  spawn?: BrowserSpawner
  isLoopbackHost?: (host: string) => boolean
}

/**
 * Call ONLY once the caller has confirmed the server is actually listening
 * and serving Studio (`index.ts` calls this after `daemon.start()` has
 * resolved without throwing — which, in every mode including orchestrator's
 * early return, only happens after `Bun.serve()` itself already succeeded).
 * Opening a browser at a URL that still refuses the connection or 404s is
 * worse than not opening one at all.
 *
 * Prints the URL unconditionally first — the fallback that always works,
 * for the person whose browser did not appear (spec §5.1's "opens
 * automatically" still needs a manual escape hatch). A spawn failure (the
 * launcher binary missing, or exiting non-zero) is logged at `warn` with the
 * URL and never rethrown — the core stays up regardless (see 00-overview
 * §7 Definition of Done: nothing here may crash startup).
 */
export function maybeOpenBrowser(opts: MaybeOpenBrowserOptions): void {
  opts.log.info(`Studio: ${opts.url}`)

  const open = shouldOpenBrowser({
    mode: opts.mode,
    host: opts.host,
    isTTY: opts.isTTY,
    open: opts.open,
    isLoopbackHost: opts.isLoopbackHost,
  })
  if (!open) return

  const platform = opts.platform ?? process.platform
  const { command, args } = browserOpenCommand(opts.url, platform)
  const spawn = opts.spawn ?? defaultSpawn
  try {
    const proc = spawn(command, args)
    void proc.exited.then(
      (code) => {
        if (code !== 0) {
          opts.log.warn(`browser launcher '${command}' exited with code ${code} — open ${opts.url} manually`)
        }
      },
      (err) => {
        opts.log.warn(`could not open a browser automatically — open ${opts.url} manually (${String(err)})`)
      },
    )
  } catch (err) {
    // e.g. `xdg-open`/`open`/`cmd` missing from PATH — Bun.spawn throws
    // synchronously in that case (ENOENT-style), never asynchronously.
    opts.log.warn(`could not open a browser automatically — open ${opts.url} manually (${String(err)})`)
  }
}
