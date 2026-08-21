import { describe, expect, test } from 'bun:test'
import { proxyKeyFor } from '../shared'
import {
  SUBJECT_MAX_LENGTH,
  bridgeLogFields,
  bridgeLogLevel,
  bridgeLogMessage,
  createBridgeLogger,
  logServiceEvent,
  proxySubject,
  type LifecycleEvent,
  type LogSink,
  type ProxyEvent,
} from './logbook'

/**
 * Plan 112 step 112.8 — the line vocabulary, its tag, and the deliberate list
 * of what is never in a line.
 *
 * **Every claim here is an absence, so every one of them carries the two
 * controls plan 109 step 109.5 requires**: that the thing being looked for is
 * real, and that it would be seen if it were there.
 */

const PASSWORD = 'Sup3rSecretUpstreamPassword'
const HOST = 'secret.example'
const PORT = 443
/** Plan 123 §4.4 — the record's own configured bind, and what was actually observed. Deliberately distinct so a mismatch test proves something. */
const BIND_ADDRESS = '192.168.50.11'
const EGRESS_ADDRESS = '118.99.123.20'

function recorder(): { sink: LogSink; lines: { level: string; message: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = []
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, ...(fields ? { fields } : {}) })
  }
  return { sink: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }, lines }
}

/** The four connection events. */
const CONNECTION_EVENTS: ProxyEvent[] = [
  { event: 'accepted', conn: 1 },
  { event: 'upstream-connected', conn: 1, destPort: PORT, destHost: HOST, egressAddress: EGRESS_ADDRESS },
  { event: 'closed', conn: 1, durationMs: 1234, bytesUp: 512, bytesDown: 4096 },
  { event: 'refused', conn: 2, reason: 'upstream', code: 'E_PROXY_UPSTREAM_TIMEOUT', destPort: PORT, destHost: HOST },
]

/**
 * Plan 123 §4.4 — the one-off event, kept OUT of `CONNECTION_EVENTS` on
 * purpose: it is not one of the four things that can happen to a connection,
 * it is a fact about the record that a connection happened to reveal, and
 * folding it into that array would break the level test just below, which
 * asserts on exactly those four.
 */
const BIND_MISMATCH_EVENT: ProxyEvent = { event: 'bind-mismatch', conn: 3, bindAddress: BIND_ADDRESS, egressAddress: EGRESS_ADDRESS }

/** The eight lifecycle events — everything the supervisor can say about one proxy. */
const LIFECYCLE_EVENTS: LifecycleEvent[] = [
  { event: 'start' },
  { event: 'listening', port: 9902, listen: 'http', upstreamProto: 'socks5', upstreamHost: 'up.example', upstreamPort: 1080 },
  { event: 'start-refused', code: 'E_PROXY_PORT_UNASSIGNED', message: 'this record needs a local port' },
  { event: 'start-failed', code: 'E_PROXY_LISTEN_ADDR_IN_USE', message: '127.0.0.1:9902 is already in use', port: 9902 },
  { event: 'drain', live: 3, drainMs: 10_000 },
  { event: 'stop', forced: false, port: 9902 },
  { event: 'restart' },
  { event: 'teardown', port: 9902 },
]

const ALL_EVENTS: ProxyEvent[] = [...CONNECTION_EVENTS, BIND_MISMATCH_EVENT, ...LIFECYCLE_EVENTS]

