import { createServer, type Server as NetServer } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  DUMP_WINDOW_HIERARCHY_TIMEOUT_MS,
  PING_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  UiServerClient,
  UiServerClientError,
} from './client'

/**
 * `UiServerClient` talks to a REAL local server rather than a mocked
 * `fetch` — `fetch` itself is what produces the exact failure this plan
 * fixes ("the socket connection was closed unexpectedly"), and that string
 * is Bun's own wording for an abruptly-destroyed TCP connection, not
 * something a mock can produce faithfully.
 */

/** Answers every endpoint the client uses, successfully and immediately. */
function startEchoServer(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/ping') return new Response('pong')
      if (url.pathname === '/jsonrpc/0') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }))
      if (url.pathname === '/screenshot/0') return new Response(new Uint8Array([1, 2, 3]))
      return new Response('not found', { status: 404 })
    },
  })
  const port = server.port
  if (typeof port !== 'number') throw new Error('Bun.serve did not report a port')
  return { port, stop: () => server.stop(true) }
}

/**
 * `AbortSignal.timeout(ms)` is the ONLY thing that carries each call's
 * timeout budget out of `client.ts` — patching it (and delegating to the
 * real implementation) lets these tests prove the exact ms value used per
 * operation without ever waiting for a real timeout to fire.
 */
function captureAbortTimeouts(): { seen: () => number[]; restore: () => void } {
  const original = AbortSignal.timeout
  const seen: number[] = []
  AbortSignal.timeout = ((ms: number) => {
    seen.push(ms)
    return original(ms)
  }) as typeof AbortSignal.timeout
  return { seen: () => seen, restore: () => (AbortSignal.timeout = original) }
}

describe('UiServerClient — per-operation timeouts are named constants, not one shared literal (plan 85 §3.5, fixes F18)', () => {
  let echo: { port: number; stop: () => void }
  beforeAll(() => {
    echo = startEchoServer()
  })
  afterAll(() => echo.stop())

  test('the four budgets are genuinely distinct', () => {
    const values = [PING_TIMEOUT_MS, RPC_TIMEOUT_MS, DUMP_WINDOW_HIERARCHY_TIMEOUT_MS, SCREENSHOT_TIMEOUT_MS]
    expect(new Set(values).size).toBe(4)
    expect(values).toEqual([1000, 5000, 20_000, 15_000])
  })

  test('ping() uses PING_TIMEOUT_MS (1000ms, unchanged)', async () => {
    const cap = captureAbortTimeouts()
    try {
      const client = new UiServerClient({ localPort: echo.port })
      expect(await client.ping()).toBe(true)
      expect(cap.seen()).toEqual([PING_TIMEOUT_MS])
    } finally {
      cap.restore()
    }
  })

  test('an ordinary RPC call (setText) uses RPC_TIMEOUT_MS (5000ms)', async () => {
    const cap = captureAbortTimeouts()
    try {
      const client = new UiServerClient({ localPort: echo.port })
      await client.setText({ text: 'x', mask: 0x01 }, 'hello')
      expect(cap.seen()).toEqual([RPC_TIMEOUT_MS])
    } finally {
      cap.restore()
    }
  })

  test('dumpWindowHierarchy() uses its own, longer DUMP_WINDOW_HIERARCHY_TIMEOUT_MS (20000ms) — the whole point of F18', async () => {
    const cap = captureAbortTimeouts()
    try {
      const client = new UiServerClient({ localPort: echo.port })
      await client.dumpWindowHierarchy()
      expect(cap.seen()).toEqual([DUMP_WINDOW_HIERARCHY_TIMEOUT_MS])
    } finally {
      cap.restore()
    }
  })

  test('screenshot() uses SCREENSHOT_TIMEOUT_MS (15000ms)', async () => {
    const cap = captureAbortTimeouts()
    try {
      const client = new UiServerClient({ localPort: echo.port })
      await client.screenshot()
      expect(cap.seen()).toEqual([SCREENSHOT_TIMEOUT_MS])
    } finally {
      cap.restore()
    }
  })

  test('a constructor-level `timeoutMs` overrides the ordinary-RPC default but NOT dumpWindowHierarchy/screenshot', async () => {
    const cap = captureAbortTimeouts()
    try {
      const client = new UiServerClient({ localPort: echo.port, timeoutMs: 4242 })
      await client.setText({ text: 'x', mask: 0x01 }, 'hello')
      await client.dumpWindowHierarchy()
      await client.screenshot()
      expect(cap.seen()).toEqual([4242, DUMP_WINDOW_HIERARCHY_TIMEOUT_MS, SCREENSHOT_TIMEOUT_MS])
    } finally {
      cap.restore()
    }
  })
})

