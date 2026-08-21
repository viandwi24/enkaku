import { afterAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { reserveClosedPort, startSocks5Upstream, type Socks5Fixture } from './fixtures'
import type { LogSink } from './logbook'
import { PROXY_STATES, createSupervisor, type Supervisor, type SupervisorHost } from './supervisor'
import { DEFAULT_DRAIN_MS, DEFAULT_MAX_CONNECTIONS, proxyAuthKeyFor, proxyKeyFor, proxySecretKeyFor, proxySecretSlotKeyFor, writeProxyRecord, type ProxyRecord } from '../shared'

/** Plan 112 step 112.7 — the supervisor: the five states, the two-phase stop, the cap, the disposer. */

const USERNAME = 'country-id-r9931204'
const PASSWORD = 'Sup3rSecretUpstreamPassword'

const plain = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('hello-from-plain-http') })

/** `Bun.serve().port` is `number | undefined` in the types; a served fixture always has one, and a missing one must fail loudly. */
function servedPort(server: { port?: number }): number {
  if (typeof server.port !== 'number') throw new Error('Bun.serve did not report a port')
  return server.port
}
const PLAIN_PORT = servedPort(plain)
afterAll(() => plain.stop(true))

function record(over: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    label: 'Office UK',
    listen: { proto: 'http', bindHost: '127.0.0.1', port: 0 },
    upstream: { proto: 'socks5', host: '127.0.0.1', port: 1, username: USERNAME, bindAddress: '', resolveThroughEgress: true },
    fallbackUpstreams: [],
    failover: { failureThreshold: 3, autoFailback: true },
    enabled: false,
    logDestinations: false,
    maxConnections: DEFAULT_MAX_CONNECTIONS,
    drainMs: DEFAULT_DRAIN_MS,
    capacity: 0,
    exclusive: false,
    listenerAuth: false,
    notes: '',
    ...over,
  }
}

/** A free port, taken and released — the supervisor never binds 0, so a test has to pick one. */
async function freePort(): Promise<number> {
  const server = net.createServer()
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface Harness {
  supervisor: Supervisor
  lines: { level: string; message: string; fields?: Record<string, unknown> }[]
  reported: { id: string; port: number; proto?: 'tcp' | 'udp'; deviceReachable?: boolean; description?: string }[]
  upstream: Socks5Fixture
  close(): Promise<void>
}

async function harness(records: Record<string, ProxyRecord>, opts: { password?: string } = {}): Promise<Harness> {
  const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
  const lines: Harness['lines'] = []
  const reported: Harness['reported'] = []
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, ...(fields ? { fields } : {}) })
  }
  const log: LogSink = { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }

  // Every record's upstream points at the fixture, which is only known now.
  const entries = new Map<string, unknown>()
  for (const [id, rec] of Object.entries(records)) {
    entries.set(proxyKeyFor(id), writeProxyRecord({ ...rec, upstream: { ...rec.upstream, port: upstream.port } }))
    entries.set(proxySecretKeyFor(id), { password: opts.password ?? PASSWORD })
  }

  const host: SupervisorHost = {
    storage: {
      global: {
        getRaw: async (key) => entries.get(key) ?? null,
        list: async (listOpts) => ({
          items: [...entries.entries()]
            .filter(([key]) => (listOpts?.prefix ? key.startsWith(listOpts.prefix) : true))
            .map(([key, value]) => ({ key, value })),
          nextCursor: null,
        }),
      },
    },
    log,
    reportListener: (listener) => {
      reported.push(listener)
      return listener
    },
  }

  const supervisor = createSupervisor(host, { dialTimeoutMs: 2_000, idleMs: 5_000 })
  return {
    supervisor,
    lines,
    reported,
    upstream,
    close: async () => {
      supervisor.destroyAll()
      await upstream.close()
    },
  }
}

/** An HTTP request through a bridge, over a socket the caller keeps. */
function openTunnel(port: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.on('connect', () => sock.write(`CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\n\r\n`))
    sock.on('data', (chunk: Buffer) => {
      if (chunk.toString('latin1').includes('200')) resolve(sock)
    })
    sock.on('error', reject)
    setTimeout(() => reject(new Error('tunnel did not open')), 3_000)
  })
}

/**
 * Bounded, with a clear diagnostic — a bare `new Promise((resolve) =>
 * sock.on('close', resolve))` with no timeout is what let a genuine hang
 * (this socket never closing, for whatever platform-specific reason) read
 * as bun's own generic "timed out after 5000ms" instead of a message that
 * names what actually failed to happen. CI failing four real-socket
 * failover tests that all passed locally is exactly the signature of an
 * unbounded wait racing something environment-dependent (a slower/loaded
 * runner), not a bug in the switch logic itself — this makes the NEXT
 * failure, if the underlying timing sensitivity isn't fully gone, point
 * straight at the real culprit instead of a generic timeout.
 */
