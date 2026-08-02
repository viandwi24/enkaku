import { shellQuote } from './monitors'

/**
 * The emulated working directory (plan 26 §3.7, §4.4). Each `shell:`
 * invocation is a fresh shell, so a real `cd` cannot persist between
 * commands — the core fakes persistence instead, and says so in the UI
 * (§3.7: "an emulation that pretends to be real is worse than one that is
 * honest").
 *
 * Keyed by `deviceId` alone, not `(deviceId, clientId)` as §4.4 describes:
 * `shell.exec` is only ever reachable after `leases.checkInputAllowed`
 * passes, and that check already guarantees at most one `clientId` may run
 * commands on a given device at any moment (the manual lease holder). A
 * second dimension on the key would track a fact the lease manager already
 * enforces, for no behavioural difference — and it would need every
 * automatic lease revocation (idle timeout, quarantine, forced release) to
 * also thread the holder's `clientId` through to stay correct, which the
 * lease manager does not currently do (see `LeaseManagerDeps.onManualRevoked`
 * — it carries `holderUserId`, not `clientId`). Keying by `deviceId` alone
 * needs none of that: `release(deviceId)` is correct regardless of WHY or
 * BY WHOM the lease was released.
 */
const DEFAULT_CWD = '/'

export interface CdAttempt {
  /** `null` for a bare `cd` with no argument (goes to the shell's default, typically `$HOME`). */
  target: string | null
}

export interface ShellSessionStore {
  /** The current emulated cwd for this device (default `/`). */
  getCwd(deviceId: string): string
  /**
   * Whether `cmd`, exactly as typed, IS a bare `cd` invocation and nothing
   * else (§3.7: "when `cd` is the whole command"). `cd /foo && ls` is NOT a
   * bare `cd` — it is treated as an ordinary command, prefixed with the
   * current cwd like anything else, and any `cd` inside it does not persist
   * (correct: a real shell would not persist it either).
   */
  parseCd(cmd: string): CdAttempt | null
  /** The on-device command for an ordinary (non-`cd`) command: `cd <quoted cwd> && <cmd>`. */
  withCwd(deviceId: string, cmd: string): string
  /**
   * The probe command for a `cd` attempt. Resolution (relative paths, `..`,
   * `~`) is left to the DEVICE's own shell, chained from the current cwd,
   * rather than reimplemented here — the core only reads back what the
   * device's `pwd` reports.
   */
  cdProbeCommand(deviceId: string, target: string | null): string
  /** Record a successful `cd`: store the printed absolute path as the new cwd. */
  commitCwd(deviceId: string, newCwd: string): void
  /** Lease released, for any reason → the next controller starts at `/` (§3.7, §4.4, acceptance #11). */
  release(deviceId: string): void
}

/**
 * Matches a bare `cd` followed by exactly ONE target token — nothing else
 * may trail it. A single `\S+` token (no embedded spaces) is what makes
 * `cd /foo && ls` fail to match (the `&& ls` tail has no home in the
 * capture group), which is the whole point: that command is NOT "cd as the
 * whole command" (§3.7), it is an ordinary command that happens to start
 * with `cd`, and is handled by `withCwd` like anything else. A quoted
 * target with embedded spaces (`cd "My Folder"`) is not intercepted either
 * — it still runs correctly on the device via the ordinary-command path,
 * it just does not persist in the emulated cwd, an accepted v1 limitation.
 */
const CD_WITH_TARGET_RE = /^cd\s+(\S+)$/

export function createShellSessionStore(): ShellSessionStore {
  const cwds = new Map<string, string>()

  return {
    getCwd(deviceId) {
      return cwds.get(deviceId) ?? DEFAULT_CWD
    },

    parseCd(cmd) {
      const trimmed = cmd.trim()
      if (trimmed === 'cd') return { target: null }
      const match = CD_WITH_TARGET_RE.exec(trimmed)
      if (!match) return null
      return { target: (match[1] as string).trim() }
    },

    withCwd(deviceId, cmd) {
      return `cd ${shellQuote(cwds.get(deviceId) ?? DEFAULT_CWD)} && ${cmd}`
    },

    cdProbeCommand(deviceId, target) {
      const cwd = cwds.get(deviceId) ?? DEFAULT_CWD
      const cdTarget = target === null ? 'cd' : `cd ${shellQuote(target)}`
      return `cd ${shellQuote(cwd)} && ${cdTarget} && pwd`
    },

    commitCwd(deviceId, newCwd) {
      cwds.set(deviceId, newCwd)
    },

    release(deviceId) {
      cwds.delete(deviceId)
    },
  }
}
