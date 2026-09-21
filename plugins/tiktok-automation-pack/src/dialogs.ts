import type { ScriptContext, WaitForOptions } from '@enkaku/sdk'
import type { Selector, UiNode } from '@enkaku/protocol'
import { centerOf, matchSelector } from '@enkaku/protocol'
import { sleep } from './human'
import { dismissInterruptions } from './interruptions'
import { signedOutAccount, signedOutError } from './screens'

/**
 * Dialog resilience — lifted verbatim out of `index.ts` (plan 86 §3.1, §4.7, §5 step 1) so
 * `switch-account` and `search-follow` sweep for a blocking dialog the exact same way `auto-scroll`
 * always has, rather than each script growing its own copy of the ACK/DENY ladder. Nothing here was
 * rewritten; `clearBlockingDialog` gained an `export` keyword (it was module-private in `index.ts`,
 * where it only had one caller) because it now has callers in other files.
 */

/**
 * Every way a runtime-permission dialog spells "deny".
 *
 * TikTok's contact prompt is NOT the Android system dialog — it is TikTok's own modal ("Temukan
 * kontak", buttons `Izinkan` / `Jangan izinkan`), so the `permissioncontroller` ids never match it.
 * They are kept anyway because a genuine system prompt can still appear, and matching one by its
 * stable id beats matching a translated label. Nothing here spells "allow".
 */
export const DENY_SELECTORS: Selector[] = [
  { id: 'com.android.permissioncontroller:id/permission_deny_button' },
  { id: 'com.android.packageinstaller:id/permission_deny_button' },
  { text: 'Jangan izinkan' },
  { text: 'JANGAN IZINKAN' },
  { text: 'Tolak' },
  { text: "Don't allow" },
  { text: 'Deny' },
]

/**
 * Every way a NOTICE spells "I saw this" without spelling "I agree to this".
 *
 * Confirmed on hardware against the "Item Virtual dan pembaruan Kebijakan Reward" modal: a single
 * button reading "Mengerti" ("understood"), which is not a refusal — `DENY_SELECTORS` can never
 * match it — and not something BACK can close either, because TikTok's policy-consent modals are
 * `setCancelable(false)`; the notice simply reappeared on every subsequent iteration.
 *
 * This list, exactly like `DENY_SELECTORS`, is a CLOSED allow-list, and that closedness is the
 * entire safety property `clearBlockingDialog` relies on: it only ever taps a label it explicitly
 * recognises. A generic "tap whatever single button is in the dialog" auto-dismisser would look
 * identical here and would also tap "Setuju" on a ToS update, "Izinkan" on a permission prompt,
 * "Ikuti" on a follow suggestion, or "Beli"/"Berlangganan" on a purchase confirmation — every one
 * of those is ALSO a single-button modal. Nothing that grants, buys, subscribes, or follows
 * (`Izinkan`, `Allow`, `Ikuti`, `Follow`, `Beli`, `Berlangganan`, …) may ever be added to this
 * list or to `DENY_SELECTORS`.
 */
export const ACK_SELECTORS: Selector[] = [
  { text: 'Mengerti' },
  { text: 'Saya mengerti' },
  { text: 'Got it' },
  { text: 'I understand' },
  { text: 'OK' },
  { text: 'Oke' },
  { text: 'Nanti saja' },
  // Measured 2026-09-03: the system "Simpan info login untuk lain waktu?" sheet that answers
  // navigating to Kotak Masuk offers exactly two buttons — "Simpan info login" (a grant, never
  // tapped) and "Tidak sekarang" (the refusal this rung is). The English half of the pair was
  // already here; the Indonesian half was not.
  { text: 'Tidak sekarang' },
  { text: 'Lewati' },
  { text: 'Skip' },
  { text: 'Not now' },
  { text: 'Tutup' },
  { text: 'Close' },
]

