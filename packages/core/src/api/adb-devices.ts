import { Hono } from 'hono'
import { z } from 'zod'
import type { AdbClient } from '@enkaku/adb'
import {
  AdbConnectRequestSchema,
  AdbDisconnectRequestSchema,
  AdbForwardCreateRequestSchema,
  AdbForwardKillRequestSchema,
  AdbProbeRequestSchema,
  AdbProbeResponseSchema,
  AdbRawListResponseSchema,
  AdbRawResultSchema,
  AdbRawShellRequestSchema,
  AdbRawShellResponseSchema,
  AdbTcpipRequestSchema,
  AdbTcpipResponseSchema,
  normalizeAdbCommand,
  type AdbRawDevice,
  type ShellMode,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import { canUseShell } from '../auth/acl'
import { SCAN_PROBE_TIMEOUT_MS } from '../config/constants'
import type { Db } from '../db'
import { blockedDevices, devices, discoveredDevices } from '../db/schema'
import { defaultTcpPreProbe, isConnectSuccess, splitHostPort } from '../registry/reconnect'
import { loadDeviceNumbers } from '../registry/device-number'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  E_BAD_REQUEST: 400,
  E_ADB_UNAVAILABLE: 503,
  E_NOT_SUPPORTED: 501,
}

/** How long the read-back after a `tcpip` switch is given before it is reported as unverified. */
const TCPIP_VERIFY_TIMEOUT_MS = 5_000
/** A raw shell command's budget. Deliberately short: this box is for `getprop`, not for `logcat`. */
const RAW_SHELL_TIMEOUT_MS = 20_000

/**
 * `true` when a serial is a TCP transport address rather than a USB serial.
 *
 * adb itself decides this by the same shape — a colon with a numeric tail —
 * and a USB serial containing a colon is not a thing adb can represent,
 * since a colon is how it addresses a network transport in the first place.
 */
function isTcpSerial(serial: string): boolean {
  const idx = serial.lastIndexOf(':')
  if (idx <= 0 || idx === serial.length - 1) return false
  const port = Number(serial.slice(idx + 1))
  return Number.isInteger(port) && port > 0 && port <= 65535
}

/**
 * adb answers a host service with prose and an OKAY status, so "did it
 * work" has to be read off the sentence. `isConnectSuccess` already does
 * that for `host:connect`, where the wording is fixed and documented; this
 * is the general case for the rest (`disconnect`, `reconnect-offline`),
 * whose replies are not a closed set.
 *
 * Deliberately a DENY list, not an allow list: an unrecognised sentence is
 * reported as success with its text shown, because adb's own successes are
 * terse and varied ("disconnected 10.0.0.4:5555", a bare empty body) while
 * its failures all announce themselves. Getting this wrong in the other
 * direction would mark a working disconnect as failed.
 */
function looksLikeAdbFailure(message: string): boolean {
  const t = message.trim().toLowerCase()
  if (!t) return false
  return /^(error|failed|cannot|unable|no such|not found)\b/.test(t)
}

/** One `AdbRawResult`, decided by `looksLikeAdbFailure` and carrying adb's own words. */
function rawResult(message: string): { ok: boolean; message: string } {
  const trimmed = message.trim()
  return { ok: !looksLikeAdbFailure(trimmed), message: trimmed }
}

/**
 * The raw adb surface (`/api/adb/devices`, `/connect`, `/disconnect`,
 * `/reconnect`, `/tcpip`, `/probe`, `/shell`, `/forwards`).
 *
 * ## Why this exists beside `/api/devices`
 *
 * `/api/devices` is the FARM: rows an operator admitted, with a name, a
 * number, a group, labels and a history. This router is ADB's own list, and
 * the two genuinely disagree in ways that matter when something is wrong:
 *
 * - a phone plugged in and still `unauthorized` has no farm row at all (no
 *   `stableId` can be read until the RSA prompt is accepted), so the Devices
 *   page cannot show it and cannot explain why it is missing;
 * - a device whose adb-tcp link dropped is `offline` here and still a farm
 *   row there, and which of those two is stale is the actual question;
 * - a serial an operator blocked appears in both with opposite meanings.
 *
 * So every row carries a `farm` block saying which of those it is, rather
 * than leaving a reader to infer it from the serial.
 *
 * ## What this router may NOT do
 *
 * It never restarts the adb server. `adb kill-server` is forbidden
 * everywhere but `tools/adb-server-control.ts`'s `cycle()` (CLAUDE.md, spec
 * §10.4) and that restriction is the reason this file uses host services
 * only: `host:reconnect-offline` re-opens transports without disturbing port
 * 5037's owner, which is exactly what an operator reaching for "restart adb"
 * usually actually wants. The Tools page keeps the real restart, with its
 * own drain.
 *
 * ## Gates
 *
 * Everything but `/shell` is `device.settings` — the same permission
 * `POST /api/devices/rescan`, `/scan` and the per-device disconnect and
 * reconnect verbs already carry, because this is the same class of act on
 * the same transports. `/shell` is `canUseShell`, the farm-wide
 * `privacy.adbCommand` switch the device terminal and the `adb` verb both
 * go through: a raw shell here is the same remote code execution it is
 * there, and a second door onto it that honoured a different switch would
 * make that switch a lie.
 */
