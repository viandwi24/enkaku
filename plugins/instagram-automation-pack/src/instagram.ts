import type { ScriptContext } from '@enkaku/sdk'
import { foreignAppOnTop as sdkForeignAppOnTop, recoverToApp, touchBlockerOnTop } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { all, flatten, rowsById } from './tree'

export const INSTAGRAM_PACKAGE = 'com.instagram.android'

/** Plain sleep. Every settle here is a property of the app, not an operator's choice. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Save a tree and a screenshot under one label, and hand the tree back.
 *
 * An Instagram layout is not a fact this repo owns — it moves with the app
 * version, the locale and the A/B bucket — so the tree at the failing step IS
 * the bug report. Pass the tree a wait already validated: re-dumping here would
 * act on a different tree than the one that passed the check.
 */
export async function capture(ctx: ScriptContext<unknown>, label: string, tree?: UiNode): Promise<UiNode> {
  const captured = tree ?? (await ctx.device.dump())
  await ctx.artifact.file(label, JSON.stringify(captured, null, 2), { ext: 'json' })
  await ctx.artifact.screenshot(label)
  return captured
}

/** The centre of a node's bounds. */
export function centre(node: UiNode): { x: number; y: number } {
  return { x: Math.round((node.bounds.left + node.bounds.right) / 2), y: Math.round((node.bounds.top + node.bounds.bottom) / 2) }
}

/**
 * Poll `dump()` until `ready` accepts the tree or the budget runs out. Returns the last tree either way.
 *
 * Every poll first closes an announcement sheet with its "not now" (0.5.0, `promoDismissButton`) —
 * unless `ready` is itself waiting for one. Instagram's camera-shortcut announcement landed over the
 * Reel editor on one production run and over the share step on another (Samsung, 2026-09-15), so a
 * wait that only looked for its own anchor failed naming that anchor instead of the sheet.
 */
export async function waitForTree(
  ctx: ScriptContext<unknown>,
  ready: (tree: UiNode) => boolean,
  opts: { budgetMs: number; intervalMs?: number },
): Promise<{ tree: UiNode; ok: boolean; waitedMs: number }> {
  const interval = opts.intervalMs ?? 1_000
  const started = Date.now()
  const poll = async (): Promise<UiNode> => {
    let tree = await ctx.device.dump()
    for (let closed = 0; closed < 2 && !ready(tree); closed++) {
      const notNow = promoDismissButton(tree)
      if (!notNow) break
      ctx.log.warn('closed an Instagram announcement sheet with its "not now" button', { headline: rowsById(tree, 'igds_headline_headline')[0]?.text ?? '' })
      await ctx.device.tap({ point: centre(notNow) })
      await sleep(1_200)
      tree = await ctx.device.dump()
    }
    return tree
  }
  let tree = await poll()
  while (!ready(tree)) {
    if (Date.now() - started >= opts.budgetMs) return { tree, ok: false, waitedMs: Date.now() - started }
    await sleep(interval)
    tree = await poll()
  }
  return { tree, ok: true, waitedMs: Date.now() - started }
}

/**
 * The bottom navigation, by id. Measured on the owner's moto g06 power
 * (Instagram 446.0, id-ID, 2026-09-14): `feed_tab` Beranda, `clips_tab` Reels,
 * `direct_tab` Pesan, `search_tab` Cara dan Jelajahi, `profile_tab` Profil.
 * Ids rather than labels: the labels are translated, the ids are not.
 */
export type NavTab = 'feed_tab' | 'clips_tab' | 'direct_tab' | 'search_tab' | 'profile_tab'

export function navTab(tree: UiNode, id: NavTab): UiNode | null {
  return rowsById(tree, id).find((n) => n.clickable) ?? null
}

/** Instagram is past its splash and drawing its own navigation. */
export function isReady(tree: UiNode): boolean {
  return navTab(tree, 'feed_tab') !== null && navTab(tree, 'profile_tab') !== null
}

/**
 * A system permission dialog is over the screen (0.7.1): Android withholds every app window from the reader while one is
 * up, so the reading holds System UI and nothing else — no Instagram, not even the launcher. Production phone #3
 * (2026-09-15) sat on "Izinkan Instagram mengambil gambar dan merekam video?" at launch, then on the microphone's own
 * dialog once the owner answered the first, both after the camera and microphone had been refused before launch.
 */
