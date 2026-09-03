import { describe, expect, test } from 'bun:test'
import { DeviceInfoSchema, type DeviceInfo } from '@enkaku/protocol'
import { buildIdentityBridge, resolveDeviceLan, type StoredLanCandidates } from './identity-bridge'
import type { Lease } from './router-driver'

/**
 * Plan 122 §3.4 / §4.9 / step 122.4 / §7 ("122.4: bridge tests over fixture
 * `DeviceInfo` payloads — a tcp device yields an address, a USB device
 * yields *needs an address* rather than a guess, a dynamic lease raises the
 * warning"). Pure, no I/O — every input is plain data.
 *
 * `DeviceInfoSchema.parse(...)` builds each fixture rather than a hand-typed
 * object literal, so every field this module does not care about (battery,
 * readiness, activities, ...) comes from the schema's own defaults and a
 * malformed fixture fails the test file loudly instead of silently drifting
 * from the real `DeviceInfo` shape.
 */

function makeDevice(overrides: { id?: string; stableId?: string; label?: string; connection: DeviceInfo['connection'] }): DeviceInfo {
  return DeviceInfoSchema.parse({
    id: overrides.id ?? 'dev-1',
    stableId: overrides.stableId ?? 'stable-1',
    serial: overrides.connection.kind === 'tcp' ? `${overrides.connection.address}:${overrides.connection.port}` : 'usbserial-1',
    label: overrides.label ?? 'Flip4-01',
    androidVersion: null,
    apiLevel: null,
    screenW: null,
    screenH: null,
    density: null,
    status: 'idle',
    lastSeen: null,
    connection: overrides.connection,
  })
}

const tcpConnection: DeviceInfo['connection'] = { kind: 'tcp', medium: 'wired', mediumSource: 'declared', address: '192.168.10.215', port: 5555, networkLabel: null }
const usbConnection: DeviceInfo['connection'] = { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null }

const NO_LEASES: Lease[] = []

function lease(overrides: Partial<Lease> & Pick<Lease, 'address' | 'dynamic'>): Lease {
  return { id: overrides.id ?? '*1', macAddress: overrides.macAddress ?? null, status: overrides.status ?? 'bound', ...overrides }
}

describe('resolveDeviceLan — tier order (§3.4: transport > probe > manual)', () => {
  test('a tcp device yields its exact, live connection.address as `transport`, regardless of any stored value', () => {
    const device = makeDevice({ connection: tcpConnection })
    const stored: StoredLanCandidates = { probe: '10.0.0.9', manual: '10.0.0.10' }
    const result = resolveDeviceLan(device, stored, NO_LEASES)
    expect(result).toEqual({
      deviceId: 'dev-1',
      stableId: 'stable-1',
      label: 'Flip4-01',
      state: 'resolved',
      lanIp: '192.168.10.215',
      lanIpSource: 'transport',
      leaseKind: 'none',
      lease: null,
    })
  })

  test('a USB device with no stored value yields `needs-address` — not hidden, not guessed', () => {
    const device = makeDevice({ connection: usbConnection })
    const result = resolveDeviceLan(device, undefined, NO_LEASES)
    expect(result).toEqual({ deviceId: 'dev-1', stableId: 'stable-1', label: 'Flip4-01', state: 'needs-address' })
  })

  test('a USB device with only a manual value falls back to `manual`', () => {
    const device = makeDevice({ connection: usbConnection })
    const stored: StoredLanCandidates = { probe: null, manual: '192.168.10.230' }
    const result = resolveDeviceLan(device, stored, NO_LEASES)
    expect(result.state).toBe('resolved')
    if (result.state === 'resolved') {
      expect(result.lanIp).toBe('192.168.10.230')
      expect(result.lanIpSource).toBe('manual')
    }
  })

  test('a USB device with both a probe and a manual value prefers `probe`', () => {
    const device = makeDevice({ connection: usbConnection })
    const stored: StoredLanCandidates = { probe: '192.168.10.231', manual: '192.168.10.230' }
    const result = resolveDeviceLan(device, stored, NO_LEASES)
    expect(result.state).toBe('resolved')
    if (result.state === 'resolved') {
      expect(result.lanIp).toBe('192.168.10.231')
      expect(result.lanIpSource).toBe('probe')
    }
  })
})