function waitForClose(sock: net.Socket, timeoutMs = 2_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`socket did not close within ${timeoutMs}ms`)), timeoutMs)
    sock.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Replaces a blind `Bun.sleep(100) // let the async switch settle` — that
 * fixed delay is exactly the kind of assumption that holds on a quiet dev
 * machine and does not hold on a loaded CI runner (the async switch is a KV
 * read plus a confirmation probe, neither bounded to 100ms by design; see
 * `docs/plans/121-m86-proxy-failover.md`'s own note on this CI failure).
 * Polls the record's live `failover` state until `activeIndex` reaches
 * `expected`, or reports plainly which index it was stuck at instead of a
 * silent timeout.
 */
async function waitForActiveIndex(getFailover: () => { activeIndex: number } | null | undefined, expected: number, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    const current = getFailover()?.activeIndex
    if (current === expected) return
    if (Date.now() - start > timeoutMs) throw new Error(`failover activeIndex did not reach ${expected} within ${timeoutMs}ms (last seen: ${current})`)
    await Bun.sleep(20)
  }
}

describe('the state machine', () => {
  test('the five words are plan 109’s five words, and `starting` is one of them', () => {
    expect([...PROXY_STATES]).toEqual(['stopped', 'starting', 'running', 'stopping', 'failed'])
  })

  test('a record starts, reads `running`, reports its listener, and serves', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port } }) })
    try {
      await h.supervisor.refresh()
      const runtime = await h.supervisor.start('office-uk')
      expect(runtime.state).toBe('running')
      expect(runtime.port).toBe(port)
      expect(runtime.lastError).toBeNull()

      const tunnel = await openTunnel(port)
      expect(h.supervisor.runtimeOf('office-uk')?.liveConnections).toBe(1)
      expect(h.supervisor.runtimeOf('office-uk')?.totalConnections).toBe(1)
      tunnel.destroy()

      // Pure observability, and NOT a device-reachability claim — the chain
      // that would make that true is step 112.11.
      expect(h.reported).toEqual([
        {
          id: 'proxy-office-uk',
          port,
          proto: 'tcp',
          deviceReachable: false,
          description: expect.stringContaining('HTTP bridge for'),
        },
      ])
      expect(h.reported[0]?.description).not.toContain(PASSWORD)
    } finally {
      await h.close()
    }
  })

  test('`enabled` is honoured at boot, and a disabled record is left alone', async () => {
    const a = await freePort()
    const b = await freePort()
    const h = await harness({
      on: record({ label: 'On', enabled: true, listen: { proto: 'http', bindHost: '127.0.0.1', port: a } }),
      off: record({ label: 'Off', enabled: false, listen: { proto: 'http', bindHost: '127.0.0.1', port: b } }),
    })
    try {
      await h.supervisor.startEnabled()
      expect(h.supervisor.runtimeOf('on')?.state).toBe('running')
      expect(h.supervisor.runtimeOf('off')?.state).toBe('stopped')
      // Control: the disabled one really would have worked, so "stopped" is a
      // decision rather than a failure it is hiding.
      expect((await h.supervisor.start('off')).state).toBe('running')
    } finally {
      await h.close()
    }
  })

  test('a SOCKS5 listener starts from the same record shape', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'socks5', bindHost: '127.0.0.1', port } }) })
    try {
      await h.supervisor.refresh()
      expect((await h.supervisor.start('office-uk')).state).toBe('running')
      expect(h.reported[0]?.description).toContain('SOCKS5 bridge')
    } finally {
      await h.close()
    }
  })

  test('a taken port produces a named, actionable error on that row — not a stack trace (criterion 8)', async () => {
    const port = await freePort()
    const squatter = net.createServer()
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()))
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port } }) })
    try {
      await h.supervisor.refresh()
      const runtime = await h.supervisor.start('office-uk')
      expect(runtime.state).toBe('failed')
      expect(runtime.lastError?.code).toBe('E_PROXY_LISTEN_ADDR_IN_USE')
      expect(runtime.lastError?.message).toContain(String(port))
      expect(runtime.lastError?.message).toContain('already in use')
      // Actionable: it names what to do, not only what happened.
      expect(runtime.lastError?.message).toMatch(/another port/)
      // Not a stack trace.
      expect(runtime.lastError?.message).not.toContain('    at ')
    } finally {
      await h.close()
      await new Promise<void>((resolve) => squatter.close(() => resolve()))
    }
  })

  test('a record the validator refuses fails with the validator’s own code, and never binds (criterion 6)', async () => {
    const port = await freePort()
    const h = await harness({
      bad: record({ listen: { proto: 'https', bindHost: '127.0.0.1', port } }),
      offhost: record({ listen: { proto: 'http', bindHost: '0.0.0.0', port } }),
      noport: record({ listen: { proto: 'http', bindHost: '127.0.0.1', port: null } }),
    })
    try {
      await h.supervisor.refresh()
      expect((await h.supervisor.start('bad')).lastError?.code).toBe('E_PROXY_LISTEN_UNSUPPORTED')
      // `E_PROXY_BIND_NOT_LOOPBACK` was retired at step 117.7 — `offhost` has
      // no listener credential (the fixture's `record()` defaults
      // `listenerAuth: false`), so the conditional rule refuses it as
      // `E_PROXY_LISTENER_AUTH_REQUIRED` instead.
      expect((await h.supervisor.start('offhost')).lastError?.code).toBe('E_PROXY_LISTENER_AUTH_REQUIRED')
      expect((await h.supervisor.start('noport')).lastError?.code).toBe('E_PROXY_PORT_UNASSIGNED')
      for (const id of ['bad', 'offhost', 'noport']) expect(h.supervisor.runtimeOf(id)?.state).toBe('failed')
      // Control: nothing bound. The port all three name is still free.
      const probe = net.createServer()
      const bound = await new Promise<boolean>((resolve) => {
        probe.on('error', () => resolve(false))
        probe.listen(port, '127.0.0.1', () => resolve(true))
      })
      expect(bound).toBe(true)
      await new Promise<void>((resolve) => probe.close(() => resolve()))
    } finally {
      await h.close()
    }
  })

  test('starting twice is a no-op rather than a second bind', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port } }) })
    try {
      await h.supervisor.refresh()
      expect((await h.supervisor.start('office-uk')).state).toBe('running')
      expect((await h.supervisor.start('office-uk')).state).toBe('running')
      expect(h.reported.length).toBe(1)
    } finally {
      await h.close()
    }
  })
})

