import { z } from 'zod'
import { PLATFORM_IDS } from './platforms'

/*
  The accounts each phone is signed in to (0.37.0).

  The owner's request (2026-09-16): a sync that walks every connected phone, opens each platform's
  app, reads the accounts signed in there — one app can hold several, TikTok most of all — and stores
  them, marking which one the phone is using right now. The TikTok pack has had a narrower version of
  this since plan 86 (`list-accounts` writes its own device-scoped row); this is the cross-platform
  one, owned by the Social Media Manager, because the manager is where an operator already asks "which
  phone posts as whom".

  One row per phone and platform, under this plugin's own global KV:

    account:<platform>:<deviceId>

  A row is a READING, not a claim about the present: `readAt` says when the phone was looked at, and
  `evidence` says how sure the "signed in now" mark is. A sync that failed keeps the previous row's
  accounts and records `error`, so a phone that went offline mid-sweep does not lose what was known
  about it.
*/

export const ACCOUNT_PREFIX = 'account:'

export function accountKeyFor(platform: string, deviceId: string): string {
  return `${ACCOUNT_PREFIX}${platform}:${deviceId}`
}

/**
 * How sure the "this is the account in use" mark is:
 *
 * - `confirmed` — the app itself marked this account on screen (TikTok's checkmark on the switch
 *   sheet, YouTube's "Akun yang dipilih", Instagram's own profile header naming it).
 * - `moved` — a mark was found, but on another row than the one the app's own ordering says is
 *   current. Both readings are kept; the disagreement is reported rather than resolved silently.
 * - `assumed` — no mark could be read, and the app's ordering (slot 1) was taken as current.
 * - `none` — nothing could be read at all: no account is marked in this row.
 */
export const AccountEvidenceSchema = z.enum(['confirmed', 'moved', 'assumed', 'none'])
export type AccountEvidence = z.infer<typeof AccountEvidenceSchema>

export const AccountSchema = z.object({
  /** The handle as the app shows it, without a leading `@` — what an operator recognises the account by. */
  username: z.string().min(1),
  /** The name shown beside the handle, when the app shows one (YouTube's channel name, Instagram's full name). Null when it shows none. */
  displayName: z.string().nullable().default(null),
  /** A stable id when the app exposes one (a YouTube channel handle, an account e-mail). Null when it does not — most apps do not. */
  accountId: z.string().nullable().default(null),
  /** 1-based, in the order the app listed them. */
  slot: z.number().int().positive(),
  /** True for the account the phone is signed in as. Several apps allow only one; a reading that could not tell marks none. */
  current: z.boolean(),
})
export type Account = z.infer<typeof AccountSchema>

export const AccountRowSchema = z.object({
  version: z.literal(1).default(1),
  platform: z.enum(PLATFORM_IDS),
  deviceId: z.string().min(1),
  /** The phone's name as the farm knew it at the sync, so a row still names the phone after it leaves the farm. */
  deviceName: z.string().nullable().default(null),
  accounts: z.array(AccountSchema).default([]),
  /** Unix seconds — the repo-wide convention. */
  readAt: z.number().int().nonnegative(),
  evidence: AccountEvidenceSchema.default('none'),
  /** What went wrong on the last sync, or null. A row with an error keeps the accounts the previous sync read. */
  error: z.string().nullable().default(null),
})
export type AccountRow = z.infer<typeof AccountRowSchema>

/** The account a row says the phone is using, or null when the reading could not tell. */
export function currentAccountOf(row: AccountRow): Account | null {
  return row.accounts.find((a) => a.current) ?? null
}

/**
 * Fold a platform's reading into a row, keeping what was known when the reading failed.
 *
 * A failed sync must not look like "this phone has no accounts": an offline phone, a locked screen or
 * an app that changed its sheet all produce no rows, and erasing the last good reading would turn a
 * temporary problem into lost knowledge. So a reading with an error keeps `previous.accounts` and
 * `previous.evidence`, and only `readAt` and `error` move.
 */
export function mergeAccountReading(
  previous: AccountRow | null,
  reading: { platform: AccountRow['platform']; deviceId: string; deviceName: string | null; accounts: Account[]; evidence: AccountEvidence; readAt: number; error: string | null },
): AccountRow {
  if (reading.error !== null) {
    return {
      version: 1,
      platform: reading.platform,
      deviceId: reading.deviceId,
      deviceName: reading.deviceName ?? previous?.deviceName ?? null,
      accounts: previous?.accounts ?? [],
      readAt: reading.readAt,
      evidence: previous?.evidence ?? 'none',
      error: reading.error,
    }
  }
  return {
    version: 1,
    platform: reading.platform,
    deviceId: reading.deviceId,
    deviceName: reading.deviceName,
    accounts: reading.accounts,
    readAt: reading.readAt,
    evidence: reading.evidence,
    error: null,
  }
}

