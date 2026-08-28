import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { Selector, UiNode } from '@enkaku/protocol'
import { centerOf } from '@enkaku/protocol'
import { z } from 'zod'
import { flatten, visibleStrings } from './tree'

/**
 * `open-register` — walks a device to Google's account-creation page and stops.
 *
 * This is step one of the pack's register flow, and deliberately nothing more:
 * open the Google app, open the account sheet, follow the account entry
 * ("Login" on a signed-out device, "add another account" on a signed-in one),
 * the "create account" row, and the audience chooser's personal-use row, and
 * PROVE — or fail to prove — that the register page is what the device ended
 * on. It never fills a field and never submits anything.
 *
 * ## What is measured, and what is not
 *
 * These facts are measured against the farm's real hardware (a moto g06
 * power, Indonesian UI):
 *
 * - the Google app package `com.google.android.googlequicksearchbox`, whose
 *   launcher activity is what `app.launch` opens;
 * - the account disc on the home screen, `googleapp_account_disc_container`,
 *   the entry to the account sheet — read off the farm device's live
 *   ui-server tree while the Inspect panel was attached, not from
 *   documentation;
 * - the sheet the disc opens: on the farm's signed-OUT device its first row
 *   is "Login" (an exact string), not an "add another account" row. Both are
 *   matched by the account-entry hop, measured on the first dev run (0.2.0);
 * - the "Buat akun" row on the sign-in chooser, and the audience chooser it
 *   expands ("Untuk penggunaan pribadi saya" leads to the form) — measured on
 *   the second dev run.
 *
 * The hops from the sheet to the signup form are TEXT walks (`findNodeByText`)
 * over the dumped tree, because the sign-in chooser's node ids vary by Google
 * app version and account state. `hops` in the result says which text hops
 * found something and were tapped, and every hop's tree is saved as an
 * artifact, so the first runs produce exactly the measurement the next member
 * (filling the form) needs — the same ladder-with-evidence pattern
 * `snapshot-accounts` uses for its activity list.
 */

/** The Google app. Measured on the farm: `am start` with its SearchActivity brought this package to the front. */
export const GOOGLE_APP = 'com.google.android.googlequicksearchbox'

/** The home screen's account disc — the avatar, and the sheet's entry point. Measured on a moto g06 power via the ui-server tree. */
export const ACCOUNT_DISC: Selector = { id: 'googleapp_account_disc_container' }

/** Time for a sheet/activity to draw before a dump. */
const SETTLE_MS = 2_000

/**
 * The hop texts, Indonesian UI first (the farm's locale), then English.
 *
 * `EXACT_LOGIN_RE` is a whole-string match on purpose: the signed-out sheet's
 * first row reads exactly "Login" (measured on the farm), and a looser
 * `/login/` would also hit "Logout" on a signed-in device's sheet and the
 * sign-in chooser's own headings, sending the walk backwards.
 */
const EXACT_LOGIN_RE = /^(login|masuk)$/i
const ADD_ACCOUNT_RE = /tambahkan akun lain|add another account|add account/i
const CREATE_ACCOUNT_RE = /buat akun|create account|create a google account/i
/**
 * The audience row on the "who is this account for" screen, measured on the
 * farm after tapping "Buat akun": the three rows read "Untuk penggunaan
 * pribadi saya", "Untuk anak saya", "Untuk kerja atau bisnis saya". This
 * regex matches ONLY the personal one — the other two must never match it.
 */
const AUDIENCE_RE = /untuk penggunaan pribadi saya|untuk diri saya|for my personal use|for myself/i
const REGISTER_PAGE_RE = /buat akun google|create your google account|create a new google account/i
const REGISTER_FIELD_RE = /nama depan|first name/i
const REGISTER_LAST_FIELD_RE = /nama belakang|last name/i
const SIGNIN_CHOOSER_RE = /pilih akun|choose an account|gunakan akun lain|use another account|sign in/i

/** Bounded scrolls while looking for the "create account" row — an account list may need one to reveal its last row. */
const MAX_CREATE_ACCOUNT_SCROLLS = 3

/** One hop of the walk, as the result reports it. */
export interface RegisterHop {
  /** Which hop this row describes. */
  hop: 'account-entry' | 'create-account' | 'audience'
  /** Whether the dump at this hop contained a node matching the hop's text. */
  found: boolean
  /** Whether the script tapped that node. `false` when `found` is false. */
  tapped: boolean
  /** How many extra scrolls the create-account hop needed, or 0. */
  scrolls: number
  /** The node that was matched, reduced to the fields a later member needs. `null` when not found. */
  node: { text: string; desc: string; resourceId: string } | null
  /** The hop's own full tree as a job artifact — the measurement later members build selectors from. */
  uiTreeArtifactId: string
}

export type RegisterEvidence = 'register-page' | 'audience-chooser' | 'create-account-visible' | 'signin-chooser' | 'account-sheet' | 'home' | 'other'

