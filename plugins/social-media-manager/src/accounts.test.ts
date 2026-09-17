import { describe, expect, test } from 'bun:test'
import { looksLikeUiRow, numberAccounts } from './accounts'

/*
  0.45.2 — the app's own buttons were being stored as accounts.

  The owner found "Go to Meta Account settings" in the accounts table as Instagram SLOT 2, and
  reported the same shape on TikTok and YouTube in production. A slot is what `switch-account`
  selects by, so a phantom row is not only untidy — it can move which account a later run picks.

  Each reader already drops rows it knows BY NAME, and that list has been widened twice and missed
  anyway: `buka pengaturan` missed "Buka Pusat Akun" (0.41.0, five phones each one account too high),
  and the widened version missed "Go to Meta Account settings" because the English row opens with
  "Go to" and the pattern expected "open". These tests cover the SHAPE rule that replaces that
  treadmill, and — just as importantly — the names it must NOT eat.
*/

describe('looksLikeUiRow — what is not an account', () => {
  test('the row the owner actually found', () => {
    expect(looksLikeUiRow('Go to Meta Account settings')).toBe(true)
  })

  test('the one that got through in 0.41.0, and its English twin', () => {
    expect(looksLikeUiRow('Buka Pusat Akun')).toBe(true)
    expect(looksLikeUiRow('Open Accounts Centre')).toBe(true)
  })

  test('the action rows each reader already knew, in both languages', () => {
    for (const row of ['Add account', 'Tambah akun', 'Tambahkan Instagram', 'Manage accounts', 'Kelola akun', 'Switch account', 'Beralih akun', 'Turn on Incognito', 'Learn more about account options']) {
      expect(looksLikeUiRow(row)).toBe(true)
    }
  })

  test('a sentence is never a handle, whatever it says', () => {
    // The point of a shape rule: it catches wordings nobody has seen yet, which is what the
    // blacklist could not do. None of these has ever been observed.
    expect(looksLikeUiRow('Add a kid account')).toBe(true)
    expect(looksLikeUiRow('Manage your Google Account')).toBe(true)
    expect(looksLikeUiRow('See all your profiles here')).toBe(true)
  })

  test('empty and absurdly long strings are refused', () => {
    expect(looksLikeUiRow('')).toBe(true)
    expect(looksLikeUiRow('   ')).toBe(true)
    expect(looksLikeUiRow('a'.repeat(41))).toBe(true)
  })
})

describe('looksLikeUiRow — what it must NOT eat', () => {
  test('real handles from the owner\'s own phones', () => {
    for (const handle of ['dewi_purnama280', 'user2578127329501', 'bitorex.bkk', 'Hendisunadi', 'owner.tiktok2']) {
      expect(looksLikeUiRow(handle)).toBe(false)
    }
  })

  test('a two-word channel name survives — YouTube falls back to one when a row has no @handle', () => {
    expect(looksLikeUiRow('Hendi sunadi')).toBe(false)
    expect(looksLikeUiRow('Rizki Aditama')).toBe(false)
  })

  test('a handle that merely CONTAINS an action word is kept — the rule anchors at the start', () => {
    expect(looksLikeUiRow('addison_rae')).toBe(false)
    expect(looksLikeUiRow('view_from_bali')).toBe(false)
    expect(looksLikeUiRow('managed.by.dee')).toBe(false)
  })
})

describe('numberAccounts — filtering must not move the signed-in tick', () => {
  const rows = (...names: string[]) => names.map((username) => ({ username }))

  test('the phantom row is dropped and the remaining account keeps its slot', () => {
    const { accounts } = numberAccounts(rows('bitorex.bkk', 'Go to Meta Account settings'), 0)
    expect(accounts.map((a) => a.username)).toEqual(['bitorex.bkk'])
    expect(accounts[0]?.slot).toBe(1)
    expect(accounts[0]?.current).toBe(true)
  })

  test('a marked account AFTER a dropped row stays marked — the index is relocated, not reused', () => {
    // Without relocating, markedIndex 2 would land on 'second' once the phantom is gone.
    const { accounts } = numberAccounts(rows('first', 'Add account', 'second'), 2)
    expect(accounts.map((a) => a.username)).toEqual(['first', 'second'])
    expect(accounts.find((a) => a.current)?.username).toBe('second')
  })

  test('slots renumber densely after a drop, so slot 2 is a real account', () => {
    const { accounts } = numberAccounts(rows('first', 'Manage accounts', 'second', 'third'), 0)
    expect(accounts.map((a) => [a.username, a.slot])).toEqual([
      ['first', 1],
      ['second', 2],
      ['third', 3],
    ])
  })

  test('when the marked row itself was a UI row, nothing is marked rather than the wrong one', () => {
    const { accounts, evidence } = numberAccounts(rows('real.account', 'Switch account'), 1)
    expect(accounts.map((a) => a.username)).toEqual(['real.account'])
    // `markedIndex` became null, so `numberAccounts` falls back to slot 1 and says it assumed.
    expect(evidence).toBe('assumed')
  })

  test('a reading that was ONLY UI rows stores nothing at all', () => {
    const { accounts, evidence } = numberAccounts(rows('Add account', 'Go to Meta Account settings'), 0)
    expect(accounts).toEqual([])
    expect(evidence).toBe('none')
  })
})
