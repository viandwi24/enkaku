import { describe, expect, test } from 'bun:test'
import { AdbError, isDeviceGone } from './errors'

/*
  `isDeviceGone` decides whether a failure means "no such device" or "that did
  not work". Two callers act on it and both make the SAME choice from it —
  stop retrying, park until the device is back:

  - the crash watcher, which hands it an already-stringified stream `reason`;
  - the always-on session builder, which hands it a caught `Error`.

  Getting a false NEGATIVE here is what the 2026-09-18 farm collapse was made
  of: every phrase adb uses for a missing device that this does not recognise
  becomes a retry ladder aimed at nothing, on a server that is already the
  reason the calls are failing. Getting a false POSITIVE is the opposite and
  no better — a real failure on a present device gets parked instead of
  retried, and the phone never comes back on its own.
*/

describe('isDeviceGone — adb has no such device', () => {
  test.each([
    "device 'R9RY90A6X4X' not found",
    "AdbError: device 'LZ0A36IDBD5172264' not found",
    'device not found',
    'device offline',
    'Device Offline',
  ])('%s is the device being gone', (message) => {
    expect(isDeviceGone(message)).toBe(true)
    expect(isDeviceGone(new Error(message))).toBe(true)
  })

  /** The exact shape the build path catches — `AdbError`, not a bare `Error`. */
  test('an AdbError carrying the not-found text is recognised', () => {
    expect(isDeviceGone(new AdbError('E_ADB_FAIL', "device 'R9RL409HHEM' not found"))).toBe(true)
  })

  test.each([
    'the scrcpy server never answered on port 65360: Error: Failed to connect',
    'exec timed out after 5000ms',
    'stream limit reached',
    'the instrumentation finished before the server was up',
    '',
  ])('%s is NOT the device being gone', (message) => {
    expect(isDeviceGone(message)).toBe(false)
    expect(isDeviceGone(new Error(message))).toBe(false)
  })

  /**
   * A device that is merely UNAUTHORIZED is present — it is on the bus and the
   * operator can accept the RSA prompt on its screen. Parking it until it
   * "comes back" would wait for an event that never fires.
   */
  test('an unauthorized device is present, not gone', () => {
    expect(isDeviceGone('device unauthorized')).toBe(false)
  })

  test('a non-Error, non-string value is stringified rather than thrown on', () => {
    expect(isDeviceGone(null)).toBe(false)
    expect(isDeviceGone(undefined)).toBe(false)
    expect(isDeviceGone({ message: "device 'X' not found" })).toBe(false)
  })
})