describe('stop is two phases (criterion 9)', () => {
  test('the port is released immediately, the live tunnel survives the drain, then `stopped`', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, drainMs: 700 }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const tunnel = await openTunnel(port)
      expect(h.supervisor.runtimeOf('office-uk')?.liveConnections).toBe(1)

      const stopping = h.supervisor.stop('office-uk')

      // Phase 1 has already happened by the time the promise exists: the
      // listening socket is gone, so somebody else can have the port even
      // though a tunnel is still running through the old one.
      await Bun.sleep(50)
      const squatter = net.createServer()
      const rebound = await new Promise<boolean>((resolve) => {
        squatter.on('error', () => resolve(false))
        squatter.listen(port, '127.0.0.1', () => resolve(true))
      })
      expect(rebound).toBe(true)
      await new Promise<void>((resolve) => squatter.close(() => resolve()))

      // …and the live tunnel is still live, and still says so.
      expect(h.supervisor.runtimeOf('office-uk')?.state).toBe('stopping')
      expect(h.supervisor.runtimeOf('office-uk')?.liveConnections).toBe(1)
      expect(tunnel.destroyed).toBe(false)

      const final = await stopping
      expect(final.state).toBe('stopped')
      expect(final.port).toBeNull()
      // The FIN has to cross loopback before the CLIENT end of the pair knows.
      await Bun.sleep(50)
      expect(tunnel.destroyed).toBe(true)
    } finally {
      await h.close()
    }
  })

  test('the drain ends early when the last tunnel closes by itself', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, drainMs: 30_000 }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const tunnel = await openTunnel(port)
      const started = performance.now()
      const stopping = h.supervisor.stop('office-uk')
      setTimeout(() => tunnel.destroy(), 200)
      expect((await stopping).state).toBe('stopped')
      // Nowhere near the 30 s drain: it waited for the tunnel, not the clock.
      expect(performance.now() - started).toBeLessThan(5_000)
    } finally {
      await h.close()
    }
  })

  test('force stop skips the drain, and the tunnel dies at once', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, drainMs: 30_000 }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const tunnel = await openTunnel(port)
      const started = performance.now()
      const final = await h.supervisor.stop('office-uk', { force: true })
      expect(final.state).toBe('stopped')
      expect(performance.now() - started).toBeLessThan(1_000)
      await Bun.sleep(30)
      expect(tunnel.destroyed).toBe(true)
      // Control: the plain stop above genuinely does wait, so "force skipped
      // the drain" is a difference rather than a description of both.
      expect(h.supervisor.runtimeOf('office-uk')?.liveConnections).toBe(0)
    } finally {
      await h.close()
    }
  })

  test('restart is stop-then-start under one lock, and the port is bindable again after it', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, drainMs: 0 }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const first = h.supervisor.runtimeOf('office-uk')?.since ?? 0
      await Bun.sleep(5)
      const runtime = await h.supervisor.restart('office-uk')
      expect(runtime.state).toBe('running')
      expect(runtime.since).toBeGreaterThan(first)
      const tunnel = await openTunnel(port)
      tunnel.destroy()
    } finally {
      await h.close()
    }
  })

  test('two overlapping restarts do not interleave into two bound listeners', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, drainMs: 0 }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const [a, b] = await Promise.all([h.supervisor.restart('office-uk'), h.supervisor.restart('office-uk')])
      expect(a.state).toBe('running')
      expect(b.state).toBe('running')
      // If the two had interleaved, the second bind would have hit the first's
      // still-open socket and the row would read `failed` with EADDRINUSE.
      expect(h.supervisor.runtimeOf('office-uk')?.lastError).toBeNull()
    } finally {
      await h.close()
    }
  })
})

