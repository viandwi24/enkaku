import { describe, expect, test } from 'bun:test'
import { countryToLocale, countryToTimezone, cityToGps } from './lookups'

describe('identity lookups', () => {
  test('countryToTimezone returns a timezone for a known country', () => {
    expect(countryToTimezone('US')).toBe('America/New_York')
    expect(countryToTimezone('ID')).toBe('Asia/Jakarta')
  })

  test('countryToTimezone is case- and whitespace-insensitive', () => {
    expect(countryToTimezone(' us ')).toBe('America/New_York')
    expect(countryToTimezone('jp')).toBe('Asia/Tokyo')
  })

  test('countryToTimezone returns undefined for an unknown country', () => {
    expect(countryToTimezone('XX')).toBeUndefined()
    expect(countryToTimezone('')).toBeUndefined()
  })

  test('countryToLocale returns a BCP 47 tag for a known country', () => {
    expect(countryToLocale('US')).toBe('en-US')
    expect(countryToLocale('jp')).toBe('ja-JP')
  })

  test('countryToLocale returns undefined for an unknown country', () => {
    expect(countryToLocale('ZZ')).toBeUndefined()
  })

  test('cityToGps returns a fix for a known city, case-insensitively', () => {
    expect(cityToGps('New York')).toEqual({ lat: 40.7128, lng: -74.006 })
    expect(cityToGps('  JAKARTA ')).toEqual({ lat: -6.2088, lng: 106.8456 })
  })

  test('cityToGps returns undefined for an unknown city', () => {
    expect(cityToGps('Atlantis')).toBeUndefined()
    expect(cityToGps('')).toBeUndefined()
  })

  test('GPS fixes are within real-world bounds', () => {
    for (const city of ['new york', 'tokyo', 'sydney', 'sao paulo']) {
      const fix = cityToGps(city)
      expect(fix).toBeDefined()
      expect(fix!.lat).toBeGreaterThanOrEqual(-90)
      expect(fix!.lat).toBeLessThanOrEqual(90)
      expect(fix!.lng).toBeGreaterThanOrEqual(-180)
      expect(fix!.lng).toBeLessThanOrEqual(180)
    }
  })
})
