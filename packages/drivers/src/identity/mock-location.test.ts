import { describe, expect, test } from 'bun:test'
import type { GuestAgentClient } from '../network/guest-agent/client'
import { createMockLocationDriver, type GuestAgentClientRunner } from './mock-location'

/** A `withClient` runner that hands out the same fake client on every call and records what was asked of it. */
function fakeRunner(overrides: Partial<GuestAgentClient> = {}): { withClient: GuestAgentClientRunner; calls: string[] } {
  const calls: string[] = []
  const client = {
    locationSet: async (lat: number, lng: number, accuracy?: number) => {
      calls.push(`locationSet:${lat},${lng},${accuracy}`)
      return { set: true as const }
    },
    locationClear: async () => {
      calls.push('locationClear')
      return { cleared: true as const }
    },
    ...overrides,
  } as GuestAgentClient
  return { withClient: (fn) => fn(client), calls }
}

describe('createMockLocationDriver (plan 58 §4.5, §5.5)', () => {
  test('set() forwards lat/lng/accuracy to the client through withClient', async () => {
    const { withClient, calls } = fakeRunner()
    const driver = createMockLocationDriver({ withClient })

    await driver.set({ lat: 40.7128, lng: -74.006, accuracy: 50 })

    expect(calls).toEqual(['locationSet:40.7128,-74.006,50'])
  })

  test('set() without an explicit accuracy still calls through (the wire default lives in the client, not here)', async () => {
    const { withClient, calls } = fakeRunner()
    const driver = createMockLocationDriver({ withClient })

    await driver.set({ lat: 1, lng: 2 })

    expect(calls).toEqual(['locationSet:1,2,undefined'])
  })

  test('clear() calls locationClear through withClient', async () => {
    const { withClient, calls } = fakeRunner()
    const driver = createMockLocationDriver({ withClient })

    await driver.clear()

    expect(calls).toEqual(['locationClear'])
  })

  test('a rejection from the client propagates unchanged — this driver never swallows an error', async () => {
    const { withClient } = fakeRunner({
      locationSet: async () => {
        throw new Error('E_NOT_PREPARED: not the mock-location app')
      },
    })
    const driver = createMockLocationDriver({ withClient })

    await expect(driver.set({ lat: 0, lng: 0 })).rejects.toThrow('E_NOT_PREPARED')
  })
})