export function withheldByDialog(tree: UiNode): boolean {
  const systemUi = all(tree, (n) => n.packageName === 'com.android.systemui').length
  return systemUi > 0 && all(tree, (n) => n.packageName !== '' && n.packageName !== 'com.android.systemui').length === 0
}

/** Nodes that belong to Instagram and carry anything a person could read or press. */
export function readableInstagramNodes(tree: UiNode): UiNode[] {
  return all(tree, (n) => n.packageName === INSTAGRAM_PACKAGE && (n.text.trim() !== '' || n.desc.trim() !== '' || n.clickable))
}

/**
 * Which other app is holding the screen, or `null` when Instagram is still there.
 *
 * Added 0.11.0, last of the three packs to get it, and the only one that had paid for the absence
 * twice over — see `isSignedOut` directly below and `relaunch`'s recovery loop. The rule itself
 * lives in `@enkaku/sdk`, which carries the production trees from the other two.
 */
export function foreignAppOnTop(tree: UiNode): string | null {
  return sdkForeignAppOnTop(tree, INSTAGRAM_PACKAGE)
}

/**
 * The signed-out entry screen: no navigation, and a login call to action.
 * Worded in both languages this farm meets.
 *
 * ## Why it asks who is in front first (0.11.0)
 *
 * This reads the WHOLE tree, not Instagram's nodes, so ANY app in front with a "Log in" button
 * answered yes: a Google sign-in page, a Play sheet, a browser. And `relaunch` does not merely
 * report that — it THROWS `E_NOT_SIGNED_IN`, whose message tells the operator to go and sign in
 * the account this phone should use. On a phone that was signed in the whole time, that sends
 * someone to the one place the fault is not, and the phone looks like an account problem rather
 * than a stuck screen.
 *
 * `youtube-automation-pack` shipped the identical wrong accusation ("that is usually a signed-out
 * YouTube", over a Play Store sheet) and fixed it in 0.39.14. This is the same bug in a second
 * pack, found by looking rather than by another farm paying for it.
 *
 * The question "is Instagram signed out" is only meaningful when Instagram is the app on screen.
 * When it is not, the honest answer is not `true`, and it is not `false` either — it is that this
 * is the wrong question, which the caller now asks in the right order.
 */
export function isSignedOut(tree: UiNode): boolean {
  if (isReady(tree)) return false
  if (foreignAppOnTop(tree) !== null) return false
  const strings = flatten(tree).map((n) => `${n.text} ${n.desc}`.trim().toLowerCase()).filter((s) => s !== '')
  return strings.some((s) => /^(masuk|log in|login)$/.test(s) || s.includes('buat akun baru') || s.includes('create new account'))
}

/**
 * Instagram's own "confirm you are human" gate (0.10.4), and the handle it names.
 *
 * Measured on three production phones in one session (#4, #14, #59 on 2026-09-16, screenshots
 * `ig-01-home`): a full screen carrying the Instagram wordmark, a shield glyph and one line —
 * "Konfirmasikan bahwa Anda adalah manusia untuk menggunakan profil Anda, bitorexroom" — over a
 * "Lanjut" button and "Perlu waktu sekitar 30 detik". There is no navigation on it, so every caller
 * sees it as "the app never came up"; naming it is the whole point of this reader.
 *
 * Nothing in this pack presses that button. Working an app's bot check is not something automation
 * here does, and a phone in this state is reported to the operator rather than driven through it.
 *
 * Returns the handle when the line names one, `'this account'` when the gate is up but unnamed, and
 * null when it is not this screen. Both wordings are now MEASURED (0.10.5): eight phones in the
 * 2026-09-16 session, `bitorexsocial` on an English build ("Confirm you're human to use your
 * account"), the rest Indonesian — and those vary too, "menggunakan profil Anda" on some and
 * "menggunakan akun Anda" on others, which is why only the first clause is matched.
 */
