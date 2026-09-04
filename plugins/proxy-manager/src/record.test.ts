import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BIND_HOST,
  DEFAULT_DRAIN_MS,
  DEFAULT_MAX_CONNECTIONS,
  PROXY_KEY_PREFIX,
  PROXY_PROBLEM_CODES,
  PROXY_SECRET_KEY_PREFIX,
  isStartableRecord,
  isStorableRecord,
  proxyIdFromKey,
  proxyKeyFor,
  proxySecretKeyFor,
  proxySecretSlotKeyFor,
  readProxyRecord,
  routeForRecord,
  validateProxyRecord,
  vpnAgentProblem,
  writeProxyRecord,
  type ProxyRecord,
} from './shared'

/**
 * Plan 112 step 112.3 — the record: the v2 schema, the two-key split, the four
 * coded refusals, and the read-time migration of the shape that is already on
 * operators' disks.
 */

function record(over: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    label: 'Office UK',
    listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 },
    upstream: { proto: 'socks5', host: '10.4.0.9', port: 1080, username: 'country-id-r9931204', bindAddress: '', resolveThroughEgress: true },
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

describe('the v2 record', () => {
  test('round-trips through write → read, and parses as a ProxyRecord', () => {
    const typed = record({ enabled: true, logDestinations: true, notes: 'expires in March' })
    const stored = writeProxyRecord(typed)
    expect(readProxyRecord(stored)).toEqual(typed)
  })

  test('a stored row this pack never wrote renders as blanks instead of throwing inside a table', () => {
    const fallback = readProxyRecord({ nonsense: true })
    expect(fallback.upstream.proto).toBe('socks5')
    expect(fallback.upstream.host).toBe('')
    expect(fallback.listen.bindHost).toBe(DEFAULT_BIND_HOST)
    expect(readProxyRecord(null).label).toBe('')
  })

  test('out-of-range numbers fall back to the defaults rather than being stored', () => {
    const read = readProxyRecord({ listen: { port: 70_000 }, upstream: { port: -1 }, maxConnections: 999_999, drainMs: -5 })
    expect(read.listen.port).toBeNull()
    expect(read.upstream.port).toBe(0)
    expect(read.maxConnections).toBe(DEFAULT_MAX_CONNECTIONS)
    expect(read.drainMs).toBe(DEFAULT_DRAIN_MS)
  })
})

describe('the read-time migration of the shipped shape (§4.3)', () => {
  const shipped = { label: 'Office UK', kind: 'socks5', host: '10.4.0.9', port: 1080, notes: 'expires in March' }

  test('every shipped field survives, and `kind` becomes the UPSTREAM protocol', () => {
    const migrated = readProxyRecord(shipped)
    expect(migrated.label).toBe('Office UK')
    expect(migrated.notes).toBe('expires in March')
    expect(migrated.upstream).toEqual({ proto: 'socks5', host: '10.4.0.9', port: 1080, username: '', bindAddress: '', resolveThroughEgress: true })
  })

  test('property 2 — `enabled` is false, always: a migration never starts a listener nobody asked for', () => {
    // Even if the old row somehow carried the word.
    expect(readProxyRecord(shipped).enabled).toBe(false)
    expect(readProxyRecord({ ...shipped, enabled: true }).enabled).toBe(false)
  })

  test('property 3 — the local port is genuinely absent, and the row says so rather than guessing', () => {
    const migrated = readProxyRecord(shipped)
    expect(migrated.listen.port).toBeNull()
    // Specifically NOT the upstream's port, which is the guess a careless
    // migration would make and which would open 1080 on the operator's machine.
    expect(migrated.listen.port).not.toBe(1080)
    const problems = validateProxyRecord(migrated)
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_PORT_UNASSIGNED'])
    // A precondition, not an error: the row is storable and simply cannot start.
    expect(isStorableRecord(problems)).toBe(true)
    expect(isStartableRecord(problems)).toBe(false)
  })

  test('an `https` row migrates, is listed, and refuses to start — never dropped, never rewritten', () => {
    const migrated = readProxyRecord({ ...shipped, kind: 'https' })
    expect(migrated.upstream.proto).toBe('https')
    const codes = validateProxyRecord(migrated).map((p) => p.code)
    expect(codes).toContain('E_PROXY_UPSTREAM_UNSUPPORTED')
    expect(isStartableRecord(validateProxyRecord(migrated))).toBe(false)
  })

  test('the migration fires on the OLD shape only — a v2 row is read as itself', () => {
    // The discriminator is the presence of `listen`/`upstream`, so a v2 row with
    // `enabled: true` keeps it. Getting this backwards would silently disable
    // every running proxy on the next read.
    const v2 = writeProxyRecord(record({ enabled: true }))
    expect(readProxyRecord(v2).enabled).toBe(true)
    expect(readProxyRecord(v2).listen.port).toBe(9902)
  })
})

