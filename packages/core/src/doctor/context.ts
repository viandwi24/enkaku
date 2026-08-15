import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { z } from 'zod'
import { AdbSocket, parseSnapshot } from '@enkaku/adb'
import { ToolchainManager, type ToolInstallRecord, type ToolInstallStore } from '@enkaku/toolchain'
import { assertTlsPolicy, loadConfig, resolveAuthMode } from '../config'
import { EnkakuError } from '../util/errors'
import { embeddedAssets } from '../embedded'
import type {
  AdbServerHealthProbe,
  ConfigLoadResult,
  CoreProbeResult,
  DbInspectResult,
  DoctorContext,
  HostAdbCoreStats,
  InputStatsProbe,
  PortHolder,
  StreamsStatus,
} from './types'

const ADB_HOST = '127.0.0.1'
const ADB_PORT = 5037
/** A representative artifact host (ui-server/scrcpy-server both ship from GitHub releases) — not exhaustive, but a real network path the toolchain actually needs. */
const EGRESS_HOST = 'github.com'
const PROBE_TIMEOUT_MS = 1500

function loadConfigSummary(): ConfigLoadResult {
  try {
    const cfg = loadConfig()
    const authMode = resolveAuthMode(cfg)
    let tlsPolicyError: string | undefined
    try {
      assertTlsPolicy(cfg, authMode)
    } catch (err) {
      tlsPolicyError = err instanceof EnkakuError ? err.message : String(err)
    }
    return {
      ok: true,
      host: cfg.host,
      port: cfg.port,
      authMode,
      tlsMode: cfg.tls.mode,
      tlsConfigured: cfg.tls.mode === 'external' || Boolean(cfg.tls.certPath && cfg.tls.keyPath),
      ...(tlsPolicyError ? { tlsPolicyError } : {}),
    }
  } catch (err) {
    if (err instanceof EnkakuError) return { ok: false, code: err.code, message: err.message }
    return { ok: false, code: 'E_INTERNAL', message: String(err) }
  }
}

async function checkFsWritable(dir: string): Promise<boolean> {
  const probe = join(dir, `.doctor-write-probe-${process.pid}`)
  try {
    await Bun.write(probe, '')
    const { unlinkSync } = await import('node:fs')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function freeBytes(dir: string): number | null {
  try {
    const st = statfsSync(dir)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}

async function tryBindPort(port: number, host: string): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: host, port, socket: { data() {} } })
    server.stop(true)
    return true
  } catch {
    return false
  }
}