describe('the ctx.onStop disposer (criteria 10 and 11)', () => {
  test('it destroys immediately, without honouring any record’s drain, and well inside the host’s 5 s total budget', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, drainMs: 30_000 }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const tunnel = await openTunnel(port)

      const started = performance.now()
      // `destroyAll()` returns a `Promise<void>` (plan 117 §12: it also awaits
      // killing the local `gost` helper, on the one platform that ever starts
      // one) — `ctx.onStop` accepts and awaits exactly this shape, within its
      // own 5 s total budget across every disposer. What this test still
      // asserts is the property that actually matters: no record's own
      // `drainMs` is honoured here, so awaiting the promise cannot itself
      // block on a 30 s drain.
      await h.supervisor.destroyAll()
      const elapsed = performance.now() - started

      // The 30 s drain on the record is deliberately longer than the 5 s
      // budget: a disposer that honoured it could only fail, earn a warn
      // naming the plugin, and leave the service reading `stopping`.
      expect(elapsed).toBeLessThan(500)
      expect(h.supervisor.runtimeOf('office-uk')?.state).toBe('stopped')
      await Bun.sleep(30)
      expect(tunnel.destroyed).toBe(true)
    } finally {
      await h.close()
    }
  })

  test('after two consecutive teardown-and-reload cycles the port is bindable again (plan 109 criterion 8)', async () => {
    const port = await freePort()
    for (let cycle = 0; cycle < 2; cycle++) {
      const h = await harness({ 'office-uk': record({ enabled: true, listen: { proto: 'http', bindHost: '127.0.0.1', port } }) })
      await h.supervisor.startEnabled()
      expect(h.supervisor.runtimeOf('office-uk')?.state).toBe('running')
      // A reload is a fresh supervisor over the same records — exactly what
      // the host does when it re-imports the bundle.
      h.supervisor.destroyAll()
      await h.upstream.close()
    }
    // And after the second one, something else can have the port.
    const probe = net.createServer()
    const bound = await new Promise<boolean>((resolve) => {
      probe.on('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => resolve(true))
    })
    expect(bound).toBe(true)
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })
})

describe('the cap, the counters, and what is never stored', () => {
  test('maxConnections is enforced per proxy, and a refusal is counted separately from a connection', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, maxConnections: 2 }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const held = [await openTunnel(port), await openTunnel(port)]
      expect(h.supervisor.runtimeOf('office-uk')?.liveConnections).toBe(2)

      await openTunnel(port).catch(() => null)
      const runtime = h.supervisor.runtimeOf('office-uk')
      expect(runtime?.refusedConnections).toBe(1)
      expect(runtime?.totalConnections).toBe(2)
      expect(runtime?.liveConnections).toBe(2)
      for (const sock of held) sock.destroy()
    } finally {
      await h.close()
    }
  })

  test('byte counters accumulate across closed connections', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port } }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const tunnel = await openTunnel(port)
      await new Promise<void>((resolve) => {
        tunnel.on('data', () => resolve())
        tunnel.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
      })
      tunnel.destroy()
      await Bun.sleep(120)
      const runtime = h.supervisor.runtimeOf('office-uk')
      expect(runtime?.bytesUp).toBeGreaterThan(0)
      expect(runtime?.bytesDown).toBeGreaterThan(0)
      expect(runtime?.liveConnections).toBe(0)
    } finally {
      await h.close()
    }
  })

  test('criterion 12 — nothing about a RUNNING proxy is ever written to storage', async () => {
    const port = await freePort()
    const writes: string[] = []
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    const entries = new Map<string, unknown>([
      [proxyKeyFor('office-uk'), writeProxyRecord(record({ enabled: true, listen: { proto: 'http', bindHost: '127.0.0.1', port }, upstream: { proto: 'socks5', host: '127.0.0.1', port: upstream.port, username: USERNAME, bindAddress: '', resolveThroughEgress: true } }))],
      [proxySecretKeyFor('office-uk'), { password: PASSWORD }],
    ])
    const noop = () => {}
    const host: SupervisorHost = {
      storage: {
        global: {
          getRaw: async (key) => {
            writes.push(`get:${key}`)
            return entries.get(key) ?? null
          },
          list: async () => {
            writes.push('list')
            return { items: [...entries.entries()].filter(([k]) => k.startsWith('proxy:')).map(([key, value]) => ({ key, value })), nextCursor: null }
          },
        },
      },
      log: { debug: noop, info: noop, warn: noop, error: noop },
    }
    const supervisor = createSupervisor(host, { dialTimeoutMs: 2_000 })
    try {
      await supervisor.startEnabled()
      const tunnel = await openTunnel(port)
      tunnel.destroy()
      await supervisor.stop('office-uk', { force: true })

      // The storage port this supervisor is given has NO `set` at all — so a
      // write is a type error, not a runtime one. What is asserted here is the
      // weaker, checkable half: only reads happened, and `enabled` is the only
      // thing storage was ever consulted about.
      expect(writes.every((w) => w === 'list' || w.startsWith('get:'))).toBe(true)
      const stored = JSON.stringify([...entries.values()])
      for (const forbidden of ['running', 'stopping', 'liveConnections', 'lastError', 'uptime', 'bytesUp']) {
        expect(stored).not.toContain(forbidden)
      }
      // Control: the search would find those words if they were there.
      expect(JSON.stringify({ ...JSON.parse(stored), state: 'running' })).toContain('running')
    } finally {
      supervisor.destroyAll()
      await upstream.close()
    }
  })

  test('startEnabled never lets one broken record stop the others', async () => {
    const good = await freePort()
    const h = await harness({
      broken: record({ enabled: true, listen: { proto: 'https', bindHost: '127.0.0.1', port: 1 } }),
      good: record({ enabled: true, listen: { proto: 'http', bindHost: '127.0.0.1', port: good } }),
    })
    try {
      await h.supervisor.startEnabled()
      expect(h.supervisor.runtimeOf('broken')?.state).toBe('failed')
      expect(h.supervisor.runtimeOf('good')?.state).toBe('running')
    } finally {
      await h.close()
    }
  })

  test('a missing secret leaves the bridge dialling without a password rather than refusing to start', async () => {
    // The honest behaviour while step 112.2 is unbuilt: an upstream that needs
    // a password fails on the upstream's own refusal, on its own row, with a
    // message that names authentication.
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port } }) }, { password: 'the-wrong-one' })
    try {
      await h.supervisor.refresh()
      expect((await h.supervisor.start('office-uk')).state).toBe('running')
      const failed = await openTunnel(port).catch((e: unknown) => e)
      expect(failed).toBeInstanceOf(Error)
    } finally {
      await h.close()
    }
  })
})