describe('plan 121 — fallbackUpstreams and failover (§4.1)', () => {
  /**
   * A value shaped exactly like what `writeProxyRecord` actually wrote to KV
   * before this plan existed: a full v2 record — every plan 112 and plan 117
   * field present — with `fallbackUpstreams` and `failover` genuinely absent,
   * not merely `undefined`. The same discipline the plan 117 fields' own
   * acceptance criterion 1 used for THIS catalogue, one plan earlier.
   */
  function captured(): Record<string, unknown> {
    const stored = writeProxyRecord(record())
    const { fallbackUpstreams, failover, ...pre121 } = stored
    return pre121
  }

  test('a record captured before this plan has neither key, and both default on read', () => {
    const pre121 = captured()
    expect(pre121).not.toHaveProperty('fallbackUpstreams')
    expect(pre121).not.toHaveProperty('failover')
    const migrated = readProxyRecord(pre121)
    expect(migrated.fallbackUpstreams).toEqual([])
    expect(migrated.failover).toEqual({ failureThreshold: 3, autoFailback: true })
    // Everything else survives untouched, exactly like a fresh record — the
    // record behaves byte-for-byte as it did before this plan (§6 criterion 1).
    expect(migrated).toEqual(record())
  })

  test('a configured backup list and non-default failover settings round-trip exactly', () => {
    const typed = record({
      fallbackUpstreams: [
        { proto: 'direct', host: '', port: 0, username: '', bindAddress: '192.168.100.12', resolveThroughEgress: true },
        { proto: 'socks5', host: 'soax.example', port: 1080, username: 'soax-user', bindAddress: '', resolveThroughEgress: true },
      ],
      failover: { failureThreshold: 5, autoFailback: false },
    })
    const stored = writeProxyRecord(typed)
    expect(readProxyRecord(stored)).toEqual(typed)
  })

  test('a junk fallbackUpstreams reads as no backups, rather than throwing', () => {
    for (const junk of [null, 'nonsense', 42, { not: 'an array' }]) {
      expect(readProxyRecord({ ...captured(), fallbackUpstreams: junk }).fallbackUpstreams).toEqual([])
    }
  })

  test('a junk failover reads as the plain defaults, rather than throwing', () => {
    const migrated = readProxyRecord({ ...captured(), failover: { failureThreshold: -3, autoFailback: 'yes' } })
    expect(migrated.failover).toEqual({ failureThreshold: 3, autoFailback: true })
  })
})

