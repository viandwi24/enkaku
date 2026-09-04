import { describe, expect, test } from 'bun:test'
import { parseForwardListLine, shouldRemoveBootForward, type BootForwardCleanupConfig } from './boot-forward-cleanup'

const cfg: BootForwardCleanupConfig = { uiServerDevicePort: 9008, uiServerRangeStart: 27100, uiServerRangeEnd: 27299 }

/** Mirrors `isOwnScrcpyForwardRemote` (`@enkaku/scrcpy`) without importing the real package, so this test stays a pure unit test of the merge logic. */
const isOwnScrcpyForwardRemote = (remote: string) => /^localabstract:scrcpy_7f[0-9a-f]{6}$/.test(remote)

describe('shouldRemoveBootForward', () => {
  test('matches a ui-server entry inside the configured range', () => {
    expect(shouldRemoveBootForward({ serial: 'SER1', local: 'tcp:27150', remote: 'tcp:9008' }, cfg, isOwnScrcpyForwardRemote)).toBe(true)
  })

  test('rejects a ui-server-shaped remote outside the range', () => {
    expect(shouldRemoveBootForward({ serial: 'SER1', local: 'tcp:30000', remote: 'tcp:9008' }, cfg, isOwnScrcpyForwardRemote)).toBe(false)
  })

  test('matches an own-scrcpy remote regardless of local port', () => {
    expect(
      shouldRemoveBootForward({ serial: 'SER1', local: 'tcp:54321', remote: 'localabstract:scrcpy_7f00aabb' }, cfg, isOwnScrcpyForwardRemote),
    ).toBe(true)
  })

  test('rejects an unrelated forward', () => {
    expect(
      shouldRemoveBootForward({ serial: 'SER1', local: 'tcp:54321', remote: 'localabstract:some_other_socket' }, cfg, isOwnScrcpyForwardRemote),
    ).toBe(false)
  })
})

describe('parseForwardListLine', () => {
  test('parses a well-formed line', () => {
    expect(parseForwardListLine('SER1 tcp:27150 tcp:9008')).toEqual({ serial: 'SER1', local: 'tcp:27150', remote: 'tcp:9008' })
  })

  test('returns null for a blank or short line', () => {
    expect(parseForwardListLine('')).toBeNull()
    expect(parseForwardListLine('   ')).toBeNull()
    expect(parseForwardListLine('SER1 tcp:27150')).toBeNull()
  })
})
