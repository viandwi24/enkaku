import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { ACCOUNTS_KEY, readAccountsFrom } from './accounts'

/**
 * `snapshot-accounts` — the pack's first member, and deliberately the one that
 * TOUCHES NOTHING.
 *
 * It opens Android's own accounts screen, saves the full UI tree and a
 * screenshot as artifacts, reads which Google addresses are listed, and stops.
 * No tap, anywhere: there is no code path in this file from a dump to a tap, so
 * "it changed something on my device" is not a bug this member can have.
 *
 * ## Why this is the right first script, not filler
 *
 * Every later member of this pack needs selectors, and selectors have to be
 * measured on the hardware they will run against. `tiktok-automation-pack`'s
 * own header is a worked example: it documents resource ids, bounds, and the
 * three regions a swipe must avoid, all read off one real device. Nothing here
 * has had that treatment yet — this farm is Samsung One UI, and the accounts
 * screen's activity name, resource ids and row shape are OEM-specific.
 *
 * So this member's most valuable output is not `accounts`. It is
 * `uiTreeArtifactId`: the real tree, from the real device, which is what the
 * next member's selectors get written from instead of from a guess.
 *
 * ## What is inference here, stated plainly
 *
 * `schemas.ts` in `plugins/mikrotik-routing` records this repo learning the
 * hard way that a shape inferred from public documentation can be wrong on real
 * hardware and take a screen down. The same caution applies:
 *
 * - the activity ladder below is inference, which is exactly why it is a LADDER
 *   and why every rung's outcome is reported in `openedVia`;
 * - the address parse is best-effort, which is why it reports `evidence`
 *   rather than a bare list.
 *
 * Neither is presented as verified. When this has been run once on a real
 * device, the artifact it saves is what turns both into measured facts.
 */

/**
 * How to get to the accounts screen, in falling order of preference.
 *
 * Samsung One UI, AOSP and the various OEM skins do not agree on the activity
 * name, and a wrong one is a silent no-op rather than an error: the launch
 * succeeds, some other screen appears, and the dump is of the wrong thing. That
 * is what `openedVia` in the result exists to expose.
 *
 * `url` is not usable here — that field delivers a VIEW intent for a browser
 * (see `DeviceApi.app.launch`), and this is a settings activity.
 */
const ACCOUNT_SCREENS: readonly { via: string; pkg: string; activity: string }[] = [
  // AOSP / Pixel, Android 10+.
  { via: 'settings-account-dashboard', pkg: 'com.android.settings', activity: '.Settings$AccountDashboardActivity' },
  // Samsung One UI's own accounts-and-backup entry point.
  { via: 'samsung-accounts', pkg: 'com.android.settings', activity: '.Settings$UserAndAccountDashboardActivity' },
  // The older sync-settings screen, still present on several skins.
  { via: 'settings-sync', pkg: 'com.android.settings', activity: '.Settings$SyncSettingsActivity' },
  // Last rung: Settings' front door. Always launches; the dump then shows the
  // top-level screen rather than accounts, and `evidence` says the parse found
  // nothing it recognised — which is the honest outcome, not a failure to hide.
  { via: 'settings-root', pkg: 'com.android.settings', activity: '.Settings' },
]

/** Packages whose tree the account parse will read. An OEM fact, kept beside the ladder that produced it. */
const SETTINGS_PACKAGES = ['com.android.settings', 'com.samsung.android.settings'] as const

/** Time for the settings activity to draw before the tree is dumped. */
const SETTLE_MS = 2_500

const paramsSchema = z.object({})

const resultSchema = z.object({
  accounts: z
    .array(z.string())
    .describe('Every email-shaped label the accounts screen showed, in tree order. Read `evidence` before trusting an empty list.')
    .meta(ui({ title: 'Accounts on this device' })),
  count: z.number().int().describe('How many addresses were read.').meta(ui({ title: 'Accounts found', kind: 'count', summary: true })),
  evidence: z
    .enum(['parsed', 'screen-not-recognised'])
    .describe('Whether the dumped screen was one this parser recognises. An empty list means nothing until this says `parsed`.')
    .meta(
      ui({
        title: 'Evidence',
        summary: true,
        labels: {
          parsed: 'Read from the accounts screen',
          'screen-not-recognised': 'Not the accounts screen — list is meaningless',
        },
      }),
    ),
  openedVia: z
    .string()
    .describe('Which rung of the activity ladder actually launched — the OEM fact this pack has to learn before any later member can be written.')
    .meta(ui({ title: 'Opened via', summary: true })),
  uiTreeArtifactId: z
    .string()
    .describe('The full UI tree as JSON. THIS is what later members get their selectors from — a measured tree, not a guess.')
    .meta(ui({ title: 'UI tree' })),
  readAt: z.number().int().describe('When the screen was read, unix seconds.').meta(ui({ title: 'Read at' })),
})

const snapshotAccountsScript: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'snapshot-accounts',
  title: 'Snapshot accounts',
  description:
    'Opens the device accounts screen, saves the UI tree and a screenshot, and reads which Google addresses are signed in. Read-only — it never taps anything, so it cannot change which account this device uses.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 2 * 60_000,

  async run(ctx) {
    let openedVia = 'none'
    for (const screen of ACCOUNT_SCREENS) {
      try {
        await ctx.device.app.launch(screen.pkg, { activity: screen.activity })
        openedVia = screen.via
        break
      } catch (err) {
        // A rung that does not exist on this OEM throws; that is information,
        // not a failure. Logged so a run's own log names which ladder rungs
        // this device rejected — the fastest way to learn the farm's real
        // activity without a second investigation.
        ctx.log.info(`google: ${screen.via} did not launch on this device`, { activity: screen.activity, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (openedVia === 'none') {
      throw new Error('no accounts screen could be opened on this device — every activity in the ladder was refused')
    }

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    const tree = await ctx.device.dump()
    // Saved BEFORE anything is parsed out of it. If the parse below finds
    // nothing, the tree is what tells an operator (or the next version of this
    // pack) why — losing it because the interesting case was the failing one
    // would be exactly backwards.
    const { artifactId: uiTreeArtifactId } = await ctx.artifact.file('accounts-screen', JSON.stringify(tree, null, 2), { ext: 'json' })
    await ctx.artifact.screenshot('accounts-screen')

    const snapshot = readAccountsFrom(tree, SETTINGS_PACKAGES, Math.floor(Date.now() / 1000))

    // Stored device-scoped so a farm-wide view can answer "which device is on
    // which account" without re-running anything. Written even when the parse
    // did not recognise the screen: `evidence` travels with it, so a later
    // reader can tell a real empty from an unread one.
    await ctx.storage.device.set(ACCOUNTS_KEY, snapshot)

    if (snapshot.evidence === 'screen-not-recognised') {
      ctx.log.warn('google: the dumped screen was not a settings screen this parser knows — the account list is not meaningful', {
        openedVia,
        packageName: tree.packageName,
        uiTreeArtifactId,
      })
    }

    return { ...snapshot, count: snapshot.accounts.length, openedVia, uiTreeArtifactId }
  },
}

export default snapshotAccountsScript