describe('the tag that makes “logs all” and “logs per proxy” ONE stream', () => {
  test('every line about a proxy carries that proxy’s subject, and nothing else identifies it', () => {
    for (const event of ALL_EVENTS) {
      const fields = bridgeLogFields(event, { proxyId: 'office-uk', logDestinations: false })
      expect(fields.subject).toBe('proxy:office-uk')
      // Not ALSO as a `proxy` field: the farm lifts `fields.subject` onto the
      // line and deletes it from the bag, and a duplicate would render twice in
      // every view that shows both (plan 109 step 109.8's own reason).
      expect(fields.proxy).toBeUndefined()
    }
  })

  test('the subject is the record’s own storage key, so a filter value needs no translation', () => {
    expect(proxySubject('office-uk')).toBe(proxyKeyFor('office-uk'))
  })

  test('the subject is clamped to the length the FARM keeps, or a long key would filter to nothing', () => {
    /**
     * `PLUGIN_LOG_MAX_SUBJECT` in `packages/core/src/plugins/runtime-logs.ts` is
     * 64 and the core trims what it STORES. If this pack tagged with an
     * untrimmed string it would then filter with an untrimmed string, no stored
     * line would match, and the per-proxy view of a long-keyed proxy would be
     * permanently, silently empty — which reads as "this proxy did nothing".
     */
    const long = 'x'.repeat(200)
    expect(proxySubject(long).length).toBe(SUBJECT_MAX_LENGTH)
    // Control — the clamp is not clamping everything: an ordinary key is
    // untouched.
    expect(proxySubject('office-uk').length).toBeLessThan(SUBJECT_MAX_LENGTH)
  })

  test('the supervisor’s own two lines are deliberately UNTAGGED, so they appear in “all” and in no per-proxy view', () => {
    const { sink, lines } = recorder()
    logServiceEvent(sink, { event: 'service-started', catalogue: 11, started: 3 })
    logServiceEvent(sink, { event: 'service-stopped', destroyed: 3 })
    for (const line of lines) expect(line.fields?.subject).toBeUndefined()
    // Control — they carry the counts that make them worth a line at all.
    expect(lines[0]?.fields).toEqual({ catalogue: 11, started: 3 })
    expect(lines[1]?.fields).toEqual({ destroyed: 3 })
  })
})

describe('what a log line records', () => {
  test('the connection number and the outcome — always', () => {
    for (const event of CONNECTION_EVENTS) {
      const fields = bridgeLogFields(event, { proxyId: 'office-uk', logDestinations: false })
      expect(fields.conn).toBe((event as { conn: number }).conn)
      expect(bridgeLogMessage(event)).toBeTruthy()
    }
  })

  test('every event in the vocabulary has a message of its own — none falls through to a generic one', () => {
    const messages = ALL_EVENTS.map(bridgeLogMessage)
    expect(new Set(messages).size).toBe(ALL_EVENTS.length)
    for (const message of messages) expect(message.length).toBeGreaterThan(8)
  })

  test('a closed connection records duration and both byte counts', () => {
    const fields = bridgeLogFields(CONNECTION_EVENTS[2] as ProxyEvent, { proxyId: 'office-uk', logDestinations: false })
    expect(fields).toEqual({ subject: 'proxy:office-uk', conn: 1, durationMs: 1234, bytesUp: 512, bytesDown: 4096 })
  })

  test('a refusal records its reason and code — a refusal with neither is undebuggable', () => {
    const fields = bridgeLogFields(CONNECTION_EVENTS[3] as ProxyEvent, { proxyId: 'office-uk', logDestinations: false })
    expect(fields.reason).toBe('upstream')
    expect(fields.code).toBe('E_PROXY_UPSTREAM_TIMEOUT')
  })

  test('a taken port gets its own sentence, because the fix is specific', () => {
    expect(bridgeLogMessage({ event: 'start-failed', code: 'E_PROXY_LISTEN_ADDR_IN_USE', message: '', port: 1 })).toContain('already in use')
    // Control — a different failure does NOT claim the port is taken.
    expect(bridgeLogMessage({ event: 'start-failed', code: 'E_PROXY_LISTEN_FAILED', message: '', port: 1 })).not.toContain('already in use')
  })

  test('a force stop is worded as one, so a drained stop and a guillotine are not the same line', () => {
    expect(bridgeLogMessage({ event: 'stop', forced: true, port: 1 })).toContain('force-stopped')
    expect(bridgeLogMessage({ event: 'stop', forced: false, port: 1 })).not.toContain('force')
  })

  test('the levels: traffic is debug, a refusal is a warn, a failed start is an error, lifecycle is info', () => {
    const { sink, lines } = recorder()
    const log = createBridgeLogger(sink, { proxyId: 'office-uk', logDestinations: false })
    for (const event of CONNECTION_EVENTS) log(event)
    // A proxy carrying real traffic writes two lines per connection into a ring
    // it shares with every other proxy; an `info` default would evict the
    // lifecycle lines somebody is actually looking for.
    expect(lines.map((l) => l.level)).toEqual(['debug', 'debug', 'debug', 'warn'])
    expect(LIFECYCLE_EVENTS.map(bridgeLogLevel)).toEqual(['info', 'info', 'warn', 'error', 'info', 'info', 'info', 'info'])
  })

  test('a `listening` line names the upstream’s address and NOT its username', () => {
    const fields = bridgeLogFields(LIFECYCLE_EVENTS[1] as ProxyEvent, { proxyId: 'office-uk', logDestinations: false })
    expect(fields).toEqual({ subject: 'proxy:office-uk', port: 9902, listen: 'http', upstreamProto: 'socks5', upstreamHost: 'up.example', upstreamPort: 1080 })
    // The username is questioned in plan 112 §9 Q1 — the owner's own example
    // encodes an exit country and a sticky-session id — so the log leaves it
    // out. The catalogue shows it; a narrower default can be widened later,
    // and a wider one cannot be un-written from a rotated file.
    expect(JSON.stringify(fields)).not.toContain('country-id-r9931204')
  })
})