describe('resolveDeviceLan — lease cross-check by IP, never MAC (§3.4, §0.3 item 3)', () => {
  test('the resolved IP has a dynamic lease: leaseKind is `dynamic`, raising the warning', () => {
    const device = makeDevice({ connection: tcpConnection })
    const leases = [lease({ id: '*30', address: '192.168.10.215', dynamic: true })]
    const result = resolveDeviceLan(device, undefined, leases)
    expect(result.state).toBe('resolved')
    if (result.state === 'resolved') {
      expect(result.leaseKind).toBe('dynamic')
      expect(result.lease?.id).toBe('*30')
    }
  })

  test('the resolved IP has a static lease: leaseKind is `static`, no warning', () => {
    const device = makeDevice({ connection: tcpConnection })
    const leases = [lease({ id: '*31', address: '192.168.10.215', dynamic: false })]
    const result = resolveDeviceLan(device, undefined, leases)
    expect(result.state).toBe('resolved')
    if (result.state === 'resolved') {
      expect(result.leaseKind).toBe('static')
      expect(result.lease?.id).toBe('*31')
    }
  })

  test('the resolved IP has no lease at all: leaseKind is `none`, distinguishable from both static and dynamic', () => {
    const device = makeDevice({ connection: tcpConnection })
    const leases = [lease({ id: '*32', address: '192.168.10.216', dynamic: true })] // a different address entirely
    const result = resolveDeviceLan(device, undefined, leases)
    expect(result.state).toBe('resolved')
    if (result.state === 'resolved') {
      expect(result.leaseKind).toBe('none')
      expect(result.lease).toBeNull()
    }
  })

  test('a lease is matched by IP even though the lease also carries a MAC this module never reads', () => {
    const device = makeDevice({ connection: tcpConnection })
    const leases = [lease({ id: '*33', address: '192.168.10.215', dynamic: true, macAddress: 'AA:BB:CC:DD:EE:99' })]
    const result = resolveDeviceLan(device, undefined, leases)
    expect(result.state).toBe('resolved')
    if (result.state === 'resolved') expect(result.leaseKind).toBe('dynamic')
  })
})

describe('buildIdentityBridge — the whole fleet at once', () => {
  test('mixes resolved and needs-address devices, keeps stored candidates keyed by deviceId, and cross-checks each independently', () => {
    const tcpDevice = makeDevice({ id: 'dev-tcp', stableId: 'stable-tcp', connection: tcpConnection })
    const usbDeviceNoStore = makeDevice({ id: 'dev-usb-1', stableId: 'stable-usb-1', connection: usbConnection })
    const usbDeviceWithManual = makeDevice({ id: 'dev-usb-2', stableId: 'stable-usb-2', connection: usbConnection })

    const leases = [lease({ id: '*30', address: '192.168.10.215', dynamic: true }), lease({ id: '*40', address: '192.168.10.240', dynamic: false })]

    const stored = new Map<string, StoredLanCandidates>([['dev-usb-2', { probe: null, manual: '192.168.10.240' }]])

    const results = buildIdentityBridge([tcpDevice, usbDeviceNoStore, usbDeviceWithManual], leases, stored)

    expect(results).toHaveLength(3)

    const byId = new Map(results.map((r) => [r.deviceId, r]))

    const tcpResult = byId.get('dev-tcp')
    expect(tcpResult?.state).toBe('resolved')
    if (tcpResult?.state === 'resolved') {
      expect(tcpResult.lanIp).toBe('192.168.10.215')
      expect(tcpResult.lanIpSource).toBe('transport')
      expect(tcpResult.leaseKind).toBe('dynamic')
    }

    expect(byId.get('dev-usb-1')).toEqual({ deviceId: 'dev-usb-1', stableId: 'stable-usb-1', label: 'Flip4-01', state: 'needs-address' })

    const manualResult = byId.get('dev-usb-2')
    expect(manualResult?.state).toBe('resolved')
    if (manualResult?.state === 'resolved') {
      expect(manualResult.lanIp).toBe('192.168.10.240')
      expect(manualResult.lanIpSource).toBe('manual')
      expect(manualResult.leaseKind).toBe('static')
    }
  })

  test('an empty fleet yields an empty result, not an error', () => {
    expect(buildIdentityBridge([], NO_LEASES)).toEqual([])
  })
})
