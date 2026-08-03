import { describe, expect, test } from 'bun:test'
import type { AdbStreamHandle, AdbStreamOptions } from '@enkaku/adb'
import type { DeviceArtifact, ToolchainManager } from '@enkaku/toolchain'
import type { Transport } from '@enkaku/protocol'
import { createInspectorForSession, type InspectorFactoryDeps } from './inspector-factory'
import { PortAllocator } from './port-allocator'
import type { Logger } from './logger'

const PKG = 'com.github.uiautomator'

function dumpsysOutput(versionCode: number): string {
  return `Packages:\n  Package [${PKG}] (39a4179):\n    versionCode=${versionCode} minSdk=21 targetSdk=29\n`
}

const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => nullLogger,
}

function fakeToolchain(deviceArtifact: DeviceArtifact | null): ToolchainManager {
  return {
    resolveToolPath: async (toolId: string) => `/tools/${toolId}`,
    deviceArtifactExpectation: async () => deviceArtifact,
  } as unknown as ToolchainManager
}

function fakeTransport(exec: (cmd: string) => Promise<string>): Transport {
  return {
    id: 'device-1',
    serial: 'serial-1',
    stableId: 'stable-1',
    connect: async () => {},
    disconnect: async () => {},
    exec,
    execOut: async () => new Uint8Array(),
  }
}

describe('createInspectorForSession — plan 41 artifact verification wiring (§4.1)', () => {
  test('threads the toolchain manifest expectation into the launcher and reports a mismatch after one failed repair', async () => {
    let dumpsysCalls = 0
    const transport = fakeTransport(async (cmd) => {
      if (cmd.startsWith('dumpsys package')) {
        dumpsysCalls++
        return dumpsysOutput(2001001) // always stale, even after the "reinstall"
      }
      return ''
    })
    const mismatches: Array<{ deviceId: string; reason: string }> = []
    const fallbacks: Array<{ deviceId: string; from: string; to: string; reason: string }> = []

    const deps: InspectorFactoryDeps = {
      toolchain: fakeToolchain({ packageName: PKG, versionCode: 2003003 }),
      ports: new PortAllocator({ rangeStart: 27100, rangeEnd: 27110 }),
      log: nullLogger,
      hostAdb: async (args) => {
        if (args[0] === 'forward' && args[1] === '--list') return `${transport.serial} tcp:1 tcp:1\n`
        return ''
      },
      execStream: async (_serial: string, _cmd: string, opts: AdbStreamOptions): Promise<AdbStreamHandle> => {
        // Never reached: ensureInstalled() throws before start() gets this far.
        opts.onEnd('stopped')
        return { pid: null, stop: async () => {} }
      },
      onFallback: (deviceId, from, to, reason) => fallbacks.push({ deviceId, from, to, reason }),
      onArtifactMismatch: (deviceId, info) => mismatches.push({ deviceId, reason: info.reason }),
    }

    const handle = await createInspectorForSession(deps, { deviceId: 'device-1', transport, requested: 'ui-server' })

    // ensureInstalled() failed after one repair attempt → falls back to uiautomator-dump (existing plan 06 §3.5 behaviour).
    expect(handle.engineId).toBe('uiautomator-dump')
    expect(fallbacks).toHaveLength(1)
    expect(mismatches).toEqual([{ deviceId: 'device-1', reason: 'version_mismatch' }])
    expect(dumpsysCalls).toBe(2) // one verify, one re-verify after the repair attempt — not a loop
  })

  // A "no expectation → starts cleanly" case is intentionally NOT exercised
  // here: past `ensureInstalled()`, `UiServerInspector.start()`'s watchdog
  // waits for a real ping over the forwarded port, which needs an actual
  // reachable ui-server (§4.2's "no check may require real hardware" cuts
  // the other way too — a fake success would need to fake a whole TCP
  // server). `launcher.test.ts`'s "AC4" case already covers the
  // no-expectation behaviour directly; this suite only proves the wiring
  // between the toolchain manifest and the launcher's `expectedArtifact`/
  // `onMismatch`, which the mismatch case above does without touching the
  // network.
})
