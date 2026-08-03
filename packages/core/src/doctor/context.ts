import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { AdbSocket, parseSnapshot } from '@enkaku/adb'
import { ToolchainManager, type ToolInstallRecord, type ToolInstallStore } from '@enkaku/toolchain'
import { assertTlsPolicy, loadConfig, resolveAuthMode } from '../config'
import { EnkakuError } from '../util/errors'
import { embeddedAssets } from '../embedded'
import type { ConfigLoadResult, CoreProbeResult, DbInspectResult, DoctorContext, PortHolder } from './types'

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

/**
 * Best-effort, read-only "who holds this port" via `lsof` — unix only, and
 * silently `null` (never thrown) when `lsof` is missing or the platform
 * (Windows) does not have it. Never sends a signal; only reads.
 */
async function findPortHolder(port: number): Promise<PortHolder> {
  if (process.platform === 'win32') return null
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
  }
}