describe('plan 123 §4.4 — egressAddress and bind-mismatch, a deliberate extension of the field allowlist', () => {
  test('`upstream-connected` always carries the observed egress address — it is this host’s own address, not a destination', () => {
    const fields = bridgeLogFields(CONNECTION_EVENTS[1] as ProxyEvent, { proxyId: 'office-uk', logDestinations: false })
    expect(fields.egressAddress).toBe(EGRESS_ADDRESS)
    // Unaffected by `logDestinations` — that switch widens the destination
    // HOST only, and never gated the egress address in the first place.
    const withDestinations = bridgeLogFields(CONNECTION_EVENTS[1] as ProxyEvent, { proxyId: 'office-uk', logDestinations: true })
    expect(withDestinations.egressAddress).toBe(EGRESS_ADDRESS)
  })

  test('`bind-mismatch` is a warn naming both addresses, once — the sentence a person greps for instead of a packet capture', () => {
    expect(bridgeLogLevel(BIND_MISMATCH_EVENT)).toBe('warn')
    const fields = bridgeLogFields(BIND_MISMATCH_EVENT, { proxyId: 'office-uk', logDestinations: false })
    expect(fields).toEqual({ subject: 'proxy:office-uk', conn: 3, bindAddress: BIND_ADDRESS, egressAddress: EGRESS_ADDRESS })
    expect(bridgeLogMessage(BIND_MISMATCH_EVENT)).toContain('bind address')
  })
})

describe('the destination PORT is always recorded, and the destination HOST is not (criterion 14)', () => {
  test('with logDestinations off, the port survives and the host does not', () => {
    for (const event of ALL_EVENTS) {
      const fields = bridgeLogFields(event, { proxyId: 'office-uk', logDestinations: false })
      expect(JSON.stringify(fields)).not.toContain(HOST)
    }
    // Control 1 — the port really is there, so "the host is absent" is not
    // "nothing is there".
    expect(bridgeLogFields(CONNECTION_EVENTS[1] as ProxyEvent, { proxyId: 'x', logDestinations: false }).destPort).toBe(PORT)
    expect(bridgeLogFields(CONNECTION_EVENTS[3] as ProxyEvent, { proxyId: 'x', logDestinations: false }).destPort).toBe(PORT)
  })

  test('control 2 — the same search DOES find the host once the switch is on', () => {
    const on = bridgeLogFields(CONNECTION_EVENTS[1] as ProxyEvent, { proxyId: 'x', logDestinations: true })
    expect(JSON.stringify(on)).toContain(HOST)
    expect(on.destHost).toBe(HOST)
    // Both halves, both events, so the switch is not half-wired.
    expect(bridgeLogFields(CONNECTION_EVENTS[3] as ProxyEvent, { proxyId: 'x', logDestinations: true }).destHost).toBe(HOST)
  })

  test('the switch changes NOTHING about a lifecycle line — it is about traffic, not about the proxy', () => {
    for (const event of LIFECYCLE_EVENTS) {
      const off = bridgeLogFields(event, { proxyId: 'office-uk', logDestinations: false })
      const on = bridgeLogFields(event, { proxyId: 'office-uk', logDestinations: true })
      expect(on).toEqual(off)
    }
  })
})