describe('validateProxyRecord — the coded refusals (§4.2)', () => {
  test('an https LISTEN protocol is refused by name, and the message says what to do instead', () => {
    const problems = validateProxyRecord(record({ listen: { proto: 'https', bindHost: '127.0.0.1', port: 9902 } }))
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_LISTEN_UNSUPPORTED'])
    expect(problems[0]?.kind).toBe('refusal')
    expect(problems[0]?.message).toMatch(/certificate/)
    expect(problems[0]?.message).toMatch(/HTTP or SOCKS5/)
  })

  test('an https UPSTREAM protocol is refused by name', () => {
    const problems = validateProxyRecord(record({ upstream: { proto: 'https', host: 'h', port: 1, username: '', bindAddress: '', resolveThroughEgress: true } }))
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_UPSTREAM_UNSUPPORTED'])
  })

  test('a non-loopback bind with no listener credential is refused, and the message names the two legitimate paths (plan 117 §3.5, retires E_PROXY_BIND_NOT_LOOPBACK)', () => {
    // `E_PROXY_BIND_NOT_LOOPBACK` was retired at step 117.7: the rule is no
    // longer unconditional, it is conditional on whether a listener
    // credential exists — `record.listenerAuth` defaults to `false` here, so
    // this is the "no intent to authenticate at all" branch.
    const problems = validateProxyRecord(record({ listen: { proto: 'http', bindHost: '0.0.0.0', port: 9902 } }))
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_LISTENER_AUTH_REQUIRED'])
    expect(problems[0]?.message).toMatch(/open relay/)
    expect(problems[0]?.message).toMatch(/SSH or WireGuard/)
  })

  test('both loopback addresses are accepted, and nothing that merely looks like one is', () => {
    for (const host of ['127.0.0.1', '::1']) {
      expect(validateProxyRecord(record({ listen: { proto: 'http', bindHost: host, port: 9902 } }))).toEqual([])
    }
    // The near-misses that a substring check would let through, which is why
    // the check is an exact membership test and not `startsWith('127.')`.
    for (const host of ['127.0.0.1.evil.example', '0.0.0.0', '::', 'localhost', '127.0.0.2']) {
      expect(validateProxyRecord(record({ listen: { proto: 'http', bindHost: host, port: 9902 } })).map((p) => p.code)).toEqual([
        'E_PROXY_LISTENER_AUTH_REQUIRED',
      ])
    }
  })

  describe('the bind gate is conditional on its own premise (plan 117 §3.5, criterion 5)', () => {
    /**
     * The invariant criterion 5 asks for, asserted as an invariant rather than
     * as one example: **a listener can never be bound off-host without
     * authentication, over any combination of record fields.** Enumerated
     * over every combination `validateProxyRecord` actually branches on —
     * whether the bind is loopback, whether the record intends to
     * authenticate (`listenerAuth`), and whether a credential row was
     * actually found (`context.hasListenerAuth`, three-valued).
     */
    const HAS_LISTENER_AUTH_VALUES = [true, false, undefined] as const

    for (const bindHost of ['127.0.0.1', '::1']) {
      test(`loopback (${bindHost}) never raises E_PROXY_LISTENER_AUTH_REQUIRED, whatever listenerAuth/hasListenerAuth are`, () => {
        // `_REQUIRED` is the code that is actually gated on the bind host —
        // it is what makes an unauthenticated off-host bind impossible.
        // `_MISSING` is a different fact ("the intent is on, but the
        // credential row is not there yet") and fires independently of the
        // bind host — asserted on its own two tests below, so a loopback
        // record that turns `listenerAuth` on without saving a credential is
        // still told about it rather than silently accepted.
        for (const listenerAuth of [true, false]) {
          for (const hasListenerAuth of HAS_LISTENER_AUTH_VALUES) {
            const problems = validateProxyRecord(record({ listen: { proto: 'http', bindHost, port: 9902 }, listenerAuth }), { hasListenerAuth })
            expect(problems.map((p) => p.code)).not.toContain('E_PROXY_LISTENER_AUTH_REQUIRED')
          }
        }
      })

      test(`loopback (${bindHost}) can still raise E_PROXY_LISTENER_AUTH_MISSING — that fact does not depend on where the bridge binds`, () => {
        const missing = validateProxyRecord(record({ listen: { proto: 'http', bindHost, port: 9902 }, listenerAuth: true }), { hasListenerAuth: false })
        expect(missing.map((p) => p.code)).toEqual(['E_PROXY_LISTENER_AUTH_MISSING'])
        // The control: with a credential found (or nobody having looked),
        // the same loopback record raises nothing at all.
        for (const hasListenerAuth of [true, undefined] as const) {
          expect(validateProxyRecord(record({ listen: { proto: 'http', bindHost, port: 9902 }, listenerAuth: true }), { hasListenerAuth })).toEqual([])
        }
      })
    }

    test('non-loopback + listenerAuth false is ALWAYS E_PROXY_LISTENER_AUTH_REQUIRED, regardless of hasListenerAuth', () => {
      for (const hasListenerAuth of HAS_LISTENER_AUTH_VALUES) {
        const problems = validateProxyRecord(record({ listen: { proto: 'http', bindHost: '10.0.0.5', port: 9902 }, listenerAuth: false }), {
          hasListenerAuth,
        })
        expect(problems.map((p) => p.code)).toContain('E_PROXY_LISTENER_AUTH_REQUIRED')
        expect(problems.map((p) => p.code)).not.toContain('E_PROXY_LISTENER_AUTH_MISSING')
      }
    })

    test('non-loopback + listenerAuth true + hasListenerAuth false is E_PROXY_LISTENER_AUTH_MISSING, never E_PROXY_LISTENER_AUTH_REQUIRED', () => {
      const problems = validateProxyRecord(record({ listen: { proto: 'http', bindHost: '10.0.0.5', port: 9902 }, listenerAuth: true }), {
        hasListenerAuth: false,
      })
      expect(problems.map((p) => p.code)).toEqual(['E_PROXY_LISTENER_AUTH_MISSING'])
    })

    test('non-loopback + listenerAuth true + hasListenerAuth true or undefined raises no auth problem at all', () => {
      for (const hasListenerAuth of [true, undefined] as const) {
        const problems = validateProxyRecord(record({ listen: { proto: 'http', bindHost: '10.0.0.5', port: 9902 }, listenerAuth: true }), {
          hasListenerAuth,
        })
        expect(problems).toEqual([])
      }
    })
  })

  test('a duplicate port is refused, but only against another ENABLED record', () => {
    const mine = record({ listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 } })
    const other = record({ label: 'The other one', listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 }, enabled: true })

    const clash = validateProxyRecord(mine, { id: 'a', catalogue: [{ id: 'b', record: other }] })
    expect(clash.map((p) => p.code)).toEqual(['E_PROXY_PORT_CONFLICT'])
    expect(clash[0]?.message).toContain('The other one')

    // Disabled ⇒ nothing is bound ⇒ nothing to clash with.
    const disabled = validateProxyRecord(mine, { id: 'a', catalogue: [{ id: 'b', record: { ...other, enabled: false } }] })
    expect(disabled).toEqual([])

    // And a record never clashes with itself, which is what an edit does.
    expect(validateProxyRecord(mine, { id: 'a', catalogue: [{ id: 'a', record: { ...mine, enabled: true } }] })).toEqual([])
  })

  test('every problem it can report is in the exported closed list', () => {
    /**
     * **Three producers, one list — plus a fourth this test cannot reach.**
     * Plan 114 step 114.9 added the two `routeForRecord` codes; 0.6.0's VPN
     * mode added three more plus `vpnAgentProblem`'s two; plan 117 §4.2 added
     * eight more across `validateProxyRecord` and `vpnRouteForRecord`/
     * `directVpnRouteForRecord`. `validateProxyRecord` answers *may this
     * record be stored, and may it be started*; `routeForRecord` answers *may
     * it be applied to a device, in this mode*; `vpnAgentProblem` answers *may
     * this DEVICE take a VPN route at all*. The list is deliberately one
     * list — a screen showing "why can I not press this" does not care which
     * function decided — so the reachability check below has to call all
     * three, or it fails for a code that is perfectly reachable from another
     * one.
     *
     * `E_PROXY_CAPACITY_FULL` is the one code in the list none of the three
     * can ever produce: its producer is `service/apply.ts`'s capacity guard,
     * which needs an `ApplyHost` (a device list and per-device storage) these
     * three pure functions do not take. It is excluded from the completeness
     * check BY NAME, with its own reachability proved separately in
     * `service/apply.test.ts` — never silently dropped from the list, and
     * never faked into `seen` here.
     *
     * `E_PROXY_PORT_MISMATCH` (plan 118 step 118.2) is the same shape of
     * exclusion for the same reason: its producer is `applyAssignment`'s
     * HTTP-mode port guard, which needs `ApplyHost.bridgePort` — the
     * supervisor's own live listener port — that none of these three pure
     * functions ever sees either. Reachability proved in `service/apply.test.ts`.
     */
    const CAPACITY_CODE = 'E_PROXY_CAPACITY_FULL'
    const PORT_MISMATCH_CODE = 'E_PROXY_PORT_MISMATCH'
    const routeProblems = [
      routeForRecord(record({ listen: { proto: 'socks5', bindHost: DEFAULT_BIND_HOST, port: 9902 }, enabled: true })),
      routeForRecord(record({ enabled: false })),
      // VPN mode's own three, each about the UPSTREAM rather than the bridge.
      routeForRecord(record({ upstream: { proto: 'http', host: 'h', port: 8080, username: '', bindAddress: '', resolveThroughEgress: true } }), { mode: 'vpn' }),
      routeForRecord(record({ upstream: { proto: 'socks5', host: '', port: 0, username: '', bindAddress: '', resolveThroughEgress: true } }), { mode: 'vpn' }),
      routeForRecord(record(), { mode: 'vpn', hasPassword: false }),
      // The `direct` record's own VPN route (§3.6) and its three refusals
      // (117.8a): a wildcard bind, a loopback bind, and a non-SOCKS5 listener.
      routeForRecord(
        record({ upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress: '192.168.100.11', resolveThroughEgress: true }, listen: { proto: 'socks5', bindHost: '0.0.0.0', port: 9902 } }),
        { mode: 'vpn' },
      ),
      routeForRecord(
        record({ upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress: '192.168.100.11', resolveThroughEgress: true }, listen: { proto: 'socks5', bindHost: '127.0.0.1', port: 9902 } }),
        { mode: 'vpn' },
      ),
      routeForRecord(
        record({ upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress: '192.168.100.11', resolveThroughEgress: true }, listen: { proto: 'http', bindHost: '192.168.100.11', port: 9902 } }),
        { mode: 'vpn' },
      ),
    ].flatMap((r) => ('problem' in r ? [r.problem] : []))
    const agentProblems = [vpnAgentProblem('absent'), vpnAgentProblem('unsupported')].flatMap((p) => (p ? [p] : []))
    const seen = [
      ...validateProxyRecord(record({ listen: { proto: 'https', bindHost: 'nope', port: null } })),
      ...validateProxyRecord(record({ upstream: { proto: 'https', host: 'h', port: 1, username: '', bindAddress: '', resolveThroughEgress: true } })),
      ...validateProxyRecord(record(), { id: 'a', catalogue: [{ id: 'b', record: record({ enabled: true }) }] }),
      // Plan 117's two `bindAddress` codes, and `E_PROXY_LISTENER_AUTH_MISSING`
      // (the precondition sibling of `_REQUIRED`, which is already reachable
      // above through the `nope` bind host).
      ...validateProxyRecord(record({ upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress: 'not-an-ip', resolveThroughEgress: true } })),
      ...validateProxyRecord(record({ upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress: '192.168.100.11', resolveThroughEgress: true } }), { hostAddresses: [] }),
      ...validateProxyRecord(record({ listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 }, listenerAuth: true }), { hasListenerAuth: false }),
      // Plan 123 §4.3, step 123.3.
      ...validateProxyRecord(record({ upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress: '192.168.100.11', resolveThroughEgress: true } }), {
        hostAddresses: ['192.168.100.11'],
        bindWorkaroundUnavailable: true,
      }),
      ...routeProblems,
      ...agentProblems,
    ].map((p) => p.code)
    for (const code of seen) expect(PROXY_PROBLEM_CODES.map(String)).toContain(code)
    // And the list is not merely a superset nobody maintains: everything in it
    // except the named exclusions above is reachable from these calls.
    const reachableHere = PROXY_PROBLEM_CODES.filter((c) => c !== CAPACITY_CODE && c !== PORT_MISMATCH_CODE)
    expect([...new Set(seen)].sort()).toEqual([...reachableHere].sort())
  })

  test('it reports EVERY problem, not just the first — a form that reveals one error at a time is four submits', () => {
    const problems = validateProxyRecord(record({ listen: { proto: 'https', bindHost: '10.0.0.5', port: null } }))
    expect(problems.map((p) => p.code).sort()).toEqual(['E_PROXY_LISTENER_AUTH_REQUIRED', 'E_PROXY_LISTEN_UNSUPPORTED', 'E_PROXY_PORT_UNASSIGNED'])
  })
})

