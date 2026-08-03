import { shellQuote } from '@enkaku/adb'
// `GUEST_AGENT_SOCKET` now lives in `@enkaku/protocol` (plan 44 §4.2) —
// re-exported here so callers of this launcher don't need a second import
// for the one constant they need alongside it.
import { GUEST_AGENT_SOCKET } from '@enkaku/protocol'

export { GUEST_AGENT_SOCKET }

/** The first-party guest agent package (plan 43, plan 44 §4.4). */
export const GUEST_AGENT_PACKAGE = 'dev.enkaku.guestagent'

/**
 * Clears the freshly-installed app's stopped state
 * (docs/research/android-guest-agent.md §1.3) — mandatory, not optional: a
 * stopped app receives no broadcasts at all, so without this call the agent
 * never restarts after the device's first reboot.
 */
const BOOTSTRAP_ACTIVITY = `${GUEST_AGENT_PACKAGE}/.BootstrapActivity`

/**
 * The app op that pre-grants VPN consent without a dialog
 * (docs/research/android-guest-agent.md §1.2). It is `@hide`/`@SystemApi`
 * and appears in zero public docs, so `ensurePreGranted()` below reads it
 * back rather than trusting the `set` call.
 */
const ACTIVATE_VPN_OP = 'ACTIVATE_VPN'

