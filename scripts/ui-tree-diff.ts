#!/usr/bin/env bun
/**
 * Plan 221 §4.2, §5 step 221.10 — proves `UiTreeService.dump()` returns the SAME node shape
 * `uiautomator dump` (and therefore `ui-server`, which is byte-identical to it per
 * `packages/drivers/src/inspector/xml-parser.ts`'s own doc comment) already returns, and measures
 * `ui.watch`'s delivery latency (G6).
 *
 * A device tool, not a test file (§5 step 221.10's own "Do not"): it needs a real phone and would
 * hang in CI. Run by the owner, gated behind `ENKAKU_TEST_DEVICE=1` like every other device script
 * in this repo (00-overview.md §4.4).
 *
 *   ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts --serial <serial>
 *   ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts --serial <serial> --watch 20
 *   ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts --serial <serial> --json out.json
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUiDump } from '../packages/drivers/src/inspector/xml-parser'
import { createGuestAgentClient } from '../packages/drivers/src/network/guest-agent/client'
import { createGuestAgentWatch } from '../packages/drivers/src/network/guest-agent/ui-watch'
import { GUEST_AGENT_SOCKET } from '../packages/protocol/src/guest-agent'
import type { UiNode } from '../packages/protocol/src/ui-node'

const PKG = 'dev.enkaku.guestagent'
const BOOTSTRAP_ACTIVITY = `${PKG}/.BootstrapActivity`
const ADB =
  process.env.ADB ||
  (process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : join(process.env.HOME || '', 'Library/Android/sdk/platform-tools/adb'))

function usage(): string {
  return `usage: ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts --serial <serial> [--watch <n>] [--json <path>] [--port <n>]

  --serial <S>   required — the device to drive.
  --watch <N>    also subscribes to ui.watch, drives N screen changes (APP_SWITCH/BACK pairs) and
                 prints the p50/p95 delivery latency (G6).
  --json <path>  writes both trees (guest-agent and uiautomator dump) to <path> for inspection.
  --port <N>     local host port for the control-socket forward (default 27402).
  --help         print this and exit, without touching adb or any device.
`
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  const serial = flag(args, 'serial')
  if (!serial) {
    console.error(usage())
    console.error('✗ --serial is required')
    process.exit(1)
  }
  if (process.env.ENKAKU_TEST_DEVICE !== '1') {
    console.error('✗ set ENKAKU_TEST_DEVICE=1 to run this against real hardware (00-overview.md §4.4)')
    process.exit(1)
  }
  const port = Number(flag(args, 'port') ?? 27402)
  const watchCount = flag(args, 'watch') ? Number(flag(args, 'watch')) : undefined
  const jsonPath = flag(args, 'json')

  async function adb(...a: string[]): Promise<string> {
    const proc = Bun.spawn([ADB, '-s', serial, ...a], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    if (code !== 0) throw new Error(`adb ${a.join(' ')} failed (${code}): ${(err || out).trim()}`)
    return (out + err).trim()
  }

  async function adbExecOut(...a: string[]): Promise<string> {
    const proc = Bun.spawn([ADB, '-s', serial, 'exec-out', ...a], { stdout: 'pipe', stderr: 'pipe' })
    const [out] = await Promise.all([new Response(proc.stdout).text()])
    await proc.exited
    return out
  }

  /** Same primary/fallback dump path `UiautomatorDumpInspector.rawDump()` uses. */
  async function fetchUiautomatorDumpXml(): Promise<string> {
    const viaTty = await adbExecOut('uiautomator', 'dump', '/dev/tty')
    if (viaTty.includes('<?xml')) return viaTty
    const path = '/sdcard/enkaku-ui-tree-diff.xml'
    await adb('shell', 'uiautomator', 'dump', path)
    const xml = await adbExecOut('cat', path)
    await adb('shell', 'rm', '-f', path)
    return xml
  }

  console.log(`ui-tree-diff: bootstrapping the guest agent on ${serial}`)
  const token = `ui-tree-diff-${crypto.randomUUID()}`
  await adb('shell', 'am', 'start', '-n', BOOTSTRAP_ACTIVITY, '--es', 'token', token)
  await Bun.sleep(800)
  await adb('forward', `tcp:${port}`, `localabstract:${GUEST_AGENT_SOCKET}`)

  const client = createGuestAgentClient({ port, token })
  const hello = await client.hello()
  if (!hello.capabilities.includes('ui-tree')) {
    console.error(`✗ this build does not advertise ui-tree (capabilities: ${hello.capabilities.join(', ')})`)
    process.exit(1)
  }

  const guestDump = await client.uiDump()
  const uiautomatorXml = await fetchUiautomatorDumpXml()
  const uiautomatorRoot = parseUiDump(uiautomatorXml)

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ guestAgent: guestDump.root, uiautomatorDump: uiautomatorRoot }, null, 2))
    console.log(`wrote both trees to ${jsonPath}`)
  }

  const diffs = diffTrees(guestDump.root, uiautomatorRoot)
  if (diffs.length === 0) {
    console.log(`identical: ${countNodes(guestDump.root)} nodes`)
  } else {
    console.log(`${diffs.length} differing node(s), first ${Math.min(10, diffs.length)}:`)
    for (const d of diffs.slice(0, 10)) console.log(`  ${d}`)
  }

  if (watchCount !== undefined) {
    await measureWatch({ serial, port, token, count: watchCount })
  }

  await adb('shell', 'am', 'force-stop', PKG).catch(() => undefined)
}

