import { describe, expect, test } from 'bun:test'
import type { TrackedDevice } from '@enkaku/adb'
import { createUsbRootCache } from './usb-root-cache'

function device(serial: string, usb?: string): TrackedDevice {
  return { serial, state: 'device', usb } as TrackedDevice
}

describe('createUsbRootCache', () => {
  test("rootOf resolves a serial's root from a cached listDevices() call", async () => {
    const cache = createUsbRootCache({ listDevices: async () => [device('SER1', '3-1.4.3'), device('SER2', '4-2.1.1')] })
    expect(await cache.rootOf('SER1')).toBe('3')
    expect(await cache.rootOf('SER2')).toBe('4')
  })

  test('rootOf returns unknown for a serial absent from the listing', async () => {
    const cache = createUsbRootCache({ listDevices: async () => [device('SER1', '3-1.4.3')] })
    expect(await cache.rootOf('SER-NOT-LISTED')).toBe('unknown')
  })

  test('rootOf tolerates a listDevices rejection by keeping the previous snapshot', async () => {
    let calls = 0
    const cache = createUsbRootCache({
      cacheMs: 0,
      listDevices: async () => {
        calls++
        if (calls === 1) return [device('SER1', '3-1.4.3')]
        throw new Error('adb server unreachable')
      },
    })
    expect(await cache.rootOf('SER1')).toBe('3')
    // Second call: the refresh throws, but the previous snapshot survives.
    expect(await cache.rootOf('SER1')).toBe('3')
    expect(calls).toBe(2)
  })

  test('rootOf re-fetches after cacheMs elapses', async () => {
    let now = 0
    const realNow = Date.now
    Date.now = () => now
    try {
      let calls = 0
      const cache = createUsbRootCache({
        cacheMs: 5_000,
        listDevices: async () => {
          calls++
          return calls === 1 ? [device('SER1', '3-1.4.3')] : [device('SER1', '4-2.1.1')]
        },
      })
      expect(await cache.rootOf('SER1')).toBe('3')
      expect(calls).toBe(1)
      // Within the cache window: no re-fetch.
      expect(await cache.rootOf('SER1')).toBe('3')
      expect(calls).toBe(1)
      now += 5_001
      expect(await cache.rootOf('SER1')).toBe('4')
      expect(calls).toBe(2)
    } finally {
      Date.now = realNow
    }
  })
})
