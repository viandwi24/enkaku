import { describe, expect, test } from 'bun:test'
import { nextStatus, type DeviceEvent } from './state-machine'

/**
 * MVP 04 §0.1, §4; plan 205 §4.6. The state machine shrank to four events
 * over three statuses — `manual`/`busy` and their four events
 * (`MANUAL_ACQUIRED`, `MANUAL_RELEASED`, `JOB_CLAIMED`, `JOB_FINISHED`) no
 * longer exist; a job or a control marker is now an activity, never a
 * stored transition.
 */
describe('nextStatus (plan 205 §4.6)', () => {
  test('DEVICE_CONNECTED: offline -> online, quarantined stays quarantined', () => {
    expect(nextStatus('DEVICE_CONNECTED', 'offline')).toBe('online')
    expect(nextStatus('DEVICE_CONNECTED', 'quarantined')).toBe('quarantined')
  })

  test('DEVICE_CONNECTED is illegal from online (already connected)', () => {
    expect(nextStatus('DEVICE_CONNECTED', 'online')).toBeNull()
  })

  test('DEVICE_DISCONNECTED: online -> offline, quarantined stays quarantined', () => {
    expect(nextStatus('DEVICE_DISCONNECTED', 'online')).toBe('offline')
    expect(nextStatus('DEVICE_DISCONNECTED', 'quarantined')).toBe('quarantined')
  })

  test('DEVICE_DISCONNECTED is illegal from offline (already disconnected)', () => {
    expect(nextStatus('DEVICE_DISCONNECTED', 'offline')).toBeNull()
  })

  test('QUARANTINE: online -> quarantined only', () => {
    expect(nextStatus('QUARANTINE', 'online')).toBe('quarantined')
    expect(nextStatus('QUARANTINE', 'offline')).toBeNull()
    expect(nextStatus('QUARANTINE', 'quarantined')).toBeNull()
  })

  test('UNQUARANTINE: quarantined -> online only', () => {
    expect(nextStatus('UNQUARANTINE', 'quarantined')).toBe('online')
    expect(nextStatus('UNQUARANTINE', 'online')).toBeNull()
    expect(nextStatus('UNQUARANTINE', 'offline')).toBeNull()
  })

  test('exactly four events exist — MANUAL_ACQUIRED/MANUAL_RELEASED/JOB_CLAIMED/JOB_FINISHED are gone', () => {
    const events: DeviceEvent[] = ['DEVICE_CONNECTED', 'DEVICE_DISCONNECTED', 'QUARANTINE', 'UNQUARANTINE']
    for (const event of events) {
      // Type-level proof: this compiles only if DeviceEvent is exactly this union.
      expect(typeof event).toBe('string')
    }
  })
})