function countNodes(node: UiNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0)
}

/**
 * Compares every field EXCEPT `bounds` when the two engines disagree only by the status-bar
 * inset (§5 step 221.10's own normalisation rule) — a few pixels of vertical offset from where
 * each engine measures the top of the content area is not a shape difference worth reporting.
 */
function diffTrees(a: UiNode, b: UiNode, path = 'root'): string[] {
  const diffs: string[] = []
  const fields: Array<keyof UiNode> = ['resourceId', 'text', 'desc', 'className', 'packageName', 'clickable', 'enabled', 'focused', 'index']
  for (const f of fields) {
    if (a[f] !== b[f]) diffs.push(`${path}.${f}: ${JSON.stringify(a[f])} !== ${JSON.stringify(b[f])}`)
  }
  const boundsDiffButNotInset =
    a.bounds.left !== b.bounds.left ||
    a.bounds.right !== b.bounds.right ||
    Math.abs(a.bounds.top - b.bounds.top) > STATUS_BAR_INSET_TOLERANCE_PX ||
    Math.abs(a.bounds.bottom - b.bounds.bottom) > STATUS_BAR_INSET_TOLERANCE_PX
  if (boundsDiffButNotInset) diffs.push(`${path}.bounds: ${JSON.stringify(a.bounds)} !== ${JSON.stringify(b.bounds)}`)
  if (a.children.length !== b.children.length) {
    diffs.push(`${path}.children.length: ${a.children.length} !== ${b.children.length}`)
    return diffs
  }
  for (let i = 0; i < a.children.length; i++) {
    diffs.push(...diffTrees(a.children[i]!, b.children[i]!, `${path}.children[${i}]`))
  }
  return diffs
}

/** A generous tolerance — both engines read the SAME window's bounds, so any real divergence is a bug, not an inset. */
const STATUS_BAR_INSET_TOLERANCE_PX = 4

async function measureWatch(opts: { serial: string; port: number; token: string; count: number }): Promise<void> {
  const { serial, port, token, count } = opts
  console.log(`ui-tree-diff: measuring ui.watch latency over ${count} screen changes`)
  const latenciesMs: number[] = []
  let driveAt = 0

  const watch = createGuestAgentWatch({
    port,
    token,
    onEvent: () => {
      latenciesMs.push(Date.now() - driveAt)
    },
    onGap: (expected, received) => console.warn(`  seq gap: expected ${expected}, got ${received}`),
    onClose: (reason) => console.warn(`  watch closed: ${reason}`),
  })
  await watch.ready

  for (let i = 0; i < count; i++) {
    driveAt = Date.now()
    await Bun.spawn([ADB, '-s', serial, 'shell', 'input', 'keyevent', 'APP_SWITCH']).exited
    await Bun.sleep(200)
    await Bun.spawn([ADB, '-s', serial, 'shell', 'input', 'keyevent', 'BACK']).exited
    await Bun.sleep(400)
  }

  await watch.close()

  if (latenciesMs.length === 0) {
    console.log('watch: no events observed — nothing to measure')
    return
  }
  const sorted = [...latenciesMs].sort((x, y) => x - y)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  console.log(`watch p50/p95: ${p50} / ${p95} ms (n=${sorted.length})`)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err))
    process.exit(1)
  })
}
