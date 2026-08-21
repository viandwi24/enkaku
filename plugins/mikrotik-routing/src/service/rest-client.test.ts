import { describe, expect, test } from 'bun:test'
import { MikrotikRestClient, type MikrotikRestConfig } from './rest-client'
import { MikrotikRestError } from './errors'

/**
 * Fake-HTTP-server tests for the REST driver's low-level client — no router
 * needed, per plan 122 §5 step 122.1 / §7. Follows the `Bun.serve({ port: 0,
 * fetch })` / `server.stop(true)` pattern already established in
 * `packages/toolchain/src/manager.test.ts`, the closest existing example of a
 * fake JSON-over-HTTP server in this repo (`plugins/proxy-manager`'s own
 * fixtures are all raw-TCP proxy protocol servers, not JSON REST, so they are
 * not the shape to copy here).
 */

const USERNAME = 'admin'
const PASSWORD = 'correct-horse-battery-staple'

/**
 * `@types/bun` types `Server.port` as `number | undefined` (it is `undefined`
 * for a unix-socket server) — every fixture here binds `port: 0` on TCP, so
 * it is always a real number by the time `.listen` resolves; this just
 * narrows the type rather than asserting anything new about runtime
 * behaviour.
 */
function boundPort(server: { port?: number }): number {
  if (server.port === undefined) throw new Error('fixture server has no bound port')
  return server.port
}

function configFor(port: number, overrides: Partial<MikrotikRestConfig> = {}): MikrotikRestConfig {
  return { baseUrl: `127.0.0.1:${port}`, username: USERNAME, password: PASSWORD, tls: false, timeoutMs: 2_000, ...overrides }
}

function checkAuth(req: Request): boolean {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  return decoded === `${USERNAME}:${PASSWORD}`
}