export interface OpenRegisterResult {
  /** True only when the final screen carries register-page markers. */
  reached: boolean
  /** What the final dump actually showed — the honest counterpart to `reached`. */
  evidence: RegisterEvidence
  /** The package that owns the final screen's content — the root node's own is empty (`hierarchy`). */
  screenPackage: string
  /** Every hop the walk made, whether it found its text or not. */
  hops: RegisterHop[]
  /** The final full UI tree as a job artifact. */
  uiTreeArtifactId: string
  /** Unix seconds, when the final screen was read. */
  readAt: number
}

/**
 * First node whose `text` or `desc` matches ANY of `res`, depth-first, in
 * list order (the first regex wins at each node). The dump-and-walk
 * counterpart to `find()` — the sheet is a list of near-identical rows, which
 * is exactly the shape `tree.ts`'s header says `find()` silently resolves
 * wrongly (the first match wins, `ambiguous` is never reported by ui-server).
 */
export function findNodeByText(root: UiNode, res: RegExp | RegExp[]): UiNode | null {
  const resList = Array.isArray(res) ? res : [res]
  return (
    flatten(root).find((n) => {
      return resList.some((re) => re.test(n.text) || re.test(n.desc))
    }) ?? null
  )
}

/**
 * The package that owns the screen's CONTENT. The root of a ui-server dump is
 * the synthetic `hierarchy` node with an empty `packageName`, and the system
 * UI nodes own the bars — so "the root's package" is never the app, and
 * "first package in the walk" is `com.android.systemui`. The first non-system
 * package in the walk is the app actually on screen.
 */
export function dominantPackage(root: UiNode): string {
  return flatten(root).find((n) => n.packageName !== '' && n.packageName !== 'com.android.systemui')?.packageName ?? root.packageName
}

/**
 * What screen the final dump is, in the coarsest terms the walk needs.
 * Markers are text-based and locale-tolerant (Indonesian first, English as
 * the fallback); the package name alone would be wrong for this, because the
 * signup page can open in a Chrome custom tab (tree owned by
 * `com.android.chrome`) as well as inside the Google app.
 */
export function classifyRegisterScreen(tree: UiNode): { evidence: RegisterEvidence; strings: string[] } {
  const strings = visibleStrings(tree)
  const has = (re: RegExp) => strings.some((s) => re.test(s))
  if (has(REGISTER_PAGE_RE) || (has(REGISTER_FIELD_RE) && has(REGISTER_LAST_FIELD_RE))) return { evidence: 'register-page', strings }
  if (has(AUDIENCE_RE)) return { evidence: 'audience-chooser', strings }
  if (has(CREATE_ACCOUNT_RE)) return { evidence: 'create-account-visible', strings }
  if (has(SIGNIN_CHOOSER_RE)) return { evidence: 'signin-chooser', strings }
  if (has(EXACT_LOGIN_RE) || has(ADD_ACCOUNT_RE)) return { evidence: 'account-sheet', strings }
  if (dominantPackage(tree) === GOOGLE_APP && strings.some((s) => /^telusuri$/i.test(s))) return { evidence: 'home', strings }
  return { evidence: 'other', strings }
}

const paramsSchema = z.object({})

const resultSchema = z.object({
  reached: z
    .boolean()
    .describe('Whether the final screen carried register-page markers. Read `evidence` before trusting a `false`.')
    .meta(ui({ title: 'Register page reached', summary: true })),
  evidence: z
    .enum(['register-page', 'audience-chooser', 'create-account-visible', 'signin-chooser', 'account-sheet', 'home', 'other'])
    .describe('What the final dump actually showed. `reached` is true only for `register-page`.')
    .meta(
      ui({
        title: 'Screen evidence',
        summary: true,
        labels: {
          'register-page': 'Register page',
          'audience-chooser': '"Who is the account for" chooser',
          'create-account-visible': '"Create account" visible, not tapped',
          'signin-chooser': 'Sign-in chooser',
          'account-sheet': 'Account sheet',
          home: 'Home screen',
          other: 'Something else — read the tree artifact',
        },
      }),
    ),
  screenPackage: z.string().describe('The package that owns the final screen\'s content.').meta(ui({ title: 'Package', summary: true })),
  hops: z
    .array(
      z.object({
        hop: z.enum(['account-entry', 'create-account', 'audience']),
        found: z.boolean(),
        tapped: z.boolean(),
        scrolls: z.number().int(),
        node: z
          .object({ text: z.string(), desc: z.string(), resourceId: z.string() })
          .nullable()
          .describe('The matched node, reduced to the fields a later member needs.'),
        uiTreeArtifactId: z.string().describe('The hop\'s own full tree as JSON.'),
      }),
    )
    .describe('Every hop the walk made, whether it found its text or not — the measurement the next member builds selectors from.')
    .meta(ui({ title: 'Hops' })),
  uiTreeArtifactId: z.string().describe('The final full UI tree as JSON.').meta(ui({ title: 'UI tree' })),
  readAt: z.number().int().describe('When the final screen was read, unix seconds.').meta(ui({ title: 'Read at' })),
})

