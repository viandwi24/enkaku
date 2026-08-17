import { describe, expect, test } from 'bun:test'
import type { Bounds } from '@enkaku/protocol'
import { AccountsSchema, parseSheetAccounts, storedPositionOf, type StoredAccounts } from './accounts'
import type { SheetRow } from './sheet'
import listAccounts from './list-accounts'

/**
 * `list-accounts` — plan 108 step 108.11's write half. Everything device-dependent lives in
 * `sheet.ts` and is exercised on hardware; what is tested here is the PURE step in between: sheet
 * rows in, the stored shape out.
 */

const box = (top: number): Bounds => ({ left: 0, top, right: 720, bottom: top + 126 })

/** A row exactly as `readSheetSnapshot` hands it over — `desc` is the username (plan 86 §4.2). */
function row(username: string, index: number, hasCheckmark = false): SheetRow {
  return { desc: username, bounds: box(1164 + index * 126), hasCheckmark }
}

describe('parseSheetAccounts — sheet rows into the stored shape', () => {
  test('numbers the slots from 1 in sheet order and marks slot 1 as the signed-in account', () => {
    const { accounts } = parseSheetAccounts([row('user2578127329501', 0, true), row('dewi_purnama280', 1)])
    expect(accounts).toEqual([
      { username: 'user2578127329501', position: 1, current: true },
      { username: 'dewi_purnama280', position: 2, current: false },
    ])
  })

  test('exactly one account is ever marked current, however many are signed in', () => {
    const { accounts } = parseSheetAccounts([row('a', 0, true), row('b', 1), row('c', 2), row('d', 3)])
    expect(accounts.filter((a) => a.current).map((a) => a.username)).toEqual(['a'])
    expect(accounts.map((a) => a.position)).toEqual([1, 2, 3, 4])
  })

  test('the checkmark on slot 1 reports `confirmed`', () => {
    expect(parseSheetAccounts([row('a', 0, true), row('b', 1)]).evidence).toBe('confirmed')
  })

  /**
   * The marker is Indonesian TalkBack's label, so a device in another UI language shows none. Plan
   * 86 §3.3 is why that is safe rather than fatal: slot 1 is the signed-in account by position, and
   * the marker only ever corroborates it. The degrade must be visible in the result — "assumed",
   * never silently reported as if it had been read.
   */
  test('no checkmark anywhere reports `assumed`, and slot 1 is STILL recorded as current', () => {
    const { accounts, evidence } = parseSheetAccounts([row('a', 0), row('b', 1)])
    expect(evidence).toBe('assumed')
    expect(accounts[0]).toEqual({ username: 'a', position: 1, current: true })
  })

  test('a checkmark on some other slot reports `moved` — and slot 1 is still the one recorded as current', () => {
    const { accounts, evidence } = parseSheetAccounts([row('a', 0), row('b', 1, true)])
    expect(evidence).toBe('moved')
    expect(accounts.map((a) => a.current)).toEqual([true, false])
  })

  test('an empty sheet parses to an empty list with no current account claimed', () => {
    const { accounts, evidence } = parseSheetAccounts([])
    expect(accounts).toEqual([])
    expect(evidence).toBe('assumed')
    // The member itself refuses to STORE this (a sheet always lists the signed-in account, so zero
    // rows is a misread, not a device with no accounts) — but the parser must still be total.
  })

  test('a single-account device — the common case — parses without a special case', () => {
    const { accounts, evidence } = parseSheetAccounts([row('only_one', 0, true)])
    expect(accounts).toEqual([{ username: 'only_one', position: 1, current: true }])
    expect(evidence).toBe('confirmed')
  })
})

describe('the stored value — what `ctx.kv.device.set` is handed', () => {
  test('the shape `run()` builds passes the schema `switch-account` reads it back with', () => {
    const { accounts } = parseSheetAccounts([row('user2578127329501', 0, true), row('dewi_purnama280', 1)])
    const value: StoredAccounts = { version: 1, accounts, readAt: 1_776_000_000 }
    expect(AccountsSchema.safeParse(value).success).toBe(true)
  })

  test('an empty account list is still a valid stored value — the refusal to write one is the member\'s decision, not the schema\'s', () => {
    expect(AccountsSchema.safeParse({ version: 1, accounts: [], readAt: 0 }).success).toBe(true)
  })

  test('round-trips: what was stored resolves back to the same slots', () => {
    const { accounts } = parseSheetAccounts([row('alice', 0, true), row('bob', 1), row('carol', 2)])
    const parsed = AccountsSchema.parse({ version: 1, accounts, readAt: 1_776_000_000 })
    expect(storedPositionOf(parsed, 'bob')).toBe(2)
    expect(storedPositionOf(parsed, 'carol')).toBe(3)
  })
})

describe('the member itself', () => {
  test('declares an id, a title, and a description — the surface renders all three (plan 108 P8)', () => {
    expect(listAccounts.id).toBe('list-accounts')
    expect(listAccounts.title).toBe('List accounts')
    expect((listAccounts.description ?? '').length).toBeGreaterThan(0)
  })

  test('declares a result schema, so the job that syncs a device also reports what it read', () => {
    expect(listAccounts.result).toBeDefined()
    const sample = { accounts: ['alice', 'bob'], count: 2, current: 'alice', currentEvidence: 'confirmed', readAt: 1_776_000_000 }
    expect(listAccounts.result?.safeParse(sample).success).toBe(true)
  })

  test('the result rejects an evidence value the parser cannot produce', () => {
    const sample = { accounts: [], count: 0, current: '', currentEvidence: 'probably', readAt: 0 }
    expect(listAccounts.result?.safeParse(sample).success).toBe(false)
  })

  test('takes no parameters — there is nothing about reading a list for an operator to decide', () => {
    expect(listAccounts.params.safeParse({}).success).toBe(true)
  })
})