/**
 * Number the accounts a scrape read, and decide which one is current.
 *
 * `markedIndex` is where the app's own mark was, when one was readable. Slot 1 is what every app
 * measured so far puts the signed-in account at, so a disagreement is recorded as `moved` — the mark
 * wins, since it is the app SAYING so, while slot 1 is only a convention this farm measured.
 */
/*
  A row of the app's own UI, not an account (0.45.2).

  The owner found "Go to Meta Account settings" stored as an Instagram account, holding SLOT 2 — and
  a slot is what `switch-account` selects by, so this is not only untidy, it can switch to the wrong
  thing. Production has the same on TikTok and YouTube; the exact strings were not captured.

  Each reader already drops the rows it knows by name, and that list has now been widened twice and
  missed anyway. `accounts-instagram.ts` matched `buka pengaturan`, missed **Buka Pusat Akun**
  (0.41.0, every one of five phones reported one account too many), was widened, and then missed
  **"Go to Meta Account settings"** because the English row begins "Go to" and the pattern expected
  "open". A blacklist of sentences can never be finished — the next build writes a new sentence.

  So this is a SHAPE rule, and it lives in `numberAccounts` because all three readers pass through
  it: one filter, three platforms, including the variants nobody has seen yet.

  What a username is on these apps: a handle. No spaces on Instagram or TikTok. YouTube falls back to
  a CHANNEL NAME when a row carries no `@handle`, and a channel name can be two words ("Hendi
  sunadi") — which is why the bar is three words and not "contains a space".

  The trade accepted, openly: a three-word channel name with no handle would be dropped. That is rare,
  and the opposite error is worse — a phantom row takes a slot, and the slot decides which account a
  later run switches to.
*/
const ACTION_PHRASE =
  /^(tambah\w*|add|buka|open|go to|kelola|manage|lihat|view|beralih|switch|masuk|log ?in|sign ?in|keluar|log ?out|buat|create|pelajari|learn|aktifkan|turn on|nonaktifkan|turn off|setelan|settings|pengaturan)\b/i
/** Longer than any handle these apps allow, and long enough that a sentence is the likelier reading. */
const MAX_USERNAME_LENGTH = 40
/** A channel name may be two words; three is prose. */
const MAX_USERNAME_WORDS = 2

/** True when this string reads as one of the app's own controls rather than an account it names. */
export function looksLikeUiRow(value: string): boolean {
  const v = value.trim()
  if (v === '') return true
  if (v.length > MAX_USERNAME_LENGTH) return true
  if (v.split(/\s+/).length > MAX_USERNAME_WORDS) return true
  return ACTION_PHRASE.test(v)
}

export function numberAccounts(
  handles: readonly { username: string; displayName?: string | null; accountId?: string | null }[],
  markedIndex: number | null,
): { accounts: Account[]; evidence: AccountEvidence } {
  if (handles.length === 0) return { accounts: [], evidence: 'none' }
  /*
    Filter FIRST, then find the marked account again by name (0.45.2). `markedIndex` is a position in
    the unfiltered list: dropping a row without re-locating it moves the "signed in" tick onto a
    different account, which is a worse bug than the one this filter fixes.
  */
  const markedUsername = markedIndex === null ? null : (handles[markedIndex]?.username ?? null)
  const kept = handles.filter((h) => !looksLikeUiRow(h.username))
  if (kept.length === 0) return { accounts: [], evidence: 'none' }
  handles = kept
  const relocated = markedUsername === null ? null : kept.findIndex((h) => h.username === markedUsername)
  markedIndex = relocated === null || relocated === -1 ? null : relocated
  const currentIndex = markedIndex ?? 0
  const evidence: AccountEvidence = markedIndex === null ? 'assumed' : markedIndex === 0 ? 'confirmed' : 'moved'
  return {
    accounts: handles.map((h, i) => ({
      username: h.username.replace(/^@/, '').trim(),
      displayName: h.displayName ?? null,
      accountId: h.accountId ?? null,
      slot: i + 1,
      current: i === currentIndex,
    })),
    evidence,
  }
}
