import { describe, expect, test } from 'bun:test'
import { shellQuote, type AdbClient } from '@enkaku/adb'
import { createSession } from './session'
import type { Logger } from './logger'

/**
 * `DeviceSession.clipboard`'s adb fallback shim (plan 38 §3.5, §4.4,
 * acceptance #8): when a session has no scrcpy control socket — the
 * `screencap-loop` path, exercised here by simply not supplying `makeScrcpy`
 * — `get()` must REFUSE with `E_CLIPBOARD_UNAVAILABLE` rather than resolving
 * with `""`, which would be indistinguishable from "the clipboard genuinely
 * is empty". `set()` still best-effort attempts `cmd clipboard set-text`
 * over adb.
 */

const silentLog = (): Logger => {
  const l = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => l,
  }
  return l as unknown as Logger
}

describe('DeviceSession.clipboard — the adb fallback shim (plan 38 §3.5, §4.4, acceptance #8)', () => {
  test('with no scrcpy control socket, get() rejects E_CLIPBOARD_UNAVAILABLE — never an empty string', async () => {
    const client = { exec: async () => '' } as unknown as AdbClient
    const session = await createSession(
      { deviceId: 'd1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog() },
    )
    expect(session.clipboard).not.toBeNull()
    await expect(session.clipboard?.get()).rejects.toMatchObject({ code: 'E_CLIPBOARD_UNAVAILABLE' })
  })

  test('set() attempts `cmd clipboard set-text` with the shell-quoted text over adb', async () => {
    const calls: string[] = []
    const client = {
      exec: async (_serial: string, cmd: string) => {
        calls.push(cmd)
        return ''
      },
    } as unknown as AdbClient
    const session = await createSession(
      { deviceId: 'd1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog() },
    )
    const text = "hello 'world'; rm -rf /"
    await session.clipboard?.set(text)
    const setCmd = calls.find((c) => c.startsWith('cmd clipboard set-text'))
    expect(setCmd).toBeDefined()
    expect(setCmd).toBe(`cmd clipboard set-text ${shellQuote(text)}`)
  })

  test('set() ignores the paste option on the adb path — no equivalent exists there', async () => {
    const calls: string[] = []
    const client = {
      exec: async (_serial: string, cmd: string) => {
        calls.push(cmd)
        return ''
      },
    } as unknown as AdbClient
    const session = await createSession(
      { deviceId: 'd1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog() },
    )
    await expect(session.clipboard?.set('x', { paste: true })).resolves.toBeUndefined()
    expect(calls.some((c) => c.includes('cmd clipboard set-text'))).toBe(true)
  })
})
