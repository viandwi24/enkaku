/** Package & komponen APK openatx yang di-pin (plan 06 §3.2/§4.6). */
export const UI_SERVER_PACKAGE = 'com.github.uiautomator'
export const UI_SERVER_TEST_PACKAGE = 'com.github.uiautomator.test'
export const UI_SERVER_INSTRUMENTATION = `${UI_SERVER_TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`
/** Server openatx listen di port tetap ini di device. */
export const UI_SERVER_DEVICE_PORT = 9008

export interface UiServerLauncherDeps {
  serial: string
  /** Shell exec per-device (lewat queue Plan 01). */
  exec: (cmd: string) => Promise<string>
  /** `adb forward`/`install` butuh adb CLI-level, disediakan core. */
  hostAdb: (args: string[]) => Promise<string>
  /** Path APK dari Toolchain Manager. */
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
 * Lifecycle server on-device: install APK (app + test), jalankan sebagai
 * instrumentation, forward port. `am instrument` dipilih karena itu satu-
 * satunya cara resmi mengakses UiAutomator2 API — konsekuensinya proses
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
      deps.onLog?.('info', `memasang ui-server APK ke ${deps.serial}`)
      // -g: auto-grant runtime permission; -r: replace kalau versi beda.
      await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', app])
      await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', test])
    },

    async start(localPort) {
      await this.ensureInstalled()
      // Instrumentation dijalankan detached: perintah ini tidak pernah
      // "selesai" selama server hidup.
      void deps
        .exec(`am instrument -w -r -e debug false -e class ${UI_SERVER_TEST_PACKAGE}.Stub ${UI_SERVER_INSTRUMENTATION}`)
        .catch((err) => deps.onLog?.('debug', `am instrument berakhir: ${String(err)}`))
      await deps.hostAdb(['-s', deps.serial, 'forward', `tcp:${localPort}`, `tcp:${UI_SERVER_DEVICE_PORT}`])
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
