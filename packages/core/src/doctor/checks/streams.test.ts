import { describe, expect, test } from 'bun:test'
import { fakeDoctorContext } from '../test-helpers'
import { streamsCheck } from './streams'

describe('streams check (plan 85 §5 85.6)', () => {
  test('skips when no core is running — occupancy is only known while it is up', async () => {
    const result = await streamsCheck.run(fakeDoctorContext({ streams: { probe: async () => null } }))
    expect(result.status).toBe('skip')
  })

  test('ok when the farm is under its budget', async () => {
    const ctx = fakeDoctorContext({
      streams: {
        probe: async () => ({ maxStreams: 13, maxStreamsPerDevice: 4, active: 2, perDevice: { d1: 2 } }),
      },
    })
    const result = await streamsCheck.run(ctx)
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('2/13')
    expect(result.observed).toContain('d1:2')
  })

  test('warns with a remedy when the farm is at its stream-lane budget', async () => {
    const ctx = fakeDoctorContext({
      streams: {
        probe: async () => ({ maxStreams: 13, maxStreamsPerDevice: 4, active: 13, perDevice: { d1: 4, d2: 4, d3: 4, d4: 1 } }),
      },
    })
    const result = await streamsCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('E_ADB_STREAM_LIMIT')
  })

  test('never warns when maxStreams is reported as 0 (nothing to divide by)', async () => {
    const ctx = fakeDoctorContext({
      streams: { probe: async () => ({ maxStreams: 0, maxStreamsPerDevice: 0, active: 0, perDevice: {} }) },
    })
    const result = await streamsCheck.run(ctx)
    expect(result.status).toBe('ok')
  })
})