/** Runs an OS command and returns its stdout as text. Never reads stderr, never sends any signal — the same read-only contract every caller below relies on. */
async function runCommandCapturingStdout(args: string[]): Promise<string> {
  const [cmd, ...rest] = args
  if (!cmd) return ''
  const proc = Bun.spawn([cmd, ...rest], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

/** Injectable so the Windows parsing below is testable on any host without actually spawning `netstat`/`tasklist` (plan 85 §5 85.6 — "your Windows code paths will run on this macOS dev box during tests"). */
export type WindowsCommandRunner = (args: string[]) => Promise<string>

/**
 * `netstat -ano` prints one line per socket, columns separated by runs of
 * whitespace: `Proto  Local Address  Foreign Address  State  PID`. Only TCP
 * sockets have a `State` column (UDP has four columns, not five) and only
 * `LISTENING` ones are "who holds this port" — an `ESTABLISHED` line for the
 * same local port is a client connection, not the holder. The local address
 * is matched on its port only (taken from the last `:`, since a bracketed
 * IPv6 address like `[::]:7700` still ends in `:<port>`), so both `0.0.0.0`
 * and `127.0.0.1` binds are found regardless of which interface Bun chose.
 */
export function parseNetstatPidForPort(output: string, port: number): number | null {
  const wantedPort = String(port)
  for (const rawLine of output.split(/\r?\n/)) {
    const fields = rawLine.trim().split(/\s+/)
    if (fields[0] !== 'TCP' || fields.length < 5) continue
    const [, local, , state, pidField] = fields
    if (state !== 'LISTENING' || !local) continue
    const sepIndex = local.lastIndexOf(':')
    if (sepIndex === -1 || local.slice(sepIndex + 1) !== wantedPort) continue
    const pid = Number.parseInt(pidField ?? '', 10)
    if (Number.isFinite(pid)) return pid
  }
  return null
}

/**
 * `tasklist ... /FO CSV /NH` prints one quoted-CSV row per matching process,
 * e.g. `"adb.exe","21440","Console","1","12,345 K"` — CSV rather than the
 * default table format because the table's column widths are not a stable
 * thing to parse, and the memory column's own comma (`12,345 K`) makes a
 * naive `split(',')` unsafe. Only the first (image name) field is ever
 * needed, so a small anchored regex is enough. When nothing matches,
 * `tasklist` prints an `INFO:` line to stdout instead of a CSV row.
 */
export function parseTasklistImageName(output: string): string | null {
  const row = output.split(/\r?\n/).find((line) => line.trim().startsWith('"'))
  return row?.trim().match(/^"([^"]*)"/)?.[1] ?? null
}

/** Counts CSV rows the same shape as `parseTasklistImageName` reads — used to count every process matching an `/FI "IMAGENAME eq ..."` filter, not just the first. */
export function countTasklistRows(output: string): number {
  return output.split(/\r?\n/).filter((line) => line.trim().startsWith('"')).length
}

/**
 * Windows "who holds this port" (plan 85 §4.7, fixes F13): `lsof` does not
 * exist on Windows, which is exactly why the old code returned `null`
 * unconditionally there — the one host the field report happened on. Both
 * `netstat` and `tasklist` ship with every Windows install and neither needs
 * elevation for a read. Strictly read-only, exactly like the `lsof` path
 * below: no signal is ever sent to the discovered process, only two
 * information-gathering commands.
 */
export async function findPortHolderWindows(port: number, runCommand: WindowsCommandRunner = runCommandCapturingStdout): Promise<PortHolder> {
  try {
    const netstatOut = await runCommand(['netstat', '-ano'])
    const pid = parseNetstatPidForPort(netstatOut, port)
    if (pid === null) return null
    const tasklistOut = await runCommand(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    return { pid, processName: parseTasklistImageName(tasklistOut) ?? 'unknown' }
  } catch {
    return null
  }
}

/**
 * Best-effort, read-only "who holds this port" — `lsof` on unix,
 * `netstat`/`tasklist` on Windows (plan 85 §4.7). Silently `null` (never
 * thrown) when the platform's tool is missing, exactly the existing habit
 * this file already has for every other best-effort probe.
 *
 * Exported so `daemon.ts` can run the SAME lookup on a listen-time
 * `EADDRINUSE` (plan 85 §4.7, §5 85.6) — one implementation of "who is this",
 * used both by `enkaku doctor` and by the core's own startup failure message.
 */
export async function findPortHolder(port: number): Promise<PortHolder> {
  if (process.platform === 'win32') return findPortHolderWindows(port)
  try {
    const proc = Bun.spawn(['lsof', '-t', '-i', `:${port}`, '-sTCP:LISTEN'], { stdout: 'pipe', stderr: 'ignore' })
    const out = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    const pid = Number.parseInt(out.split('\n')[0] ?? '', 10)
    if (!Number.isFinite(pid)) return null
    const nameProc = Bun.spawn(['ps', '-p', String(pid), '-o', 'comm='], { stdout: 'pipe', stderr: 'ignore' })
    const processName = (await new Response(nameProc.stdout).text()).trim() || 'unknown'
    await nameProc.exited
    return { pid, processName }
  } catch {
    return null
  }
}

/**
 * OS-level census of `adb`/`adb.exe` processes on this host (plan 85 §5
 * 85.6) — the adb server itself is one of them. Read-only, degrades to
 * `null` when the platform's tool is missing (same rule as `findPortHolder`
 * above), never signals anything.
 */
async function countAdbProcesses(runWindows: WindowsCommandRunner = runCommandCapturingStdout): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const out = await runWindows(['tasklist', '/FI', 'IMAGENAME eq adb.exe', '/FO', 'CSV', '/NH'])
      return countTasklistRows(out)
    }
    const proc = Bun.spawn(['ps', '-A', '-o', 'comm='], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.split('\n').filter((line) => /(^|\/)adb$/.test(line.trim())).length
  } catch {
    return null
  }
}

