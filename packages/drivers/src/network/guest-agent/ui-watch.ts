import {
  GuestAgentResponseSchema,
  UiChangedEventSchema,
  UiWatchRequestSchema,
  UiUnwatchRequestSchema,
  UiWatchResultSchema,
  type UiChangedEvent,
} from '@enkaku/protocol'
import { GuestAgentClientError } from './client'
import type { GuestAgentConnect, GuestAgentSocketHandle } from './client'

/**
 * The `ui.watch` subscription (plan 221 §4.4, §4.11). `client.ts`'s `sendOnce` reads one line and
 * closes, which is right for every other method on this wire — this is deliberately a second,
 * separate function rather than a change to that one, so nothing that works today changes shape.
 *
 * It opens exactly ONE connection to `127.0.0.1:<port>` — the same forward a launcher already
 * owns (`launcher.ts`'s host-port ownership check), never a forward of its own — writes one
 * `ui.watch` request line, validates the ack, and from then on parses every later line as a
 * `UiChangedEvent`. A line that parses as neither is dropped with `onClose('unexpected frame')`
 * and the socket ends: never guess at a frame.
 */
export interface GuestAgentWatchOptions {
  port: number
  token: string
  connect?: GuestAgentConnect
  /** How long the ack may take. The subscription itself has no timeout: silence is the normal state. */
  ackTimeoutMs?: number
  onEvent: (event: UiChangedEvent) => void
  /** A gap in `seq` means frames were lost; the caller re-dumps rather than trusting its cache. */
  onGap?: (expected: number, received: number) => void
  onClose?: (reason: string) => void
}

export interface GuestAgentWatch {
  /** Resolves once the agent's ack line has been read and validated. */
  readonly ready: Promise<{ debounceMs: number }>
  close(): Promise<void>
}

const defaultConnect: GuestAgentConnect = (opts) => Bun.connect(opts) as unknown as Promise<GuestAgentSocketHandle>

export function createGuestAgentWatch(opts: GuestAgentWatchOptions): GuestAgentWatch {
  const connect = opts.connect ?? defaultConnect
  const ackTimeoutMs = opts.ackTimeoutMs ?? 15_000

  let sock: GuestAgentSocketHandle | undefined
  let buffer = ''
  let ackResolved = false
  let expectedSeq = 1
  let closed = false

  let resolveReady!: (value: { debounceMs: number }) => void
  let rejectReady!: (err: unknown) => void
  const ready = new Promise<{ debounceMs: number }>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const ackTimer = setTimeout(() => {
    if (!ackResolved) {
      ackResolved = true
      rejectReady(new GuestAgentClientError('E_TIMEOUT', `guest agent did not ack ui.watch within ${ackTimeoutMs}ms`))
      endSocket()
    }
  }, ackTimeoutMs)

  function endSocket(): void {
    if (closed) return
    closed = true
    clearTimeout(ackTimer)
    try {
      sock?.end()
    } catch {
      // already gone — nothing to clean up
    }
  }

  function handleLine(line: string): void {
    if (line.trim() === '') return

    if (!ackResolved) {
      ackResolved = true
      clearTimeout(ackTimer)
      let json: unknown
      try {
        json = JSON.parse(line)
      } catch (err) {
        rejectReady(new GuestAgentClientError('E_UNEXPECTED_RESPONSE', `guest agent ui.watch ack was not valid JSON: ${String(err)}`))
        endSocket()
        return
      }
      const envelope = GuestAgentResponseSchema.safeParse(json)
      if (!envelope.success || !envelope.data.ok) {
        rejectReady(new GuestAgentClientError('E_UNEXPECTED_RESPONSE', 'guest agent did not ack ui.watch'))
        endSocket()
        return
      }
      const result = UiWatchResultSchema.safeParse(envelope.data.result)
      if (!result.success) {
        rejectReady(new GuestAgentClientError('E_UNEXPECTED_RESPONSE', `ui.watch ack did not match its schema: ${result.error.message}`))
        endSocket()
        return
      }
      resolveReady({ debounceMs: result.data.debounceMs })
      return
    }

    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      opts.onClose?.('unexpected frame')
      endSocket()
      return
    }
    const event = UiChangedEventSchema.safeParse(json)
    if (!event.success) {
      opts.onClose?.('unexpected frame')
      endSocket()
      return
    }
    if (event.data.seq !== expectedSeq) {
      opts.onGap?.(expectedSeq, event.data.seq)
    }
    expectedSeq = event.data.seq + 1
    opts.onEvent(event.data)
  }

  const req = UiWatchRequestSchema.parse({ id: crypto.randomUUID(), token: opts.token, method: 'ui.watch' })

  connect({
    hostname: '127.0.0.1',
    port: opts.port,
    socket: {
      data(_s, data) {
        buffer += new TextDecoder().decode(data, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          handleLine(line)
        }
      },
      close() {
        if (!ackResolved) {
          ackResolved = true
          clearTimeout(ackTimer)
          rejectReady(new GuestAgentClientError('E_TRANSPORT', 'guest agent closed the connection before acking ui.watch'))
        }
        closed = true
        opts.onClose?.('closed')
      },
      error(_s, err) {
        if (!ackResolved) {
          ackResolved = true
          clearTimeout(ackTimer)
          rejectReady(new GuestAgentClientError('E_TRANSPORT', `guest agent socket error: ${err.message}`))
        }
      },
      connectError(_s, err) {
        ackResolved = true
        clearTimeout(ackTimer)
        rejectReady(new GuestAgentClientError('E_TRANSPORT', `could not connect to 127.0.0.1:${opts.port}: ${err.message}`))
      },
    },
  })
    .then((s) => {
      sock = s
      s.write(`${JSON.stringify(req)}\n`)
    })
    .catch((err: unknown) => {
      if (!ackResolved) {
        ackResolved = true
        clearTimeout(ackTimer)
        rejectReady(new GuestAgentClientError('E_TRANSPORT', `could not connect to 127.0.0.1:${opts.port}: ${String(err)}`))
      }
    })

  return {
    ready,
    async close() {
      if (closed) return
      try {
        const unwatch = UiUnwatchRequestSchema.parse({ id: crypto.randomUUID(), token: opts.token, method: 'ui.unwatch' })
        sock?.write(`${JSON.stringify(unwatch)}\n`)
      } catch {
        // best-effort — the socket may already be gone
      }
      endSocket()
    },
  }
}
