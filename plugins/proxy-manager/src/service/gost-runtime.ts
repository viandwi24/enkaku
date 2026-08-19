import net from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureGostBinary, gostBinaryPath } from './gost-provision'
import { ProxyError } from './errors'

/**
 * Supervises ONE local `gost` process (plan 117 §12, Windows-only) that
 * serves every `direct` record's Windows workaround at once — not one
 * process per record. gost has no live-reload this pack uses, so a new
 * `bindAddress` this runtime has not seen before means: rewrite the whole
 * config, restart the whole process. That is a brief interruption for every
 * OTHER already-running Windows `direct` record too, accepted deliberately
 * (00-overview §4.3: no cleverness this narrow workaround does not need) —
 * measured cost is a few hundred ms, on a farm where a `direct` record is
 * added rarely, not per connection.
 *
 * Every service this runtime creates:
 *   - binds `127.0.0.1` only — never reachable off this host, matching the
 *     loopback-only rule the pack's own listeners already carry;
 *   - speaks plain HTTP CONNECT, so `service/dial-http.ts` — already written,
 *     already tested, used today for vendor HTTP upstreams — is the ONLY
 *     dialler this pack needs on the Bun→gost hop. No new protocol code.
 *   - has no `chain`: gost dials the client's requested destination directly,
 *     bound to `interface: <bindAddress>` (verified against the real
 *     `go-gost/gost` v3.2.6 binary, 2026-08-19 — a plain HTTP service with no
 *     chain and a literal IP in `interface` starts and forwards correctly).
 *
 * **DNS is deliberately NOT bound through gost.** `resolveThroughEgress`
 * (plan 117 §3.4) has no effect once a record is served through this
 * runtime — gost resolves hostnames through its own default resolver,
 * unbound. This is not an oversight: on one real topology this workaround
 * was proven against, a `bindAddress`'s own routing carried only a default
 * route with no path back to the LAN's DNS server, so binding DNS through
 * it is precisely the configuration already PROVEN not to work there
 * (`E_PROXY_DNS_EGRESS_FAILED`, worked around by turning
 * `resolveThroughEgress` off). Matching gost's own default behaviour to
 * that proven-working shape is the safe choice; forcing gost's DNS through
 * the bound interface is an unverified assumption this file does not make.
 */

export interface GostRuntimeHost {
  log: {
    info(msg: string, fields?: Record<string, unknown>): void
    warn(msg: string, fields?: Record<string, unknown>): void
    error(msg: string, fields?: Record<string, unknown>): void
  }
}

export interface GostRuntime {
  /**
   * The loopback port a `direct` upstream bound to `bindAddress` should dial
   * (plain HTTP CONNECT, no auth). Provisions the binary on first call,
   * (re)writes gost's config and (re)starts the process if `bindAddress` is
   * new, and does not resolve until a real TCP probe confirms the port
   * accepts connections — never a fixed sleep standing in for "it's up".
   */
  ensurePort(bindAddress: string): Promise<number>
  /** Kills the gost process, if one is running. Idempotent. Called from this plugin's own `onStop`. */
  stopAll(): Promise<void>
}

const PORT_BASE = 39101
const PORT_PROBE_TIMEOUT_MS = 3000
const PORT_PROBE_INTERVAL_MS = 100

/** True the moment a bare TCP connect to `127.0.0.1:port` is accepted — proof the listener is actually up, not a guess based on how long a spawn usually takes. */
function probeListening(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const settle = (ok: boolean): void => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(ok)
      }
      socket.once('connect', () => settle(true))
      socket.once('error', () => {
        if (Date.now() >= deadline) {
          settle(false)
        } else {
          setTimeout(attempt, PORT_PROBE_INTERVAL_MS)
        }
      })
    }
    attempt()
  })
}

/** Is `port` free on loopback, right now? Same bind-test shape the SDK's own `ctx.isPortFree` uses (plan 109 §3.3) — advice, not a reservation, so the caller still handles a bind failing anyway. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** One `services:` entry, hand-built rather than pulled through a YAML library: every interpolated value is either an IP literal already refused by `validateProxyRecord` if it were anything else, or an integer, so there is nothing here a library's escaping would earn its keep on. */
function renderService(name: string, port: number, bindAddress: string): string {
  return [
    `- name: ${name}`,
    `  addr: "127.0.0.1:${port}"`,
    `  interface: ${bindAddress}`,
    `  handler:`,
    `    type: http`,
    `  listener:`,
    `    type: tcp`,
  ].join('\n')
}