describe('the `bindAddress` checks (plan 117 §4.2, both codes)', () => {
  function direct(bindAddress: string, resolveThroughEgress = true): ProxyRecord {
    return record({
      listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 },
      upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress, resolveThroughEgress },
    })
  }

  test('empty means "the host default route" — nothing to validate about it', () => {
    expect(validateProxyRecord(direct(''))).toEqual([])
  })

  test('E_PROXY_BIND_ADDRESS_INVALID — not an IPv4/IPv6 literal, a REFUSAL (never storable)', () => {
    for (const bad of ['not-an-ip', '192.168.1', '192.168.1.256', 'localhost', '10.0.0.1/24']) {
      const problems = validateProxyRecord(direct(bad))
      expect(problems.map((p) => p.code)).toEqual(['E_PROXY_BIND_ADDRESS_INVALID'])
      expect(problems[0]?.kind).toBe('refusal')
      expect(isStorableRecord(problems)).toBe(false)
    }
  })

  test('E_PROXY_BIND_ADDRESS_UNAVAILABLE — a valid literal this host does not hold, a PRECONDITION (storable, not startable)', () => {
    const problems = validateProxyRecord(direct('192.168.100.11'), { hostAddresses: ['127.0.0.1', '10.0.0.5'] })
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_BIND_ADDRESS_UNAVAILABLE'])
    expect(problems[0]?.kind).toBe('precondition')
    expect(problems[0]?.message).toContain('192.168.100.11')
    expect(isStorableRecord(problems)).toBe(true)
    expect(isStartableRecord(problems)).toBe(false)
  })

  test('a literal the host DOES hold raises neither code', () => {
    expect(validateProxyRecord(direct('192.168.100.11'), { hostAddresses: ['127.0.0.1', '192.168.100.11'] })).toEqual([])
  })

  test('`hostAddresses: undefined` ("nobody looked") never becomes a refusal it cannot justify', () => {
    // The browser half cannot call `os.networkInterfaces()` — this is its
    // honest answer, and it must not be read as "this host holds nothing".
    expect(validateProxyRecord(direct('192.168.100.11'))).toEqual([])
  })

  test('an IPv6 literal is accepted by the same two checks', () => {
    expect(validateProxyRecord(direct('2001:db8::11'), { hostAddresses: ['2001:db8::11'] })).toEqual([])
    expect(validateProxyRecord(direct('2001:db8::11'), { hostAddresses: ['127.0.0.1'] }).map((p) => p.code)).toEqual(['E_PROXY_BIND_ADDRESS_UNAVAILABLE'])
  })

  test('these two codes are only ever raised for a `direct` upstream', () => {
    // `bindAddress` is ignored for every other proto — see `ProxyUpstream`'s
    // own doc comment — so a non-empty one on a vendor record raises nothing.
    const vendor = record({ upstream: { proto: 'socks5', host: 'h', port: 1080, username: '', bindAddress: 'not-an-ip', resolveThroughEgress: true } })
    expect(validateProxyRecord(vendor)).toEqual([])
  })
})

