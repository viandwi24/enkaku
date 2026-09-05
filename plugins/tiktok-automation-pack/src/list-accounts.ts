import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { sleep } from './human'
import { ACCOUNTS_KEY, parseSheetAccounts, type StoredAccounts } from './accounts'
import { MAX_SHEET_SCROLL_ATTEMPTS, TIKTOK_PACKAGE, openSwitchAccountSheet, scanSheet, type SheetRow } from './sheet'

/**
 * Reads which TikTok accounts are signed in on this device and stores the list under the plugin's
 * own device-scoped KV key (plan 108 §3.1, §4.7). The write half of the "a script's scrape shows on
 * the screen" loop the plugin surface is built around: this member fills the `TikTok accounts`
 * table, and `switch-account` reads the same entry back to resolve a username to a slot.
 *
 * **Read-only on the device.** It walks to the switch-account sheet, dumps it, scrolls inside the
 * sheet's own box, and never taps an account row — the one tap that would change which account is
 * signed in is the one thing this member must not do. That is not merely a convention here: every
 * account row is reached through `scanSheet`, which reads and scrolls and has no tap in it at all,
 * so there is no code path from this file to a row tap to get wrong.
 */

/** Names every screenshot artifact this member writes, so a failed run says which member failed. */
const ARTIFACT_PREFIX = 'list-accounts'

/**
 * No parameters. Reading the account list has nothing to decide: there is one sheet, it lists what
 * it lists, and every bound this member obeys (how far to scroll, how long to wait) is a property of
 * the app measured on hardware, not an operator's choice. An empty object rather than no schema at
 * all because `params` is required and is what the run dialog renders — it renders nothing here,
 * which is the honest answer.
 */
const paramsSchema = z.object({})

const resultSchema = z.object({
  accounts: z
    .array(z.string())
    .describe('Every account handle the switch-account sheet listed, in slot order — slot 1 first.')
    .meta(ui({ title: 'Accounts' })),
  count: z.number().int().describe('How many accounts are signed in on this device.').meta(ui({ title: 'Accounts found', kind: 'count', summary: true })),
  current: z.string().describe('The account the device is signed in as — slot 1 (plan 86 §3.3).').meta(ui({ title: 'Signed in as', summary: true })),
  currentEvidence: z
    .enum(['confirmed', 'moved', 'assumed'])
    .describe('How much the on-screen current-account checkmark corroborated slot 1. Slot 1 is treated as current either way; this says how sure that is.')
    .meta(
      ui({
        title: 'Current-account evidence',
        labels: {
          confirmed: 'Checkmark on slot 1',
          moved: 'Checkmark on another slot',
          assumed: 'No checkmark found',
        },
      }),
    ),
  readAt: z.number().int().describe('When the sheet was read, in unix seconds — the same value stored alongside the list.').meta(ui({ title: 'Read at' })),
})

const listAccountsScript: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'list-accounts',
  title: 'List accounts',
  description:
    "Reads the switch-account sheet and stores which TikTok accounts are signed in on this device, so the TikTok accounts screen can show them. Never taps an account — it changes nothing about which account is signed in.",
  /** Plan 310 §3.3 — the script's own icon; `node.icon` (same value) stays as a fallback read for a core older than this plan. */
  icon: 'list',
  node: { category: 'device', icon: 'list', summary: [], keywords: ['accounts', 'list'] },
  params: paramsSchema,
  result: resultSchema,
  // Shorter than `switch-account`'s: this member walks the same five screens but does none of the
  // post-switch verification, and its scroll budget is the same bounded one.
  timeout: 4 * 60_000,

  async prepare(ctx) {
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
    await ctx.device.app.launch(TIKTOK_PACKAGE)
    // The same settle `switch-account`/`auto-scroll` take: let the launch storm pass before the
    // run's own anchor wait starts polling into it.
    await sleep(4_000)
  },

  async run(ctx) {
    await openSwitchAccountSheet(ctx, ARTIFACT_PREFIX)

    // Scroll to exhaustion rather than to a target: a pass that adds no new row means the
    // RecyclerView has nothing further to give, which is the end of the list. `scanSheet` merges
    // rows across dumps by username, so "nothing new" is a statement about the whole list, not
    // about what happens to be on screen.
    const rows = await scanSheet<SheetRow[]>(ctx, ARTIFACT_PREFIX, ({ rows, added, isLast }) => {
      if (rows.length > 0 && added.length === 0) return rows
      if (isLast) return rows
      return null
    })

    if (rows.length === 0) {
      // Refuse rather than store nothing. A sheet with zero rows is not a device with zero
      // accounts — the signed-in account is always listed — so this is a misread, and writing it
      // would replace a good list with an empty one on the screen this member exists to fill.
      await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-empty-sheet`)
      throw Object.assign(
        new Error(`the switch-account sheet listed no accounts at all, even after ${MAX_SHEET_SCROLL_ATTEMPTS} scrolls — refusing to overwrite the stored list with nothing`),
        { code: 'E_NO_ACCOUNTS_FOUND' },
      )
    }

    const { accounts, evidence } = parseSheetAccounts(rows)
    if (evidence === 'assumed') {
      ctx.log.warn('no current-account checkmark was found — slot 1 is still recorded as the signed-in account, but nothing on screen corroborated it')
    } else if (evidence === 'moved') {
      ctx.log.warn('the current-account checkmark was on a slot other than 1 — slot 1 is still recorded as the signed-in account (plan 86 §3.3)')
    }

    const readAt = Math.floor(Date.now() / 1000)
    // Device scope, plugin namespace, neither of them named here: the runner resolves the namespace
    // from the plugin id and the scope id from this job's device (plan 108 §3.1, findings G2/G4).
    // That is what lets `switch-account` read this exact entry back on a later job.
    const value: StoredAccounts = { version: 1, accounts, readAt }
    const { version } = await ctx.kv.device.set(ACCOUNTS_KEY, value)

    ctx.log.info('stored the account list for this device', { key: ACCOUNTS_KEY, entryVersion: version, accounts: accounts.length })

    return {
      accounts: accounts.map((account) => account.username),
      count: accounts.length,
      // `rows.length > 0` is checked above, so slot 1 exists — the fallback is here only because
      // TypeScript cannot see that, never because an empty list reaches this point.
      current: accounts[0]?.username ?? '',
      currentEvidence: evidence,
      readAt,
    }
  },

  /**
   * Stateless and idempotent — it may run again in a fresh process after a timeout kill, and
   * `forceStop` on an already-stopped package is a no-op. Unlike `switch-account` there is nothing
   * on the device to undo: this member left the account list exactly as it found it.
   */
  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot(`${ARTIFACT_PREFIX}-failed`)
    await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
  },
}

export default listAccountsScript