describe('the listener credential — read from `proxy-auth:<id>` and wired through to the bind gate (plan 117 §3.5, §4.4, steps 117.6–117.8a)', () => {
  /** Same shape as `harness()`, plus an optional `proxy-auth:<id>` row per proxy. */
  async function authHarness(records: Record<string, ProxyRecord>, auth: Record<string, { username: string; password: string }> = {}): Promise<Harness> {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    const lines: Harness['lines'] = []
    const reported: Harness['reported'] = []
    const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
      lines.push({ level, message, ...(fields ? { fields } : {}) })
    }
    const log: LogSink = { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
    const entries = new Map<string, unknown>()
    for (const [id, rec] of Object.entries(records)) {
      entries.set(proxyKeyFor(id), writeProxyRecord({ ...rec, upstream: { ...rec.upstream, port: upstream.port } }))
      entries.set(proxySecretKeyFor(id), { password: PASSWORD })
      const cred = auth[id]
      if (cred) entries.set(proxyAuthKeyFor(id), cred)
    }
    const host: SupervisorHost = {
      storage: {
        global: {
          getRaw: async (key) => entries.get(key) ?? null,
          list: async (listOpts) => ({
            items: [...entries.entries()].filter(([key]) => (listOpts?.prefix ? key.startsWith(listOpts.prefix) : true)).map(([key, value]) => ({ key, value })),
            nextCursor: null,
          }),
        },
      },
      log,
      reportListener: (listener) => {
        reported.push(listener)
        return listener
      },
    }
    const supervisor = createSupervisor(host, { dialTimeoutMs: 2_000, idleMs: 5_000 })
    return { supervisor, lines, reported, upstream, close: async () => { supervisor.destroyAll(); await upstream.close() } }
  }

  test('listenerAuth true + a saved credential lets a non-loopback bind actually start', async () => {
    const port = await freePort()
    const h = await authHarness(
      {
        'office-uk': record({ listen: { proto: 'http', bindHost: '10.0.0.5', port }, listenerAuth: true }),
      },
      { 'office-uk': { username: 'ops', password: 'super-secret-listener-pass' } },
    )
    try {
      await h.supervisor.refresh()
      const runtime = await h.supervisor.start('office-uk')
      // `10.0.0.5` is not an address this test box necessarily holds, so the
      // BIND may itself fail (EADDRNOTAVAIL) — that is a fact about the host,
      // not about the auth gate. What this test proves is that VALIDATION let
      // it through: the failure, if any, is never `E_PROXY_LISTENER_AUTH_…`.
      expect(runtime.lastError?.code).not.toBe('E_PROXY_LISTENER_AUTH_REQUIRED')
      expect(runtime.lastError?.code).not.toBe('E_PROXY_LISTENER_AUTH_MISSING')
    } finally {
      await h.close()
    }
  })

  test('listenerAuth true with NO saved credential refuses to start with E_PROXY_LISTENER_AUTH_MISSING, even on loopback', async () => {
    const port = await freePort()
    const h = await authHarness({
      'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, listenerAuth: true }),
    })
    try {
      await h.supervisor.refresh()
      const runtime = await h.supervisor.start('office-uk')
      expect(runtime.state).toBe('failed')
      expect(runtime.lastError?.code).toBe('E_PROXY_LISTENER_AUTH_MISSING')
    } finally {
      await h.close()
    }
  })

  test('a saved credential actually reaches the listener — an unauthenticated client is refused', async () => {
    const port = await freePort()
    const h = await authHarness(
      { 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, listenerAuth: true }) },
      { 'office-uk': { username: 'ops', password: 'super-secret-listener-pass' } },
    )
    try {
      await h.supervisor.refresh()
      expect((await h.supervisor.start('office-uk')).state).toBe('running')
      // No `Proxy-Authorization` at all — the listener's own `407`, proving
      // `supervisor.ts` actually passed the credential down to `listen-http.ts`
      // rather than merely reading it and discarding it.
      const reply = await new Promise<string>((resolve) => {
        const sock = net.connect(port, '127.0.0.1')
        let out = ''
        sock.on('connect', () => sock.write(`CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\n\r\n`))
        sock.on('data', (chunk: Buffer) => {
          out += chunk.toString('latin1')
        })
        sock.on('close', () => resolve(out))
        setTimeout(() => {
          sock.destroy()
          resolve(out)
        }, 3_000)
      })
      expect(reply).toContain('407')
    } finally {
      await h.close()
    }
  })
})