/**
 * A raw `net` server (not `Bun.serve`) so a connection can be destroyed
 * BEFORE any HTTP response is written — that is exactly what reproduces
 * Bun fetch's "the socket connection was closed unexpectedly" (verified
 * directly against a real Bun fetch: this message has no `.cause`, which is
 * why `client.ts` chains it on with `{ cause: err }` itself). Every
 * connection past `failFirstN` answers a minimal, valid JSON-RPC success.
 */
function startFlakyJsonRpcServer(failFirstN: number): { port: number; close: () => void; connections: () => number } {
  let seen = 0
  const server: NetServer = createServer((socket) => {
    seen += 1
    const mine = seen
    socket.on('data', () => {
      if (mine <= failFirstN) {
        socket.destroy()
        return
      }
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      )
    })
  })
  server.listen(0, '127.0.0.1')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return { port: address.port, close: () => server.close(), connections: () => seen }
}

describe('UiServerClient — the stale-forward retry (plan 85 §3.5, fixes F18s real cause)', () => {
  let flaky: { port: number; close: () => void; connections: () => number }
  afterEach(() => flaky?.close())

  test('a single closed-socket failure is retried exactly once, after re-asserting the forward, and succeeds', async () => {
    flaky = startFlakyJsonRpcServer(1)
    let reassertCalls = 0
    const client = new UiServerClient({
      localPort: flaky.port,
      reassertForward: async () => {
        reassertCalls += 1
      },
    })

    const result = await client.rpc('someMethod', [])

    expect(result).toBeNull()
    expect(reassertCalls).toBe(1)
    expect(flaky.connections()).toBe(2)
  })

  test('a closed-socket failure that repeats on the retry is thrown — not retried a second time', async () => {
    flaky = startFlakyJsonRpcServer(99)
    let reassertCalls = 0
    const client = new UiServerClient({
      localPort: flaky.port,
      reassertForward: async () => {
        reassertCalls += 1
      },
    })

    await expect(client.rpc('someMethod', [])).rejects.toThrow(/socket connection was closed unexpectedly/i)
    expect(reassertCalls).toBe(1)
    // Exactly two connections: the original attempt and the ONE retry — a
    // third would mean the retry-exactly-once budget was not respected.
    expect(flaky.connections()).toBe(2)
  })

  test('a `reassertForward` that itself throws does not block the retry', async () => {
    flaky = startFlakyJsonRpcServer(1)
    const client = new UiServerClient({
      localPort: flaky.port,
      reassertForward: async () => {
        throw new Error('adb forward failed too, whatever')
      },
    })

    const result = await client.rpc('someMethod', [])

    expect(result).toBeNull()
    expect(flaky.connections()).toBe(2)
  })

  test('no `reassertForward` supplied still retries once, just without the repair step', async () => {
    flaky = startFlakyJsonRpcServer(1)
    const client = new UiServerClient({ localPort: flaky.port })

    const result = await client.rpc('someMethod', [])

    expect(result).toBeNull()
    expect(flaky.connections()).toBe(2)
  })

  test('an UNREACHABLE failure that is not a closed socket (e.g. connection refused) is never retried', async () => {
    // No server at all: the request fails as a connection refusal, which
    // does not match the "closed unexpectedly" pattern.
    let reassertCalls = 0
    const client = new UiServerClient({
      localPort: 1, // a port nothing listens on — connection refused
      reassertForward: async () => {
        reassertCalls += 1
      },
    })

    let caught: unknown
    try {
      await client.rpc('someMethod', [])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UiServerClientError)
    expect((caught as UiServerClientError).code).toBe('UI_SERVER_UNREACHABLE')
    expect(reassertCalls).toBe(0)
  })
})
