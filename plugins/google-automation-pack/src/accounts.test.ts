import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { readAccountsFrom } from './accounts'

const PACKAGES = ['com.android.settings', 'com.samsung.android.settings'] as const

function node(partial: Partial<UiNode> & { packageName?: string }): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.TextView',
    packageName: 'com.android.settings',
    bounds: { left: 0, top: 0, right: 100, bottom: 40 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

function screen(pkg: string, labels: string[]): UiNode {
  return node({
    packageName: pkg,
    className: 'android.widget.FrameLayout',
    children: labels.map((text, index) => node({ text, packageName: pkg, index })),
  })
}

describe('readAccountsFrom', () => {
  test('reads the addresses an accounts screen lists, in tree order', () => {
    const tree = screen('com.android.settings', ['Accounts', 'farm.device07@gmail.com', 'Google', 'farm.device07b@gmail.com', 'Add account'])
    expect(readAccountsFrom(tree, PACKAGES, 1_700_000_000)).toEqual({
      accounts: ['farm.device07@gmail.com', 'farm.device07b@gmail.com'],
      evidence: 'parsed',
      readAt: 1_700_000_000,
    })
  })

  /**
   * The whole reason `evidence` exists. An empty list has two unrelated
   * meanings — "this device has no Google account" and "this is not the screen
   * we thought it was" — and collapsing both into `accounts: []` is the same
   * quiet lie plan 134 spent a whole milestone removing from path health.
   */
  test('a tree from some other app is `screen-not-recognised`, not an empty account list', () => {
    const tree = screen('com.android.chrome', ['someone@example.com'])
    expect(readAccountsFrom(tree, PACKAGES, 5)).toEqual({ accounts: [], evidence: 'screen-not-recognised', readAt: 5 })
  })

  test('a real settings screen with no account on it IS an empty list, and says so', () => {
    const tree = screen('com.android.settings', ['Accounts', 'Add account'])
    expect(readAccountsFrom(tree, PACKAGES, 5)).toMatchObject({ accounts: [], evidence: 'parsed' })
  })

  test("Samsung's own settings package is recognised — the owner's farm is One UI", () => {
    const tree = screen('com.samsung.android.settings', ['device21@gmail.com'])
    expect(readAccountsFrom(tree, PACKAGES, 5)).toMatchObject({ accounts: ['device21@gmail.com'], evidence: 'parsed' })
  })

  test('a sub-package of settings counts as settings', () => {
    const tree = screen('com.android.settings.accounts', ['device21@gmail.com'])
    expect(readAccountsFrom(tree, PACKAGES, 5).evidence).toBe('parsed')
  })

  /**
   * The anchored pattern, and why it is anchored. This parse runs over EVERY
   * string on the screen — help text, summaries, footers. A permissive email
   * regex turns a support address in a settings description into an account,
   * and a farm-wide "which device is on which account" table built on that is
   * worse than no table.
   */
  test('an address embedded in a sentence is not an account', () => {
    const tree = screen('com.android.settings', ['Need help? Write to support@google.com for more information.'])
    expect(readAccountsFrom(tree, PACKAGES, 5).accounts).toEqual([])
  })

  test('a label that is nothing but an address counts even with surrounding whitespace', () => {
    const tree = screen('com.android.settings', ['  device05@gmail.com  '])
    expect(readAccountsFrom(tree, PACKAGES, 5).accounts).toEqual(['device05@gmail.com'])
  })

  test('an address in a content description is read too — Samsung labels several rows that way', () => {
    const tree = node({
      packageName: 'com.android.settings',
      children: [node({ desc: 'device09@gmail.com' })],
    })
    expect(readAccountsFrom(tree, PACKAGES, 5).accounts).toEqual(['device09@gmail.com'])
  })

  test('the same address shown as both text and description is reported once', () => {
    const tree = node({
      packageName: 'com.android.settings',
      children: [node({ text: 'device09@gmail.com', desc: 'device09@gmail.com' })],
    })
    expect(readAccountsFrom(tree, PACKAGES, 5).accounts).toEqual(['device09@gmail.com'])
  })
})