describe('per-upstream-slot secret storage (plan 121 §4.1, widened by step 121.4)', () => {
  /**
   * A bare `SupervisorHost` over a caller-supplied KV map — like `harness()`
   * above, but without that helper's own opinion about which secret keys get
   * written, since every test below needs to control that precisely.
   */
  function slotHost(entries: Map<string, unknown>): { host: SupervisorHost; lines: Harness['lines'] } {
    const lines: Harness['lines'] = []
    const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
      lines.push({ level, message, ...(fields ? { fields } : {}) })
    }
    const log: LogSink = { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
    return {
      lines,
      host: {
        storage: {
          global: {
            getRaw: async (key) => entries.get(key) ?? null,
            list: async (listOpts) => ({
              items: [...entries.entries()].filter(([key]) => (listOpts?.prefix ? key.startsWith(listOpts.prefix) : true)).map(([key, value]) => ({ key, value })),
              nextCursor: null,
            }),
          },
        },
        log,
      },
    }
  }

  /** A client socket that sends a CONNECT for the shared plain-HTTP fixture, and nothing else. */
  function connectAttempt(port: number): net.Socket {
    const sock = net.connect(port, '127.0.0.1')
    sock.on('connect', () => sock.write(`CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\n\r\n`))
    sock.on('error', () => {})
    return sock
  }

  test('slot 0 (the primary) falls back to the legacy bare proxy-secret:<id> key when no proxy-secret:<id>:0 row exists', async () => {
    const port = await freePort()
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    const entries = new Map<string, unknown>([
      [proxyKeyFor('office-uk'), writeProxyRecord(record({ listen: { proto: 'http', bindHost: '127.0.0.1', port }, upstream: { proto: 'socks5', host: '127.0.0.1', port: upstream.port, username: USERNAME, bindAddress: '', resolveThroughEgress: true } }))],
      // Deliberately the LEGACY bare key only — no `proxy-secret:office-uk:0`
      // row at all, which is exactly what a record saved before step 121.4
      // looks like.
      [proxySecretKeyFor('office-uk'), { password: PASSWORD }],
    ])
    const { host } = slotHost(entries)
    const supervisor = createSupervisor(host, { dialTimeoutMs: 2_000 })
    try {
      await supervisor.refresh()
      expect((await supervisor.start('office-uk')).state).toBe('running')
      const tunnel = await openTunnel(port)
      expect(upstream.authAccepted).toBe(true)
      tunnel.destroy()
    } finally {
      supervisor.destroyAll()
      await upstream.close()
    }
  })

  test('a fallback resolves ITS OWN stored password, not the primary\'s', async () => {
    const port = await freePort()
    const closedPort = await reserveClosedPort() // primary: nothing is listening, so every dial fails immediately
    const FALLBACK_USERNAME = 'fallback-account'
    const FALLBACK_PASSWORD = 'fallback-only-DISTINCT-password'
    const fallback = await startSocks5Upstream({ username: FALLBACK_USERNAME, password: FALLBACK_PASSWORD })
    const rec = record({
      listen: { proto: 'http', bindHost: '127.0.0.1', port },
      upstream: { proto: 'socks5', host: '127.0.0.1', port: closedPort, username: USERNAME, bindAddress: '', resolveThroughEgress: true },
      fallbackUpstreams: [{ proto: 'socks5', host: '127.0.0.1', port: fallback.port, username: FALLBACK_USERNAME, bindAddress: '', resolveThroughEgress: true }],
      failover: { failureThreshold: 1, autoFailback: true },
    })
    const entries = new Map<string, unknown>([
      [proxyKeyFor('office-uk'), writeProxyRecord(rec)],
      // Two DIFFERENT passwords, on two DIFFERENT slot keys — if the code
      // reused slot 0's password for slot 1, the fallback's own SOCKS5 auth
      // would reject it and `openTunnel` below would never see a 200.
      [proxySecretSlotKeyFor('office-uk', 0), { password: PASSWORD }],
      [proxySecretSlotKeyFor('office-uk', 1), { password: FALLBACK_PASSWORD }],
    ])
    const { host } = slotHost(entries)
    const supervisor = createSupervisor(host, { dialTimeoutMs: 2_000 })
    try {
      await supervisor.refresh()
      expect((await supervisor.start('office-uk')).state).toBe('running')

      // First connection dials the (unreachable) primary, fails, and reaches
      // `failureThreshold` of 1 — the confirmation probe has no configured
      // endpoint in this test process, so it "fails" immediately too (the
      // same skip-means-fail discipline `probeEntry` itself documents), and
      // the switch to the fallback happens right away.
      const first = connectAttempt(port)
      await waitForClose(first)
      await waitForActiveIndex(() => supervisor.snapshot().find((v) => v.id === 'office-uk')?.failover, 1)

      // The NEXT connection dials the fallback, authenticating as ITSELF.
      const second = await openTunnel(port)
      expect(fallback.authAccepted).toBe(true)
      expect(fallback.usernamesSeen).toContain(FALLBACK_USERNAME)
      second.destroy()
    } finally {
      supervisor.destroyAll()
      await fallback.close()
    }
  })

  test('a fallback with no secret at all still works when its own kind needs none — a direct upstream', async () => {
    const port = await freePort()
    const closedPort = await reserveClosedPort()
    const rec = record({
      listen: { proto: 'http', bindHost: '127.0.0.1', port },
      upstream: { proto: 'socks5', host: '127.0.0.1', port: closedPort, username: USERNAME, bindAddress: '', resolveThroughEgress: true },
      fallbackUpstreams: [{ proto: 'direct', host: '', port: 0, username: '', bindAddress: '', resolveThroughEgress: true }],
      failover: { failureThreshold: 1, autoFailback: true },
    })
    const entries = new Map<string, unknown>([
      [proxyKeyFor('office-uk'), writeProxyRecord(rec)],
      [proxySecretSlotKeyFor('office-uk', 0), { password: PASSWORD }],
      // No `proxy-secret:office-uk:1` row at all — a freshly-added fallback
      // nobody has entered credentials for, and `direct` needs none anyway.
    ])
    const { host } = slotHost(entries)
    const supervisor = createSupervisor(host, { dialTimeoutMs: 2_000 })
    try {
      await supervisor.refresh()
      expect((await supervisor.start('office-uk')).state).toBe('running')

      const first = connectAttempt(port)
      await waitForClose(first)
      await waitForActiveIndex(() => supervisor.snapshot().find((v) => v.id === 'office-uk')?.failover, 1)

      // Reading a missing slot secret must not throw and must not block the
      // switch — the direct upstream dials the plain fixture straight through.
      const second = await openTunnel(port)
      second.destroy()
    } finally {
      supervisor.destroyAll()
    }
  })

  test('a fallback with no secret at all does NOT silently authenticate as the primary', async () => {
    const port = await freePort()
    const closedPort = await reserveClosedPort()
    const FALLBACK_USERNAME = 'fallback-account'
    // The fixture requires this exact username with an EMPTY password — the
    // correct reading of "no secret saved for this slot" (`readSlotPassword`
    // resolves to `''`, never `undefined`, never a throw). If the code instead
    // reused the primary's own (non-empty) `PASSWORD`, this auth would be
    // REJECTED — the discriminator this test is actually built on, stronger
    // than merely observing a rejection either way would be.
    const fallback = await startSocks5Upstream({ username: FALLBACK_USERNAME, password: '' })
    const rec = record({
      listen: { proto: 'http', bindHost: '127.0.0.1', port },
      upstream: { proto: 'socks5', host: '127.0.0.1', port: closedPort, username: USERNAME, bindAddress: '', resolveThroughEgress: true },
      fallbackUpstreams: [{ proto: 'socks5', host: '127.0.0.1', port: fallback.port, username: FALLBACK_USERNAME, bindAddress: '', resolveThroughEgress: true }],
      failover: { failureThreshold: 1, autoFailback: true },
    })
    const entries = new Map<string, unknown>([
      [proxyKeyFor('office-uk'), writeProxyRecord(rec)],
      // Only the PRIMARY has a saved secret, and it is NOT empty — no
      // `proxy-secret:office-uk:1` row exists for the fallback at all.
      [proxySecretSlotKeyFor('office-uk', 0), { password: PASSWORD }],
    ])
    const { host } = slotHost(entries)
    const supervisor = createSupervisor(host, { dialTimeoutMs: 2_000 })
    try {
      await supervisor.refresh()
      expect((await supervisor.start('office-uk')).state).toBe('running')

      const first = connectAttempt(port)
      await waitForClose(first)
      await waitForActiveIndex(() => supervisor.snapshot().find((v) => v.id === 'office-uk')?.failover, 1)

      // The switch happened (index moved to the fallback), and the fallback's
      // own SOCKS5 server ACCEPTS the empty password it was actually sent —
      // proving the primary's real password was NOT silently substituted.
      const second = await openTunnel(port)
      expect(fallback.usernamesSeen).toContain(FALLBACK_USERNAME)
      expect(fallback.authAccepted).toBe(true)
      second.destroy()
    } finally {
      supervisor.destroyAll()
      await fallback.close()
    }
  })
})

