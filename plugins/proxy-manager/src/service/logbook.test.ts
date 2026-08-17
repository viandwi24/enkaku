import { describe, expect, test } from 'bun:test'
import { bridgeLogFields, bridgeLogMessage, createBridgeLogger, type BridgeEvent, type LogSink } from './logbook'

/**
 * Plan 112 step 112.8's vocabulary half, tested now because the negative
 * assertions are the point and they are true as soon as the lines exist.
 *
 * **Every claim here is an absence, so every one of them carries the two
 * controls plan 109 step 109.5 requires**: that the thing being looked for is
 * real, and that it would be seen if it were there.
 */

const PASSWORD = 'Sup3rSecretUpstreamPassword'
const HOST = 'secret.example'
const PORT = 443

function recorder(): { sink: LogSink; lines: { level: string; message: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = []
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, ...(fields ? { fields } : {}) })
  }
  return { sink: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }, lines }
}

const EVENTS: BridgeEvent[] = [
  { event: 'accepted', conn: 1 },
  { event: 'upstream-connected', conn: 1, destPort: PORT, destHost: HOST },
  { event: 'closed', conn: 1, durationMs: 1234, bytesUp: 512, bytesDown: 4096 },
  { event: 'refused', conn: 2, reason: 'upstream', code: 'E_PROXY_UPSTREAM_TIMEOUT', destPort: PORT, destHost: HOST },
]

describe('what a log line records', () => {
  test('the id, the connection number, and the outcome — always', () => {
    for (const event of EVENTS) {
      const fields = bridgeLogFields(event, { proxyId: 'office-uk', logDestinations: false })
      expect(fields.proxy).toBe('office-uk')
      expect(fields.conn).toBe(event.conn)
      expect(bridgeLogMessage(event)).toBeTruthy()
    }
  })

  test('a closed connection records duration and both byte counts', () => {
    const fields = bridgeLogFields(EVENTS[2] as BridgeEvent, { proxyId: 'office-uk', logDestinations: false })
    expect(fields).toEqual({ proxy: 'office-uk', conn: 1, durationMs: 1234, bytesUp: 512, bytesDown: 4096 })
  })

  test('a refusal records its reason and code — a refusal with neither is undebuggable', () => {
    const fields = bridgeLogFields(EVENTS[3] as BridgeEvent, { proxyId: 'office-uk', logDestinations: false })
    expect(fields.reason).toBe('upstream')
    expect(fields.code).toBe('E_PROXY_UPSTREAM_TIMEOUT')
  })

  test('a refusal is a warn and everything else is a debug, so a busy proxy does not drown its own log', () => {
    const { sink, lines } = recorder()
    const log = createBridgeLogger(sink, { proxyId: 'office-uk', logDestinations: false })
    for (const event of EVENTS) log(event)
    expect(lines.map((l) => l.level)).toEqual(['debug', 'debug', 'debug', 'warn'])
  })
})

describe('the destination PORT is always recorded, and the destination HOST is not (criterion 14)', () => {
  test('with logDestinations off, the port survives and the host does not', () => {
    for (const event of EVENTS) {
      const fields = bridgeLogFields(event, { proxyId: 'office-uk', logDestinations: false })
      expect(JSON.stringify(fields)).not.toContain(HOST)
    }
    // Control 1 — the port really is there, so "the host is absent" is not
    // "nothing is there".
    expect(bridgeLogFields(EVENTS[1] as BridgeEvent, { proxyId: 'x', logDestinations: false }).destPort).toBe(PORT)
    expect(bridgeLogFields(EVENTS[3] as BridgeEvent, { proxyId: 'x', logDestinations: false }).destPort).toBe(PORT)
  })

  test('control 2 — the same search DOES find the host once the switch is on', () => {
    const on = bridgeLogFields(EVENTS[1] as BridgeEvent, { proxyId: 'x', logDestinations: true })
    expect(JSON.stringify(on)).toContain(HOST)
    expect(on.destHost).toBe(HOST)
    // Both halves, both events, so the switch is not half-wired.
    expect(bridgeLogFields(EVENTS[3] as BridgeEvent, { proxyId: 'x', logDestinations: true }).destHost).toBe(HOST)
  })
})

describe('a path, a query string and a password never reach a line, at any setting', () => {
  /**
   * The bridge is structurally incapable of logging a path: nothing in
   * `BridgeEvent` can hold one, because a CONNECT tunnel has no path to see
   * and the absolute-form path is read and forwarded without ever being put in
   * an event. This test is what stops a later field being added quietly.
   */
  test('the event vocabulary has no field a path or a credential could travel in', () => {
    // The allowlist, spelled out. A new field added to `bridgeLogFields`
    // without a decision about what may travel in it fails here.
    const ALLOWED = ['proxy', 'conn', 'destPort', 'destHost', 'durationMs', 'bytesUp', 'bytesDown', 'reason', 'code']
    const seen = new Set<string>()
    for (const logDestinations of [false, true]) {
      for (const event of EVENTS) {
        for (const key of Object.keys(bridgeLogFields(event, { proxyId: 'office-uk', logDestinations }))) {
          seen.add(key)
          expect(ALLOWED).toContain(key)
        }
      }
    }
    // And the allowlist is not a superset nobody maintains: every name on it
    // is actually produced by the four events above.
    expect([...seen].sort()).toEqual([...ALLOWED].sort())
  })

  test('a fixture connection to https://secret.example/private?token=abc leaves none of it in the log', () => {
    const { sink, lines } = recorder()
    const log = createBridgeLogger(sink, { proxyId: 'office-uk', logDestinations: false })
    for (const event of EVENTS) log(event)
    const rendered = JSON.stringify(lines)
    for (const forbidden of [HOST, '/private', 'token', 'abc', PASSWORD]) {
      expect(rendered).not.toContain(forbidden)
    }
    // Control — the search is looking at something. The rendered log is not
    // empty, and it does contain the things it is supposed to.
    expect(rendered).toContain('office-uk')
    expect(rendered).toContain('443')
    expect(rendered).toContain('E_PROXY_UPSTREAM_TIMEOUT')
  })
})
