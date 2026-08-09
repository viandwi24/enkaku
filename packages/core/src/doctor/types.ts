/**
 * `enkaku doctor` (plan 41 §3.4, §3.5, §4.3): a check registry that runs
 * with or without a live core, every check unit-testable against injected
 * fakes (no check may require real hardware — §4.3, §7). This file is the
 * shared contract; `checks/*.ts` implement it, `context.ts` wires the real
 * (CLI) implementation, and `run.ts`/`render.ts` execute and print it.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  status: CheckStatus
  /** What was observed — always present, even on `ok` (§3.5). */
  observed: string
  /** Required whenever `status` is `warn` or `fail` (§3.5) — a diagnostic that only reports status hands the problem back to the user. */
  remedy?: string
}

export interface Check {
  id: string
  title: string
  run(ctx: DoctorContext): Promise<CheckResult>
}

export type AuthMode = 'local' | 'server'
export type TlsMode = 'off' | 'self' | 'external'

export type ConfigLoadResult =
  | {
      ok: true
      host: string
      port: number
      authMode: AuthMode
      tlsMode: TlsMode
      /** Presence and shape only — never the cert/key file contents or paths (plan 41 §3.5, §8). */
      tlsConfigured: boolean
      /** Set when the config parses but would fail `assertTlsPolicy` at boot (e.g. server mode with TLS off and no override). */
      tlsPolicyError?: string
    }
  | { ok: false; code: string; message: string }

export type PortHolder = { pid: number; processName: string } | null

export type DbInspectResult =
  | { state: 'absent' }
  | { state: 'ok'; pendingMigrations: number }
  | { state: 'corrupt'; detail: string }

export interface ToolStatusRow {
  id: string
  displayName: string
  provisioned: boolean
  version: string | null
  /** `null` when never health-checked (e.g. never provisioned). */
  healthOk: boolean | null
  detail: string | null
}

export interface AdbServerStatus {
  reachable: boolean
  version?: string
  error?: string
}

export interface TrackedDeviceLike {
  serial: string
  state: string
}

export type CoreProbeResult =
  | { running: false }
  | {
      running: true
      health: { version: string; deviceCount: number; uptimeMs: number; mode: string }
      quarantined: Array<{ deviceId: string; label: string; reason: string }>
    }

/** `GET /api/adb/stats`'s `streams` block (plan 85 §4.2, §5 85.6) — the streaming lane's farm-wide occupancy against its (autoscaled) budget. */
export interface StreamsStatus {
  maxStreams: number
  maxStreamsPerDevice: number
  active: number
  perDevice: Record<string, number>
}

/** `packages/core/src/device/host-adb.ts`'s `HostAdb.stats()` shape, as reported by a live core (plan 85 §4.5, §5 85.6) — never recomputed independently here. */
export interface HostAdbCoreStats {
  running: number
  maxConcurrent: number
  installsRunning: number
  longLived: number
}

/**
 * Everything a check may read. Each namespace maps to exactly one row in
 * §4.3's table; a check only touches the namespace(s) it needs, which is
 * what keeps every check testable with a small, focused fake rather than a
 * fully-wired context.
 */
export interface DoctorContext {
  dataDir: string
  runtime: { bunVersion: string; platform: string; arch: string }
  fs: {
    exists(path: string): Promise<boolean>
    writable(path: string): Promise<boolean>
    /** `null` when free space cannot be determined on this platform. */
    freeBytes(path: string): Promise<number | null>
  }
  config: {
    load(): ConfigLoadResult
  }
  port: {
    /** Asks a candidate URL for `/api/health` — a live core answering here means the port is legitimately in use. */
    probeHealth(url: string): Promise<{ ok: true; version: string; deviceCount: number } | { ok: false }>
    /** `true` when the port could be bound (and was immediately released) — i.e. it is free. Never sends a signal to anything (plan 41 §8 risk table). */
    tryBind(port: number, host: string): Promise<boolean>
    /** Best-effort, read-only "who is listening here" — `null` when it cannot be determined (no `lsof`, permissions, unsupported platform). */
    findHolder(port: number): Promise<PortHolder>
  }
  db: {
    inspect(): Promise<DbInspectResult>
  }
  tools: {
    status(): Promise<ToolStatusRow[]>
  }
  adbServer: {
    /** Reachability + version ONLY — never starts or kills the server (plan 41 §6.10). */
    check(): Promise<AdbServerStatus>
  }
  devices: {
    list(): Promise<TrackedDeviceLike[]>
  }
  egress: {
    /** The host checked for reachability, for the observed/remedy text — never a full URL with a token in it. */
    host: string
    check(): Promise<{ reachable: true } | { reachable: false; error: string }>
  }
  core: {
    /** `{ running: false }` when no core answers at all — a legitimate, common state, not a failure. */
    probe(): Promise<CoreProbeResult>
  }
  streams: {
    /** `null` when no core is running — the stream-lane budget only exists while the core is up (plan 85 §5 85.6, mirrors `core.probe()`'s standalone case). */
    probe(): Promise<StreamsStatus | null>
  }
  hostAdb: {
    /** OS-level count of `adb`/`adb.exe` processes on this host right now (the adb server itself is one of them) — `null` when it cannot be determined (missing tool, unsupported platform), same degrade-gracefully rule as `port.findHolder` (plan 85 §5 85.6). */
    countAdbProcesses(): Promise<number | null>
    /** The live core's own `host-adb.ts` bookkeeping, when a running core reports it — `null` when no core is running, or an older core does not yet expose this block. */
    probeCoreStats(): Promise<HostAdbCoreStats | null>
  }
}
