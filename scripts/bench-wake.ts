#!/usr/bin/env bun
/**
 * Per-command timing for the wake path, against a real phone.
 *
 *   ENKAKU_TEST_DEVICE=1 bun run bench:wake -- --serial <SERIAL>
 *
 * ## Why this exists
 *
 * `wakeDevice` runs on every session open and on every reconcile toward
 * `desired: 'awake'`, so its cost is paid per device, and a twenty-phone farm
 * pays it twenty times. The one number anyone has ever measured on it is plan
 * 96 §22's `svc power stayon` at **1422 ms** — a single figure, on one phone,
 * from a different release. Everything since has been reasoned from it rather
 * than re-measured, including the two optimisations landed on 2026-09-06
 * (batching `readPowerState` into one `adb shell`, and trying
 * `dumpsys window policy` before the full `dumpsys window`).
 *
 * Those two are safe by construction — the batched read falls back when it
 * cannot line the answers up with the keys it asked for, and the keyguard
 * probe falls back rather than defaulting to "unlocked". But safe is not the
 * same as worth it, and the remaining question — whether the sequential
 * WRITES deserve attention — cannot be answered from a stale number. This
 * script answers it with the farm's own hardware.
 *
 * ## What it measures
 *
 * Every `transport.exec` the real `wakeDevice` issues, in order, with its
 * wall-clock duration. It drives the production function, not a copy: the
 * transport it hands over is a thin recorder around `AdbClient`, so any
 * change to `wake.ts`/`power.ts` shows up here without editing this file.
 *
 * Three passes by default, because the first is not representative:
 *
 *   - **cold** — the device as found. `svc power stayon` runs if the value
 *     differs, which is the expensive branch plan 96 measured.
 *   - **warm** — immediately after, with the values already correct.
 *     `applyStayOn` should skip the write entirely; the difference between
 *     the two passes IS what the read-before-write buys.
 *   - **repeat** — a third pass, to separate a genuine steady state from a
 *     one-off.
 *
 * ## What it does NOT do
 *
 * It never restores the device's original power settings, because
 * `wakeDevice` itself does not: the capture sink (`devices.power_capture`,
 * plan 125 §0.2) is the farm's record of what a phone had before Enkaku
 * touched it, and this script deliberately runs WITHOUT one — so it also
 * refuses to write the persisted screen timeout at all (`wakeDevice` returns
 * `refused` for it with no sink). What it does write is `svc power stayon`,
 * exactly as a session open would, and it prints the before/after readback so
 * the operator can see what changed.
 */

import { join } from 'node:path'
import { AdbClient } from '../packages/adb/src/client'
import { wakeDevice } from '../packages/session/src/wake'
import { readPowerState } from '../packages/session/src/power'
import type { KeepAwakeMode, ShellResult, Transport, TransportExecOptions } from '../packages/protocol/src/driver'
import type { Logger } from '../packages/session/src/logger'

const ROOT = join(import.meta.dir, '..')

function usage(): string {
  return `usage: ENKAKU_TEST_DEVICE=1 bun run bench:wake -- --serial <SERIAL> [options]

  --serial <S>        required — the device to drive (never guessed, matching bench-device-nfrs.ts)
  --adb <path>        adb binary (default: the toolchain's, else 'adb' on PATH)
  --keep-awake <mode> off | while-charging | always (default: always — the mode that actually writes)
  --passes <N>        how many times to run the sequence (default 3: cold, warm, repeat)
  --help              print this and exit, without touching adb or any device

Env:
  ENKAKU_TEST_DEVICE=1   required gate — this script drives real hardware
`
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
}

interface Sample {
  cmd: string
  ms: number
  failed: boolean
}

/**
 * The real `Transport` shape, wrapping one `AdbClient` and timing every
 * `exec`. `connect`/`disconnect` are no-ops on purpose: this script measures
 * the wake sequence on a device adb already has, and transport lifetime
 * belongs to the registry, never to a script (plan 88 §3.7).
 */
function recordingTransport(client: AdbClient, serial: string, into: Sample[]): Transport {
  const timed = async <T>(cmd: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now()
    try {
      const out = await run()
      into.push({ cmd, ms: performance.now() - started, failed: false })
      return out
    } catch (err) {
      into.push({ cmd, ms: performance.now() - started, failed: true })
      throw err
    }
  }
  return {
    id: `bench:${serial}`,
    serial,
    stableId: `bench:${serial}`,
    connect: async () => {},
    disconnect: async () => {},
    exec: (cmd: string, _opts?: TransportExecOptions): Promise<ShellResult> => timed(cmd, () => client.exec(serial, cmd)),
    execOut: (cmd: string, _opts?: TransportExecOptions): Promise<Uint8Array> => timed(cmd, () => client.execOut(serial, cmd)),
  }
}

