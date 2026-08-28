import type { UiNode } from '@enkaku/protocol'
import { visibleStrings } from './tree'

/** The device-scoped KV key this pack stores its account snapshot under. */
export const ACCOUNTS_KEY = 'google:accounts'

/**
 * An address shaped like an email, found in a UI tree.
 *
 * Deliberately narrower than a general email grammar and deliberately anchored:
 * this runs over EVERY string on the screen, including help text and settings
 * summaries, and a permissive pattern turns "contact us at support@…" in a
 * footer into an account. Anchoring to the whole trimmed string means only a
 * label that is nothing but an address counts, which is what an account row is.
 *
 * Not hardware-verified. See `snapshotAccounts`' own header for what that
 * means for how the result is reported.
 */
const EMAIL_ONLY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** How much the screen actually corroborated what is being reported. Never collapsed into a bare list — see `snapshot-accounts.ts`. */
export type AccountsEvidence = 'parsed' | 'screen-not-recognised'

export interface AccountsSnapshot {
  /** Every email-shaped string on the screen, in the order the tree presented them. */
  accounts: string[]
  evidence: AccountsEvidence
  /** Unix seconds. */
  readAt: number
}

/**
 * Reads addresses out of a dumped accounts screen.
 *
 * `evidence` is the load-bearing field. An empty list has two completely
 * different meanings — "this device has no Google account" and "this is not
 * the screen we thought it was" — and reporting both as `accounts: []` is the
 * kind of quiet lie this repo has paid for before (a modem with no data plan
 * reporting `Up`, plan 134). So the parse says which:
 *
 * - `parsed` — the tree came from the settings package and was read.
 * - `screen-not-recognised` — it did not, so the empty list is a statement
 *   about this parser, not about the device.
 *
 * `settingsPackages` is passed in rather than hardcoded because "which package
 * owns Settings" is an OEM fact, and the owner's farm is Samsung.
 */
export function readAccountsFrom(tree: UiNode, settingsPackages: readonly string[], now: number): AccountsSnapshot {
  const onSettings = settingsPackages.some((pkg) => tree.packageName === pkg || tree.packageName.startsWith(`${pkg}.`))
  if (!onSettings) return { accounts: [], evidence: 'screen-not-recognised', readAt: now }
  return {
    accounts: visibleStrings(tree).filter((value) => EMAIL_ONLY.test(value)),
    evidence: 'parsed',
    readAt: now,
  }
}
