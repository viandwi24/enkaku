import { describe, expect, test } from 'bun:test'
import net from 'node:net'
import { createFailoverController, type FailoverHost } from './failover'
import { createListener, type Negotiator, type UpstreamHolder } from './listener'
import type { BridgeSocket } from './socket'
import type { Upstream, UpstreamTarget } from './upstream'
import { PROXY_FAILOVER_EVENT, PROXY_PROBE_SKIP_REASON, type ProxyProbeResult, type ProxyRecord, type ProxyUpstream } from '../shared'
import type { LogSink } from './logbook'

/**
 * Plan 121 step 121.3 — failure counting + confirmation-probe-gated failover
 * (§4.2). Every acceptance criterion from §6 gets its own, unambiguous test:
 *
 * 1. An empty `fallbackUpstreams` is provably inert.
 * 2. A streak below `failureThreshold` never probes or switches.
 * 3. A streak AT threshold whose confirmation probe SUCCEEDS resets and does
 *    NOT switch — the false-positive-avoidance case the whole plan exists
 *    for, and the single most important test in this file.
 * 4. A streak AT threshold whose confirmation probe FAILS switches to the
 *    next fallback, resets, and leaves an already-open connection through
 *    the OLD upstream untouched — proved through a REAL listener and REAL
 *    sockets, the same fixtures `listener.test.ts` already established for
 *    step 121.2's own holder-swap mechanism.
 * 5. Exhausting every fallback (each one's own confirmation probe also
 *    fails) stays on the last one, never wraps back to primary.
 *
 * Step 121.5 (auto-failback, §4.4) adds its own `describe` block below,
 * covering:
 *
 * 6. Primary recovers, the recovery streak reaches the fixed anti-flap
 *    threshold, `autoFailback: true` → switches back to primary, both
 *    counters reset, `history` records it.
 * 7. Same setup with `autoFailback: false` → the streak still advances every
 *    call (so Studio can show recovery progress as information) but
 *    `activeIndex` never changes on its own; `resetToPrimary()` still works.
 * 8. A flaky primary (a success is always followed by a failure before a
 *    second consecutive success can occur) never reaches auto-failback, even
 *    though its TOTAL successes across the whole sequence exceed the
 *    threshold — proving the streak genuinely resets on any failure rather
 *    than "eventually getting there" by accumulation.
 * 9. An unconfigured probe endpoint during a background primary check
 *    (`PROXY_PROBE_SKIP_REASON`) leaves `primaryRecoveryStreak` untouched —
 *    neither a fabricated success nor an unearned reset.
 */