export interface GuestAgentLauncherDeps {
  serial: string
  /** Per-device shell exec (through the Plan 01 queue). */
  exec: (cmd: string) => Promise<string>
  /** `adb install` and `adb forward` need CLI-level adb, supplied by the core. */
  hostAdb: (args: string[]) => Promise<string>
  /** APK path from the Toolchain Manager (or `ENKAKU_GUEST_AGENT_PATH`, plan 44 §7). */
  apkPath: () => Promise<string>
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

export interface GuestAgentLauncher {
  isInstalled(): Promise<boolean>
  ensureInstalled(): Promise<void>
  ensurePreGranted(): Promise<void>
  bootstrap(token: string): Promise<void>
  forward(localPort: number): Promise<void>
  removeForward(localPort: number): Promise<void>
  stop(): Promise<void>
}

/**
 * On-device agent lifecycle: install the APK, pre-grant the VPN app op,
 * clear the stopped state, forward the control-channel socket. Mirrors
 * `packages/drivers/src/inspector/ui-server/launcher.ts` file for file
 * (plan 44 §4.4).
 *
 * `installedVersion()` is deliberately not part of this surface: the only
 * cheap on-device source for it is `dumpsys package <pkg>`, whose output
 * has no format contract (the same reason
 * docs/research/android-guest-agent.md §6 says VPN state must come from the
 * agent's control channel rather than from parsing `dumpsys`) — getting a
 * version cheaply and reliably needs the agent's own `hello` response
 * (plan 44 §4.2), not a shell command.
 */
export function createGuestAgentLauncher(deps: GuestAgentLauncherDeps): GuestAgentLauncher {
  return {
    async isInstalled() {
      // `cmd package path <pkg>` takes the package name as an argument, not
      // a filter — unlike `pm list packages`, whose substring match would
      // false-positive on a sibling package (docs/research/android-guest-agent.md
      // §6). On a real device this prints `package:/data/app/.../base.apk`
      // and exits 0 when installed, or nothing and exit 1 when it is not —
      // but the per-device `exec` here is adb's legacy `shell:` service,
      // which streams stdout until the socket closes and never surfaces the
      // remote exit code. So this keys on the fixed `package:` prefix
      // rather than on an exit code `exec` cannot report.
      const out = await deps.exec(`cmd package path ${shellQuote(GUEST_AGENT_PACKAGE)}`)
      return out.startsWith('package:')
    },

    async ensureInstalled() {
      if (await this.isInstalled()) return
      const apk = await deps.apkPath()
      deps.onLog?.('info', `installing the guest agent on ${deps.serial}`)
      // -g auto-grants runtime permissions; -r replaces a different version.
      // -g cannot grant ACTIVATE_VPN — that is an app op, not a permission,
      // hence the separate ensurePreGranted() below.
      await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', apk])
    },

    async ensurePreGranted() {
      // "No UID for <pkg> in user 0" means package manager has not registered the package yet —
      // a fresh install, or a reinstall still settling. That is transient and worth one retry,
      // and it is a different thing from the app op having stopped behaving as documented, which
      // must still fail loudly. Seen in the field as an install that reported success and then
      // failed to pre-grant.
      for (let attempt = 1; attempt <= 3; attempt++) {
        const probe = await deps.exec(`appops get ${shellQuote(GUEST_AGENT_PACKAGE)} ${ACTIVATE_VPN_OP}`)
        if (!probe.includes('No UID')) break
        if (attempt === 3) {
          throw new Error(
            `${GUEST_AGENT_PACKAGE} is not registered with package manager (${JSON.stringify(probe)}) — ` +
              'the install did not take, so the VPN app op cannot be granted',
          )
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      await deps.exec(`appops set ${shellQuote(GUEST_AGENT_PACKAGE)} ${ACTIVATE_VPN_OP} allow`)
      // Read back rather than trust: this app op is @hide/@SystemApi
      // (docs/research/android-guest-agent.md §1.2) and could stop behaving
      // this way on any future Android release without notice.
      const readback = await deps.exec(`appops get ${shellQuote(GUEST_AGENT_PACKAGE)} ${ACTIVATE_VPN_OP}`)
      if (!readback.includes('allow')) {
        throw new Error(
          `appops set ${GUEST_AGENT_PACKAGE} ${ACTIVATE_VPN_OP} allow did not take (readback: ${JSON.stringify(readback)}) — ` +
            `this app op is @hide/@SystemApi and its behaviour is not guaranteed across Android releases`,
        )
      }
    },

    async bootstrap(token) {
      // A freshly installed app sits in the stopped state and receives no
      // broadcasts at all (docs/research/android-guest-agent.md §1.3) — this
      // `am start` is mandatory, not optional, or the agent never restarts
      // after the device's first reboot. Budget for the same after any
      // force-stop (see stop() below).
      const out = await deps.exec(`am start -n ${BOOTSTRAP_ACTIVITY} --es token ${shellQuote(token)}`)
      deps.onLog?.('debug', `bootstrap on ${deps.serial}: ${out}`)
    },

    async forward(localPort) {
      await deps.hostAdb(['-s', deps.serial, 'forward', `tcp:${localPort}`, `localabstract:${GUEST_AGENT_SOCKET}`])

      // A host port belongs to one device. Every device's guest agent
      // listens on the same socket name, so a host port that another
      // device already holds gets silently rebound and this driver would
      // talk to the OTHER phone. Copied verbatim (adapted to this socket)
      // from packages/drivers/src/inspector/ui-server/launcher.ts:57-71,
      // per plan 44 §4.4.
      const list = await deps.hostAdb(['forward', '--list'])
      const owner = list
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([, local]) => local === `tcp:${localPort}`)
      if (!owner || owner[0] !== deps.serial) {
        throw new Error(
          `tcp:${localPort} is bound to ${owner?.[0] ?? 'nothing'}, not to ${deps.serial} — refusing to drive another device's guest agent`,
        )
      }
      deps.onLog?.('debug', `forward tcp:${localPort} → device localabstract:${GUEST_AGENT_SOCKET}`)
    },

    async removeForward(localPort) {
      await deps.hostAdb(['-s', deps.serial, 'forward', '--remove', `tcp:${localPort}`]).catch(() => undefined)
    },

    async stop() {
      await deps.exec(`am force-stop ${shellQuote(GUEST_AGENT_PACKAGE)}`).catch(() => undefined)
    },
  }
}
