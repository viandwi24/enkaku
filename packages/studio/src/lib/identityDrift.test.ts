import { describe, expect, test } from 'bun:test'
import type { DeviceIdentity } from './api'
import { computeIdentityDrift, hasIdentityDrift } from './identityDrift'

describe('computeIdentityDrift (plan 58 §3.5, §4.6, §5.8)', () => {
  test('no suggestion (no geo observation yet) means no drift on any field', () => {
    const identity: DeviceIdentity = { timezone: 'Asia/Jakarta' }
    expect(computeIdentityDrift(identity, null)).toEqual({ timezone: false, locale: false, gps: false })
  })

  test('a matching identity has no drift', () => {
    const identity: DeviceIdentity = { timezone: 'America/New_York', locale: 'en-US', gps: { lat: 40.71, lng: -74.0 } }
    const suggestion: DeviceIdentity = { timezone: 'America/New_York', locale: 'en-US', gps: { lat: 40.7128, lng: -74.006 } }
    expect(computeIdentityDrift(identity, suggestion)).toEqual({ timezone: false, locale: false, gps: false })
  })

  test('a mismatched timezone drifts, independently of locale/gps', () => {
    const identity: DeviceIdentity = { timezone: 'Asia/Jakarta', locale: 'en-US' }
    const suggestion: DeviceIdentity = { timezone: 'America/New_York', locale: 'en-US' }
    expect(computeIdentityDrift(identity, suggestion)).toEqual({ timezone: true, locale: false, gps: false })
  })

  test('a mismatched locale drifts', () => {
    const identity: DeviceIdentity = { locale: 'id-ID' }
    const suggestion: DeviceIdentity = { locale: 'en-US' }
    expect(computeIdentityDrift(identity, suggestion).locale).toBe(true)
  })

  test('gps far from the suggestion drifts; a small residential wobble does not', () => {
    const suggestion: DeviceIdentity = { gps: { lat: 40.7128, lng: -74.006 } }
    const nearby: DeviceIdentity = { gps: { lat: 40.72, lng: -74.01 } }
    const farAway: DeviceIdentity = { gps: { lat: -6.2088, lng: 106.8456 } } // Jakarta
    expect(computeIdentityDrift(nearby, suggestion).gps).toBe(false)
    expect(computeIdentityDrift(farAway, suggestion).gps).toBe(true)
  })

  test('no gps set at all counts as drift once the proxy suggests one', () => {
    const identity: DeviceIdentity = {}
    const suggestion: DeviceIdentity = { gps: { lat: 1, lng: 2 } }
    expect(computeIdentityDrift(identity, suggestion).gps).toBe(true)
  })

  test('a field absent from the SUGGESTION (unknown city/country) is never flagged as drift', () => {
    const identity: DeviceIdentity = { timezone: 'Asia/Jakarta', gps: { lat: -6.2, lng: 106.8 } }
    const suggestion: DeviceIdentity = {} // country/city unrecognised by the lookup tables
    expect(computeIdentityDrift(identity, suggestion)).toEqual({ timezone: false, locale: false, gps: false })
  })
})

describe('hasIdentityDrift', () => {
  test('false when every field agrees', () => {
    expect(hasIdentityDrift({ timezone: false, locale: false, gps: false })).toBe(false)
  })

  test('true when any single field drifted', () => {
    expect(hasIdentityDrift({ timezone: false, locale: true, gps: false })).toBe(true)
  })
})
