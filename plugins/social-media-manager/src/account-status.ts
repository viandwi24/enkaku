import { z } from 'zod'

/**
 * An account that needs a PERSON, recorded per phone and platform (0.64.0).
 *
 * Production, 2026-09-21: twelve TikTok accounts were signed out by TikTok in one day, and one
 * Instagram account was held behind "confirm you are human". Each failed its post with a message
 * that said so — and the next video for that phone went out anyway, and failed the same way, and
 * so did every warm-up activity on that platform. No script can answer any of these: signing in
 * needs the account's password, a security check or a human check needs the owner on the phone.
 *
 * So the first failure is recorded here (`acct:<deviceId>:<platform>`), the router sends nothing
 * more on that platform to that phone — posts and warm-ups wait with the reason — and the page
 * offers "Signed in" to clear it once somebody has dealt with it on the phone.
 *
 * Detected from the scripts' own words, the one thing the router has of a failed job. Each pattern
 * is a sentence a pack writes (`tiktok-automation-pack` `screens.ts` `signedOutError`, `post-video.ts`
 * security check; `instagram-automation-pack` `post-video.ts` human check), so a change there must
 * change this too — the tests below pin them.
 */

export const ACCOUNT_PROBLEM_PREFIX = 'acct:'

export const ACCOUNT_PROBLEM_KINDS = ['signed-out', 'security-check', 'human-check'] as const
export type AccountProblemKind = (typeof ACCOUNT_PROBLEM_KINDS)[number]

export const AccountProblemSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1),
  platform: z.string().min(1),
  kind: z.enum(ACCOUNT_PROBLEM_KINDS),
  /** The account's handle when the app named it, else `null`. */
  account: z.string().nullable().default(null),
  at: z.number().int().nonnegative(),
  /** The script's own message, clipped — what the operator reads when in doubt. */
  reason: z.string().max(400).default(''),
})
export type AccountProblem = z.infer<typeof AccountProblemSchema>

export function accountKey(deviceId: string, platform: string): string {
  return `${ACCOUNT_PROBLEM_PREFIX}${deviceId}:${platform}`
}

/** The account a failed activity or post says needs a person, or `null`. */
export function accountProblemOf(platform: string, error: string | null | undefined): { kind: AccountProblemKind; account: string | null } | null {
  if (!error) return null
  if (platform === 'tiktok') {
    const out = /TikTok has signed this phone out of (?:the account "([^"]+)"|its account)/.exec(error)
    if (out) return { kind: 'signed-out', account: out[1] ?? null }
    if (/TikTok is asking this account for a security check/.test(error)) return { kind: 'security-check', account: null }
  }
  if (platform === 'instagram') {
    const held = /Instagram is holding (.+?) behind its "confirm you are human" check/.exec(error)
    if (held) return { kind: 'human-check', account: held[1]?.trim() || null }
  }
  return null
}

const TITLE: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' }

/** One line an operator reads: what is wrong, with which account, and what to do. */
export function accountProblemText(problem: Pick<AccountProblem, 'platform' | 'kind' | 'account'>): string {
  const app = TITLE[problem.platform] ?? problem.platform
  const who = problem.account !== null ? ` (${problem.account})` : ''
  switch (problem.kind) {
    case 'signed-out':
      return `${app} is signed out${who} — sign in on the phone, then press Signed in.`
    case 'security-check':
      return `${app} wants a security check${who} — complete it on the phone, then press Signed in.`
    case 'human-check':
      return `${app} wants "confirm you are human"${who} — answer it on the phone, then press Signed in.`
  }
}
