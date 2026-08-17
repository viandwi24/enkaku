import { describe, expect, test } from 'bun:test'
import { ProxyRecordSchema, ProxySecretSchema, SECRET_PREFIX_IS_DISJOINT } from './record'
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
  readProxyRecord,
  validateProxyRecord,
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
    upstream: { proto: 'socks5', host: '10.4.0.9', port: 1080, username: 'country-id-r9931204' },
    enabled: false,
    logDestinations: false,
    maxConnections: DEFAULT_MAX_CONNECTIONS,
    drainMs: DEFAULT_DRAIN_MS,
    notes: '',
    ...over,
  }
}

describe('the v2 record', () => {
  test('round-trips through write → read, and parses as a ProxyRecord', () => {
    const typed = record({ enabled: true, logDestinations: true, notes: 'expires in March' })
    const stored = writeProxyRecord(typed)
    expect(Object.keys(stored)).toEqual(Object.keys(ProxyRecordSchema.shape))
    const parsed = ProxyRecordSchema.safeParse(stored)
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(readProxyRecord(stored)).toEqual(typed)
  })

  test('everything the defensive reader can produce also parses against the schema', () => {
    // The invariant that keeps the two halves from drifting apart in the one
    // direction a round-trip test cannot see: `readProxyRecord` is deliberately
    // more permissive than the schema, so the schema has to accept its whole
    // output range — including the blanks it invents for a junk row.
    for (const junk of [null, 42, 'nonsense', [], { nonsense: true }, { listen: 'no' }, { upstream: [] }]) {
      const parsed = ProxyRecordSchema.safeParse(writeProxyRecord(readProxyRecord(junk)))
      expect(parsed.error?.issues ?? []).toEqual([])
    }
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
    expect(migrated.upstream).toEqual({ proto: 'socks5', host: '10.4.0.9', port: 1080, username: '' })
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

describe('validateProxyRecord — the coded refusals (§4.2)', () => {
  test('an https LISTEN protocol is refused by name, and the message says what to do instead', () => {
    const problems = validateProxyRecord(record({ listen: { proto: 'https', bindHost: '127.0.0.1', port: 9902 } }))
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_LISTEN_UNSUPPORTED'])
    expect(problems[0]?.kind).toBe('refusal')
    expect(problems[0]?.message).toMatch(/certificate/)
    expect(problems[0]?.message).toMatch(/HTTP or SOCKS5/)
  })

  test('an https UPSTREAM protocol is refused by name', () => {
    const problems = validateProxyRecord(record({ upstream: { proto: 'https', host: 'h', port: 1, username: '' } }))
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_UPSTREAM_UNSUPPORTED'])
  })

  test('a non-loopback bind is refused, and the message names the two legitimate paths', () => {
    const problems = validateProxyRecord(record({ listen: { proto: 'http', bindHost: '0.0.0.0', port: 9902 } }))
    expect(problems.map((p) => p.code)).toEqual(['E_PROXY_BIND_NOT_LOOPBACK'])
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
        'E_PROXY_BIND_NOT_LOOPBACK',
      ])
    }
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
    const seen = [
      ...validateProxyRecord(record({ listen: { proto: 'https', bindHost: 'nope', port: null } })),
      ...validateProxyRecord(record({ upstream: { proto: 'https', host: 'h', port: 1, username: '' } })),
      ...validateProxyRecord(record(), { id: 'a', catalogue: [{ id: 'b', record: record({ enabled: true }) }] }),
    ].map((p) => p.code)
    for (const code of seen) expect(PROXY_PROBLEM_CODES.map(String)).toContain(code)
    // And the list is not merely a superset nobody maintains: everything in it
    // is reachable from the three calls above.
    expect([...new Set(seen)].sort()).toEqual([...PROXY_PROBLEM_CODES].sort())
  })

  test('it reports EVERY problem, not just the first — a form that reveals one error at a time is four submits', () => {
    const problems = validateProxyRecord(record({ listen: { proto: 'https', bindHost: '10.0.0.5', port: null } }))
    expect(problems.map((p) => p.code).sort()).toEqual(['E_PROXY_BIND_NOT_LOOPBACK', 'E_PROXY_LISTEN_UNSUPPORTED', 'E_PROXY_PORT_UNASSIGNED'])
  })
})

describe('the two-key split (§3.6)', () => {
  test('the secret prefix can never be picked up by a list of the record prefix', () => {
    expect(SECRET_PREFIX_IS_DISJOINT).toBe(true)
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

  test('the secret is an object with one field, and the schema says so', () => {
    expect(ProxySecretSchema.safeParse({ password: 'hunter2hunter2' }).success).toBe(true)
    expect(ProxySecretSchema.safeParse('hunter2hunter2').success).toBe(false)
    expect(Object.keys(ProxySecretSchema.shape)).toEqual(['password'])
  })
})