const HUMAN_GATE = /konfirmasikan bahwa anda adalah manusia|confirm (that )?you(?:'re| are)? (?:a )?human/i
/** The handle sits at the END of the gate's own line: "…profil Anda, bitorexdecode". */
const GATE_HANDLE = /,\s*@?([A-Za-z0-9._]{2,30})\s*$/

export function humanCheckAccount(tree: UiNode): string | null {
  if (isReady(tree)) return null
  // Each half on its own (0.10.5). A node's `text` and `desc` are not always the same string, and the
  // handle is at the END of whichever line carries it — joining the two halves worked only because the
  // production dumps repeat the sentence in both, and would hide the name on a build that describes the
  // screen in one half and names the account in the other. Naming the account is the point of this read.
  const halves = flatten(tree)
    .filter((n) => n.packageName === INSTAGRAM_PACKAGE)
    .flatMap((n) => [n.text.trim(), n.desc.trim()])
    .filter((s) => s !== '')
  const lines = halves.filter((s) => HUMAN_GATE.test(s))
  if (lines.length === 0) return null
  for (const line of lines) {
    const named = GATE_HANDLE.exec(line)
    if (named?.[1]) return named[1]
  }
  return 'this account'
}

/**
 * Instagram's "add and confirm a phone number" wall (0.10.6) — a SECOND demand, not the bot check.
 *
 * Measured on six production phones (#41, #46, #50, #51, #72, #73 on 2026-09-16; dumps carry 44
 * Instagram nodes): an English screen reading "Enter your mobile number" over "You'll need to confirm
 * this mobile number with a code via SMS or WhatsApp", a country chip "ID +62", a "Phone number"
 * field, a "Send code" button and "Get support" in the top bar. Like the human gate it draws no
 * navigation, so without this reader every caller reports "the app never came up" — which is how six
 * phones spent a session looking like a farm bug.
 *
 * Nothing here fills that field in or presses "Send code". Entering contact details for an account is
 * not something this automation does; the reader exists to name the wall so a person can answer it.
 *
 * Two sentences are required, not one: "Enter your mobile number" alone also appears in Instagram's
 * ordinary settings, and a reader that fired there would mislabel a perfectly healthy screen. The
 * Indonesian wording is UNMEASURED — matched on the chance the farm meets an id-ID build of it.
 */
export function phoneNumberWallShowing(tree: UiNode): boolean {
  if (isReady(tree)) return false
  const halves = flatten(tree)
    .filter((n) => n.packageName === INSTAGRAM_PACKAGE)
    .flatMap((n) => [n.text.trim(), n.desc.trim()])
    .filter((s) => s !== '')
  const asks = halves.some((s) => /enter your mobile number|masukkan nomor (ponsel|hp|telepon|seluler)/i.test(s))
  const confirms = halves.some((s) => /confirm this mobile number|konfirmasi(kan)? nomor|cod(e|a) via sms|kode (lewat|via) sms/i.test(s))
  return asks && confirms
}

const MEDIA_PERMISSIONS = ['READ_MEDIA_VIDEO', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VISUAL_USER_SELECTED', 'READ_EXTERNAL_STORAGE', 'POST_NOTIFICATIONS'] as const

/**
 * Grant what Instagram's gallery needs before it opens.
 *
 * Android 14+ hides the runtime-permission dialog from the farm's reader (the
 * lesson `youtube-automation-pack` 0.27.0 records), so a dialog nobody answered
 * stops a run with nothing on screen it can read. The camera is left exactly as
 * the phone has it: the upload path this pack walks (home "+" → gallery) never
 * asked for it on the walk, while the Reels tab's own "Buat reel" button did.
 * Never fatal — an older core without the capability logs and carries on.
 */
async function grantMediaBeforeLaunch(ctx: ScriptContext<unknown>): Promise<void> {
  try {
    const granted = await ctx.device.app.grantPermissions(INSTAGRAM_PACKAGE, MEDIA_PERMISSIONS)
    const failed = granted.filter((r) => r.outcome === 'failed')
    if (failed.length > 0) ctx.log.warn('some Instagram permissions could not be granted — a hidden dialog may still appear', { failed: failed.map((f) => `${f.permission}: ${f.detail ?? ''}`).join('; ') })
  } catch (err) {
    ctx.log.warn('could not set Instagram permissions before launch — continuing', { error: String(err) })
  }
  /*
    Camera and microphone are REFUSED and fixed, in their own call (0.7.0). On the owner's Samsung production phone
    #3 (2026-09-15) Android's "Izinkan Instagram mengambil gambar dan merekam video?" came up at the editor → share
    step — hidden from the reader — and the run failed "the share screen did not open". The gallery upload this pack
    walks never uses either, and a fixed refusal means Android never asks again.
  */
  try {
    const denied = await ctx.device.app.denyPermissions(INSTAGRAM_PACKAGE, ['CAMERA', 'RECORD_AUDIO'])
    const failed = denied.filter((r) => r.outcome === 'failed')
    if (failed.length > 0) ctx.log.warn('Instagram camera/microphone could not be refused — their dialog may still appear, hidden from this run', { failed: failed.map((f) => `${f.permission}: ${f.detail ?? ''}`).join('; ') })
  } catch (err) {
    ctx.log.warn('could not refuse Instagram camera/microphone before launch — continuing', { error: String(err) })
  }
}

/**
 * Instagram's feature-announcement sheet, and its "not now" button.
 *
 * Measured on the first routed `check-inbox` run on the owner's moto
 * (2026-09-14): opening the inbox raised "Memperkenalkan instan" with a primary
 * `igds_headline_primary_action_button` ("Coba") and a secondary
 * `igds_headline_secondary_action_text_button` ("Lain kali") — and the run
 * reported the sheet's words as message threads. Only the SECONDARY button is
 * ever returned: the primary one opts the account into whatever is announced.
 */
export function promoDismissButton(tree: UiNode): UiNode | null {
  if (rowsById(tree, 'igds_headline_primary_action_button').length > 0) {
    return rowsById(tree, 'igds_headline_secondary_action_text_button').find((n) => n.clickable) ?? null
  }
  /*
    0.5.0 — the camera-shortcut announcement ("Abadikan momen dengan pintasan kamera baru"), seen
    over the Reel editor on the owner's Samsung production farm (2026-09-15, screenshot only): its
    primary button is "Buka pengaturan perangkat", which would leave Instagram for the system
    settings. Should that sheet ever be drawn without the igds ids, it is still recognised by that
    primary label, and only its "Lain kali" is returned.
  */
  const nodes = flatten(tree)
  const label = (n: UiNode): string => n.desc.trim() || n.text.trim()
  if (!nodes.some((n) => PROMO_LEAVES_APP_LABELS.includes(label(n)))) return null
  return nodes.find((n) => n.clickable && PROMO_DISMISS_LABELS.includes(label(n))) ?? null
}

/** An announcement's primary button that opens the system settings — never tapped. */
const PROMO_LEAVES_APP_LABELS = ['Buka pengaturan perangkat', 'Open device settings']
const PROMO_DISMISS_LABELS = ['Lain kali', 'Not now']

/** Close any announcement sheet on screen (at most `times` in a row). Returns the tree left behind. */
export async function dismissPromos(ctx: ScriptContext<unknown>, times = 2): Promise<UiNode> {
  let tree = await ctx.device.dump()
  for (let i = 0; i < times; i++) {
    const button = promoDismissButton(tree)
    if (!button) return tree
    ctx.log.info('closed an Instagram announcement sheet with its "not now" button', { headline: rowsById(tree, 'igds_headline_headline')[0]?.text ?? '' })
    await ctx.device.tap({ point: centre(button) })
    await sleep(1_200)
    tree = await ctx.device.dump()
  }
  return tree
}

const READY_TIMEOUT_MS = 25_000
const SETTLE_TIMEOUT_MS = 15_000

function countNodes(tree: UiNode): number {
  return flatten(tree).length
}

/**
 * Force-stop, launch, and WAIT FOR THE APP — not for a fixed five seconds.
 *
 * Every member of this pack used to sleep 5 s after launch and then act. The
 * YouTube pack measured why that fails on a cold start (a tap sent while the
 * app is still drawing does nothing), so this polls for Instagram's own bottom
 * navigation and then for two same-sized dumps in a row. A phone whose
 * Instagram is signed out is reported by name instead of as "tab not found".
 */
export async function relaunch(ctx: ScriptContext<unknown>, opts?: { clearRecents?: boolean }): Promise<UiNode> {
  await grantMediaBeforeLaunch(ctx)
  await ctx.device.app.forceStop(INSTAGRAM_PACKAGE, { clearRecents: opts?.clearRecents ?? true })
  await ctx.device.app.launch(INSTAGRAM_PACKAGE)
  await sleep(2_500)
  let nav = await waitForTree(ctx, (t) => isReady(t) || isSignedOut(t), { budgetMs: READY_TIMEOUT_MS })
  // A hidden permission dialog over the launch (0.7.1, `withheldByDialog`): BACK refuses it. Instagram asked for the camera
  // and then the microphone on phone #3, one dialog after the other, so up to three are refused.
  for (let round = 0; round < 3 && !nav.ok && withheldByDialog(nav.tree); round++) {
    ctx.log.warn('a system permission dialog is over Instagram at launch (the reader sees only System UI) — refusing it with BACK', { round: round + 1 })
    await ctx.device.key('BACK')
    await sleep(1_500)
    nav = await waitForTree(ctx, (t) => isReady(t) || isSignedOut(t), { budgetMs: 12_000 })
  }
  /*
    Another app over Instagram (0.11.0) — the guard this pack was missing entirely.

    BACK closes a sheet; `launch` brings Instagram's own task back to the front. The intruder is
    NEVER force-stopped: on a production phone that package may be something of the owner's that
    has nothing to do with this run, and killing it to tidy a run is not this pack's call. Three
    rounds, then the caller's own anchor reports — but the log will already have named the app.

    Order matters here and is the point: this runs BEFORE the signed-out check, because that check
    used to answer yes for any app in front with a "Log in" button and throw the operator at an
    account that was fine.
  */
  if (!nav.ok) {
    const recovered = await recoverToApp(ctx, { ownPackage: INSTAGRAM_PACKAGE, tree: nav.tree })
    if (recovered.did.length > 0) {
      ctx.log.warn(`the screen at launch was not Instagram's — ${recovered.did.join('; ')}`, { blockedBy: recovered.blockedBy, back: recovered.ok })
      nav = await waitForTree(ctx, (t) => isReady(t) || isSignedOut(t), { budgetMs: 12_000 })
    }
  }

  if (isSignedOut(nav.tree)) {
    await capture(ctx, 'ig-signed-out', nav.tree)
    throw Object.assign(new Error('Instagram on this phone is signed out. Sign in to the account this phone should use, then re-run.'), { code: 'E_NOT_SIGNED_IN' })
  }
  if (!nav.ok) {
    const stillThere = touchBlockerOnTop(nav.tree) ?? foreignAppOnTop(nav.tree)
    ctx.log.warn(
      stillThere === null
        ? `instagram did not show its navigation within ${READY_TIMEOUT_MS / 1000}s — continuing, and the next anchor will say where the device is`
        : `instagram never came to the front — "${stillThere}" held the screen through every attempt to clear it. The run continues, and its first anchor will name it rather than blame an Instagram control.`,
    )
    return nav.tree
  }
  let previous = -1
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const size = countNodes(await ctx.device.dump())
    if (size === previous) break
    previous = size
    await sleep(1_200)
  }
  return dismissPromos(ctx)
}

/**
 * Tap a bottom-nav tab and wait until the screen it names is showing.
 * `ready` is the screen's own anchor; returns the validated tree.
 */
export async function openTab(
  ctx: ScriptContext<unknown>,
  id: NavTab,
  ready: (tree: UiNode) => boolean,
  budgetMs = 15_000,
): Promise<{ tree: UiNode; ok: boolean }> {
  let tree = await ctx.device.dump()
  if (ready(tree)) return { tree, ok: true }
  for (let attempt = 0; attempt < 2; attempt++) {
    const tab = navTab(tree, id)
    if (!tab) return { tree, ok: false }
    await ctx.device.tap({ point: centre(tab) })
    const got = await waitForTree(ctx, ready, { budgetMs })
    if (got.ok) return { tree: got.tree, ok: true }
    tree = got.tree
  }
  return { tree, ok: false }
}

/** Press BACK until the navigation is showing again (at most `times`). */
export async function backToNav(ctx: ScriptContext<unknown>, times = 3): Promise<UiNode> {
  let tree = await ctx.device.dump()
  for (let i = 0; i < times && !isReady(tree); i++) {
    await ctx.device.key('BACK')
    await sleep(1_200)
    tree = await ctx.device.dump()
  }
  return tree
}