describe('MikrotikRestClient — basic auth, verbs, and RouterOS-shaped responses', () => {
  test('GET returns the parsed JSON array, hardware-shaped per plan 122 §4.1 (.id/src-address/table/comment/disabled/inactive)', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (!checkAuth(req)) return new Response('', { status: 401 })
        if (req.method === 'GET' && new URL(req.url).pathname === '/rest/routing/rule') {
          return Response.json([{ '.id': '*1', 'src-address': '192.168.10.215/32', table: 'via-modem7-p12', comment: 'enkaku:mikrotik-routing:v1:g:1', disabled: false, inactive: false }])
        }
        return new Response('not found', { status: 404 })
      },
    })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server)))
      const body = await client.get('/routing/rule')
      expect(body).toEqual([{ '.id': '*1', 'src-address': '192.168.10.215/32', table: 'via-modem7-p12', comment: 'enkaku:mikrotik-routing:v1:g:1', disabled: false, inactive: false }])
    } finally {
      server.stop(true)
    }
  })

  test('PUT returns the created object including its .id — the shape a resolve-before-write caller (a later step) needs', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (!checkAuth(req)) return new Response('', { status: 401 })
        if (req.method === 'PUT' && new URL(req.url).pathname === '/rest/routing/rule') {
          const sent = (await req.json()) as Record<string, unknown>
          return Response.json({ '.id': '*6', ...sent })
        }
        return new Response('not found', { status: 404 })
      },
    })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server)))
      const body = await client.put('/routing/rule', { 'src-address': '192.168.10.216/32', table: 'via-modem2', comment: 'enkaku:mikrotik-routing:v1:g:2' })
      expect(body).toMatchObject({ '.id': '*6', 'src-address': '192.168.10.216/32' })
    } finally {
      server.stop(true)
    }
  })

  test('PATCH against an id carrying a literal "*" (no URL-encoding, per §4.1 evidence) returns the updated object', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (!checkAuth(req)) return new Response('', { status: 401 })
        const url = new URL(req.url)
        if (req.method === 'PATCH' && url.pathname === '/rest/routing/rule/*6') {
          const sent = (await req.json()) as Record<string, unknown>
          return Response.json({ '.id': '*6', table: 'via-modem9', ...sent })
        }
        return new Response('not found', { status: 404 })
      },
    })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server)))
      const body = await client.patch('/routing/rule/*6', { table: 'via-modem9' })
      expect(body).toEqual({ '.id': '*6', table: 'via-modem9' })
    } finally {
      server.stop(true)
    }
  })

  test('DELETE returns an empty body, parsed as `undefined` rather than a parse failure', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (!checkAuth(req)) return new Response('', { status: 401 })
        if (req.method === 'DELETE') return new Response('', { status: 200 })
        return new Response('not found', { status: 404 })
      },
    })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server)))
      const body = await client.delete('/routing/rule/*6')
      expect(body).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })

  test('wrong credentials produce a `MikrotikRestError` of kind "auth", status 401, and never contain the configured password', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('', { status: 401 }) })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server), { password: 'wrong-password' }))
      await expect(client.get('/routing/rule')).rejects.toThrow(MikrotikRestError)
      try {
        await client.get('/routing/rule')
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(MikrotikRestError)
        const restErr = err as MikrotikRestError
        expect(restErr.kind).toBe('auth')
        expect(restErr.status).toBe(401)
        expect(restErr.message).not.toContain(PASSWORD)
      }
    } finally {
      server.stop(true)
    }
  })

  test('a non-2xx, non-401 status becomes a "http" error naming the status, with the router password scrubbed from any echoed body', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (!checkAuth(req)) return new Response('', { status: 401 })
        return new Response(`internal error touching secret ${PASSWORD}`, { status: 500 })
      },
    })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server)))
      try {
        await client.get('/routing/rule')
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(MikrotikRestError)
        const restErr = err as MikrotikRestError
        expect(restErr.kind).toBe('http')
        expect(restErr.status).toBe(500)
        expect(restErr.message).toContain('500')
        expect(restErr.message).not.toContain(PASSWORD)
      }
    } finally {
      server.stop(true)
    }
  })

  test('a body that is not JSON becomes a "parse" error rather than a silently-garbage return value', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (!checkAuth(req)) return new Response('', { status: 401 })
        return new Response('<html>not json</html>', { status: 200 })
      },
    })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server)))
      try {
        await client.get('/routing/rule')
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(MikrotikRestError)
        expect((err as MikrotikRestError).kind).toBe('parse')
      }
    } finally {
      server.stop(true)
    }
  })

  test('an unreachable host becomes a "network" error', async () => {
    // A port with nothing listening on loopback — reserved and released.
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const deadPort = boundPort(probe)
    probe.stop(true)
    const client = new MikrotikRestClient(configFor(deadPort))
    try {
      await client.get('/routing/rule')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MikrotikRestError)
      expect((err as MikrotikRestError).kind).toBe('network')
    }
  })

  test('a request slower than `timeoutMs` is aborted, not left hanging forever', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (!checkAuth(req)) return new Response('', { status: 401 })
        await new Promise((resolve) => setTimeout(resolve, 500))
        return Response.json([])
      },
    })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server), { timeoutMs: 50 }))
      const start = Date.now()
      try {
        await client.get('/routing/rule')
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(MikrotikRestError)
        expect((err as MikrotikRestError).kind).toBe('network')
        expect((err as MikrotikRestError).message).toMatch(/did not answer/)
        expect(Date.now() - start).toBeLessThan(500)
      }
    } finally {
      server.stop(true)
    }
  })

  test('`tls: true` against a plain-HTTP fixture fails to connect — proving the toggle actually changes the scheme dialled, not just a config field nobody reads', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json([]) })
    try {
      const client = new MikrotikRestClient(configFor(boundPort(server), { tls: true, timeoutMs: 500 }))
      await expect(client.get('/routing/rule')).rejects.toThrow(MikrotikRestError)
    } finally {
      server.stop(true)
    }
  })
})
