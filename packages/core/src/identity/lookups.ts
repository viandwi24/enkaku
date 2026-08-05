/**
 * Static lookup tables for the identity "sync with proxy" affordance (plan 58
 * §3.4, §4.7). These turn a route's observed exit (Plan 55's `GeoObservation`)
 * into suggested timezone / locale / GPS values. They are deliberately a small,
 * dependency-free, pure module: no geocoding API call, no vendor lock-in — a
 * lookup that cannot answer returns `undefined`, and the sync endpoint surfaces
 * "no suggestion" rather than a guess (the same honesty rule as the geo check).
 *
 * Coverage is intentionally the top handful of countries/cities a social-media
 * farm actually targets; extending a table is a one-line change. A farm needing
 * arbitrary city -> coordinates should point at a self-hosted geocoder later
 * (plan 58 §9 Q3), which is why `cityToGps` is a plain function, not a constant.
 */

/**
 * Country (ISO 3166-1 alpha-2) -> representative IANA timezone. Countries with
 * several zones use the most populous business centre; the operator can always
 * override the suggestion before applying (plan 58 §3.4).
 */
const COUNTRY_TIMEZONE: Record<string, string> = {
  US: 'America/New_York',
  GB: 'Europe/London',
  JP: 'Asia/Tokyo',
  ID: 'Asia/Jakarta',
  SG: 'Asia/Singapore',
  MY: 'Asia/Kuala_Lumpur',
  TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh',
  PH: 'Asia/Manila',
  IN: 'Asia/Kolkata',
  AU: 'Australia/Sydney',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  NL: 'Europe/Amsterdam',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
  BR: 'America/Sao_Paulo',
  MX: 'America/Mexico_City',
  CA: 'America/Toronto',
  KR: 'Asia/Seoul',
  AE: 'Asia/Dubai',
  TR: 'Europe/Istanbul',
  ZA: 'Africa/Johannesburg',
  NZ: 'Pacific/Auckland',
}

/**
 * Country (ISO 3166-1 alpha-2) -> a representative BCP 47 locale tag. Uses the
 * hyphen form Android's `persist.sys.locale` accepts (`setprop` reads BCP 47).
 */
const COUNTRY_LOCALE: Record<string, string> = {
  US: 'en-US',
  GB: 'en-GB',
  JP: 'ja-JP',
  ID: 'id-ID',
  SG: 'en-SG',
  MY: 'ms-MY',
  TH: 'th-TH',
  VN: 'vi-VN',
  PH: 'en-PH',
  IN: 'en-IN',
  AU: 'en-AU',
  DE: 'de-DE',
  FR: 'fr-FR',
  NL: 'nl-NL',
  ES: 'es-ES',
  IT: 'it-IT',
  BR: 'pt-BR',
  MX: 'es-MX',
  CA: 'en-CA',
  KR: 'ko-KR',
  AE: 'ar-AE',
  TR: 'tr-TR',
  ZA: 'en-ZA',
  NZ: 'en-NZ',
}

/**
 * City name -> approximate GPS fix. Keys are matched case-insensitively. These
 * are city-centre coordinates; a residential exit rarely sits exactly at one,
 * but city-centre is close enough for a mock fix that only needs to read as
 * "in this city" (plan 58 §3.4). Extending this is the one thing a farm with
 * exotic targets will do first.
 */
const CITY_GPS: Record<string, { lat: number; lng: number }> = {
  'new york': { lat: 40.7128, lng: -74.006 },
  'los angeles': { lat: 34.0522, lng: -118.2437 },
  chicago: { lat: 41.8781, lng: -87.6298 },
  london: { lat: 51.5074, lng: -0.1278 },
  tokyo: { lat: 35.6762, lng: 139.6503 },
  jakarta: { lat: -6.2088, lng: 106.8456 },
  surabaya: { lat: -7.2575, lng: 112.7521 },
  singapore: { lat: 1.3521, lng: 103.8198 },
  'kuala lumpur': { lat: 3.139, lng: 101.6869 },
  bangkok: { lat: 13.7563, lng: 100.5018 },
  'ho chi minh city': { lat: 10.8231, lng: 106.6297 },
  manila: { lat: 14.5995, lng: 120.9842 },
  sydney: { lat: -33.8688, lng: 151.2093 },
  berlin: { lat: 52.52, lng: 13.405 },
  paris: { lat: 48.8566, lng: 2.3522 },
  amsterdam: { lat: 52.3676, lng: 4.9041 },
  madrid: { lat: 40.4168, lng: -3.7038 },
  rome: { lat: 41.9028, lng: 12.4964 },
  'sao paulo': { lat: -23.5505, lng: -46.6333 },
  'mexico city': { lat: 19.4326, lng: -99.1332 },
  toronto: { lat: 43.6532, lng: -79.3832 },
  seoul: { lat: 37.5665, lng: 126.978 },
  dubai: { lat: 25.2048, lng: 55.2708 },
  istanbul: { lat: 41.0082, lng: 28.9784 },
  johannesburg: { lat: -26.2041, lng: 28.0473 },
  auckland: { lat: -36.8485, lng: 174.7633 },
}

/** Case-insensitive, trimmed key — geo providers vary in casing/whitespace. */
function norm(value: string): string {
  return value.trim().toLowerCase()
}

/** Country -> representative IANA timezone, or `undefined` when unknown. */
export function countryToTimezone(country: string): string | undefined {
  return COUNTRY_TIMEZONE[country.trim().toUpperCase()]
}

/** Country -> representative BCP 47 locale, or `undefined` when unknown. */
export function countryToLocale(country: string): string | undefined {
  return COUNTRY_LOCALE[country.trim().toUpperCase()]
}

/** City -> approximate GPS fix, or `undefined` when unknown. */
export function cityToGps(city: string): { lat: number; lng: number } | undefined {
  return CITY_GPS[norm(city)]
}