describe('E_PROXY_BIND_INEFFECTIVE — the bind-workaround precondition (plan 123 §4.3, step 123.3)', () => {
  function direct(bindAddress: string): ProxyRecord {
    return record({
      listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 },
      upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress, resolveThroughEgress: true },
    })
  }

  test('bindWorkaroundUnavailable: true — a PRECONDITION (storable, not startable), naming all three facts', () => {
    const problems = validateProxyRecord(direct('192.168.50.11'), { hostAddresses: ['192.168.50.11'], bindWorkaroundUnavailable: true })
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_BIND_INEFFECTIVE'])
    expect(problems[0]?.kind).toBe('precondition')
    expect(isStorableRecord(problems)).toBe(true)
    expect(isStartableRecord(problems)).toBe(false)
    const message = problems[0]?.message ?? ''
    // Fact 1: the host DOES hold the address — must not read like the
    // address itself is the problem (that would send an operator to their
    // router, which is the exact mistake §0.1's own field report made).
    expect(message).toContain('does hold 192.168.50.11')
    // Fact 2: the RUNTIME is what ignores the bind, not the record or the address.
    expect(message.toLowerCase()).toContain('runtime')
    expect(message.toLowerCase()).toContain('ignores the bind')
    // Fact 3: what to do about it — the external-binder workaround, or a runtime upgrade.
    expect(message.toLowerCase()).toContain('gost')
    expect(message.toLowerCase()).toContain('runtime upgrade')
  })

  test('bindWorkaroundUnavailable: false raises nothing — the bind works, or gost covers it', () => {
    expect(validateProxyRecord(direct('192.168.50.11'), { hostAddresses: ['192.168.50.11'], bindWorkaroundUnavailable: false })).toEqual([])
  })

  test('bindWorkaroundUnavailable: undefined ("nobody looked") never becomes a refusal it cannot justify', () => {
    // The browser half — and `snapshot()`'s own synchronous read — cannot run
    // an actual socket probe. This is their honest answer, and must not be
    // read as "the bind is broken".
    expect(validateProxyRecord(direct('192.168.50.11'), { hostAddresses: ['192.168.50.11'] })).toEqual([])
  })

  test('an EMPTY bindAddress is completely unaffected, even with bindWorkaroundUnavailable: true (plan 123 §6 criterion 4)', () => {
    // Nothing to bind — this field must never fire for the common case,
    // regardless of what a (nonsensical, for this record) upstream caller
    // passes in.
    expect(validateProxyRecord(direct(''), { bindWorkaroundUnavailable: true })).toEqual([])
  })

  test('is only ever raised for a `direct` upstream', () => {
    const vendor = record({ upstream: { proto: 'socks5', host: 'h', port: 1080, username: '', bindAddress: '192.168.50.11', resolveThroughEgress: true } })
    expect(validateProxyRecord(vendor, { hostAddresses: ['192.168.50.11'], bindWorkaroundUnavailable: true })).toEqual([])
  })

  test('`PROXY_PROBLEM_CODES` carries the code, so a screen can switch on it', () => {
    expect(PROXY_PROBLEM_CODES).toContain('E_PROXY_BIND_INEFFECTIVE')
  })
})

