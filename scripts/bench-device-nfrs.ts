#!/usr/bin/env bun
/**
 * Device benchmark for four of spec §16's seven NFR numbers — plan 84's
 * audit found none of the seven had any test, benchmark, or assertion
 * anywhere in the repo; the sharpest case being the ui-server "<200 ms per
 * find" claim shown verbatim in the product UI (`packages/drivers/src/
 * descriptors.ts`), which the audit found wrong by roughly a factor of 10
 * through an entire shipped release. This script is the harness that would
 * catch that: it drives one real phone through the exact production code
 * paths (`@enkaku/drivers`'s `UiServerLauncher`/`UiServerInspector`,
 * `@enkaku/scrcpy`'s `startScrcpySession`) and reports real numbers.
 *
 *   ENKAKU_TEST_DEVICE=1 bun run bench:device-nfrs -- --serial <SERIAL>
 *
 * What this measures, and what it deliberately does NOT:
 *
 *   - Inspector `find` / `dump` latency (spec §16 "<200ms per find", §11.2's
 *     "334-584ms" dump figure): measured directly, real RPC round trips
 *     against the real on-device ui-server.
 *   - "ui-server attach" time: the device-bound half of spec §16's "Job
 *     overhead (spawn → prepare) < 3s" — install-verify, instrumentation
 *     launch, port forward, first successful ping. The device-FREE half
 *     (child process spawn + bundle import) is a separate, no-hardware-needed
 *     benchmark: `packages/core/src/jobs/spawn-overhead.bench.test.ts`. This
 *     script does not attempt the full spawn→prepare number end to end
 *     because that requires `@enkaku/session`'s `JobRunner`/`SessionManager`
 *     (a whole session/control-marker/reset lifecycle owned by another workstream on
 *     this branch) — reproducing it here would mean re-deriving that wiring
 *     from scratch with nothing to test it against, which is a worse kind of
 *     fake than not measuring at all.
 *   - Video FPS (spec §16 "≥ 24 fps"): counts REAL frame packets off the
 *     scrcpy video socket (`ScrcpyPacket.kind === 'frame' | 'keyframe'`) over
 *     a wall-clock window — the actual on-device H.264 encoder's output rate.
 *   - "Time to first frame": session start to the first video packet
 *     (config or frame) arriving on the socket — the server-side leg of
 *     "glass-to-glass latency" and one of plan 85 §7.3's own ladder rows.
 *
 *   - Glass-to-glass latency (spec §16 "< 150ms") is NOT measured here and
 *     cannot be, by any headless script: the spec's own definition is
 *     "scrcpy H.264 plus WebCodecs" — i.e. input injected → the on-device
 *     encoder → the network → BROWSER decode → BROWSER paint. The decode and
 *     paint legs only exist inside a real browser tab (WebCodecs, a
 *     `requestVideoFrameCallback` timestamp compared against the moment a
 *     click was sent). Faking that leg from a Bun script — guessing a decode
 *     time, or silently dropping it and calling the remainder "glass-to-
 *     glass" — is exactly the failure mode plan 84's audit exists to stop.
 *     A real measurement needs a browser-driving harness (Studio e2e,
 *     Playwright + WebCodecs), which does not exist in this repo; this
 *     script's "time to first frame" stage is the honest partial substitute
 *     — the server-side leg only, reported and labelled as such.
 *   - "Max devices per host" (both rows) is a fleet-scale measurement, not a
 *     single-device one — `docs/plans/85-m50-windows-fleet-scale.md` §7.3
 *     already IS that harness (a documented, one-rung-at-a-time procedure);
 *     recorded there as "outstanding — not run" as of this writing. Nothing
 *     here duplicates it.
 *
 * Prerequisites (same shape as `scripts/smoke-guest-agent.ts`):
 *   - A real phone attached over adb, awake and unlocked (some stages act on
 *     whatever is currently on screen).
 *   - `bun run dev` has been started at least once against the SAME data dir
 *     this script points at (`--data-dir`, default `.dev-data` — the same
 *     default `bun run dev` uses), so adb/ui-server/ui-server-test/
 *     scrcpy-server are already provisioned. This script never provisions
 *     anything itself — same "adb is never bundled, only downloaded and
 *     verified" rule as the rest of the toolchain.
 *
 * Optional:
 *   ENKAKU_DATA_DIR / --data-dir   toolchain data dir (default $PWD/.dev-data)
 *   --port <N>                    ui-server local forward port (default 27510)
 *   --find-iterations <N>         per-find RPC samples (default 30)
 *   --fps-window-sec <N>          scrcpy capture window, seconds (default 5)
 *   --skip-inspector / --skip-video   run only the other stage group
 *
 * Plan 206 §4.12 adds a separate mode, `--warmup`: boots a real core against
 * `--data-dir` and measures cold-start warm-up (spec §3, MVP 16 §3's "20
 * devices warm within 60s of a core restart") via `GET /api/video/sessions`
 * — no `--serial`, the whole attached farm at once. See `--help` for its
 * own flags (`--expect`, `--timeout-sec`, `--core-port`).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
// Relative imports across a package boundary are normally forbidden
// (CLAUDE.md) — every other caller reaches these through the `@enkaku/*`
// package name. This script is the same deliberate exception
// `smoke-guest-agent.ts` already documents: root-level tooling with no
// `package.json` dependency wiring of its own.
import { AdbClient } from '../packages/adb/src/client'
import { ToolchainManager, type ToolInstallStore } from '../packages/toolchain/src/manager'
import {
  createUiServerLauncher,
  UiServerInspector,
  UI_SERVER_PACKAGE,
  UI_SERVER_TEST_PACKAGE,
} from '../packages/drivers/src/inspector/ui-server/index'
import { createGuestAgentLauncher, createGuestAgentClient, createGuestAgentWatch, UiTreeInspector } from '../packages/drivers/src/index'
import { resolveGuestAgentApkPath } from '../packages/core/src/api/guest-agent'
import type { UiNode } from '../packages/protocol/src/ui-node'
import { startScrcpySession, type AdbExecutor } from '../packages/scrcpy/src/session'
import type { ScrcpyPacket } from '../packages/scrcpy/src/demuxer'

const ROOT = join(import.meta.dir, '..')

function usage(): string {
  return `usage: ENKAKU_TEST_DEVICE=1 bun run bench:device-nfrs -- --serial <SERIAL> [options]

  --serial <S>          required — the device to drive (never guessed, see smoke-guest-agent.ts's own note)
  --data-dir <path>      toolchain data dir (default: \${ENKAKU_DATA_DIR:-$PWD/.dev-data})
  --port <N>             ui-server local forward port (default 27510)
  --find-iterations <N>  per-find RPC samples (default 30)
  --fps-window-sec <N>   scrcpy capture window in seconds (default 5)
  --skip-inspector       skip the ui-server attach/find/dump stages
  --attach-cycles <N>    cold-attach cycles to measure (default 3; plan 208 §4.13) — force-stops
                         both openatx packages before each cycle, so the reported p50/max are
                         genuinely cold starts, not a warm re-attach
  --skip-video           skip the scrcpy FPS/time-to-first-frame stages
  --latency              server-side latency leg: time to first packet, first keyframe, PTS interval, arrival jitter (needs --serial)
  --engine <ui-tree|ui-server>   which inspector engine the inspector stages drive (default ui-server —
                         an unattended re-run of the old command keeps measuring the old thing; plan 222 §4.11)
  --waitfor-cycles <N>   plan 222 §4.11 (G17) — with N > 0, subscribes to the guest agent's ui.watch and
                         drives N screen changes (input keyevent APP_SWITCH / BACK pairs), measuring event-to-
                         resolve latency for each. Needs --engine ui-tree. Default 0 (skipped).
  --warmup               plan 206 (always-on sessions) mode: boots a real core against --data-dir and measures
                         cold-start warm-up via GET /api/video/sessions — no --serial needed, the whole attached farm.
  --expect <N>           --warmup only: devices expected to reach state 'ready' (default: 'adb devices' rows in state 'device')
  --timeout-sec <N>      --warmup only: give up after this many seconds (default 120)
  --core-port <N>        --warmup only: port the spawned core binds (default 7710)
  --help                 print this and exit, without touching adb or any device

Env:
  ENKAKU_TEST_DEVICE=1   required gate — this script drives real hardware
`
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

/** A store implementation `ToolchainManager` never actually calls on this path (resolveToolPath reads the active pointer, not the DB rows) — matches `packages/toolchain/src/manager.test.ts`'s own `fakeStore()`. */
function noopStore(): ToolInstallStore {
  return {
    list: () => [],
    listByTool: () => [],
    insert: () => {},
    delete: () => {},
    setActive: () => {},
  }
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length))
  return sortedMs[idx] ?? 0
}

