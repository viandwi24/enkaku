import { describe, expect, test, beforeEach } from 'bun:test'
import net from 'node:net'
import { resetBindProbeCacheForTests } from './bind-probe'
import { ProxyError } from './errors'
import type { GostRuntime, GostRuntimeHost } from './gost-runtime'
import { createUpstream, resetGostRuntimeForTests } from './upstream'
import { DEFAULT_DRAIN_MS, DEFAULT_MAX_CONNECTIONS, type ProxyRecord } from '../shared'

/**
 * Plan 123 step 123.2 — the four-row gate in `createUpstream` (§4.2), the
 * platform-name gate replaced by measurement.
 *
 * `createDirectUpstream`/`createHttpUpstream` build an `Upstream` object
 * synchronously, with no network I/O until `.connect()` is called — so which
 * branch `createUpstream` took is readable straight off the returned
 * `description` (`direct via …` vs `http://127.0.0.1:<port>`) without ever
 * opening a socket. That is deliberate: these tests are about the ROUTING
 * decision, not about dialling, so no real gost process and no real upstream
 * fixture is needed anywhere in this file.
 *
 * `checkBindEffective` and `buildGostRuntime` are test-only seams added on
 * `createUpstream`'s own `opts` (see that function's doc comment) — the real
 * `bindIsEffective()` cannot be forced to report "the bind works" on a
 * runtime where it genuinely does not (`bind-probe.test.ts`'s own header
 * explains why), and the real `gost` machinery is Windows-only by
 * construction and not something a test should provision for real.
 */

const noopLog: GostRuntimeHost['log'] = { info() {}, warn() {}, error() {} }

function record(over: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    label: 'Office UK',
    listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 },
    upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress: '', resolveThroughEgress: true },
    fallbackUpstreams: [],
    failover: { failureThreshold: 3, autoFailback: true },
    enabled: true,
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

function directRecord(bindAddress: string): ProxyRecord {
  return record({ upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress, resolveThroughEgress: true } })
}

function succeedingGostRuntime(port: number, seenBindAddresses: string[]): (host: GostRuntimeHost) => GostRuntime {
  return () => ({
    ensurePort: async (bindAddress: string) => {
      seenBindAddresses.push(bindAddress)
      return port
    },
    stopAll: async () => {},
  })
}

function unsupportedPlatformGostRuntime(): (host: GostRuntimeHost) => GostRuntime {
  return () => ({
    ensurePort: async () => {
      throw new ProxyError('E_PROXY_GOST_UNSUPPORTED_PLATFORM', 'gost provisioning was reached on linux — this workaround exists for Windows only')
    },
    stopAll: async () => {},
  })
}

function listenLoopback(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

beforeEach(() => {
  resetGostRuntimeForTests()
  resetBindProbeCacheForTests()
})

describe('row 1 — empty bindAddress: completely unaffected (§6 criterion 4)', () => {
  test('native direct, no probe call, no gost, no precondition', async () => {
    let probeCalls = 0
    const upstream = await createUpstream(directRecord(''), '', {
      checkBindEffective: async () => {
        probeCalls++
        return true
      },
      buildGostRuntime: () => {
        throw new Error('gost must not be built when there is nothing to bind')
      },
    })
    expect(probeCalls).toBe(0)
    expect(upstream.description).toBe('direct (this host’s default route)')
  })
})

describe('row 2 — bindAddress set, bind works: native direct, now MEASURED', () => {
  test('the plain direct upstream is used and gost is never attempted', async () => {
    const upstream = await createUpstream(directRecord('192.168.50.11'), '', {
      log: noopLog,
      checkBindEffective: async () => true,
      buildGostRuntime: () => {
        throw new Error('gost must not be built when the bind works')
      },
    })
    expect(upstream.description).toContain('192.168.50.11')
    expect(upstream.description).not.toContain('http://')
  })
})

describe('row 3 — bind broken + gost available: the gost hop, on ANY platform (§6 criterion 2, the change’s whole purpose)', () => {
  test('the gost hop is taken with process.platform stubbed to a NON-Windows value', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: true })
    try {
      const seen: string[] = []
      const upstream = await createUpstream(directRecord('192.168.50.11'), '', {
        log: noopLog,
        checkBindEffective: async () => false,
        buildGostRuntime: succeedingGostRuntime(40123, seen),
      })
      // THE CLAIM: `process.platform` reads 'linux' throughout this call, yet
      // the gost hop was still taken — nothing in createUpstream's routing
      // consults it any more. Only whether the (faked) gost machinery itself
      // succeeds decides this branch.
      expect(upstream.description).toBe('http://127.0.0.1:40123')
      expect(seen).toEqual(['192.168.50.11'])
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true, writable: true })
    }
  })
})

describe('row 4 — bind broken + no gost available: E_PROXY_BIND_INEFFECTIVE (§6 criterion 3’s createUpstream half)', () => {
  test('gost refusing this platform becomes E_PROXY_BIND_INEFFECTIVE, not the raw internal code', async () => {
    let rejected: unknown
    try {
      await createUpstream(directRecord('192.168.50.11'), '', {
        log: noopLog,
        checkBindEffective: async () => false,
        buildGostRuntime: unsupportedPlatformGostRuntime(),
      })
    } catch (err) {
      rejected = err
    }
    expect(rejected).toBeInstanceOf(ProxyError)
    expect((rejected as ProxyError).code).toBe('E_PROXY_BIND_INEFFECTIVE')
    expect((rejected as ProxyError).message).toContain('192.168.50.11')
  })

  test('a DIFFERENT gost failure (a real provisioning problem, not a platform refusal) propagates unconverted — the gost branch is otherwise untouched', async () => {
    const upstream = createUpstream(directRecord('192.168.50.11'), '', {
      log: noopLog,
      checkBindEffective: async () => false,
      buildGostRuntime: () => ({
        ensurePort: async () => {
          throw new ProxyError('E_PROXY_GOST_UNAVAILABLE', 'the local gost helper did not start listening on 127.0.0.1:40123 within 3000 ms')
        },
        stopAll: async () => {},
      }),
    })
    await expect(upstream).rejects.toMatchObject({ code: 'E_PROXY_GOST_UNAVAILABLE' })
  })
})

describe('row 5 / §6 criterion 5 — the probe is cached: many createUpstream calls pay for at most one measurement', () => {
  test('hostAddresses (the real bindIsEffective() dependency) is invoked exactly once across five createUpstream calls', async () => {
    const server = net.createServer((sock) => sock.end())
    const port = await listenLoopback(server)
    try {
      let hostAddressCalls = 0
      resetBindProbeCacheForTests({
        hostAddresses: () => {
          hostAddressCalls++
          return []
        },
        target: { host: '127.0.0.1', port },
        timeoutMs: 500,
      })
      const seen: string[] = []
      for (let i = 0; i < 5; i++) {
        // Deliberately NOT passing `checkBindEffective`: this test exercises
        // the DEFAULT wiring, i.e. that createUpstream really does route
        // through the shared, process-cached `bindIsEffective()` rather than
        // probing on its own.
        const upstream = await createUpstream(directRecord('192.168.50.11'), '', {
          log: noopLog,
          buildGostRuntime: succeedingGostRuntime(39999, seen),
        })
        expect(upstream.description).toBe('http://127.0.0.1:39999')
      }
      expect(hostAddressCalls).toBe(1)
      expect(seen).toEqual(['192.168.50.11', '192.168.50.11', '192.168.50.11', '192.168.50.11', '192.168.50.11'])
    } finally {
      server.close()
    }
  })
})