/**
 * The subset of `GET /api/adb/stats` this file reads, validated locally
 * (plan 85 §5 85.6, extended by plan 88 §5 step 88.7 with `adbHealth`):
 * `streams`, `hostAdb` and `adbHealth` are all required fields on the
 * canonical `AdbStatsResponseSchema` (`@enkaku/protocol`) now, but this stays
 * a hand-rolled, fully-optional local copy rather than importing that schema
 * directly — an OLDER core (pre-plan-85, or one that has not yet added a
 * given block) must keep answering with any of them simply absent, never a
 * thrown parse error, and coupling this probe to the live schema's shape
 * would break that the next time any block grows a field.
 */
const AdbStatsProbeSchema = z.object({
  streams: z
    .object({
      maxStreams: z.number(),
      maxStreamsPerDevice: z.number(),
      active: z.number(),
      perDevice: z.record(z.string(), z.number()),
    })
    .optional(),
  hostAdb: z
    .object({
      running: z.number(),
      maxConcurrent: z.number(),
      installsRunning: z.number(),
      longLived: z.number(),
    })
    .optional(),
  adbHealth: z
    .object({
      status: z.enum(['ok', 'degraded', 'stuck']),
      versionRttMs: z.number().nullable(),
      lastCheckedAt: z.number(),
      window: z.object({ seconds: z.number(), execs: z.number(), timeouts: z.number(), timeoutRate: z.number() }),
      wedged: z.array(z.object({ serial: z.string(), consecutiveTimeouts: z.number(), adbState: z.string() })),
      stuckOffline: z.array(z.object({ serial: z.string(), state: z.string(), sinceSec: z.number(), nudges: z.number() })),
      symptoms: z.array(
        z.object({
          symptom: z.enum(['server-unreachable', 'server-unresponsive', 'transports-wedged', 'reconnect-ineffective', 'timeout-storm']),
          detail: z.string(),
          since: z.number(),
        }),
      ),
      restartAdvised: z.boolean(),
    })
    .optional(),
  /** Plan 91 §4.10, §5 step 91.10 — same "hand-rolled, fully optional" reasoning as `streams`/`hostAdb`/`adbHealth` above: an older core simply omits this block. */
  input: z
    .object({
      lanes: z.record(z.string(), z.object({ depth: z.number(), waitMsP50: z.number(), waitMsP95: z.number(), refusals: z.number() })),
      assistsActive: z.number(),
      mirrorGroups: z.number(),
      mirrorMembers: z.number(),
      mirrorFanoutMsP50: z.number(),
      mirrorFanoutMsP95: z.number(),
      queueWaitMs: z.number(),
      uncollectedGrants: z.number(),
      orphanedMirrorGroups: z.number(),
    })
    .optional(),
})

