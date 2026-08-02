/** The pinned openatx APK package and component (plan 06 §3.2/§4.6). */
export const UI_SERVER_PACKAGE = 'com.github.uiautomator'
export const UI_SERVER_TEST_PACKAGE = 'com.github.uiautomator.test'
export const UI_SERVER_INSTRUMENTATION = `${UI_SERVER_TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`
/** The openatx server listens on this fixed port on the device. */
export const UI_SERVER_DEVICE_PORT = 9008

export interface UiServerLauncherDeps {
  serial: string
  /** Per-device shell exec (through the Plan 01 queue). */
  exec: (cmd: string) => Promise<string>
  /** `adb forward` and `install` need CLI-level adb, supplied by the core. */
  hostAdb: (args: string[]) => Promise<string>
  /** APK path from the Toolchain Manager. */
  apkPaths: () => Promise<{ app: string; test: string }>
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

export interface UiServerLauncher {
  ensureInstalled(): Promise<void>
  start(localPort: number): Promise<void>
  stop(localPort: number): Promise<void>
  isInstalled(): Promise<boolean>
}

/**
 * On-device server lifecycle: install the APKs (app and test), run them as
 * the instrumentation, forward the port. `am instrument` is used because it
 * is the only sanctioned way to reach the UiAutomator2 API — which means the process
 * gampang di-kill sistem, ditangani watchdog.
 */
export function createUiServerLauncher(deps: UiServerLauncherDeps): UiServerLauncher {
  return {
    async isInstalled() {
      const out = await deps.exec(`pm list packages ${UI_SERVER_PACKAGE}`)
      return out.includes(UI_SERVER_PACKAGE)
    },

    async ensureInstalled() {
      if (await this.isInstalled()) return
      const { app, test } = await deps.apkPaths()
      deps.onLog?.('info', `installing the ui-server APKs on ${deps.serial}`)
      // -g auto-grants runtime permissions; -r replaces a different version.
      await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', app])
      await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', test])
    },

    async start(localPort) {
      await this.ensureInstalled()
      // The instrumentation runs detached: this command never
      // "finish" while the server is alive.
      void deps
        .exec(`am instrument -w -r -e debug false -e class ${UI_SERVER_TEST_PACKAGE}.Stub ${UI_SERVER_INSTRUMENTATION}`)
        .catch((err) => deps.onLog?.('debug', `am instrument ended: ${String(err)}`))
      await deps.hostAdb(['-s', deps.serial, 'forward', `tcp:${localPort}`, `tcp:${UI_SERVER_DEVICE_PORT}`])

      // A host port belongs to one device. Every phone's ui-server listens on
      // the same device port, so a host port that another device already holds
      // gets silently rebound and this inspector would answer with the OTHER
      // phone's screen. Throwing here drops us to the uiautomator-dump
      // fallback, which is slow but at least reads the right device.
      const list = await deps.hostAdb(['forward', '--list'])
      const owner = list
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([, local]) => local === `tcp:${localPort}`)
      if (!owner || owner[0] !== deps.serial) {
        throw new Error(
          `tcp:${localPort} is bound to ${owner?.[0] ?? 'nothing'}, not to ${deps.serial} — refusing to inspect another device`,
        )
      }
      deps.onLog?.('debug', `forward tcp:${localPort} → device tcp:${UI_SERVER_DEVICE_PORT}`)
    },

    async stop(localPort) {
      await deps
        .hostAdb(['-s', deps.serial, 'forward', '--remove', `tcp:${localPort}`])
        .catch(() => undefined)
      await deps.exec(`am force-stop ${UI_SERVER_PACKAGE}`).catch(() => undefined)
      await deps.exec(`am force-stop ${UI_SERVER_TEST_PACKAGE}`).catch(() => undefined)
    },
  }
}