function noopLog(): LogSink {
  const calls: { level: string; message: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    calls.push({ level, message, fields })
  }
  return Object.assign({ debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') }, { calls }) as LogSink & {
    calls: { level: string; message: string; fields?: Record<string, unknown> }[]
  }
}

/** A minimal, valid `ProxyUpstream` — the fields do not matter to this file, only how many of them exist. */
function upstreamConfig(host: string): ProxyUpstream {
  return { proto: 'socks5', host, port: 1080, username: '', bindAddress: '', resolveThroughEgress: true }
}

/** A minimal, valid `ProxyRecord`, with `fallbackUpstreams`/`failover` overridable per test. */
function record(opts: { fallbackUpstreams?: ProxyUpstream[]; failureThreshold?: number } = {}): ProxyRecord {
  return {
    label: 'test',
    listen: { proto: 'socks5', bindHost: '127.0.0.1', port: null },
    upstream: upstreamConfig('primary'),
    fallbackUpstreams: opts.fallbackUpstreams ?? [],
    failover: { failureThreshold: opts.failureThreshold ?? 3, autoFailback: true },
    enabled: false,
    logDestinations: false,
    maxConnections: 256,
    drainMs: 10_000,
    capacity: 0,
    exclusive: false,
    listenerAuth: false,
    notes: '',
  }
}

/** A fake `Upstream` — `connect()` never actually dials anything, this file only cares whether it was BUILT and reassigned. */
function fakeUpstream(description: string): Upstream {
  return {
    description,
    connect: async () => {
      throw new Error('not dialled in this test')
    },
  }
}

describe('createFailoverController — plan 121 §4.2', () => {
  test('criterion 1: an empty fallbackUpstreams is provably inert — no counter, no probe, no switch, ever', async () => {
    const holder: UpstreamHolder = { current: fakeUpstream('primary') }
    let probeCalls = 0
    let buildCalls = 0
    const host: FailoverHost = {
      id: 'p1',
      getRecord: () => record({ fallbackUpstreams: [] }),
      holder,
      buildUpstream: async (u) => {
        buildCalls += 1
        return fakeUpstream(u.host)
      },
      probe: async () => {
        probeCalls += 1
        return { at: 0, ok: false }
      },
      log: noopLog(),
    }
    const controller = createFailoverController(host)

    // Far more than any threshold would ever require.
    for (let i = 0; i < 50; i++) await controller.onDialResult(false)

    expect(controller.state.consecutiveFailures).toBe(0)
    expect(controller.state.activeIndex).toBe(0)
    expect(controller.state.history).toEqual([])
    expect(probeCalls).toBe(0)
    expect(buildCalls).toBe(0)
    expect(holder.current).toBe(host.holder.current) // unchanged — same object identity as constructed
  })

  test('criterion 2: a streak below failureThreshold never probes or switches', async () => {
    const holder: UpstreamHolder = { current: fakeUpstream('primary') }
    let probeCalls = 0
    const host: FailoverHost = {
      id: 'p1',
      getRecord: () => record({ fallbackUpstreams: [upstreamConfig('backup-1')], failureThreshold: 3 }),
      holder,
      buildUpstream: async (u) => fakeUpstream(u.host),
      probe: async () => {
        probeCalls += 1
        return { at: 0, ok: false }
      },
      log: noopLog(),
    }
    const controller = createFailoverController(host)

    await controller.onDialResult(false)
    await controller.onDialResult(false)
    // Two failures, threshold is three: the streak has not yet been reached.

    expect(controller.state.consecutiveFailures).toBe(2)
    expect(controller.state.activeIndex).toBe(0)
    expect(probeCalls).toBe(0)
    expect(holder.current.description).toBe('primary')

    // A success resets the streak, per §4.2's own reset rule.
    await controller.onDialResult(true)
    expect(controller.state.consecutiveFailures).toBe(0)
  })

  test('criterion 3 (the load-bearing case): a streak AT threshold whose confirmation probe SUCCEEDS resets and does NOT switch', async () => {
    const holder: UpstreamHolder = { current: fakeUpstream('primary') }
    let probeCalls = 0
    let buildCalls = 0
    const originalUpstream = holder.current
    const host: FailoverHost = {
      id: 'p1',
      getRecord: () => record({ fallbackUpstreams: [upstreamConfig('backup-1')], failureThreshold: 3 }),
      holder,
      buildUpstream: async (u) => {
        buildCalls += 1
        return fakeUpstream(u.host)
      },
      // THE confirmation probe succeeds — the streak was target-site-specific,
      // not this upstream's fault.
      probe: async (): Promise<ProxyProbeResult> => {
        probeCalls += 1
        return { at: 0, ok: true, publicAddress: '203.0.113.1' }
      },
      log: noopLog(),
    }
    const controller = createFailoverController(host)

    await controller.onDialResult(false)
    await controller.onDialResult(false)
    await controller.onDialResult(false) // reaches the threshold of 3

    // THE assertion this whole plan exists to prove: no switch happened.
    expect(controller.state.activeIndex).toBe(0)
    expect(holder.current).toBe(originalUpstream)
    expect(buildUpstreamNeverCalledAssertion(buildCalls)).toBe(true)
    expect(controller.state.consecutiveFailures).toBe(0)
    expect(controller.state.history).toEqual([])
    expect(probeCalls).toBe(1)

    // A control: had the code switched anyway, `holder.current` would no
    // longer be `originalUpstream` and `history` would be non-empty — both
    // assertions above would have failed. Restated as its own assertion so a
    // regression that flips the switch condition is caught even if a future
    // edit reorders the assertions above.
    expect(controller.state.activeIndex === 0 && holder.current === originalUpstream).toBe(true)
  })

  test('criterion 4: a streak AT threshold whose confirmation probe FAILS switches to the next fallback, resets the counter, and an already-open OLD connection is unaffected', async () => {
    const a = await startBannerServer('from-A')
    const b = await startBannerServer('from-B')
    try {
      // A dialler to A's real server that can be told to fail on command —
      // the fake-Upstream-with-controllable-outcome pattern this task calls
      // for, driving REAL dials through a REAL listener so the "already-open
      // connection is unaffected" claim is proved on real sockets, not merely
      // asserted about object identity.
      let failDials = false
      const upstreamA: Upstream = {
        description: 'A',
        connect: async (_dest: UpstreamTarget): Promise<BridgeSocket> => {
          if (failDials) throw new Error('simulated dial failure')
          return net.connect(a.port, '127.0.0.1') as unknown as BridgeSocket
        },
      }
      const upstreamB: Upstream = {
        description: 'B',
        connect: async (_dest: UpstreamTarget): Promise<BridgeSocket> => net.connect(b.port, '127.0.0.1') as unknown as BridgeSocket,
      }

      const holder: UpstreamHolder = { current: upstreamA }
      let probeCalls = 0
      const host: FailoverHost = {
        id: 'p1',
        getRecord: () => record({ fallbackUpstreams: [upstreamConfig('backup-1')], failureThreshold: 2 }),
        holder,
        buildUpstream: async (u, slot) => {
          expect(u.host).toBe('backup-1')
          // Plan 121.4 — the slot this build is FOR reaches the host, so it can
          // look up backup-1's OWN stored credential rather than primary's.
          expect(slot).toBe(1)
          return upstreamB
        },
        probe: async (_upstream, slot): Promise<ProxyProbeResult> => {
          probeCalls += 1
          // The probe runs against whatever is CURRENTLY active — primary
          // (slot 0) at this point, since the switch has not happened yet.
          expect(slot).toBe(0)
          return { at: 0, ok: false, error: 'confirmed down' }
        },
        log: noopLog(),
      }
      const controller = createFailoverController(host)

      const negotiate: Negotiator = (client, api) => {
        api.open(
          { host: 'ignored', port: 0 },
          {
            onReady: () => {},
            onFailure: () => client.destroy(),
          },
        )
      }
      // The listener's OWN `onDialResult` wiring, exactly as `supervisor.ts`
      // wires it — this is what makes the test prove the real seam, not a
      // hand call into the controller.
      const listener = await createListener(
        { bindHost: '127.0.0.1', port: 0, upstream: holder, maxConnections: 16, log: () => {}, onDialResult: (ok) => void controller.onDialResult(ok) },
        negotiate,
      )
      try {
        // First connection: dials A successfully, and STAYS OPEN — this is the
        // "already-open connection" the switch must not disturb.
        const first = net.connect(listener.port, '127.0.0.1')
        expect(await readOnce(first)).toBe('from-A')

        // Now every further dial to A fails, and `failureThreshold` is 2.
        failDials = true
        const second = net.connect(listener.port, '127.0.0.1')
        await new Promise<void>((resolve) => second.on('close', () => resolve())) // refused, closes
        const third = net.connect(listener.port, '127.0.0.1')
        await new Promise<void>((resolve) => third.on('close', () => resolve())) // the 2nd failure — reaches threshold

        // Give the async probe-and-switch sequence a tick to finish.
        await new Promise((resolve) => setImmediate(resolve))

        expect(probeCalls).toBe(1)
        expect(controller.state.activeIndex).toBe(1)
        expect(controller.state.consecutiveFailures).toBe(0)
        expect(holder.current).toBe(upstreamB)

        // The NEXT connection dials through the NEW upstream, B.
        const fourth = net.connect(listener.port, '127.0.0.1')
        expect(await readOnce(fourth)).toBe('from-B')

        // The FIRST connection — opened before any of this happened — is
        // still a live pipe to A, completely undisturbed by the switch.
        const echoPromise = readOnce(first)
        first.write('still-a')
        expect(await echoPromise).toBe('still-a')

        first.destroy()
        fourth.destroy()
      } finally {
        listener.close()
        listener.destroyLive()
      }
    } finally {
      await a.close()
      await b.close()
    }
  })

  test('criterion 5: exhausting every fallback stays on the last one and never wraps back to primary', async () => {
    const primary = fakeUpstream('primary')
    const backup1 = fakeUpstream('backup-1')
    const backup2 = fakeUpstream('backup-2')
    const holder: UpstreamHolder = { current: primary }
    const built: Upstream[] = []
    const logSink = noopLog() as LogSink & { calls: { level: string; message: string; fields?: Record<string, unknown> }[] }
    const probedSlots: number[] = []
    const host: FailoverHost = {
      id: 'p1',
      getRecord: () => record({ fallbackUpstreams: [upstreamConfig('backup-1'), upstreamConfig('backup-2')], failureThreshold: 1 }),
      holder,
      buildUpstream: async (u, slot) => {
        // Plan 121.4 — the slot handed to `buildUpstream` always matches the
        // upstream it is building, by the same `activeIndex` addressing.
        expect(slot).toBe(u.host === 'backup-1' ? 1 : 2)
        const built1 = u.host === 'backup-1' ? backup1 : backup2
        built.push(built1)
        return built1
      },
      // Every confirmation probe fails — including backup-2's own, once active.
      probe: async (_upstream, slot): Promise<ProxyProbeResult> => {
        probedSlots.push(slot)
        return { at: 0, ok: false, error: 'always down in this test' }
      },
      log: logSink,
    }
    const controller = createFailoverController(host)

    // failureThreshold is 1, so every single failure is its own streak.
    await controller.onDialResult(false) // primary's streak -> probe fails -> switch to backup-1
    expect(controller.state.activeIndex).toBe(1)
    expect(holder.current).toBe(backup1)

    await controller.onDialResult(false) // backup-1's streak -> probe fails -> switch to backup-2
    expect(controller.state.activeIndex).toBe(2)
    expect(holder.current).toBe(backup2)

    await controller.onDialResult(false) // backup-2's streak -> probe fails -> nothing further configured
    expect(controller.state.activeIndex).toBe(2) // stayed — did NOT wrap back to 0
    expect(holder.current).toBe(backup2) // unchanged

    // A few more failures must keep staying, not wrap, not throw.
    await controller.onDialResult(false)
    await controller.onDialResult(false)
    expect(controller.state.activeIndex).toBe(2)
    expect(holder.current).toBe(backup2)

    // Every probe ran against whatever was ACTIVE at the time — 0, then 1,
    // then 2 three times over (the two extra failures above) — never a slot
    // that was never active (plan 121.4).
    expect(probedSlots).toEqual([0, 1, 2, 2, 2])

    expect(controller.state.history.length).toBeGreaterThanOrEqual(3)
    // Every switch, and the final "nothing left" state, logged at warn.
    expect(logSink.calls.every((c) => c.level === 'warn')).toBe(true)
    expect(logSink.calls.some((c) => c.message.includes('no working upstream left'))).toBe(true)

    // Step 121.6 — every one of those lines carries the structured event
    // shape a live UI (or anything else reading this plugin's log) can act
    // on, not only prose: the `PROXY_FAILOVER_EVENT` marker, this record's
    // own id twice over (as `recordId` and folded into `subject`), and the
    // exact `from`/`to`/`reason`/`at` `pushHistory` recorded for that same
    // transition — proving the log line and `state.history` cannot disagree.
    expect(logSink.calls).toHaveLength(controller.state.history.length)
    controller.state.history
      .slice()
      .reverse() // history is most-recent-first; calls were emitted oldest-first
      .forEach((histEntry, i) => {
        const call = logSink.calls[i]
        expect(call?.fields).toEqual({
          subject: 'proxy:p1',
          event: PROXY_FAILOVER_EVENT,
          recordId: 'p1',
          from: histEntry.from,
          to: histEntry.to,
          reason: histEntry.reason,
          at: histEntry.at,
        })
      })
  })
})

/** A trivially-true helper so the "no switch" assertion in criterion 3 reads as its own named claim rather than a bare boolean. */
function buildUpstreamNeverCalledAssertion(buildCalls: number): boolean {
  return buildCalls === 0
}

describe('checkPrimaryRecovery / resetToPrimary — auto-failback, plan 121 §4.4, step 121.5', () => {
  /**
   * Every test in this block starts a record already ON a backup — forced
   * there the same way criterion 4/5 above do, through a real
   * threshold-triggered switch (`failureThreshold: 1`, a confirmation probe
   * that always fails) — rather than reaching into `state` directly, which
   * the `FailoverController` interface does not expose a way to do.
   *
   * `buildUpstream`/`probe` are shared by BOTH the forward-failover
   * confirmation path and the new background primary-recovery path, exactly
   * as `supervisor.ts`'s own wiring shares one pair of closures for both
   * (§4.4's own instruction: reuse the skip discipline, don't reinvent it).
   * The two are told apart the same way `supervisor.ts` cannot: this file's
   * `buildUpstream` returns a freshly identifiable object for slot 0
   * (`rebuiltPrimary`) that only `checkPrimaryRecovery` ever asks to have
   * built — the forced initial switch's own confirmation probe runs directly
   * against `holder.current` (the ORIGINAL primary object) and never calls
   * `buildUpstream` for slot 0 at all.
   */
  function backupHost(opts: {
    onPrimaryProbe: (rebuiltPrimary: Upstream) => Promise<ProxyProbeResult> | ProxyProbeResult
    autoFailback?: boolean
  }): {
    host: FailoverHost
    holder: UpstreamHolder
    primaryUpstream: Upstream
    rebuiltPrimary: Upstream
    backup1: Upstream
    logSink: LogSink & { calls: { level: string; message: string; fields?: Record<string, unknown> }[] }
  } {
    const primaryUpstream = fakeUpstream('primary')
    const rebuiltPrimary = fakeUpstream('primary-rebuilt')
    const backup1 = fakeUpstream('backup-1')
    const holder: UpstreamHolder = { current: primaryUpstream }
    const logSink = noopLog() as LogSink & { calls: { level: string; message: string; fields?: Record<string, unknown> }[] }
    const host: FailoverHost = {
      id: 'p1',
      getRecord: () => {
        const base = record({ fallbackUpstreams: [upstreamConfig('backup-1')], failureThreshold: 1 })
        return { ...base, failover: { ...base.failover, autoFailback: opts.autoFailback ?? true } }
      },
      holder,
      buildUpstream: async (u, slot) => {
        if (slot === 0) return rebuiltPrimary
        expect(u.host).toBe('backup-1')
        return backup1
      },
      probe: async (upstream, slot) => {
        if (upstream === rebuiltPrimary && slot === 0) return opts.onPrimaryProbe(rebuiltPrimary)
        // The forced initial confirmation probe, against whatever is
        // currently active (primary, slot 0, at that point) — always fails,
        // so every test in this block starts already switched to backup-1.
        return { at: 0, ok: false, error: 'primary confirmed down' }
      },
      log: logSink,
    }
    return { host, holder, primaryUpstream, rebuiltPrimary, backup1, logSink }
  }

  test('6: primary recovers, the streak reaches the anti-flap threshold, autoFailback true — switches back, both counters reset, history records it', async () => {
    const { host, holder, rebuiltPrimary, backup1, logSink } = backupHost({
      onPrimaryProbe: () => ({ at: 0, ok: true, publicAddress: '203.0.113.9' }),
    })
    const controller = createFailoverController(host)

    await controller.onDialResult(false) // forces the initial switch to backup-1
    expect(controller.state.activeIndex).toBe(1)
    expect(holder.current).toBe(backup1)

    await controller.checkPrimaryRecovery()
    expect(controller.state.primaryRecoveryStreak).toBe(1)
    expect(controller.state.activeIndex).toBe(1) // one success — not yet at threshold (2)

    await controller.checkPrimaryRecovery() // reaches RECOVERY_STREAK_THRESHOLD
    expect(controller.state.activeIndex).toBe(0)
    expect(controller.state.primaryRecoveryStreak).toBe(0)
    expect(controller.state.consecutiveFailures).toBe(0)
    expect(holder.current).toBe(rebuiltPrimary)
    expect(controller.state.history[0]).toMatchObject({ from: 1, to: 0 })

    // Step 121.6 — the failback logs at INFO (distinct from a forward
    // failover's WARN), carrying the same structured event shape.
    const failbackCall = logSink.calls.at(-1)
    expect(failbackCall?.level).toBe('info')
    expect(failbackCall?.fields).toEqual({
      subject: 'proxy:p1',
      event: PROXY_FAILOVER_EVENT,
      recordId: 'p1',
      from: 1,
      to: 0,
      reason: expect.any(String),
      at: expect.any(Number),
    })
  })

  test('7: autoFailback false — the recovery streak still advances every check, but activeIndex never changes on its own; resetToPrimary() still works', async () => {
    const { host, holder, backup1, rebuiltPrimary } = backupHost({
      onPrimaryProbe: () => ({ at: 0, ok: true, publicAddress: '203.0.113.9' }),
      autoFailback: false,
    })
    const controller = createFailoverController(host)

    await controller.onDialResult(false)
    expect(controller.state.activeIndex).toBe(1)

    for (let i = 0; i < 5; i++) await controller.checkPrimaryRecovery()
    // Well past the threshold — the streak is tracked as information (Studio's
    // future "primary looks healthy again"), but never triggers a switch.
    expect(controller.state.primaryRecoveryStreak).toBeGreaterThanOrEqual(2)
    expect(controller.state.activeIndex).toBe(1)
    expect(holder.current).toBe(backup1)

    // Only the manual seam moves it, in this mode.
    await controller.resetToPrimary()
    expect(controller.state.activeIndex).toBe(0)
    expect(controller.state.primaryRecoveryStreak).toBe(0)
    expect(controller.state.consecutiveFailures).toBe(0)
    expect(holder.current).toBe(rebuiltPrimary)
    expect(controller.state.history[0]).toMatchObject({ from: 1, to: 0, reason: expect.stringContaining('manual') })
  })

  test('8: a flaky primary never reaches auto-failback despite total successes exceeding the threshold, because the streak resets on every failure', async () => {
    // Never two SUCCESSES in a row — a failure always lands between them —
    // so the fixed threshold of 2 is never reached, even though FOUR total
    // successes occur across the sequence (well over the threshold, summed).
    const pattern: boolean[] = [true, false, true, false, true, false, true]
    let i = 0
    const { host, holder, backup1 } = backupHost({
      onPrimaryProbe: () => {
        const ok = pattern[i]
        i += 1
        return ok ? { at: 0, ok: true, publicAddress: '203.0.113.9' } : { at: 0, ok: false, error: 'still down' }
      },
    })
    const controller = createFailoverController(host)

    await controller.onDialResult(false)
    expect(controller.state.activeIndex).toBe(1)

    for (let n = 0; n < pattern.length; n++) {
      await controller.checkPrimaryRecovery()
      expect(controller.state.activeIndex).toBe(1) // never switches, at any point in the sequence
    }
    expect(i).toBe(pattern.length) // every probe in the pattern actually ran
    expect(holder.current).toBe(backup1) // still on the backup

    // Control: the mechanism itself is not broken — a genuine unbroken run of
    // 2 successes right after DOES trigger the switch.
    let controlCalls = 0
    const control = backupHost({
      onPrimaryProbe: () => {
        controlCalls += 1
        return { at: 0, ok: true, publicAddress: '203.0.113.9' }
      },
    })
    const controlController = createFailoverController(control.host)
    await controlController.onDialResult(false)
    await controlController.checkPrimaryRecovery()
    await controlController.checkPrimaryRecovery()
    expect(controlController.state.activeIndex).toBe(0)
    expect(controlCalls).toBe(2)
  })

  test('9: an unconfigured probe endpoint during a background primary check does not corrupt primaryRecoveryStreak in either direction', async () => {
    let mode: 'skip' | 'ok' = 'skip'
    const { host } = backupHost({
      onPrimaryProbe: () => (mode === 'skip' ? { at: 0, ok: false, error: PROXY_PROBE_SKIP_REASON } : { at: 0, ok: true, publicAddress: '203.0.113.9' }),
    })
    const controller = createFailoverController(host)

    await controller.onDialResult(false)
    expect(controller.state.activeIndex).toBe(1)

    // Repeated unconfigured checks: not a success (never advances toward the
    // threshold) and not a failure either (never silently "punished").
    for (let n = 0; n < 5; n++) await controller.checkPrimaryRecovery()
    expect(controller.state.primaryRecoveryStreak).toBe(0)
    expect(controller.state.activeIndex).toBe(1)

    // Control: once the endpoint IS configured (a real success), the streak
    // advances normally from zero — proving the skip case left no stuck or
    // poisoned state behind.
    mode = 'ok'
    await controller.checkPrimaryRecovery()
    expect(controller.state.primaryRecoveryStreak).toBe(1)
  })
})

// --- fixtures shared by the criterion-4 real-listener test, matching
// `listener.test.ts`'s own pattern exactly (plan 121.2's precedent) ---

function startBannerServer(banner: string): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.write(banner)
    sock.on('data', (chunk: Buffer) => sock.write(chunk))
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy()
            server.close(() => res())
          }),
      })
    })
  })
}

function readOnce(sock: net.Socket): Promise<string> {
  return new Promise<string>((resolve) => {
    sock.once('data', (chunk: Buffer) => resolve(chunk.toString()))
  })
}