/**
 * Gets rid of whatever modal is in the way WITHOUT ever granting anything.
 *
 * Three mechanisms, tried in this order, because on this device any one of them can be the only
 * one that actually works:
 *
 * 1. Tap an explicit acknowledgement. Tried FIRST because it is the only one of the three that can
 *    close a `setCancelable(false)` notice — the "Mengerti" policy-consent modal accepted neither
 *    a deny tap (it is not asking permission for anything, so nothing in `DENY_SELECTORS` matches)
 *    nor BACK (confirmed uncancelable on hardware: the notice was still there after it).
 * 2. Otherwise tap an explicit deny button. Unambiguous when the inspector can see one, but it is
 *    answering a different question ("no, don't grant this") than ACK does ("fine, I saw it") —
 *    which is exactly why the two lists are kept disjoint rather than merged into one.
 * 3. Otherwise, IF `allowBack` (default `true`), press BACK. Verified on hardware against the live
 *    "Izinkan TikTok mengakses kontak?" modal: one BACK closed it and returned to the feed with
 *    nothing granted. BACK is safe by construction against a genuine dialog — no Android dialog and
 *    no in-app pre-prompt treats it as consent — but it is also a NAVIGATION action, and that is a
 *    different kind of unsafe than "grants something": on `auto-scroll`, whose whole run lives on
 *    one screen (the feed), BACK either closes a modal or is a no-op, because there is nowhere for
 *    it to navigate BACK *to* other than the same feed. `switch-account` and `search-follow` are not
 *    that: they walk FORWARD through five distinct screens (feed → profile → drawer → settings →
 *    sheet), and on those, BACK undoes whatever step the script just took.
 *
 *    `allowBack: false` exists because "no ack/deny button was readable" turned out, on hardware, to
 *    be caused far more often by the INSPECTOR being briefly unable to see the screen than by there
 *    being nothing to see. Root-caused against `switch-account` (plan 86 §7.2 follow-up): a run's own
 *    diagnostic dump, taken at the exact moment an anchor "did not appear", failed with
 *    `http://127.0.0.1:27100/jsonrpc/0 did not respond within 20000ms: Error: The socket connection
 *    was closed unexpectedly` — the ui-server had gone briefly unresponsive, exactly the class of
 *    flakiness already on record above (`uiautomator dump` coming back `Killed`). Every `find` this
 *    function itself does during that same outage ALSO reports "nothing found" (indistinguishable
 *    from a real absence — `device-executor.ts`'s `waitFor` maps any inspector error to
 *    `not-found`), so during an outage this sweep can never see a real dialog either. On `auto-scroll`
 *    that is still safe to resolve with BACK: worst case, a no-op on the same feed. On a multi-screen
 *    script it is not: a second, independent hardware run (same root cause) left the "Profil" tap's
 *    target screen never reached at all — the app was still sitting exactly where it had been before
 *    the tap — and blindly pressing BACK on top of THAT would have discarded real, correct progress
 *    over a problem BACK cannot fix (the inspector coming back is a matter of time, not of navigation).
 *    A recovery that can leave the intended screen — or the app itself — is not a recovery for a
 *    script whose whole job is "prove which screen this device is on".
 */
/**
 * The first selector in `list` that matches anything on `screen`, and what it matched.
 *
 * In list order, not tree order — the lists are ranked (an explicit acknowledgement is preferred
 * to a generic "Tutup"), and that ranking is what the old one-`find`-per-selector loop honoured.
 * `matchSelector` answers `null` for a miss and, for a `{ point }` selector, a synthetic node; the
 * lists here hold only `{ text }` and `{ id }`, so a match is always a real node on the screen.
 */
export function firstMatch(screen: UiNode, list: readonly Selector[]): { node: UiNode; selector: Selector } | null {
  for (const selector of list) {
    const node = matchSelector(screen, selector)
    if (node !== null) return { node, selector }
  }
  return null
}

export async function clearBlockingDialog(ctx: ScriptContext<unknown>, opts?: { allowBack?: boolean }): Promise<void> {
  const allowBack = opts?.allowBack ?? true
  /*
    ONE reading for the whole ladder, not one per selector.

    This asked `find()` for each of the twenty ack and deny labels in turn, and every `find` is a
    dump of its own. That is only slow on a good day. On a bad one it is ruinous: the owner's
    production phone #27 (SM-A075F, 2026-09-21) sat on a playing TikTok video whose screen the
    uiautomator fallback could not dump at all, each dump failed after about ninety-five seconds,
    and every failure was swallowed by the `catch` below and answered with the next label — twenty
    of them, so one sweep took over half an hour. `auto-scroll` gives up after three sweeps, which
    it never reached: its sixty-minute timeout ended the job first, after fifteen swipes of the
    thirty-six it was sent to do, with the phone frozen on one video the whole time.

    `matchSelector` is the same walk the core does to answer `find()`, so matching twenty selectors
    against one dump reads exactly what twenty finds would have — once. And when that one dump
    fails, the ladder has nothing to read, so it stops asking rather than asking nineteen more times.
  */
  let screen: UiNode | null = null
  try {
    // A known interruption first (1.32.0): it is closed by its own close control, which the closed
    // lists below cannot tell apart from any other "Tutup" on screen. `dismissInterruptions` reads
    // the screen and hands that same reading back, so the ladder below asks the inspector nothing.
    const interrupted = await dismissInterruptions(ctx)
    if (interrupted.dismissed.length > 0) return
    screen = interrupted.tree
  } catch {
    ctx.log.warn('the inspector could not read the screen, so no ack or deny button can be found this sweep')
  }
  /*
    A signed-out account is not a dialog to clear (1.57.0). Production 2026-09-21: `auto-scroll` on
    four phones whose TikTok had signed its account out swept three times — tapping the "Status akun"
    dialog's OK as an ack, then BACK on the "Selamat datang kembali" sheet — and gave up reporting "a
    modal (e.g. a policy-consent notice) is likely still covering the screen". The account needs its
    password typed on the phone, so every member that sweeps stops here and says so, by name.
  */
  const signedOut = screen !== null ? signedOutAccount(screen) : null
  if (signedOut !== null) {
    await ctx.artifact.screenshot('signed-out').catch(() => {})
    throw signedOutError(signedOut)
  }
  if (screen !== null) {
    const ack = firstMatch(screen, ACK_SELECTORS)
    if (ack) {
      await ctx.device.tap({ point: centerOf(ack.node.bounds) })
      ctx.log.warn('acknowledged a notice dialog', { selector: JSON.stringify(ack.selector) })
      return
    }
    const deny = firstMatch(screen, DENY_SELECTORS)
    if (deny) {
      await ctx.device.tap({ point: centerOf(deny.node.bounds) })
      ctx.log.warn('denied a permission prompt', { selector: JSON.stringify(deny.selector) })
      return
    }
  }
  if (!allowBack) {
    ctx.log.warn('no ack or deny button was readable — NOT pressing BACK (a multi-screen flow cannot treat it as a safe generic recovery; see the comment above)')
    return
  }
  ctx.log.warn('pressing BACK to clear whatever is on top — no ack or deny button was readable')
  await ctx.device.key('BACK')
}

