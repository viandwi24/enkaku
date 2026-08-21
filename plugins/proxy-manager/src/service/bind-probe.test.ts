import { describe, expect, test, beforeEach } from 'bun:test'
import net from 'node:net'
import { bindIsEffective, pickBindProbeAddress, resetBindProbeCacheForTests } from './bind-probe'

/**
 * Plan 123 step 123.1 — `bindIsEffective()` (§3.1, §3.2, §4.1).
 *
 * ## Why this file does not simply assert `toBe(false)`
 *
 * On the runtime this was written against, `false` (the option is silently
 * dropped) is what `bindIsEffective()` genuinely returns. But `false` is
 * the BUG, not the contract: the day Bun fixes `localAddress`, that answer
 * flips to `true`, and a test that pinned `false` forever would then fail
 * and look like a regression when it is actually the bug being fixed
 * (plan 123 §5 step 123.1, §8's own risk table). So the "what does this
 * runtime actually do" test below compares `bindIsEffective()` against an
 * INDEPENDENT, from-scratch measurement of the same runtime, taken inside
 * the test rather than imported from the module under test — both sides
 * move together if Bun's behaviour ever changes, so the assertion is about
 * the two branches being distinguishable and self-consistent, not about
 * which branch today happens to be true.
 */

beforeEach(() => {
  resetBindProbeCacheForTests()
})

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

/**
 * Reimplements the §3.1 discriminator from scratch — bind to a TEST-NET-1
 * address this host cannot hold, connect to a listener started here, see
 * whether the bind was honoured — without calling `bindIsEffective` or
 * anything it imports. Kept deliberately independent so the comparison in
 * the test below is not tautological.
 */
async function measureRawBindHonoured(): Promise<boolean> {
  const server = net.createServer()
  const port = await listen(server)
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const socket = net.connect({ host: '127.0.0.1', port, localAddress: '192.0.2.222' })
      const timer = setTimeout(() => finish(false), 1_000)
      function finish(result: boolean): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolve(result)
      }
      socket.on('connect', () => finish(false))
      socket.on('error', (err: NodeJS.ErrnoException) => finish(err.code === 'EADDRNOTAVAIL' || err.code === 'EINVAL'))
    })
  } finally {
    server.close()
  }
}

describe('bindIsEffective() — agrees with reality on whatever this runtime does', () => {
  test('matches an independent, from-scratch measurement of this runtime — not a pinned constant', async () => {
    const raw = await measureRawBindHonoured()
    const result = await bindIsEffective()
    // THE CLAIM: whatever this runtime's `net.connect({ localAddress })`
    // actually does, `bindIsEffective()` reports the same thing. If a
    // future Bun release fixes the option, `raw` becomes `true` and this
    // assertion keeps passing, because both sides flip together.
    expect(result).toBe(raw)
    // Documented for humans, not pinned as the contract: on Bun 1.3.14
    // (macOS, this session, 2026-08-21) `raw` was measured `false` — the
    // option is silently dropped, matching plan 123 §0.2's own finding.
  })
})

describe('§3.1 — the discriminator, exercised directly through the internal branches', () => {
  // The "honoured → EADDRNOTAVAIL → true" branch is NOT tested here with a
  // forced fixture: forcing it would require a runtime that actually calls
  // `bind()` for `localAddress`, which is precisely the thing this runtime
  // does not do (§0.2) — there is no seam that fakes a raw socket error
  // without also faking the very question under test. It is still covered,
  // honestly: the "agrees with reality" test above compares against an
  // independent measurement of the SAME discriminator, so if a future Bun
  // build ever takes the "honoured" branch for real, that test starts
  // exercising it and keeps passing rather than needing to be rewritten.

  test('bind ignored (the connect succeeds from an address this host does not hold) → false', async () => {
    const server = net.createServer((sock) => sock.end())
    const port = await listen(server)
    try {
      resetBindProbeCacheForTests({ hostAddresses: () => [], target: { host: '127.0.0.1', port }, timeoutMs: 500 })
      const result = await bindIsEffective()
      // On a runtime that ignores `localAddress` (this one, per §0.2), the
      // connect reaches the listener regardless of `target`'s address, and
      // the probe reports `false`.
      expect(result).toBe(false)
    } finally {
      server.close()
    }
  })

  test('the timeout path — neither a connect nor an address error inside the deadline → false, inconclusive', async () => {
    // 203.0.113.0/24 (RFC 5737 TEST-NET-3) is silently dropped rather than
    // promptly refused — the same fixture `dial-direct.test.ts`'s own
    // connect-timeout test relies on, for the same reason: a genuine
    // connect-level hang, not a fast ECONNREFUSED.
    resetBindProbeCacheForTests({ hostAddresses: () => [], target: { host: '203.0.113.1', port: 81 }, timeoutMs: 300 })
    const started = Date.now()
    const result = await bindIsEffective()
    expect(result).toBe(false)
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 10_000)
})

describe('§3.1 — a host that holds a TEST-NET-1 candidate still gets a correct answer', () => {
  test('pickBindProbeAddress skips a held candidate rather than picking it', () => {
    const held = ['192.0.2.1', '192.0.2.2', '192.0.2.3']
    const picked = pickBindProbeAddress(() => held)
    expect(picked).not.toBeNull()
    expect(held).not.toContain(picked)
    expect(picked).toBe('192.0.2.4')
  })

  test('every TEST-NET-1 address reported held → null, the documented inconclusive case', () => {
    const wholeBlock = Array.from({ length: 254 }, (_, i) => `192.0.2.${i + 1}`)
    const picked = pickBindProbeAddress(() => wholeBlock)
    expect(picked).toBeNull()
  })

  test('bindIsEffective() still resolves (does not hang or throw) when the first candidate is reported held', async () => {
    const server = net.createServer((sock) => sock.end())
    const port = await listen(server)
    try {
      resetBindProbeCacheForTests({ hostAddresses: () => ['192.0.2.1'], target: { host: '127.0.0.1', port }, timeoutMs: 500 })
      const result = await bindIsEffective()
      expect(typeof result).toBe('boolean')
    } finally {
      server.close()
    }
  })
})

describe('§3.2 — cached per process: the probe runs at most once no matter how many callers ask', () => {
  test('hostAddresses is invoked exactly once across many concurrent and sequential calls', async () => {
    const server = net.createServer((sock) => sock.end())
    const port = await listen(server)
    try {
      let calls = 0
      resetBindProbeCacheForTests({
        hostAddresses: () => {
          calls += 1
          return []
        },
        target: { host: '127.0.0.1', port },
        timeoutMs: 500,
      })

      const [a, b, c] = await Promise.all([bindIsEffective(), bindIsEffective(), bindIsEffective()])
      const d = await bindIsEffective()

      expect(calls).toBe(1)
      expect([a, b, c, d].every((v) => v === a)).toBe(true)
    } finally {
      server.close()
    }
  })

  test('resetBindProbeCacheForTests() forces a fresh probe on the next call', async () => {
    const server = net.createServer((sock) => sock.end())
    const port = await listen(server)
    try {
      let calls = 0
      const countingDeps = {
        hostAddresses: () => {
          calls += 1
          return []
        },
        target: { host: '127.0.0.1', port },
        timeoutMs: 500,
      }
      resetBindProbeCacheForTests(countingDeps)
      await bindIsEffective()
      expect(calls).toBe(1)

      resetBindProbeCacheForTests(countingDeps)
      await bindIsEffective()
      expect(calls).toBe(2)
    } finally {
      server.close()
    }
  })
})
