import { describe, expect, test } from 'bun:test'
import type { UiChangedEvent } from '@enkaku/protocol'
import type { GuestAgentConnect, GuestAgentSocketHandle, GuestAgentSocketHandlers } from './client'
import { createGuestAgentWatch } from './ui-watch'

/** A parsed request line. */
function parseLine(line: string): { id: string; token: string; method: string } {
  return JSON.parse(line)
}

/**
 * A fake `connect` that hands the test a `push(line)` function to deliver server frames on its
 * own schedule — unlike `client.test.ts`'s `scriptedConnect`, a watch connection is not
 * request/reply: the agent writes events whenever it likes, long after the one ack.
 */
function fakeWatchConnect(): {
  connect: GuestAgentConnect
  push: (obj: unknown) => void
  writes: () => string[]
  ended: () => boolean
} {
  const writes: string[] = []
  let handlers: GuestAgentSocketHandlers | undefined
  let socket: GuestAgentSocketHandle | undefined
  let isEnded = false
  const connect: GuestAgentConnect = async (opts) => {
    handlers = opts.socket
    socket = {
      write(data: string) {
        writes.push(data)
        return data.length
      },
      end() {
        isEnded = true
      },
    }
    return socket
  }
  return {
    connect,
    push: (obj: unknown) => {
      handlers?.data(socket as GuestAgentSocketHandle, new TextEncoder().encode(`${JSON.stringify(obj)}\n`))
    },
    writes: () => writes,
    ended: () => isEnded,
  }
}

describe('createGuestAgentWatch (plan 221 §4.11)', () => {
  test('the ack resolves ready and the following lines are events', async () => {
    const { connect, push } = fakeWatchConnect()
    const events: UiChangedEvent[] = []
    const watch = createGuestAgentWatch({ port: 1, token: 't', connect, onEvent: (e) => events.push(e) })

    push({ id: 'x', ok: true, result: { watching: true, debounceMs: 50 } })
    const ready = await watch.ready
    expect(ready.debounceMs).toBe(50)

    push({ event: 'ui.changed', seq: 1, at: 1_700_000_000, packageName: 'com.example', reason: 'content' })
    await Bun.sleep(0)
    expect(events).toHaveLength(1)
    expect(events[0]?.seq).toBe(1)

    await watch.close()
  })

  test('a gap in seq calls onGap', async () => {
    const { connect, push } = fakeWatchConnect()
    const events: UiChangedEvent[] = []
    const gaps: Array<[number, number]> = []
    const watch = createGuestAgentWatch({
      port: 1,
      token: 't',
      connect,
      onEvent: (e) => events.push(e),
      onGap: (expected, received) => gaps.push([expected, received]),
    })
    push({ id: 'x', ok: true, result: { watching: true, debounceMs: 50 } })
    await watch.ready

    push({ event: 'ui.changed', seq: 3, at: 1, packageName: 'a', reason: 'content' })
    await Bun.sleep(0)
    expect(gaps).toEqual([[1, 3]])
    expect(events).toHaveLength(1)

    await watch.close()
  })

  test('an unparseable line closes the watch instead of guessing', async () => {
    const { connect, push } = fakeWatchConnect()
    let closedReason: string | undefined
    const watch = createGuestAgentWatch({
      port: 1,
      token: 't',
      connect,
      onEvent: () => undefined,
      onClose: (reason) => {
        closedReason = reason
      },
    })
    push({ id: 'x', ok: true, result: { watching: true, debounceMs: 50 } })
    await watch.ready

    push({ event: 'not.a.real.event' })
    await Bun.sleep(0)
    expect(closedReason).toBe('unexpected frame')
  })

  test('close writes ui.unwatch exactly once and is idempotent', async () => {
    const { connect, push, writes, ended } = fakeWatchConnect()
    const watch = createGuestAgentWatch({ port: 1, token: 't', connect, onEvent: () => undefined })
    push({ id: 'x', ok: true, result: { watching: true, debounceMs: 50 } })
    await watch.ready

    await watch.close()
    await watch.close()

    const unwatchWrites = writes().filter((line) => parseLine(line.trim()).method === 'ui.unwatch')
    expect(unwatchWrites).toHaveLength(1)
    expect(ended()).toBe(true)
  })
})