function table(rows: Array<Record<string, string>>): void {
  if (rows.length === 0) return
  const cols = Object.keys(rows[0]!)
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => (r[c] ?? '').length))]))
  const line = (cells: string[]) => '  ' + cells.map((v, i) => v.padEnd(width[cols[i]!]!)).join('  ')
  console.log(line(cols))
  console.log('  ' + cols.map((c) => '─'.repeat(width[c]!)).join('  '))
  for (const r of rows) console.log(line(cols.map((c) => r[c] ?? '')))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(usage())
    return
  }
  if (process.env.ENKAKU_TEST_DEVICE !== '1') {
    console.error('✗ set ENKAKU_TEST_DEVICE=1 to run this against real hardware (repo convention, 00-overview.md §4.4)')
    process.exit(1)
  }
  const serial = flag(args, 'serial')
  if (!serial) {
    console.error('✗ --serial is required — this script drives a real phone and never guesses which one\n')
    console.error(usage())
    process.exit(1)
  }
  const keepAwake = (flag(args, 'keep-awake') ?? 'always') as KeepAwakeMode
  if (!['off', 'while-charging', 'always'].includes(keepAwake)) {
    console.error(`✗ --keep-awake must be off | while-charging | always (got ${keepAwake})`)
    process.exit(1)
  }
  const passes = Number(flag(args, 'passes') ?? 3)
  const adbPath = flag(args, 'adb') ?? join(ROOT, '.dev-data/tools/adb/adb')

  const client = new AdbClient({ adbPath })
  const transport = recordingTransport(client, serial, [])

  console.log(`\nwake benchmark — ${serial}, keepAwake=${keepAwake}, ${passes} pass(es)\n`)

  const before = await readPowerState(transport)
  console.log(`  before: screen_off_timeout=${before.screenOffTimeoutMs ?? 'unreadable'}  stay_on_while_plugged_in=${before.stayOnWhilePluggedIn ?? 'unreadable'}\n`)

  const perPass: Sample[][] = []
  for (let pass = 0; pass < passes; pass++) {
    const samples: Sample[] = []
    const t = recordingTransport(client, serial, samples)
    const started = performance.now()
    // No `capture` sink on purpose: without one `wakeDevice` REFUSES the
    // persisted screen-timeout write rather than overwriting a value with no
    // record of what it was (plan 125 §0.2 rule 1). `svc power stayon` is
    // unaffected and still runs, which is the expensive branch this measures.
    const result = await wakeDevice(t, { keepAwake, log: silentLog })
    const total = performance.now() - started
    perPass.push(samples)

    const label = pass === 0 ? 'cold' : pass === 1 ? 'warm' : `repeat ${pass - 1}`
    console.log(`  ── pass ${pass + 1} (${label}) — ${total.toFixed(0)} ms total, ${samples.length} adb call(s)`)
    console.log(`     screenOffTimeout=${result.screenOffTimeout}  stayOn=${result.stayOn}${result.reason ? `  reason: ${result.reason}` : ''}`)
    table(
      samples.map((s) => ({
        ms: s.ms.toFixed(0).padStart(6),
        status: s.failed ? 'failed' : 'ok',
        command: s.cmd.length > 88 ? `${s.cmd.slice(0, 85)}…` : s.cmd,
      })),
    )
    console.log('')
  }

  const after = await readPowerState(transport)
  console.log(`  after:  screen_off_timeout=${after.screenOffTimeoutMs ?? 'unreadable'}  stay_on_while_plugged_in=${after.stayOnWhilePluggedIn ?? 'unreadable'}`)

  const totals = perPass.map((p) => p.reduce((sum, s) => sum + s.ms, 0))
  console.log('\n  ── summary')
  table(
    totals.map((t, i) => ({
      pass: String(i + 1),
      'adb calls': String(perPass[i]!.length),
      'total ms': t.toFixed(0),
      slowest: (() => {
        const worst = [...perPass[i]!].sort((a, b) => b.ms - a.ms)[0]
        return worst ? `${worst.ms.toFixed(0)} ms  ${worst.cmd.slice(0, 60)}` : '—'
      })(),
    })),
  )
  if (totals.length >= 2) {
    const saved = totals[0]! - totals[1]!
    console.log(
      `\n  Cold minus warm: ${saved.toFixed(0)} ms. That difference is what reading the power state\n` +
        `  before writing it buys — on a warm device \`applyStayOn\` skips \`svc power stayon\`\n` +
        `  entirely, which plan 96 §22 measured at 1422 ms on its own hardware.\n`,
    )
  }
}

await main()