export function createAdbDeviceRoutes(deps: {
  db: Db
  audit: AuditLogger
  /** `null` in orchestrator mode, or before the adb subsystem is up. */
  client: () => AdbClient | null
  shellSettings: () => { mode: ShellMode }
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  function adb(): AdbClient {
    const client = deps.client()
    if (!client) throw new EnkakuError('E_ADB_UNAVAILABLE', 'the adb subsystem is not available (orchestrator mode, or adb has not started yet)')
    return client
  }

  function requireShell(c: { get: (k: 'user') => { id: string; role: 'admin' | 'operator' } | undefined }): string | null {
    const user = c.get('user')
    if (!user || !canUseShell(user.role, deps.shellSettings().mode)) {
      throw new EnkakuError('auth.forbidden', 'a raw adb shell needs the same permission as an adb command (privacy.adbCommand)')
    }
    return user.id
  }

  async function body<T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
    const parsed = schema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid body')
    return parsed.data
  }

  /**
   * `GET /api/adb/devices` — `host:devices-l` joined to what the farm knows.
   *
   * `serverVersion` and `forwards` are best-effort: a farm whose adb server
   * answers `host:devices-l` but not `host:list-forward` (an old server, a
   * build without the service) still gets its device list, with an empty
   * forward list rather than a 500. They are reported as absent, never
   * fabricated.
   */
  app.get('/devices', requirePermission('device.settings'), async (c) => {
    const client = adb()
    const [tracked, serverVersion, forwards] = await Promise.all([
      client.listDevices(),
      client.version().catch(() => null),
      client.listForward().catch(() => [] as { serial: string; local: string; remote: string }[]),
    ])

    const deviceRows = db.select().from(devices).all()
    const numbers = loadDeviceNumbers(db)
    const discoveredRows = db.select().from(discoveredDevices).all()
    const blockedRows = db.select().from(blockedDevices).all()

    // Keyed on the adb SERIAL, which is what this list has — not on
    // `stableId`, which is the farm's identity and which adb never reports.
    // A farm row whose serial has moved since (USB ↔ ip:port) simply does
    // not match, and its adb row reads `unknown`; that is honest — this
    // page's job is to show adb's view, and inventing a join adb cannot
    // make would be the one thing it must not do.
    const bySerial = new Map(deviceRows.map((d) => [d.serial, d]))
    const discoveredBySerial = new Map(discoveredRows.map((d) => [d.serial, d]))
    const blockedByStableId = new Set(blockedRows.map((b) => b.stableId))

    const rows: AdbRawDevice[] = tracked.map((t) => {
      const row = bySerial.get(t.serial)
      const discovered = discoveredBySerial.get(t.serial)
      const farm: AdbRawDevice['farm'] = row
        ? {
            kind: blockedByStableId.has(row.stableId) ? 'blocked' : 'enrolled',
            deviceId: row.id,
            name: row.label,
            number: numbers.get(row.stableId) ?? null,
            status: row.status ?? null,
          }
        : discovered
          ? {
              kind: blockedByStableId.has(discovered.stableId) ? 'blocked' : 'discovered',
              deviceId: null,
              name: discovered.label,
              number: null,
              status: null,
            }
          : { kind: 'unknown', deviceId: null, name: null, number: null, status: null }

      return {
        serial: t.serial,
        state: t.state,
        usb: t.usb ?? null,
        transportId: t.transportId ?? null,
        product: t.product ?? null,
        model: t.model ?? null,
        deviceCode: t.deviceCode ?? null,
        endpoint: isTcpSerial(t.serial) ? splitHostPort(t.serial) : null,
        farm,
        pending: client.pending(t.serial),
      }
    })

    const user = c.get('user')
    return typedJson(c, AdbRawListResponseSchema, {
      serverVersion,
      devices: rows,
      forwards,
      shellAllowed: user ? canUseShell(user.role, deps.shellSettings().mode) : false,
    })
  })

  /**
   * `POST /api/adb/connect` — `adb connect <host>:<port>`.
   *
   * The cheap `Bun.connect` pre-probe runs FIRST, and a refused dial is
   * answered without ever calling `host:connect`. That is not an
   * optimisation: plan 88 §3.3 measured a real `host:connect` against an
   * unroutable address blocking for the OS's own TCP connect timeout — tens
   * of seconds to over a minute — with the adb server's attention held for
   * all of it. Nothing in this repo dials `connectDevice` without this gate
   * in front, and neither does an operator typing an address by hand.
   */
  app.post('/connect', requirePermission('device.settings'), async (c) => {
    const { host, port } = await body(c, AdbConnectRequestSchema)
    const client = adb()
    const probe = await defaultTcpPreProbe(host, port, SCAN_PROBE_TIMEOUT_MS)
    if (probe !== 'accepted') {
      return typedJson(c, AdbRawResultSchema, {
        ok: false,
        message: `${host}:${port} ${probe === 'timeout' ? 'did not answer' : 'refused the connection'} — nothing is listening for adb there`,
      })
    }
    const message = (await client.connectDevice(`${host}:${port}`)).trim()
    const ok = isConnectSuccess(message)
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'adb.raw', target: `${host}:${port}`, meta: { op: 'connect', ok } })
    return typedJson(c, AdbRawResultSchema, { ok, message })
  })

  /** `POST /api/adb/disconnect` — one target, or every TCP transport when none is named. */
  app.post('/disconnect', requirePermission('device.settings'), async (c) => {
    const { target } = await body(c, AdbDisconnectRequestSchema)
    const message = await adb().disconnectDevice(target ?? '')
    const result = rawResult(message || (target ? `disconnected ${target}` : 'disconnected everything'))
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'adb.raw', target: target ?? 'all', meta: { op: 'disconnect', ok: result.ok } })
    return typedJson(c, AdbRawResultSchema, result)
  })

  /**
   * `POST /api/adb/reconnect` — `host:reconnect-offline`.
   *
   * This re-opens the server's transports for everything stuck `offline`.
   * It is NOT a restart: port 5037 keeps its owner and no other tool's
   * session on it is disturbed. There is deliberately no per-serial variant
   * here — `adb reconnect <serial>` asks the DEVICE to drop its side, which
   * for a farm phone is what the device row's own Reconnect action does,
   * with the session drain and endpoint memory that belong to it.
   */
  app.post('/reconnect', requirePermission('device.settings'), async (c) => {
    const message = await adb().reconnectOffline()
    const result = rawResult(message || 'reconnect requested')
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'adb.raw', meta: { op: 'reconnect-offline', ok: result.ok } })
    return typedJson(c, AdbRawResultSchema, result)
  })

  /**
   * `POST /api/adb/tcpip` — restart one device's adbd in TCP mode.
   *
   * Three steps, in this order for a reason:
   *   1. read the device's own IP while it is still attached, because after
   *      step 2 the transport this request came in on may be gone;
   *   2. `tcpip:<port>`, which only reports that the REQUEST was accepted;
   *   3. read `service.adb.tcp.port` back, which is the only thing that
   *      distinguishes an accepted request from a working listener.
   *
   * Step 3 failing is reported as `listeningPort: null`, not as an error:
   * adbd restarting its listener is exactly what was asked for, and the
   * read-back racing that restart is normal. The operator's next move is
   * `connect`, which answers the question properly.
   */
  app.post('/tcpip', requirePermission('device.settings'), async (c) => {
    const { serial, port, verify } = await body(c, AdbTcpipRequestSchema)
    const client = adb()

    const address = await client
      .exec(serial, 'ip -o -4 addr show scope global', { timeoutMs: TCPIP_VERIFY_TIMEOUT_MS })
      .then((r) => r.stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null)
      .catch(() => null)

    await client.tcpip(serial, port)

    let listeningPort: number | null = null
    if (verify) {
      listeningPort = await client
        .exec(serial, 'getprop service.adb.tcp.port', { timeoutMs: TCPIP_VERIFY_TIMEOUT_MS })
        .then((r) => {
          const n = Number(r.stdout.trim())
          return Number.isInteger(n) && n > 0 ? n : null
        })
        .catch(() => null)
    }

    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'adb.raw', target: serial, meta: { op: 'tcpip', port, listeningPort } })
    return typedJson(c, AdbTcpipResponseSchema, {
      ok: true,
      message: listeningPort === null ? `tcpip ${port} accepted (listener not read back)` : `adbd is listening on port ${listeningPort}`,
      listeningPort,
      suggestedEndpoint: address ? `${address}:${listeningPort ?? port}` : null,
    })
  })

  /**
   * `POST /api/adb/probe` — a plain TCP dial, no adb involved.
   *
   * "Is the port open" and "will adb connect" are different questions, and
   * an operator chasing a Wi-Fi device needs the first one answered without
   * the second one's minute-long worst case. Same `Bun.connect` probe the
   * reconnect ladder and the subnet sweep use.
   */
  app.post('/probe', requirePermission('device.settings'), async (c) => {
    const { host, port } = await body(c, AdbProbeRequestSchema)
    const started = Date.now()
    const outcome = await defaultTcpPreProbe(host, port, SCAN_PROBE_TIMEOUT_MS)
    return typedJson(c, AdbProbeResponseSchema, {
      open: outcome === 'accepted',
      rttMs: outcome === 'accepted' ? Date.now() - started : null,
      error: outcome === 'accepted' ? null : outcome === 'timeout' ? `no answer within ${SCAN_PROBE_TIMEOUT_MS}ms` : 'connection refused',
    })
  })

  /**
   * `POST /api/adb/shell` — one command on one adb serial.
   *
   * Takes a SERIAL, not a device id, which is the whole point: the phone
   * this is most needed on is the one with no device row. There is
   * therefore no activity marker and no per-device ownership check to make
   * — there may be no device to own — so the farm-wide `privacy.adbCommand`
   * switch is the only gate, and it is the same one the `adb` verb and the
   * device terminal honour.
   *
   * The command is normalised exactly as a saved shortcut is, so `adb shell
   * getprop` and `getprop` are the same command however it was typed.
   */
  app.post('/shell', async (c) => {
    const userId = requireShell(c)
    const { serial, command } = await body(c, AdbRawShellRequestSchema)
    const normalized = normalizeAdbCommand(command)
    if (!normalized.ok) throw new EnkakuError('E_BAD_REQUEST', normalized.error)
    const cmd = normalized.cmd
    const started = Date.now()
    const result = await adb().exec(serial, cmd, { timeoutMs: RAW_SHELL_TIMEOUT_MS })
    deps.audit.record({ userId, action: 'adb.raw', target: serial, meta: { op: 'shell', cmd, exitCode: result.exitCode } })
    return typedJson(c, AdbRawShellResponseSchema, {
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    })
  })

  /** `POST /api/adb/forwards` — `adb -s <serial> forward <local> <remote>`. */
  app.post('/forwards', requirePermission('device.settings'), async (c) => {
    const { serial, local, remote } = await body(c, AdbForwardCreateRequestSchema)
    await adb().forward(serial, local, remote)
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'adb.raw', target: serial, meta: { op: 'forward', local, remote } })
    return typedJson(c, AdbRawResultSchema, { ok: true, message: `${local} → ${remote}` })
  })

  /** `DELETE /api/adb/forwards` — `adb -s <serial> forward --remove <local>`. */
  app.delete('/forwards', requirePermission('device.settings'), async (c) => {
    const { serial, local } = await body(c, AdbForwardKillRequestSchema)
    await adb().killForward(serial, local)
    deps.audit.record({ userId: c.get('user')?.id ?? null, action: 'adb.raw', target: serial, meta: { op: 'killforward', local } })
    return typedJson(c, AdbRawResultSchema, { ok: true, message: `removed ${local}` })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    }
    if (err instanceof z.ZodError) {
      return c.json(new EnkakuError('E_BAD_REQUEST', err.issues.map((i) => i.message).join('; ')).toJSON(), 400)
    }
    // An `AdbError` (a FAIL from a host service, a timeout) reaching here is
    // adb refusing the operation, not the core breaking: 502, with adb's own
    // reason, rather than a 500 that says nothing.
    const message = err instanceof Error ? err.message : String(err)
    return c.json(new EnkakuError('E_ADB_FAIL', message).toJSON(), 502)
  })

  return app
}