/** Fetches `/api/adb/stats` once and returns every block this file cares about — `null` on any failure (unreachable core, bad JSON, schema mismatch), same "a diagnostic never throws" rule as every other probe in this file. */
async function probeAdbStats(
  host: string,
  port: number,
): Promise<{
  streams: StreamsStatus | null
  hostAdb: HostAdbCoreStats | null
  adbHealth: AdbServerHealthProbe | null
  input: InputStatsProbe | null
}> {
  try {
    const res = await fetch(`http://${host}:${port}/api/adb/stats`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return { streams: null, hostAdb: null, adbHealth: null, input: null }
    const parsed = AdbStatsProbeSchema.safeParse(await res.json())
    if (!parsed.success) return { streams: null, hostAdb: null, adbHealth: null, input: null }
    return {
      streams: parsed.data.streams ?? null,
      hostAdb: parsed.data.hostAdb ?? null,
      adbHealth: parsed.data.adbHealth ?? null,
      input: parsed.data.input ?? null,
    }
  } catch {
    return { streams: null, hostAdb: null, adbHealth: null, input: null }
  }
}

async function probeHealth(url: string): Promise<{ ok: true; version: string; deviceCount: number } | { ok: false }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return { ok: false }
    const body = (await res.json()) as { ok?: boolean; version?: string; deviceCount?: number }
    if (!body.ok) return { ok: false }
    return { ok: true, version: String(body.version ?? 'unknown'), deviceCount: body.deviceCount ?? 0 }
  } catch {
    return { ok: false }
  }
}

interface JournalEntry {
  when: number
}