const openRegisterScript: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'open-register',
  title: 'Open Google register page',
  description:
    'Opens the Google app, walks the account sheet to the "create account" entry, and stops on Google\'s account-creation page. Read-only — it never fills a field and never submits a registration.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 3 * 60_000,

  async run(ctx) {
    await ctx.device.app.launch(GOOGLE_APP)

    const disc = await ctx.device.waitFor(ACCOUNT_DISC, { timeout: 25_000 })
    await ctx.device.tap({ point: centerOf(disc.bounds) })
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    const hops: RegisterHop[] = []

    const dumpAndSave = async (label: string): Promise<{ tree: UiNode; artifactId: string }> => {
      const tree = await ctx.device.dump()
      const { artifactId } = await ctx.artifact.file(`open-register-${label}`, JSON.stringify(tree, null, 2), { ext: 'json' })
      // The screenshot pairs with the saved tree so a human can see the same
      // screen the walk decided from.
      await ctx.artifact.screenshot(`open-register-${label}`)
      return { tree, artifactId }
    }

    // Hop 1: the account sheet's own entry — "Login" (measured on the farm's
    // signed-out device) or "add another account" (a signed-in device).
    {
      const { tree, artifactId } = await dumpAndSave('account-entry')
      const found = findNodeByText(tree, [EXACT_LOGIN_RE, ADD_ACCOUNT_RE])
      hops.push({
        hop: 'account-entry',
        found: found !== null,
        tapped: found !== null,
        scrolls: 0,
        node: found === null ? null : { text: found.text, desc: found.desc, resourceId: found.resourceId },
        uiTreeArtifactId: artifactId,
      })
      if (found !== null) {
        await ctx.device.tap({ point: centerOf(found.bounds) })
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      }
    }

    // Hop 2: the sign-in chooser's "create account" row, with bounded scrolls —
    // the row sits at the bottom of the account list and may not be on the
    // first dump. Only walks when hop 1 found its entry: tapping on from an
    // unknown screen is the silent-failure mode this pack refuses (plan 86
    // §3.6's discipline).
    const entryDone = hops[0]?.found === true
    if (entryDone) {
      let found: UiNode | null = null
      let scrolls = 0
      let hopTree: UiNode | null = null
      let hopArtifactId = ''
      for (; scrolls <= MAX_CREATE_ACCOUNT_SCROLLS; scrolls++) {
        const dumped = await dumpAndSave('create-account')
        hopTree = dumped.tree
        hopArtifactId = dumped.artifactId
        found = findNodeByText(hopTree, [CREATE_ACCOUNT_RE])
        if (found !== null) break
        await ctx.device.scroll({ direction: 'down' })
        await new Promise((resolve) => setTimeout(resolve, 800))
      }
      hops.push({
        hop: 'create-account',
        found: found !== null,
        tapped: found !== null,
        scrolls,
        node: found === null ? null : { text: found.text, desc: found.desc, resourceId: found.resourceId },
        uiTreeArtifactId: hopArtifactId,
      })
      if (found !== null) {
        await ctx.device.tap({ point: centerOf(found.bounds) })
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

        // Hop 3: tapping "Buat akun" expands the audience chooser — "Untuk
        // penggunaan pribadi saya" is the row that leads to the register form
        // (measured on the farm, second dev run). No scroll here: the three
        // rows were all on the first dump.
        const { tree: audienceTree, artifactId: audienceArtifactId } = await dumpAndSave('audience')
        const audienceNode = findNodeByText(audienceTree, [AUDIENCE_RE])
        hops.push({
          hop: 'audience',
          found: audienceNode !== null,
          tapped: audienceNode !== null,
          scrolls: 0,
          node: audienceNode === null ? null : { text: audienceNode.text, desc: audienceNode.desc, resourceId: audienceNode.resourceId },
          uiTreeArtifactId: audienceArtifactId,
        })
        if (audienceNode !== null) {
          await ctx.device.tap({ point: centerOf(audienceNode.bounds) })
          await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
        }
      }
    }

    const { tree: finalTree, artifactId: finalArtifactId } = await dumpAndSave('final-tree')
    const { evidence, strings } = classifyRegisterScreen(finalTree)
    const reached = evidence === 'register-page'
    const screenPackage = dominantPackage(finalTree)
    if (!reached) {
      ctx.log.warn('google: the walk ended on a screen that is not the register page', {
        evidence,
        packageName: screenPackage,
        screenStrings: strings.slice(0, 40),
        uiTreeArtifactId: finalArtifactId,
      })
    }

    return {
      reached,
      evidence,
      screenPackage,
      hops,
      uiTreeArtifactId: finalArtifactId,
      readAt: Math.floor(Date.now() / 1000),
    }
  },
}

export default openRegisterScript