describe('vpnRouteForRecord — vendor and `direct` records (plan 117 §3.6)', () => {
  const vendorBase = record({
    label: 'soax',
    listen: { proto: 'http', bindHost: DEFAULT_BIND_HOST, port: 9905 },
    upstream: { proto: 'socks5', host: 'proxy.soax.com', port: 5000, username: 'package-123', bindAddress: '', resolveThroughEgress: true },
    enabled: true,
  })

  function directRecord(over: { listenProto?: 'http' | 'socks5' | 'https'; bindHost?: string } = {}): ProxyRecord {
    return record({
      label: 'this farm',
      listen: { proto: over.listenProto ?? 'socks5', bindHost: over.bindHost ?? '192.168.100.11', port: 9902 },
      upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress: '192.168.100.11', resolveThroughEgress: true },
      listenerAuth: true,
      enabled: true,
    })
  }

  test('a vendor record\'s VPN route names the UPSTREAM — unchanged by this plan', () => {
    const resolved = routeForRecord(vendorBase, { mode: 'vpn', hasPassword: true })
    expect(resolved).toEqual({ route: { engine: 'vpn-helper', host: 'proxy.soax.com', port: 5000, username: 'package-123' } })
  })

  test('a `direct` record\'s VPN route names its own BRIDGE — the listener, not an upstream it does not have', () => {
    const resolved = routeForRecord(directRecord(), { mode: 'vpn' })
    expect(resolved).toEqual({ route: { engine: 'vpn-helper', host: '192.168.100.11', port: 9902 } })
    // No credential here either — `service/apply.ts` is the only place that
    // reads `proxy-auth:<id>` and fills it in, in the core's own process.
    expect(JSON.stringify(resolved)).not.toContain('username')
    expect(JSON.stringify(resolved)).not.toContain('password')
  })

  test('E_PROXY_VPN_BIND_UNSPECIFIED — a wildcard bind names no address the phone could dial', () => {
    for (const bindHost of ['0.0.0.0', '::']) {
      const resolved = routeForRecord(directRecord({ bindHost }), { mode: 'vpn' })
      expect(resolved).toMatchObject({ problem: { code: 'E_PROXY_VPN_BIND_UNSPECIFIED', kind: 'refusal' } })
    }
  })

  test('E_PROXY_VPN_BIND_LOOPBACK — a loopback bind means the phone would dial itself', () => {
    for (const bindHost of ['127.0.0.1', '::1']) {
      const resolved = routeForRecord(directRecord({ bindHost }), { mode: 'vpn' })
      expect(resolved).toMatchObject({ problem: { code: 'E_PROXY_VPN_BIND_LOOPBACK', kind: 'refusal' } })
    }
  })

  test('E_PROXY_VPN_LISTEN_NOT_SOCKS5 — the guest agent dials the bridge over SOCKS5 and nothing else', () => {
    for (const listenProto of ['http', 'https'] as const) {
      const resolved = routeForRecord(directRecord({ listenProto }), { mode: 'vpn' })
      expect(resolved).toMatchObject({ problem: { code: 'E_PROXY_VPN_LISTEN_NOT_SOCKS5', kind: 'refusal' } })
    }
  })

  test('the three `direct` refusals are checked in the stated order — SOCKS5 first, then loopback, then wildcard', () => {
    // A record that fails more than one check at once still gets exactly one
    // problem back — `directVpnRouteForRecord` returns on the first refusal
    // it finds, unlike `validateProxyRecord`, which is a deliberate difference
    // documented in `shared.ts`'s own header for `vpnRouteForRecord`.
    const httpAndLoopback = routeForRecord(directRecord({ listenProto: 'http', bindHost: '127.0.0.1' }), { mode: 'vpn' })
    expect(httpAndLoopback).toMatchObject({ problem: { code: 'E_PROXY_VPN_LISTEN_NOT_SOCKS5' } })
  })

  test('the HTTP-mode route is untouched by any of this — it still names the bridge port for `adb-reverse-proxy`', () => {
    expect(routeForRecord(directRecord({ listenProto: 'http' }))).toEqual({ route: { engine: 'adb-reverse-proxy', hostPort: 9902 } })
  })
})