function readJournalEntries(): JournalEntry[] {
  const embeddedPath = embeddedAssets()?.drizzle?.['meta/_journal.json']
  const path = embeddedPath ?? join(import.meta.dir, '..', '..', 'drizzle', 'meta', '_journal.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries: JournalEntry[] }
  return parsed.entries
}

/** Opens `enkaku.db` READ-ONLY — never runs migrations, never mutates (plan 41 §4.3 "db" row). */
function inspectDb(dataDir: string): DbInspectResult {
  const path = join(dataDir, 'enkaku.db')
  if (!existsSync(path)) return { state: 'absent' }
  let sqlite: Database
  try {
    sqlite = new Database(path, { readonly: true, create: false })
  } catch (err) {
    return { state: 'corrupt', detail: `cannot open: ${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    const integrity = sqlite.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null
    if (!integrity || integrity.integrity_check !== 'ok') {
      return { state: 'corrupt', detail: integrity?.integrity_check ?? 'PRAGMA integrity_check returned nothing' }
    }
    const entries = readJournalEntries()
    const tableExists = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get()
    let pending = entries.length
    if (tableExists) {
      const last = sqlite.query('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as
        | { created_at?: number }
        | null
      if (last?.created_at !== undefined) pending = entries.filter((e) => e.when > (last.created_at as number)).length
    }
    return { state: 'ok', pendingMigrations: pending }
  } catch (err) {
    return { state: 'corrupt', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    sqlite.close()
  }
}

/** A throwaway install store — the toolchain manager's `reconcile()` populates it purely by scanning disk, never touching the real `enkaku.db` (a diagnostic must not depend on the DB it might itself be reporting a problem with). */
function memoryToolInstallStore(): ToolInstallStore {
  const rows: ToolInstallRecord[] = []
  return {
    list: () => rows,
    listByTool: (toolId) => rows.filter((r) => r.toolId === toolId),
    insert: (rec) => rows.push(rec),
    delete: (toolId, version) => {
      const i = rows.findIndex((r) => r.toolId === toolId && r.version === version)
      if (i >= 0) rows.splice(i, 1)
    },
    setActive: (toolId, version) => {
      for (const r of rows) if (r.toolId === toolId) r.active = r.version === version
    },
  }
}

async function checkAdbServer(): Promise<{ reachable: boolean; version?: string; error?: string }> {
  let socket: AdbSocket | null = null
  try {
    socket = await AdbSocket.connect(ADB_HOST, ADB_PORT, { connectTimeoutMs: PROBE_TIMEOUT_MS })
    socket.send('host:version')
    await socket.readStatus({ timeoutMs: PROBE_TIMEOUT_MS })
    const version = await socket.readBlock({ timeoutMs: PROBE_TIMEOUT_MS })
    socket.close()
    return { reachable: true, version }
  } catch (err) {
    socket?.close(true)
    return { reachable: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function listDevices(): Promise<Array<{ serial: string; state: string }>> {
  let socket: AdbSocket | null = null
  try {
    socket = await AdbSocket.connect(ADB_HOST, ADB_PORT, { connectTimeoutMs: PROBE_TIMEOUT_MS })
    socket.send('host:devices')
    await socket.readStatus({ timeoutMs: PROBE_TIMEOUT_MS })
    const raw = await socket.readBlock({ timeoutMs: PROBE_TIMEOUT_MS })
    socket.close()
    return parseSnapshot(raw)
  } catch {
    socket?.close(true)
    return [] // the adb-server check already reports an unreachable server; this just has nothing to add
  }
}

async function checkEgress(): Promise<{ reachable: true } | { reachable: false; error: string }> {
  try {
    const res = await fetch(`https://${EGRESS_HOST}`, { method: 'HEAD', signal: AbortSignal.timeout(3000) })
    if (res.ok || res.status < 500) return { reachable: true }
    return { reachable: false, error: `HTTP ${res.status}` }
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function probeCore(host: string, port: number): Promise<CoreProbeResult> {
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return { running: false }
    const health = (await res.json()) as { ok?: boolean; version?: string; deviceCount?: number; uptimeMs?: number; mode?: string }
    if (!health.ok) return { running: false }
    let quarantined: Array<{ deviceId: string; label: string; reason: string }> = []
    try {
      const devicesRes = await fetch(`http://${host}:${port}/api/devices`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (devicesRes.ok) {
        const body = (await devicesRes.json()) as { devices?: Array<{ id: string; label: string; status: string; quarantineReason?: string | null }> }
        quarantined = (body.devices ?? [])
          .filter((d) => d.status === 'quarantined')
          .map((d) => ({ deviceId: d.id, label: d.label, reason: d.quarantineReason ?? 'unknown' }))
      }
    } catch {
      // The health probe already succeeded — a failed devices fetch just means an empty quarantine list here.
    }
    return {
      running: true,
      health: {
        version: String(health.version ?? 'unknown'),
        deviceCount: health.deviceCount ?? 0,
        uptimeMs: health.uptimeMs ?? 0,
        mode: health.mode ?? 'local',
      },
      quarantined,
    }
  } catch {
    return { running: false }
  }
}

/** The real, wired-up context `enkaku doctor` uses from the CLI — every field above has a fake counterpart used in tests. */
export async function createRealDoctorContext(dataDir: string): Promise<DoctorContext> {
  const configResult = loadConfigSummary()
  const host = configResult.ok ? configResult.host : '127.0.0.1'
  const port = configResult.ok ? configResult.port : 7700

  const toolchain = new ToolchainManager({ dataDir, coreVersion: '0.0.0-doctor', store: memoryToolInstallStore() })
  await toolchain.init().catch(() => undefined)

  return {
    dataDir,
    runtime: { bunVersion: Bun.version, platform: process.platform, arch: process.arch },
    fs: {
      exists: async (p) => existsSync(p),
      writable: (p) => checkFsWritable(p),
      freeBytes: async (p) => freeBytes(p),
    },
    config: { load: () => loadConfigSummary() },
    port: {
      probeHealth,
      tryBind: tryBindPort,
      findHolder: findPortHolder,
    },
    db: { inspect: async () => inspectDb(dataDir) },
    tools: {
      status: async () =>
        (await toolchain.list()).map((t) => ({
          id: t.id,
          displayName: t.displayName,
          provisioned: t.activeVersion !== null,
          version: t.activeVersion,
          healthOk: t.health?.ok ?? null,
          detail: t.health?.detail ?? null,
        })),
    },
    adbServer: { check: checkAdbServer },
    devices: { list: listDevices },
    egress: { host: EGRESS_HOST, check: checkEgress },
    core: { probe: () => probeCore(host, port) },
    streams: { probe: async () => (await probeAdbStats(host, port)).streams },
    hostAdb: {
      countAdbProcesses: () => countAdbProcesses(),
      probeCoreStats: async () => (await probeAdbStats(host, port)).hostAdb,
    },
    adbHealth: { probe: async () => (await probeAdbStats(host, port)).adbHealth },
    coControl: { probe: async () => (await probeAdbStats(host, port)).input },
  }
}