describe('a path, a query string and a password never reach a line, at any setting', () => {
  /**
   * The bridge is structurally incapable of logging a path: nothing in the
   * event vocabulary can hold one, because a CONNECT tunnel has no path to see
   * and the absolute-form path is read and forwarded without ever being put in
   * an event. This test is what stops a later field being added quietly.
   */
  test('the event vocabulary has no field a path or a credential could travel in', () => {
    // The allowlist, spelled out. A new field added to `bridgeLogFields`
    // without a decision about what may travel in it fails here.
    const ALLOWED = [
      'subject',
      'conn',
      'destPort',
      'destHost',
      'durationMs',
      'bytesUp',
      'bytesDown',
      'reason',
      'code',
      'port',
      'listen',
      'upstreamProto',
      'upstreamHost',
      'upstreamPort',
      'live',
      'drainMs',
      'forced',
      'message',
      // Plan 123 §4.4 — added deliberately, not incidentally: both are an
      // address of the HOST ITSELF (never a destination, never a credential),
      // added specifically so a wrongly-bound egress becomes greppable
      // instead of requiring a packet capture on the router (plan 123 §0.4).
      // See this file's own header, "egressAddress and bind-mismatch are a
      // deliberate exception, not an oversight", for the full reasoning.
      'egressAddress',
      'bindAddress',
    ]
    const seen = new Set<string>()
    for (const logDestinations of [false, true]) {
      for (const event of ALL_EVENTS) {
        for (const key of Object.keys(bridgeLogFields(event, { proxyId: 'office-uk', logDestinations }))) {
          seen.add(key)
          expect(ALLOWED).toContain(key)
        }
      }
    }
    // And the allowlist is not a superset nobody maintains: every name on it is
    // actually produced by the events above.
    expect([...seen].sort()).toEqual([...ALLOWED].sort())
  })

  test('a fixture connection to https://secret.example/private?token=abc leaves none of it in the log', () => {
    const { sink, lines } = recorder()
    const log = createBridgeLogger(sink, { proxyId: 'office-uk', logDestinations: false })
    for (const event of ALL_EVENTS) log(event)
    const rendered = JSON.stringify(lines)
    for (const forbidden of [HOST, '/private', 'token', 'abc', PASSWORD]) {
      expect(rendered).not.toContain(forbidden)
    }
    // Control — the search is looking at something. The rendered log is not
    // empty, and it does contain the things it is supposed to.
    expect(rendered).toContain('proxy:office-uk')
    expect(rendered).toContain('443')
    expect(rendered).toContain('E_PROXY_UPSTREAM_TIMEOUT')
  })

  test('and none of it survives the switch being ON either — the switch widens hosts, and only hosts', () => {
    const { sink, lines } = recorder()
    const log = createBridgeLogger(sink, { proxyId: 'office-uk', logDestinations: true })
    for (const event of ALL_EVENTS) log(event)
    const rendered = JSON.stringify(lines)
    for (const forbidden of ['/private', 'token', 'abc', PASSWORD]) {
      expect(rendered).not.toContain(forbidden)
    }
    // Control — the host IS there now, so the four absences above are not the
    // absence of a log.
    expect(rendered).toContain(HOST)
  })
})
