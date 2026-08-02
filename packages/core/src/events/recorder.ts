import type { DeviceEvent } from '@enkaku/protocol'
import type { Db } from '../db'
import { deviceEvents, type DeviceEventInsert } from '../db/schema'

export interface EventRecorder {
  /** Fire-and-forget. Buffered; never awaited by a request path (plan 18 §3.5). */
  record(e: {
    deviceId: string
    stream: 'main' | 'input'
    kind: string
    actor?: string | null
    meta?: Record<string, unknown>
  }): void
  /** Flush and stop — called on daemon shutdown. */
  stop(): Promise<void>
}

/**
 * Buffers device events in memory and flushes them in one transaction, on a
 * timer or when the buffer fills — whichever comes first. `record()` never
 * awaits the database: the WS input handler that calls it must not pay for a
 * SQLite insert on every tap (plan 18 §3.5).
 *
 * `publish` is called synchronously from `record()`, before the row is ever
 * written — live tail must feel instant, and a dropped write on a hard crash
 * is an accepted loss for this log class (plan 18 §3.5, risks table).
 */
export function createEventRecorder(deps: {
  db: Db
  /** Fan an event out to subscribed WS clients. */
  publish: (deviceId: string, ev: DeviceEvent) => void
  flushIntervalMs?: number
  maxBufferedRows?: number
}): EventRecorder {
  const flushIntervalMs = deps.flushIntervalMs ?? 250
  const maxBufferedRows = deps.maxBufferedRows ?? 200

  let buffer: DeviceEventInsert[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    // One transaction per flush, not one per event (plan 18 §3.5, §4.3).
    deps.db.transaction((tx) => {
      tx.insert(deviceEvents).values(batch).run()
    })
  }

  function scheduleFlush(): void {
    if (timer || stopped) return
    timer = setTimeout(flush, flushIntervalMs)
  }

  return {
    record(e) {
      if (stopped) return
      const atSec = Math.floor(Date.now() / 1000)
      const id = crypto.randomUUID()
      const actor = e.actor ?? null
      const meta = e.meta ?? null
      buffer.push({ id, deviceId: e.deviceId, stream: e.stream, kind: e.kind, actor, meta, at: new Date(atSec * 1000) })
      deps.publish(e.deviceId, {
        id,
        deviceId: e.deviceId,
        stream: e.stream,
        kind: e.kind,
        actor,
        meta,
        at: atSec,
      })
      if (buffer.length >= maxBufferedRows) flush()
      else scheduleFlush()
    },

    async stop() {
      stopped = true
      flush()
    },
  }
}