/**
 * Waits for an anchor node and treats one miss as an ordinary hiccup — sweep for a blocking dialog
 * once, settle, and retry. A SECOND miss means the script cannot prove where the device actually is,
 * so it fails loudly with a screenshot artifact rather than guessing (plan 86 §3.6).
 *
 * Lifted out of `switch-account.ts`'s own module-private `waitForAnchor` (identical logic, unchanged)
 * so `search.ts` and `search-follow.ts` do not each grow their own copy. `switch-account.ts` itself
 * is left untouched here — it already carries its own copy and is hardware-proven (plan 86 §7.2); this
 * plan does not risk that by refactoring it to import this one.
 *
 * `allowBack` defaults to `false`: every caller added by this plan is a forward, multi-screen walk
 * (home feed → search → results, or results → profile), where BACK undoes the very step being
 * verified rather than recovering from anything (plan 86 §0.9).
 */
export async function waitForAnchor(
  ctx: ScriptContext<unknown>,
  label: string,
  sel: Selector,
  opts?: WaitForOptions,
  dialogOpts?: { allowBack?: boolean },
): Promise<UiNode> {
  try {
    return await ctx.device.waitFor(sel, opts)
  } catch {
    ctx.log.warn(`anchor "${label}" did not appear — sweeping for a blocking dialog once`, { selector: JSON.stringify(sel) })
    await clearBlockingDialog(ctx, { allowBack: dialogOpts?.allowBack ?? false })
    await sleep(1_500)
    try {
      return await ctx.device.waitFor(sel, opts)
    } catch {
      const artifactLabel = `missing-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      await ctx.artifact.screenshot(artifactLabel)
      throw Object.assign(
        new Error(`the "${label}" anchor never appeared, even after a dialog sweep — cannot confirm where the device actually is`),
        { code: 'E_ANCHOR_NOT_FOUND' },
      )
    }
  }
}

export type DialogAction = 'continue' | 'sweep' | 'blocked'

/**
 * Pure escalation decision for the "the feed nodes are not there" detector, kept separate from
 * `run()` so the ladder is testable without a device or a mocked `ScriptContext`.
 *
 * `consecutiveBlind` counts iterations in a row where `readVisibleSignals()` came back with
 * `ok: false` — every feed selector answered `not-found`, not `Killed` and not a timeout. ONE
 * blind read is ordinary (a video can genuinely be mid-transition when the read lands); TWO in a
 * row is the threshold, because that is what the real stuck run showed: the same three selectors
 * refused across six iterations straight, never once recovering on their own.
 *
 * `sweeps` counts how many times `clearBlockingDialog()` has already run without a since-recovered
 * read resetting it. THREE fruitless sweeps means ACK, DENY, and BACK have each been tried three
 * times apiece with the feed never coming back — a fourth attempt is not a new idea, it is the
 * same one again, and the run should fail loudly instead of quietly spinning forever.
 */
export function nextDialogAction(consecutiveBlind: number, sweeps: number): DialogAction {
  if (consecutiveBlind < 2) return 'continue'
  return sweeps >= 3 ? 'blocked' : 'sweep'
}
