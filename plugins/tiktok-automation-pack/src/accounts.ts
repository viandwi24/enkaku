import { z } from 'zod'
import { detectCurrentIndex, type SheetRow } from './sheet'

/**
 * What this plugin stores about a device's TikTok accounts, and the pure functions that read and
 * write that shape.
 *
 * The one definition, shared by both members (plan 108 §5 step 108.11): `list-accounts` writes it,
 * `switch-account` reads it, and neither declares a namespace — a plugin's KV namespace is its
 * plugin id, resolved parent-side, and every member of one plugin sees the same one (plan 108 §3.1,
 * finding G2). This module is where that guarantee stops being a claim in a plan and becomes two
 * imports of one schema.
 *
 * DEVICE scope, not global, by plan 108 §3.1's own rule: *if forgetting the device should forget the
 * fact, it is device-scoped.* Which accounts are signed in on a phone is a fact about that phone —
 * a forgotten device's entry goes with it, in the same transaction that removes the device.
 */

/** The KV key, spelled once: the surface's `kv.scan` reads the same string the members write. */
export const ACCOUNTS_KEY = 'accounts'

export const StoredAccountSchema = z
  .object({
    /** The row's own `desc` on the switch-account sheet, which is the account's unique username (plan 86 §4.2). */
    username: z.string().min(1),
    /** 1-based slot in the sheet, "Tambah akun" already excluded — the same numbering `switch-account`'s `target` accepts. */
    position: z.number().int().positive(),
    /** True for exactly one account: position 1, the one signed in (plan 86 §3.3). */
    current: z.boolean(),
  })
  .strict()
export type StoredAccount = z.infer<typeof StoredAccountSchema>

/**
 * `version` is a literal, not a range, and the object is `.strict()`, on purpose. `ctx.kv.device.get`
 * THROWS when a stored value no longer matches the schema it is handed, and that throw is exactly
 * the signal `switch-account` needs: a value written by a future member is a value this code must
 * not guess at, so it falls back to reading the live sheet rather than half-understanding what it
 * found. A permissive schema would turn a shape change into a silent misread.
 */
export const AccountsSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(StoredAccountSchema),
    /** Unix SECONDS, matching the farm's own timestamp convention everywhere else. */
    readAt: z.number().int().nonnegative(),
  })
  .strict()
export type StoredAccounts = z.infer<typeof AccountsSchema>

/**
 * How much the current-account marker actually told us (plan 86 §3.3, §8). `current` on a stored
 * account is ALWAYS "this is row 0", never "this row had a checkmark" — the checkmark is
 * locale-dependent and this is the pack's standing rule. What varies is how much corroboration there
 * was, and that is worth reporting rather than discarding:
 *
 * - `confirmed` — the checkmark was on row 0, exactly where §3.3 says the current account sits.
 * - `moved` — a checkmark was found, on some other row. Row 0 is still treated as current; the
 *   disagreement is reported so an operator can see it.
 * - `assumed` — no checkmark anywhere (a non-Indonesian device UI, or a changed label). Row 0 is
 *   still treated as current, and this value is what stops that from being reported as a fact.
 */
export type CurrentAccountEvidence = 'confirmed' | 'moved' | 'assumed'

export interface ParsedSheetAccounts {
  accounts: StoredAccount[]
  evidence: CurrentAccountEvidence
}

/**
 * Sheet rows → the stored shape. Pure: no device, no context, no clock — `readAt` is stamped by the
 * caller so this function stays testable against a fixed value.
 *
 * Position 1 is the signed-in account (plan 86 §3.3), so `current` is decided by ORDER and nothing
 * else. The checkmark only ever downgrades the claim (`evidence`), which is the same degrade-rather-
 * than-guess posture `switch-account.ts` already takes: a marker that cannot be read must never turn
 * into a different answer, only into a less confident one.
 */
export function parseSheetAccounts(rows: SheetRow[]): ParsedSheetAccounts {
  const checkmarkIndex = detectCurrentIndex(rows)
  const evidence: CurrentAccountEvidence = checkmarkIndex === null ? 'assumed' : checkmarkIndex === 0 ? 'confirmed' : 'moved'
  return {
    accounts: rows.map((row, index) => ({ username: row.desc, position: index + 1, current: index === 0 })),
    evidence,
  }
}

/**
 * The stored list's answer to "which slot is this username in", or `null` when it has no answer —
 * no list at all, or a list that does not name this username. Case-insensitive, matching how
 * `resolveTargetRow` compares a username against a live row.
 *
 * `null` is never an error here: it means "ask the device", which is what `switch-account` did
 * before this plan and still does whenever the stored list cannot help.
 */
export function storedPositionOf(stored: StoredAccounts | null, username: string): number | null {
  if (!stored) return null
  const wanted = username.trim().toLowerCase()
  const match = stored.accounts.find((account) => account.username.toLowerCase() === wanted)
  return match ? match.position : null
}