function firstNamedNode(node: UiNode): { sel: { id: string } | { text: string } | { desc: string }; label: string } | undefined {
  if (node.resourceId) return { sel: { id: node.resourceId }, label: `id=${node.resourceId}` }
  if (node.text) return { sel: { text: node.text }, label: `text=${JSON.stringify(node.text)}` }
  if (node.desc) return { sel: { desc: node.desc }, label: `desc=${JSON.stringify(node.desc)}` }
  for (const child of node.children) {
    const found = firstNamedNode(child)
    if (found) return found
  }
  return undefined
}

/**
 * Plan 206 §4.12 — the cold-start warm-up harness: boots a REAL core (a
 * child process, not an in-process import — the whole point is measuring
 * what an operator's own restart looks like) against `--data-dir` and polls
 * `GET /api/video/sessions` until every attached device reaches `state:
 * 'ready'` or the timeout elapses. No `--serial`: this drives the whole
 * attached farm, not one device.
 */
async function runWarmup(args: string[]): Promise<void> {
  const dataDir = flag(args, 'data-dir') ?? process.env.ENKAKU_DATA_DIR ?? join(ROOT, '.dev-data')
  const corePort = Number(flag(args, 'core-port') ?? 7710)
  const timeoutSec = Number(flag(args, 'timeout-sec') ?? 120)

  if (!existsSync(dataDir)) {
    console.error(`✗ data dir ${dataDir} does not exist — run \`bun run dev\` at least once first (see this script's own header comment)`)
    process.exit(1)
  }

  const expectFlag = flag(args, 'expect')
  let expect: number
  if (expectFlag !== undefined) {
    expect = Number(expectFlag)
  } else {
    // Default: however many devices `adb devices` currently lists as state 'device' —
    // resolved through the SAME toolchain-pinned adb every other stage in this script uses.
    const toolchain = new ToolchainManager({ dataDir, coreVersion: '0.0.0-bench', store: noopStore() })
    await toolchain.init()
    const adbPath = await toolchain.resolveToolPath('adb')
    const proc = Bun.spawn([adbPath, 'devices'], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect = out
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter(([, state]) => state === 'device').length
  }

  console.log(`Booting a core against ${dataDir} on port ${corePort}, expecting ${expect} device(s) to warm (timeout ${timeoutSec}s)…`)
  const t0 = performance.now()
  const proc = Bun.spawn(['bun', 'run', join(ROOT, 'packages/core/src/index.ts')], {
    // A spawned browser is off by default now (`ENKAKU_OPEN` opts in), and this
    // process has no TTY anyway — nothing to suppress.
    env: { ...process.env, ENKAKU_DATA_DIR: dataDir, ENKAKU_PORT: String(corePort) },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  interface SessionsRow {
    deviceId: string
    number: number | null
    state: string
    step: number | null
    attempt: number
  }
  interface SessionsBody {
    devices: SessionsRow[]
    rssBytes: number
  }

  const deadline = t0 + timeoutSec * 1000
  let lastBody: SessionsBody | null = null
  let timedOut = false

  try {
    // Step 1: wait for the core to answer at all.
    for (;;) {
      let up = false
      try {
        up = (await fetch(`http://127.0.0.1:${corePort}/api/health`)).status === 200
      } catch {
        up = false
      }
      if (up) break
      if (performance.now() > deadline) {
        timedOut = true
        break
      }
      await Bun.sleep(250)
    }

    // Step 2: poll the always-on builder's own report until every device is ready.
    if (!timedOut) {
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${corePort}/api/video/sessions`)
          if (res.ok) {
            lastBody = (await res.json()) as SessionsBody
            const ready = lastBody.devices.filter((d) => d.state === 'ready').length
            if (ready >= expect) break
          }
        } catch {
          // the core may still be finishing its own boot sequence — keep polling
        }
        if (performance.now() > deadline) {
          timedOut = true
          break
        }
        await Bun.sleep(500)
      }
    }
  } finally {
    proc.kill()
    await proc.exited
  }

  const elapsedSec = (performance.now() - t0) / 1000
  const ready = lastBody?.devices.filter((d) => d.state === 'ready').length ?? 0
  console.log(`warm: ${ready}/${expect} in ${elapsedSec.toFixed(1)} s${timedOut ? ' (timeout)' : ''}`)
  if (lastBody) {
    console.log(`rss: ${(lastBody.rssBytes / 1_048_576).toFixed(0)} MB for ${ready} sessions`)
    for (const d of lastBody.devices) {
      console.log(`  #${d.number ?? '?'} ${d.state}${d.step ? ` step ${d.step}` : ''}${d.attempt ? ` attempt ${d.attempt}` : ''}`)
    }
  }

  process.exit(ready === expect ? 0 : 1)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  if (process.env.ENKAKU_TEST_DEVICE !== '1') {
    console.error('✗ set ENKAKU_TEST_DEVICE=1 to run this against real hardware (repo convention, 00-overview.md §4.4)')
    process.exit(1)
  }
  // Plan 206 §4.12 — `--warmup` is its own mode, gated the same as every
  // other stage in this script (real hardware) but needing no `--serial`.
  if (args.includes('--warmup')) {
    await runWarmup(args)
    return
  }
  const serial = flag(args, 'serial')
  if (!serial) {
    console.error(usage())
    console.error('✗ --serial is required')
    process.exit(1)
  }
  const dataDir = flag(args, 'data-dir') ?? process.env.ENKAKU_DATA_DIR ?? join(ROOT, '.dev-data')
  const localPort = Number(flag(args, 'port') ?? 27510)
  const findIterations = Number(flag(args, 'find-iterations') ?? 30)
  const attachCycles = Number(flag(args, 'attach-cycles') ?? 3)
  const fpsWindowSec = Number(flag(args, 'fps-window-sec') ?? 5)
  const skipInspector = args.includes('--skip-inspector')
  const skipVideo = args.includes('--skip-video')
  const latency = args.includes('--latency')
  // Default 'ui-server' (plan 222 §4.11): an unattended re-run of the old
  // command must keep measuring the old thing.
  const engine = flag(args, 'engine') ?? 'ui-server'
  const waitforCycles = Number(flag(args, 'waitfor-cycles') ?? 0)

  if (!existsSync(dataDir)) {
    console.error(`✗ data dir ${dataDir} does not exist — run \`bun run dev\` at least once first (see this script's own header comment)`)
    process.exit(1)
  }

  console.log(`Resolving the toolchain from ${dataDir} …`)
  const toolchain = new ToolchainManager({ dataDir, coreVersion: '0.0.0-bench', store: noopStore() })
  await toolchain.init()

  let adbPath: string
  try {
    adbPath = await toolchain.resolveToolPath('adb')
  } catch (err) {
    console.error(`✗ adb is not provisioned in ${dataDir}: ${String(err)}`)
    console.error('  run `bun run dev` once against this data dir first, and let first-run provisioning finish.')
    process.exit(1)
  }

  async function hostAdb(cliArgs: string[]): Promise<string> {
    const proc = Bun.spawn([adbPath, ...cliArgs], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    if (code !== 0) throw new Error(`adb ${cliArgs.join(' ')} failed (${code}): ${(err || out).trim()}`)
    return out
  }

  const listed = await hostAdb(['devices'])
  const attached = listed
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .some(([s, state]) => s === serial && state === 'device')
  if (!attached) {
    console.error(`✗ device ${serial} is not attached (adb devices does not list it as "device")`)
    process.exit(1)
  }

  const client = new AdbClient({ adbPath })
  // Neither `createUiServerLauncher` nor `verifyDeviceArtifact` ever pass
  // `opts` at their `deps.exec` call sites — a plain arity-1 wrapper is
  // structurally assignable to the `(cmd, opts?: TransportExecOptions) =>
  // Promise<string>` shape both expect, with no profile↔AdbTimeoutProfile
  // mapping needed (the mapping `packages/drivers/src/transport/adb-
  // transport.ts` does exists for the real session path, not this one).
  const exec = (cmd: string) => client.exec(serial, cmd).then((r) => r.stdout)

  type Row = { metric: string; value: string; note: string }
  const rows: Row[] = []
  let failed = false

  // ---- ui-tree inspector stages (plan 222 §4.11 — G15, G16, G17) ----

  if (!skipInspector && engine === 'ui-tree') {
    console.log(`\n== Inspector stages (ui-tree) — ${findIterations} find() samples ==`)
    const apkPath = await resolveGuestAgentApkPath({ toolchain, onLog: (level, msg) => console.log(`  [apk:${level}] ${msg}`) })
    const guestAgentLauncher = createGuestAgentLauncher({
      serial,
      exec: (cmd) => client.exec(serial, cmd),
      hostAdb: (cliArgs) => hostAdb(cliArgs),
      adb: client,
      apkPath: async () => apkPath,
      onLog: (level, msg) => console.log(`  [guest-agent:${level}] ${msg}`),
    })

    let guestAgentClient: Awaited<ReturnType<typeof createGuestAgentClient>> | null = null
    try {
      await guestAgentLauncher.ensureInstalled()
      await guestAgentLauncher.ensurePreGranted().catch(() => undefined) // best-effort; ui-tree needs no VPN consent
      await guestAgentLauncher.ensureAccessibilityEnabled()
      const token = crypto.randomUUID()
      await guestAgentLauncher.bootstrap(token)
      await guestAgentLauncher.forward(localPort)
      guestAgentClient = createGuestAgentClient({ port: localPort, token, onLog: (level, msg) => console.log(`  [client:${level}] ${msg}`) })

      const probeT0 = performance.now()
      const status = await guestAgentClient.uiStatus()
      const probeMs = performance.now() - probeT0
      rows.push({ metric: 'ui-tree probe', value: `${probeMs.toFixed(0)} ms`, note: `enabled=${status.enabled} connected=${status.connected}` })
      console.log(`  ui.status in ${probeMs.toFixed(0)}ms — enabled=${status.enabled} connected=${status.connected}`)
      if (!status.enabled || !status.connected) {
        console.log('  ⚠ the accessibility service is not enabled/connected — see plan 221 §4.10\'s "Open accessibility settings"')
      }

      const inspector = new UiTreeInspector({
        deviceId: serial,
        transport: { execOut: (cmd: string) => client.execOut(serial, cmd) } as never,
        withClient: (fn) => fn(guestAgentClient!),
      })

      const dumpT0 = performance.now()
      const tree = await inspector.dump()
      const dumpMs = performance.now() - dumpT0
      rows.push({ metric: 'dump() latency', value: `${dumpMs.toFixed(0)} ms`, note: 'ui-tree — plan 222 G16' })
      console.log(`  dump() in ${dumpMs.toFixed(0)}ms`)

      const target = firstNamedNode(tree)
      if (!target) {
        console.log('  ⚠ no id/text/desc-bearing node found on the current screen — skipping find() timing')
      } else {
        console.log(`  using selector ${target.label} for ${findIterations} find() samples`)
        const samples: number[] = []
        for (let i = 0; i < findIterations; i++) {
          const t = performance.now()
          await inspector.find(target.sel)
          samples.push(performance.now() - t)
        }
        samples.sort((a, b) => a - b)
        const p50 = percentile(samples, 50)
        const p95 = percentile(samples, 95)
        const max = samples[samples.length - 1] ?? 0
        rows.push({ metric: 'find() p50', value: `${p50.toFixed(0)} ms`, note: 'ui-tree — plan 222 G15' })
        rows.push({ metric: 'find() p95', value: `${p95.toFixed(0)} ms`, note: 'plan 222 G15 claims <200ms' })
        rows.push({ metric: 'find() max', value: `${max.toFixed(0)} ms`, note: '' })
        console.log(`  p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${max.toFixed(0)}ms`)
        if (p95 > 200) {
          console.log(`  ✗ find() p95 (${p95.toFixed(0)}ms) exceeds the 200ms target (G15)`)
          failed = true
        } else {
          console.log('  ✓ find() p95 within the 200ms target (G15)')
        }
      }

      // ---- waitFor push latency (G17) ----
      if (waitforCycles > 0) {
        console.log(`\n== waitFor push latency (ui-tree) — ${waitforCycles} cycle(s) ==`)
        const pushSamples: number[] = []
        let seq = 0
        const watch = createGuestAgentWatch({
          port: localPort,
          token,
          onEvent: () => {
            seq += 1
          },
          onGap: () => {
            seq += 1
          },
        })
        await watch.ready
        try {
          for (let i = 0; i < waitforCycles; i++) {
            const before = seq
            const t0 = performance.now()
            // Alternates two keys so consecutive cycles both produce a real
            // visible change rather than toggling the same screen back and
            // forth into a no-op.
            await hostAdb(['-s', serial, 'shell', 'input', 'keyevent', i % 2 === 0 ? 'KEYCODE_APP_SWITCH' : 'KEYCODE_BACK'])
            // Poll the local seq counter rather than a second watch — this
            // measures wall-clock from the adb call returning to the FIRST
            // ui.changed event this cycle, i.e. the same event a waitFor
            // would have woken on.
            const deadline = performance.now() + 5_000
            while (seq === before && performance.now() < deadline) await Bun.sleep(5)
            pushSamples.push(performance.now() - t0)
          }
        } finally {
          await watch.close().catch(() => undefined)
        }
        pushSamples.sort((a, b) => a - b)
        const p50 = percentile(pushSamples, 50)
        const p95 = percentile(pushSamples, 95)
        rows.push({ metric: 'waitFor push p50', value: `${p50.toFixed(0)} ms`, note: 'plan 222 G17' })
        rows.push({ metric: 'waitFor push p95', value: `${p95.toFixed(0)} ms`, note: 'plan 222 G17 claims <100ms' })
        console.log(`waitFor push p50: ${p50.toFixed(0)} ms`)
        console.log(`waitFor push p95: ${p95.toFixed(0)} ms`)
        if (p95 > 100) {
          console.log(`  ✗ waitFor push p95 (${p95.toFixed(0)}ms) exceeds the 100ms target (G17)`)
          failed = true
        } else {
          console.log('  ✓ waitFor push p95 within the 100ms target (G17)')
        }
      }
    } finally {
      await guestAgentLauncher.removeForward(localPort).catch(() => undefined)
    }
  }

  // ---- inspector stages (spec §16 "<200ms per find", §11.2's dump figure) --

  if (!skipInspector && engine === 'ui-server') {
    console.log(`\n== Inspector stages (ui-server) — ${findIterations} find() samples ==`)
    const launcher = createUiServerLauncher({
      serial,
      exec,
      hostAdb,
      apkPaths: async () => ({
        app: await toolchain.resolveToolPath('ui-server'),
        test: await toolchain.resolveToolPath('ui-server-test'),
      }),
      // `onData` forwarded and `pinned: true` (plan 208 §3.3, §3.6, §4.13):
      // the bench uses a bare `AdbClient`, so pinning only keeps the stats
      // honest, but the fail-fast parser still needs the real bytes.
      execStream: (cmd, streamOpts) =>
        client.execStream(serial, cmd, {
          onData: streamOpts.onData,
          onEnd: (reason, err) => streamOpts.onEnd(reason, err),
          idleTimeoutMs: 0,
          absoluteTimeoutMs: 0,
          pinned: true,
        }),
      onLog: (level, msg) => console.log(`  [launcher:${level}] ${msg}`),
    })

    const inspector = new UiServerInspector({
      serial,
      localPort,
      launcher,
      screenSize: async () => {
        const out = await exec('wm size')
        const m = out.match(/(\d+)x(\d+)/)
        return m ? { width: Number(m[1]), height: Number(m[2]) } : null
      },
      onLog: (level, msg) => console.log(`  [inspector:${level}] ${msg}`),
    })

    try {
      // Plan 208 §4.13, §5 step 208.13: `--attach-cycles` cold-attach
      // rows — before each cycle (but the first, which is already cold on
      // a freshly booted bench run) both openatx packages are force-stopped
      // so the reported p50/max are genuinely cold starts, never a warm
      // re-attach to a process the previous cycle left running.
      const attachSamples: number[] = []
      for (let cycle = 0; cycle < attachCycles; cycle++) {
        if (cycle > 0) {
          await inspector.stop().catch(() => undefined)
          await exec(`am force-stop ${UI_SERVER_PACKAGE}`).catch(() => undefined)
          await exec(`am force-stop ${UI_SERVER_TEST_PACKAGE}`).catch(() => undefined)
        }
        const t0 = performance.now()
        await inspector.start()
        attachSamples.push(performance.now() - t0)
      }
      attachSamples.sort((a, b) => a - b)
      const attachP50 = percentile(attachSamples, 50)
      const attachMax = attachSamples[attachSamples.length - 1] ?? 0
      rows.push({ metric: 'ui-server attach cold p50', value: `${attachP50.toFixed(0)} ms`, note: `device-bound half of "job overhead" (spec §16), n=${attachCycles}` })
      rows.push({ metric: 'ui-server attach cold max', value: `${attachMax.toFixed(0)} ms`, note: '' })
      console.log(`  attach cold p50=${attachP50.toFixed(0)}ms max=${attachMax.toFixed(0)}ms over ${attachCycles} cycle(s)`)

      const dumpT0 = performance.now()
      const tree = await inspector.dump()
      const dumpMs = performance.now() - dumpT0
      rows.push({ metric: 'dump() latency', value: `${dumpMs.toFixed(0)} ms`, note: 'spec §11.2 claims 334-584ms, unverified before this run' })
      console.log(`  dump() in ${dumpMs.toFixed(0)}ms`)

      const target = firstNamedNode(tree)
      if (!target) {
        console.log('  ⚠ no id/text/desc-bearing node found on the current screen — skipping find() timing (open any app with visible text/buttons and re-run)')
      } else {
        console.log(`  using selector ${target.label} for ${findIterations} find() samples`)
        const samples: number[] = []
        for (let i = 0; i < findIterations; i++) {
          const t = performance.now()
          await inspector.find(target.sel)
          samples.push(performance.now() - t)
        }
        samples.sort((a, b) => a - b)
        const p50 = percentile(samples, 50)
        const p95 = percentile(samples, 95)
        const max = samples[samples.length - 1] ?? 0
        rows.push({ metric: 'find() p50', value: `${p50.toFixed(0)} ms`, note: 'spec §16 claims <200ms' })
        rows.push({ metric: 'find() p95', value: `${p95.toFixed(0)} ms`, note: '' })
        rows.push({ metric: 'find() max', value: `${max.toFixed(0)} ms`, note: '' })
        console.log(`  p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${max.toFixed(0)}ms`)

        // Generous: catches roughly a 10x regression against the 200ms
        // claim, exactly the failure mode plan 84's audit found already
        // happened once, rather than flaking on ordinary device jitter.
        if (p95 > 2000) {
          console.log(`  ✗ find() p95 (${p95.toFixed(0)}ms) exceeds the 2000ms (10x) regression bound`)
          failed = true
        } else {
          console.log('  ✓ find() p95 within the 10x-regression bound')
        }
      }
    } finally {
      await inspector.stop().catch(() => undefined)
    }
  }

  // ---- video stages (spec §16 "≥24fps", "glass-to-glass" server-side leg) --

  if (!skipVideo) {
    console.log(`\n== Video stages (scrcpy) — ${fpsWindowSec}s capture window ==`)
    let scrcpyServerJar: string
    try {
      scrcpyServerJar = await toolchain.resolveToolPath('scrcpy-server')
    } catch (err) {
      console.log(`  ⚠ scrcpy-server is not provisioned (${String(err)}) — skipping video stages`)
      scrcpyServerJar = ''
    }

    if (scrcpyServerJar) {
      const adbExecutor: AdbExecutor = {
        serial,
        exec,
        hostAdb,
        spawnLongLived: (spawnArgs, opts) => {
          const proc = Bun.spawn([adbPath, ...spawnArgs], { stdout: 'pipe', stderr: 'pipe' })
          let tailBuf = ''
          const pump = async (stream: ReadableStream<Uint8Array> | undefined) => {
            if (!stream) return
            const decoder = new TextDecoder()
            for await (const chunk of stream) {
              tailBuf = (tailBuf + decoder.decode(chunk, { stream: true })).slice(-65536)
            }
          }
          void pump(proc.stdout)
          void pump(proc.stderr)
          void proc.exited.then((code) => opts?.onExit?.(code, tailBuf))
          return { pid: proc.pid, tail: () => tailBuf, kill: () => proc.kill(), exited: proc.exited }
        },
      }

      const sessionT0 = performance.now()
      let firstFrameMs: number | null = null
      const frameTimestamps: number[] = []
      // Plan 203 §4.13 — `--latency`'s own samples, taken off the SAME
      // `session.onPacket` subscription rather than a second one: `ttfp` is
      // the existing measurement above, `firstKeyframeMs` the same idea
      // scoped to `kind === 'keyframe'`, and `ptsIntervalMs`/`arrivalJitterMs`
      // are per-consecutive-frame deltas (ptsUs > 0n frames only — a config
      // packet carries no PTS).
      let firstKeyframeMs: number | null = null
      const ptsIntervalMs: number[] = []
      const arrivalJitterMs: number[] = []
      let lastPtsUs: bigint | null = null
      let lastArrivalMs: number | null = null
      let session: Awaited<ReturnType<typeof startScrcpySession>> | undefined
      try {
        session = await startScrcpySession(adbExecutor, {
          jarPath: scrcpyServerJar,
          onLog: (level, msg) => console.log(`  [scrcpy:${level}] ${msg}`),
        })
        session.onPacket((p: ScrcpyPacket) => {
          const now = performance.now()
          if (firstFrameMs === null) firstFrameMs = now - sessionT0
          if (p.kind === 'frame' || p.kind === 'keyframe') {
            frameTimestamps.push(now)
            if (p.kind === 'keyframe' && firstKeyframeMs === null) firstKeyframeMs = now - sessionT0
            if (latency) {
              if (lastPtsUs !== null && lastArrivalMs !== null && p.ptsUs > lastPtsUs) {
                const deltaPtsMs = Number(p.ptsUs - lastPtsUs) / 1000
                const deltaArrivalMs = now - lastArrivalMs
                ptsIntervalMs.push(deltaPtsMs)
                arrivalJitterMs.push(Math.abs(deltaArrivalMs - deltaPtsMs))
              }
              lastPtsUs = p.ptsUs
              lastArrivalMs = now
            }
          }
        })

        await Bun.sleep(fpsWindowSec * 1000)

        // A plain function boundary, not a ternary read straight off the
        // closure-captured `let` — TS's control-flow narrowing of a variable
        // reassigned inside a different closure does not carry back into the
        // outer scope's read cleanly; a fresh parameter re-narrows fine.
        const formatMsOrNever = (ms: number | null): string => (ms === null ? 'never arrived' : `${ms.toFixed(0)} ms`)
        rows.push({
          metric: 'time to first video packet',
          value: formatMsOrNever(firstFrameMs),
          note: 'server-side leg only — NOT full glass-to-glass (needs a browser decode+paint leg, see header comment)',
        })
        console.log(`  time to first packet: ${formatMsOrNever(firstFrameMs)}`)

        if (frameTimestamps.length < 2) {
          console.log(`  ✗ only ${frameTimestamps.length} frame packet(s) arrived in ${fpsWindowSec}s — cannot compute FPS`)
          rows.push({ metric: 'video FPS', value: 'n/a', note: `only ${frameTimestamps.length} frame(s) received` })
          failed = true
        } else {
          const spanSec = (frameTimestamps[frameTimestamps.length - 1]! - frameTimestamps[0]!) / 1000
          const fps = spanSec > 0 ? (frameTimestamps.length - 1) / spanSec : 0
          rows.push({ metric: 'video FPS', value: fps.toFixed(1), note: 'spec §16 claims ≥24fps (may legitimately drop while idle)' })
          console.log(`  ${frameTimestamps.length} frames over ${spanSec.toFixed(1)}s → ${fps.toFixed(1)} fps`)
          // Generous: catches roughly a 10x regression against the 24fps
          // target (a healthy idle screen can legitimately sit well below
          // 24fps per spec's own caveat — this bound is deliberately loose).
          if (fps < 3) {
            console.log(`  ✗ ${fps.toFixed(1)}fps is below the 3fps (~10x) regression bound`)
            failed = true
          } else {
            console.log('  ✓ FPS within the 10x-regression bound')
          }
        }

        // Plan 203 §4.13, G12 — the server-side leg of latency, on demand
        // only: no regression bound exists yet (no baseline to check
        // against, plan 200 §3.0), so `--latency` never changes the exit
        // code, only adds a line and four rows.
        if (latency) {
          const ptsSorted = ptsIntervalMs.slice().sort((a, b) => a - b)
          const jitterSorted = arrivalJitterMs.slice().sort((a, b) => a - b)
          const ptsP50 = percentile(ptsSorted, 50)
          const ptsP95 = percentile(ptsSorted, 95)
          const jitterP95 = percentile(jitterSorted, 95)
          const ttfp = firstFrameMs === null ? -1 : Math.round(firstFrameMs)
          const firstKeyframe = firstKeyframeMs === null ? -1 : Math.round(firstKeyframeMs)
          const line =
            `latency: ttfp=${ttfp} ms  first-keyframe=${firstKeyframe} ms  ` +
            `pts-interval p50=${Math.round(ptsP50)} ms p95=${Math.round(ptsP95)} ms  ` +
            `arrival-jitter p95=${Math.round(jitterP95)} ms  frames=${frameTimestamps.length}`
          console.log(`  ${line}`)
          rows.push({ metric: 'latency ttfp', value: `${ttfp} ms`, note: 'plan 203 §4.13 — server-side leg only' })
          rows.push({ metric: 'latency first-keyframe', value: `${firstKeyframe} ms`, note: 'session start → first keyframe packet' })
          rows.push({
            metric: 'latency pts-interval',
            value: `p50=${Math.round(ptsP50)} p95=${Math.round(ptsP95)} ms`,
            note: 'consecutive device PTS deltas — the encoder’s real frame interval',
          })
          rows.push({
            metric: 'latency arrival-jitter',
            value: `p95=${Math.round(jitterP95)} ms`,
            note: '|Δ arrival − Δ pts| between consecutive frames',
          })
        }
      } finally {
        await session?.close().catch(() => undefined)
      }
    }
  }

  // ---- report -----------------------------------------------------------

  console.log('\n== Results ==')
  const widths = {
    metric: Math.max(6, ...rows.map((r) => r.metric.length)),
    value: Math.max(5, ...rows.map((r) => r.value.length)),
  }
  for (const r of rows) {
    console.log(`  ${r.metric.padEnd(widths.metric)}  ${r.value.padEnd(widths.value)}  ${r.note}`)
  }

  console.log(failed ? '\n✗ one or more metrics exceeded their regression bound' : '\n✓ all measured metrics are within their regression bounds')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('✗ unexpected error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
