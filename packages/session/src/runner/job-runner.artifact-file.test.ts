import { describe, expect, test } from 'bun:test'
import type { ArtifactApi, DeviceApi } from '@enkaku/sdk'
import type { Subprocess } from 'bun'
import { createJobRunner, type JobSpec } from './job-runner'
import type { IsolationProvider } from './isolation'
import type { ChildToParent, ParentToChild } from './ipc'
import type { DeviceSession } from '../session'
import type { SessionManager } from '../manager'
import type { Logger } from '../logger'

/**
 * Plan 115 §3.6, §4.5's "bridge" (W5, criterion 7) exercised at the actual
 * wire boundary `ctx.artifact.file()` crosses — `job-runner.ts`'s real
 * `artifact.save` handler (not a stand-in), driven the same way
 * `job-runner.test.ts` drives it: a scripted fake `IsolationProvider` plays
 * the child, `createJobRunner` runs for real.
 *
 * What this proves, concretely: when the child sends `{ t: 'artifact.save',
 * kind: 'file', ... }`, the runner saves it through the injected
 * `ArtifactSink` and replies `{ t: 'artifact.result', ok: true, artifactId }`
 * — the SAME shape `child-entry.ts`'s `saveArtifact()` resolves
 * `ctx.artifact.file()` with (`{ artifactId: string }`, per
 * `packages/sdk/src/types.ts`'s `ArtifactApi.file()`). The second half of
 * criterion 7 — that this is an id `ctx.device.push()` "would accept" — is
 * checked by handing the exact same string to a stub typed as
 * `DeviceApi['push']`: if `ArtifactApi.file()`'s resolved shape ever stopped
 * matching what `push()` expects for `artifactId`, this file would fail to
 * typecheck, not just fail at runtime.
 */

const DEVICE_ID = 'dev-1'
const JOB: JobSpec = { id: 'job-1', deviceId: DEVICE_ID, bundlePath: '/does/not/matter.mjs', params: {} }

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function fakeSession(): DeviceSession {
  return {
    deviceId: DEVICE_ID,
    inspector: null,
    inspectorPollIntervalMs: 500,
    transport: { exec: async () => '', execOut: async () => new Uint8Array() },
    whenInspectorReady: async () => {},
  } as unknown as DeviceSession
}

function fakeSessions(session: DeviceSession): SessionManager {
  return {
    acquire: async () => session,
    release: () => {},
    get: () => session,
    closeDevice: async () => {},
    closeIfIdle: async () => {},
    idleSessions: () => [],
    closeAll: async () => 0,
  }
}

/** A single scripted child (plan 35 §7's own pattern, duplicated here rather than imported — `job-runner.test.ts`'s `fakeIsolation` is module-local, not exported). */
function fakeIsolation(
  onInit: (emit: (m: ChildToParent) => void) => void,
): { isolation: IsolationProvider; sent: ParentToChild[] } {
  const sent: ParentToChild[] = []
  const isolation: IsolationProvider = {
    mode: 'child-process',
    available: true,
    spawn(_req, ipc) {
      let resolveExited: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        resolveExited = resolve
      })
      const child = {
        send: (msg: unknown) => {
          const m = msg as ParentToChild
          sent.push(m)
          if (m.t === 'init') queueMicrotask(() => onInit(ipc))
        },
        kill: () => resolveExited(0),
        exited,
        stdout: undefined,
        stderr: undefined,
      }
      queueMicrotask(() => ipc({ t: 'ready', scriptId: 'test-script', version: '1.0.0' }))
      return child as unknown as Subprocess<'ignore', 'pipe', 'pipe'>
    },
  }
  return { isolation, sent }
}

const NO_RESET_SETTINGS = {
  resetPolicy: 'none' as const,
  resetTimeoutMs: 15_000,
  resetStrict: false,
  retry: { maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true },
  crashPolicy: 'declared' as const,
  defaultTimeoutMs: 3_600_000,
  startupTimeoutMs: 60_000,
  maxTimeoutMs: null,
  memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill' as const, sampleIntervalMs: 2_000 },
  trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  maxResultBytes: 65_536,
  progressIntervalMs: 1_000,
}

describe('artifact.save -> artifact.result (plan 115 §3.6, criterion 7 — the IPC contract, not a device)', () => {
  test('the runner answers a "file" save with an artifactId the child resolves ctx.artifact.file() with', async () => {
    const savedIds: string[] = []
    const { isolation, sent } = fakeIsolation((emit) => {
      emit({ t: 'artifact.save', callId: 'call-1', kind: 'file', label: 'post-video-folder', dataBase64: btoa('bytes'), ext: 'mp4' })
      // The final result only after the artifact round trip has had a turn
      // to complete — `artifacts.save` below resolves synchronously (a
      // fake), so this is not a race in practice, only sequencing on paper.
      queueMicrotask(() => emit({ t: 'result', ok: true, value: 'done', finishRan: true }))
    })

    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession()),
      artifacts: () => ({
        save: async ({ data }) => {
          const id = `artifact-${savedIds.length + 1}`
          savedIds.push(id)
          return { id, path: `artifacts/${id}.mp4`, sizeBytes: data.length }
        },
      }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => NO_RESET_SETTINGS,
      onReset: () => {},
    })

    const result = await runner.execute(JOB)
    expect(result.ok).toBe(true)

    const artifactResult = sent.find((m): m is Extract<ParentToChild, { t: 'artifact.result' }> => m.t === 'artifact.result')
    expect(artifactResult).toBeDefined()
    expect(artifactResult?.ok).toBe(true)
    expect(artifactResult?.callId).toBe('call-1')
    // The exact id `artifacts.save` minted — proving the runner round-trips
    // it rather than inventing or dropping it on the way to the wire.
    expect(artifactResult?.artifactId).toBe(savedIds[0])

    // `ChildToParentSchema.safeParse` (child-entry.ts's `send()`) would refuse
    // to forward `artifact.save` if it were shaped wrong; a symmetric proof
    // is not needed here since `fakeIsolation` never round-trips this
    // message through the real schema — `ipc.test.ts` (not this file) is
    // where the schema itself is checked. What THIS test proves is the
    // runner's own handler, exercised for real.

    // ---- The second half of criterion 7: this id is one `ctx.device.push()`
    // would accept. `ArtifactApi.file()` resolves `{ artifactId: string }`
    // (packages/sdk/src/types.ts) — reconstruct that exact shape from the
    // wire value above and hand it straight to a `DeviceApi['push']`-typed
    // stub. If the two shapes ever drifted, this would fail to typecheck.
    const resolved: Awaited<ReturnType<ArtifactApi['file']>> = { artifactId: artifactResult!.artifactId! }
    const pushCalls: Array<Parameters<DeviceApi['push']>[0]> = []
    const push: DeviceApi['push'] = async (opts) => {
      pushCalls.push(opts)
      return { mediaScan: { ran: false, method: null, ms: 0 } }
    }
    await push({ artifactId: resolved.artifactId, remotePath: '/sdcard/Movies/post-video-folder.mp4' })
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]?.artifactId).toBe(savedIds[0])
  })
})