describe('the two-key split (§3.6)', () => {
  test('the secret prefix can never be picked up by a list of the record prefix', () => {
    expect(PROXY_SECRET_KEY_PREFIX.startsWith(PROXY_KEY_PREFIX)).toBe(false)
    expect(proxySecretKeyFor('office-uk').startsWith(PROXY_KEY_PREFIX)).toBe(false)
    // The control: the record key DOES match that prefix, so the assertion
    // above is about the strings and not about `startsWith` always being false.
    expect(proxyKeyFor('office-uk').startsWith(PROXY_KEY_PREFIX)).toBe(true)
  })

  test('both keys are legal KV keys', () => {
    const legal = /^[A-Za-z0-9._:-]+$/
    expect(proxyKeyFor('office-uk')).toMatch(legal)
    expect(proxySecretKeyFor('office-uk')).toMatch(legal)
  })

  test('an id round-trips through its key, and a foreign key is not mistaken for one', () => {
    expect(proxyIdFromKey(proxyKeyFor('office-uk'))).toBe('office-uk')
    expect(proxyIdFromKey(proxySecretKeyFor('office-uk'))).toBeNull()
    expect(proxyIdFromKey('assigned')).toBeNull()
    expect(proxyIdFromKey(PROXY_KEY_PREFIX)).toBeNull()
  })

  test('plan 121.4 — the per-slot secret key widens the bare key rather than replacing it', () => {
    expect(proxySecretSlotKeyFor('office-uk', 0)).toBe('proxy-secret:office-uk:0')
    expect(proxySecretSlotKeyFor('office-uk', 1)).toBe('proxy-secret:office-uk:1')
    expect(proxySecretSlotKeyFor('office-uk', 2)).toBe('proxy-secret:office-uk:2')
    // Still starts with the bare key — the legacy key is a genuine PREFIX of
    // every slotted one, not a coincidence of spelling, which is what makes
    // `proxySecretKeyFor` remain a valid fallback lookup on its own.
    expect(proxySecretSlotKeyFor('office-uk', 0).startsWith(proxySecretKeyFor('office-uk'))).toBe(true)
    // Still disjoint from the record prefix, the same property every other
    // key in the "two-key split" above already holds.
    expect(proxySecretSlotKeyFor('office-uk', 0).startsWith(PROXY_KEY_PREFIX)).toBe(false)
    expect(proxySecretSlotKeyFor('office-uk', 0)).toMatch(/^[A-Za-z0-9._:-]+$/)
  })
})