export function createGostRuntime(host: GostRuntimeHost): GostRuntime {
  const ports = new Map<string, number>() // bindAddress -> loopback port
  let proc: ReturnType<typeof Bun.spawn> | null = null
  let stopping = false
  let restartChain: Promise<void> = Promise.resolve()

  async function allocatePort(): Promise<number> {
    let candidate = PORT_BASE + ports.size
    for (let tries = 0; tries < 200; tries++) {
      if (![...ports.values()].includes(candidate) && (await isPortFree(candidate))) return candidate
      candidate++
    }
    throw new ProxyError('E_PROXY_GOST_UNAVAILABLE', 'could not find a free loopback port for the local gost helper after 200 attempts')
  }

  async function writeConfigAndRestart(binaryPath: string): Promise<void> {
    const configPath = join(process.env.ENKAKU_DATA_DIR ?? binaryPath.replace(/[/\\][^/\\]+$/, ''), 'gost.services.yaml')
    const body = `services:\n${[...ports.entries()].map(([addr, port], i) => renderService(`direct-${i}`, port, addr)).join('\n')}\n`
    writeFileSync(configPath, body)

    if (proc) {
      stopping = true
      proc.kill()
      await proc.exited.catch(() => {})
      stopping = false
    }

    proc = Bun.spawn([binaryPath, '-C', configPath], { stdout: 'pipe', stderr: 'pipe' })
    host.log.info('gost helper starting', { subject: 'gost', services: ports.size, pid: proc.pid })
    pipeLogs(proc)
    watchExit(proc, binaryPath, configPath)
  }

  function pipeLogs(p: ReturnType<typeof Bun.spawn>): void {
    const forward = async (stream: ReadableStream<Uint8Array> | null, level: 'info' | 'warn'): Promise<void> => {
      if (!stream) return
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
        if (done) return
        const line = decoder.decode(value).trim()
        if (line.length > 0) host.log[level](`gost: ${line}`, { subject: 'gost' })
      }
    }
    forward(p.stdout as ReadableStream<Uint8Array> | null, 'info')
    forward(p.stderr as ReadableStream<Uint8Array> | null, 'warn')
  }

  function watchExit(p: ReturnType<typeof Bun.spawn>, binaryPath: string, configPath: string): void {
    p.exited.then((code) => {
      if (proc !== p) return // superseded by a later restart; this exit is expected
      proc = null
      if (stopping) return // `stopAll()` or a deliberate restart asked for this
      host.log.warn('gost helper exited unexpectedly — restarting once', { subject: 'gost', code })
      restartChain = restartChain.then(async () => {
        if (ports.size === 0) return // every record using it was removed in the meantime
        proc = Bun.spawn([binaryPath, '-C', configPath], { stdout: 'pipe', stderr: 'pipe' })
        pipeLogs(proc)
        watchExit(proc, binaryPath, configPath)
      })
    })
  }

  async function ensurePort(bindAddress: string): Promise<number> {
    const existing = ports.get(bindAddress)
    if (existing !== undefined && proc !== null) return existing

    const binaryPath = existing !== undefined ? gostBinaryPath() : await ensureGostBinary(host.log)
    const port = existing ?? (await allocatePort())
    ports.set(bindAddress, port)

    await restartChain // do not race a crash-triggered restart already in flight
    await writeConfigAndRestart(binaryPath)

    const up = await probeListening(port, PORT_PROBE_TIMEOUT_MS)
    if (!up) {
      throw new ProxyError('E_PROXY_GOST_UNAVAILABLE', `the local gost helper did not start listening on 127.0.0.1:${port} within ${PORT_PROBE_TIMEOUT_MS} ms`)
    }
    return port
  }

  async function stopAll(): Promise<void> {
    ports.clear()
    if (!proc) return
    stopping = true
    proc.kill()
    await proc.exited.catch(() => {})
    proc = null
    stopping = false
  }

  return { ensurePort, stopAll }
}
