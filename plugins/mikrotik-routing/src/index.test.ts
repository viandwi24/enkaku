import { describe, expect, test } from 'bun:test'
import activateGroupScript from './activate-group'
import discoverLanIpScript from './discover-lan-ip'
import plugin, { checkScript } from './index'
import verifyEgressScript from './verify-egress'

/**
 * A smoke test for the plugin manifest itself. Step 122.1 only needed the
 * package to be a valid, importable plugin; step 122.3 adds the real
 * manifest — the capability list §4.10 declares, the service, and the
 * tier-C surface — so this file grows the assertions those add, still kept
 * far smaller than `plugins/proxy-manager/src/index.test.ts`'s own (that
 * pack's screen has years of iteration behind it; this one has one step).
 */

describe('the plugin manifest', () => {
  test('definePlugin accepts it — id, version, and four member scripts (122.10 adds three)', () => {
    expect(plugin.id).toBe('mikrotik-routing')
    expect(plugin.version).toBe('0.10.0')
    expect(plugin.scripts).toHaveLength(4)
    expect(plugin.scripts.map((s) => s.id)).toEqual(['check', 'verify-egress', 'discover-lan-ip', 'activate-group'])
  })
})

describe('checkScript — honest about doing nothing yet', () => {
  test('is a real script (declared params/result and a run function), not a stub the runner would reject', () => {
    expect(typeof checkScript.run).toBe('function')
    expect(checkScript.params.safeParse({}).success).toBe(true)
    expect(checkScript.result?.safeParse({ ok: false })).toMatchObject({ success: true })
  })
})

describe('the three member scripts (122.10) — real scripts the runner would accept, not stubs', () => {
  test('verify-egress declares empty params, a real result schema, and a run function', () => {
    expect(typeof verifyEgressScript.run).toBe('function')
    expect(verifyEgressScript.params.safeParse({}).success).toBe(true)
    expect(verifyEgressScript.result?.safeParse({ publicIp: '1.2.3.4', expectedPath: 'via-modem1', matches: null })).toMatchObject({ success: true })
  })

  test('discover-lan-ip declares empty params, a real result schema, and a run function', () => {
    expect(typeof discoverLanIpScript.run).toBe('function')
    expect(discoverLanIpScript.params.safeParse({}).success).toBe(true)
    expect(discoverLanIpScript.result?.safeParse({ resolved: true, lanIp: '192.168.10.215', reason: null })).toMatchObject({ success: true })
  })

  test('activate-group requires a group id, defaults force to false, and declares a run function', () => {
    expect(typeof activateGroupScript.run).toBe('function')
    expect(activateGroupScript.params.safeParse({}).success).toBe(false)
    const parsed = activateGroupScript.params.safeParse({ group: 'jadwal-1' })
    expect(parsed).toMatchObject({ success: true, data: { group: 'jadwal-1', force: false } })
    expect(activateGroupScript.result?.safeParse({ ok: true, code: null, message: null })).toMatchObject({ success: true })
  })
})

describe('the capability list (§4.10, acceptance criterion 8)', () => {
  test('is exactly device.list, device.get, job.run, notify.send — no more, no fewer', () => {
    expect(plugin.service?.permissions).toEqual(['device.list', 'device.get', 'job.run', 'notify.send'])
  })

  test('declares no device-control capability of any kind — the plugin never touches a phone', () => {
    const permissions = plugin.service?.permissions ?? []
    // A literal grep-shaped check, mirroring criterion 8's own wording: no
    // entry names a device WRITE/control surface (network, shell, input,
    // clipboard, transfer, the adb endpoint, …) — only the two read
    // capabilities (`device.list`, `device.get`) may start with `device.`.
    for (const id of permissions) {
      if (id.startsWith('device.')) {
        expect(['device.list', 'device.get']).toContain(id)
      }
    }
  })

  test('declares no listeners and no resetData — nothing here opens a port or claims extra authority yet', () => {
    expect(plugin.service?.listeners ?? []).toHaveLength(0)
    expect(plugin.service?.onResetData).toBeUndefined()
  })
})

describe('the tier-C surface', () => {
  test('one nav entry and one view, both id "routing", react entry index.js', () => {
    expect(plugin.surface?.nav).toHaveLength(1)
    expect(plugin.surface?.nav[0]?.view).toBe('routing')
    const view = plugin.surface?.views.routing
    expect(view?.react?.entry).toBe('index.js')
  })
})