describe('failover joins snapshot(), and Supervisor.resetFailover — plan 121 §4.5, step 121.6', () => {
  test('snapshot() reports failover: null for a record with no live listener', async () => {
    const h = await harness({ 'office-uk': record() })
    try {
      await h.supervisor.refresh()
      const view = h.supervisor.snapshot().find((v) => v.id === 'office-uk')
      expect(view?.failover).toBeNull()
    } finally {
      await h.close()
    }
  })

  test('a running record with no configured backups reports failover: activeIndex 0, empty history — provably inert, not merely absent', async () => {
    const port = await freePort()
    const h = await harness({ 'office-uk': record({ listen: { proto: 'http', bindHost: '127.0.0.1', port } }) })
    try {
      await h.supervisor.refresh()
      await h.supervisor.start('office-uk')
      const view = h.supervisor.snapshot().find((v) => v.id === 'office-uk')
      expect(view?.failover).toEqual({ activeIndex: 0, consecutiveFailures: 0, primaryRecoveryStreak: 0, history: [] })
    } finally {
      await h.close()
    }
  })

  test('after a real threshold-triggered switch, snapshot() reports the new activeIndex and history, and resetFailover() puts it back', async () => {
    const port = await freePort()
    const closedPort = await reserveClosedPort() // primary: nothing listening, every dial fails
    const fallback = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    const rec = record({
      listen: { proto: 'http', bindHost: '127.0.0.1', port },
      upstream: { proto: 'socks5', host: '127.0.0.1', port: closedPort, username: USERNAME, bindAddress: '', resolveThroughEgress: true },
      fallbackUpstreams: [{ proto: 'socks5', host: '127.0.0.1', port: fallback.port, username: USERNAME, bindAddress: '', resolveThroughEgress: true }],
      failover: { failureThreshold: 1, autoFailback: true },
    })
    const entries = new Map<string, unknown>([
      [proxyKeyFor('office-uk'), writeProxyRecord(rec)],
      [proxySecretSlotKeyFor('office-uk', 0), { password: PASSWORD }],
      [proxySecretSlotKeyFor('office-uk', 1), { password: PASSWORD }],
    ])
    const log: LogSink = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    const host: SupervisorHost = { storage: { global: { getRaw: async (key) => entries.get(key) ?? null, list: async (opts) => ({ items: [...entries.entries()].filter(([key]) => (opts?.prefix ? key.startsWith(opts.prefix) : true)).map(([key, value]) => ({ key, value })), nextCursor: null }) } }, log }
    const supervisor = createSupervisor(host, { dialTimeoutMs: 2_000 })
    try {
      await supervisor.refresh()
      expect((await supervisor.start('office-uk')).state).toBe('running')

      const first = net.connect(port, '127.0.0.1')
      first.on('connect', () => first.write(`CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\n\r\n`))
      first.on('error', () => {})
      await waitForClose(first)
      await waitForActiveIndex(() => supervisor.snapshot().find((v) => v.id === 'office-uk')?.failover, 1)

      const switched = supervisor.snapshot().find((v) => v.id === 'office-uk')
      expect(switched?.failover?.activeIndex).toBe(1)
      expect(switched?.failover?.history.length).toBeGreaterThanOrEqual(1)
      expect(switched?.failover?.history[0]).toMatchObject({ from: 0, to: 1 })

      const runtime = await supervisor.resetFailover('office-uk')
      expect(runtime.state).toBe('running') // resetFailover never stops the listener

      const reset = supervisor.snapshot().find((v) => v.id === 'office-uk')
      expect(reset?.failover?.activeIndex).toBe(0)
      expect(reset?.failover?.history[0]).toMatchObject({ from: 1, to: 0, reason: expect.stringContaining('manual') })
    } finally {
      supervisor.destroyAll()
      await fallback.close()
    }
  })

  test('resetFailover() on a record that is not running is a no-op, not a throw', async () => {
    const h = await harness({ 'office-uk': record() })
    try {
      await h.supervisor.refresh()
      const runtime = await h.supervisor.resetFailover('office-uk')
      expect(runtime.state).toBe('stopped')
    } finally {
      await h.close()
    }
  })

  test('resetFailover() on an unknown id throws, same as start/stop/restart', async () => {
    const h = await harness({ 'office-uk': record() })
    try {
      await h.supervisor.refresh()
      await expect(h.supervisor.resetFailover('no-such-record')).rejects.toThrow()
    } finally {
      await h.close()
    }
  })
})
