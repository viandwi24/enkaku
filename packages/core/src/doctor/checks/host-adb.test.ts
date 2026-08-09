import { describe, expect, test } from 'bun:test'
import { fakeDoctorContext } from '../test-helpers'
import { hostAdbCheck } from './host-adb'

describe('host-adb check (plan 85 §5 85.6)', () => {
  test('skips when adb processes cannot be enumerated on this platform', async () => {
    const result = await hostAdbCheck.run(fakeDoctorContext({ hostAdb: { countAdbProcesses: async () => null, probeCoreStats: async () => null } }))
    expect(result.status).toBe('skip')
  })

  test('ok when no adb process is running at all', async () => {
    const result = await hostAdbCheck.run(fakeDoctorContext({ hostAdb: { countAdbProcesses: async () => 0, probeCoreStats: async () => null } }))
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('no adb process')
  })

  test('ok for exactly the adb server with no core to compare against', async () => {
    const result = await hostAdbCheck.run(fakeDoctorContext({ hostAdb: { countAdbProcesses: async () => 1, probeCoreStats: async () => null } }))
    expect(result.status).toBe('ok')
  })

  test('warns when several adb processes exist and no core is reporting to explain them', async () => {
    const result = await hostAdbCheck.run(fakeDoctorContext({ hostAdb: { countAdbProcesses: async () => 3, probeCoreStats: async () => null } }))
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('Get-Process')
  })

  test('ok when the running core accounts for every adb process (children + long-lived + the server itself)', async () => {
    const ctx = fakeDoctorContext({
      hostAdb: {
        countAdbProcesses: async () => 4, // 1 exec + 2 long-lived (scrcpy) + 1 adb server
        probeCoreStats: async () => ({ running: 1, maxConcurrent: 4, installsRunning: 0, longLived: 2 }),
      },
    })
    const result = await hostAdbCheck.run(ctx)
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('4 adb process(es)')
  })

  test('warns with a remedy when the core cannot account for every adb process found', async () => {
    const ctx = fakeDoctorContext({
      hostAdb: {
        countAdbProcesses: async () => 6,
        probeCoreStats: async () => ({ running: 0, maxConcurrent: 4, installsRunning: 0, longLived: 1 }), // accounts for 2 (0 + 1 + the server)
      },
    })
    const result = await hostAdbCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.observed).toContain('unexplained')
    expect(result.remedy).toContain('crashed or force-killed')
  })
})
