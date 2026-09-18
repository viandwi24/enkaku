import type { UiNode } from '@enkaku/protocol'
import { foreignAppOnTop, touchBlockerOnTop } from './screen'
import type { ScriptContext } from './types'

/**
 * What `recoverToApp` did, and whether the app under test is back.
 *
 * `did` is empty when nothing was wrong — that is the common case and the reason this is safe to
 * call on every failed wait: it costs one dump and returns.
 */
export interface RecoveryOutcome {
  /** True when the app under test holds the screen again (or never lost it). */
  ok: boolean
  /** Each action taken, in order, in words a log line can carry. */
  did: string[]
  /** What is still holding the screen when `ok` is false — a package name, a blocker's headline, or null when the screen could not be read at all. */
  blockedBy: string | null
}

/** How long to let the screen settle after a press, a swipe or a launch. */
const SETTLE_MS = 1_200

/**
 * BACK is tried this many times before the app is launched again.
 *
 * Two, and measured rather than chosen (moto g06 power, ZP2222RMBS, 2026-09-18). The production
 * intruder is the Play Store's `TransparentMainActivity` install sheet, and reproducing it over a
 * running Instagram showed the first BACK does not leave the Play Store at all — it drops the
 * transparent sheet onto `MainActivityPrivate`, the store's own full screen, which is still a
 * foreign app. The SECOND BACK is the one that lands back on Instagram's `MainTabActivity`, with
 * the app's own task intact. A one-press guard, which is what this obviously wants to be, would
 * have recovered none of the twenty-six runs it was written for.
 */
const BACK_ROUNDS = 2

/** Rounds in total: BACK, BACK, launch, and one last look. */
const ROUNDS = 4

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Get the app under test back in front of whatever wandered over it, and say what that was.
 *
 * ## Why this is in the SDK and not in a pack
 *
 * Half of every upload failure on the owner's farm is not an upload failure. Measured over three
 * days (2026-09-18, 103 failed `post-video` runs on the versions then active), by reading the tree
 * each run had already saved beside its own error message:
 *
 * | what was actually on the screen | runs | what the run said |
 * |---|---|---|
 * | the Play Store (`com.android.vending`) | 31 | "the share screen did not open after the editor" |
 * | Samsung's accidental-touch protection | 14 | "the bottom navigation is not on screen after launch" |
 * | the Samsung keyboard, alone | 4 | "the share screen is not showing" |
 * | the launcher, or Settings | 2 | assorted |
 *
 * Every one of those messages names a control in an app that was not on the screen. Instagram's
 * were the clearest: twenty-six runs failed with "the share screen did not open after the editor",
 * on twenty-six different phones, and all fourteen sampled trees held the Play Store's install
 * sheet for "Edits: Editor Video" — the app Instagram promotes from inside its own Reel editor —
 * with no Instagram node anywhere in them. The share screen did not open because Instagram was not
 * in front to open it.
 *
 * The packs already had the DETECTORS for this (`foreignAppOnTop` is in this package precisely
 * because three packs wrote it separately). What none of them had was the RECOVERY, anywhere but
 * at launch: `relaunch` guards the first screen and nothing guards the other eight. A sheet that
 * lands in the middle of a flow — which is when they land, because that is when the app is being
 * driven — met no guard at all.
 *
 * ## What it does, and what it deliberately does not
 *
 * One action per round: swipe up past a touch blocker, else BACK out of a foreign app (twice),
 * else launch the app under test again, then look once more.
 *
 * It never force-stops the intruder. A Play sheet, a system dialog, an update prompt — these may
 * be the owner's, and killing something the operator opened is not this function's call to make;
 * `youtube-automation-pack` 0.39.14 settled that and it holds here. Launching the app under test
 * brings its existing task forward without restarting it, so a flow that was mid-editor is usually
 * still mid-editor afterwards, which is the whole reason a caller can carry on rather than start
 * over.
 *
 * It is also honest about an unreadable screen: a dump that fails, or a tree with nothing
 * measurable in it, returns `ok: false` with `blockedBy: null` rather than a guess. A caller that
 * cannot read the screen has learnt nothing and should say so.
 */
export async function recoverToApp(
  ctx: ScriptContext<unknown>,
  opts: {
    /** The package the flow is driving. */
    ownPackage: string
    /** Rounds of recovery; each round takes at most one action. Default 4. */
    rounds?: number
    /** May the app be launched again when BACK does not clear the intruder? Default true. */
    relaunch?: boolean
    /** Settle time after each action. Default 1200 ms. */
    settleMs?: number
    /** A tree already in hand, so the first dump can be skipped — pass the one whose wait just failed. */
    tree?: UiNode | null
  },
): Promise<RecoveryOutcome> {
  const rounds = opts.rounds ?? ROUNDS
  const settleMs = opts.settleMs ?? SETTLE_MS
  const relaunch = opts.relaunch ?? true
  const did: string[] = []
  let tree: UiNode | null = opts.tree ?? null
  let blockedBy: string | null = null
  let backs = 0

  for (let round = 0; round < rounds; round++) {
    if (tree === null) {
      tree = await ctx.device.dump().catch(() => null)
      if (tree === null) {
        // A dump that fails says nothing about the screen, so it is not treated as evidence of
        // anything — but it is worth one more round, because the reader recovers on its own.
        blockedBy = null
        await sleep(settleMs)
        continue
      }
    }

    const blocker = touchBlockerOnTop(tree)
    if (blocker !== null) {
      blockedBy = blocker
      await swipePastBlocker(ctx, tree)
      did.push(blockerPhrase(blocker))
      tree = null
      await sleep(settleMs)
      continue
    }

    const foreign = foreignAppOnTop(tree, opts.ownPackage)
    if (foreign === null) return { ok: true, did, blockedBy: null }
    blockedBy = foreign

    if (backs < BACK_ROUNDS) {
      backs++
      await ctx.device.key('BACK').catch(() => undefined)
      did.push(`pressed BACK to leave ${foreign}`)
    } else if (relaunch) {
      // Never force-stopped: see the header. This brings the app's own task forward.
      await ctx.device.app.launch(opts.ownPackage).catch(() => undefined)
      did.push(`launched ${opts.ownPackage} again over ${foreign}`)
    } else {
      break
    }
    tree = null
    await sleep(settleMs)
  }

  // One last look, so `ok` reflects the screen as it is now rather than as it was before the final action.
  const last = tree ?? (await ctx.device.dump().catch(() => null))
  if (last === null) return { ok: false, did, blockedBy: null }
  const blocker = touchBlockerOnTop(last)
  if (blocker !== null) return { ok: false, did, blockedBy: blocker }
  const foreign = foreignAppOnTop(last, opts.ownPackage)
  return foreign === null ? { ok: true, did, blockedBy: null } : { ok: false, did, blockedBy: foreign ?? blockedBy }
}

/**
 * The swipe the blocker itself asks for ("Usap ke atas untuk mengabaikan perlindungan sentuhan
 * yang tidak disengaja" / "Swipe up to dismiss").
 *
 * Measured from the overlay's own geometry rather than assumed: the production tree (720x1600,
 * SM-A075F, 2026-09-18) puts its lock image at y 949-1077 and its hint at 1116-1185, so a swipe
 * that starts below the hint and ends above the image crosses the whole gesture. Fractions, not
 * pixels, because the farm's phones are not all this size.
 */
async function swipePastBlocker(ctx: ScriptContext<unknown>, tree: UiNode): Promise<void> {
  const { width, height } = frameOf(tree)
  if (width === 0 || height === 0) return
  const x = Math.round(width / 2)
  await ctx.device
    .swipe({ x, y: Math.round(height * 0.78) }, { x, y: Math.round(height * 0.22) }, 420, { easing: 'easeInOutCubic' })
    .catch(() => undefined)
}

function frameOf(tree: UiNode): { width: number; height: number } {
  let width = 0
  let height = 0
  const walk = (n: UiNode): void => {
    if (n.bounds.right > width) width = n.bounds.right
    if (n.bounds.bottom > height) height = n.bounds.bottom
    for (const c of n.children) walk(c)
  }
  walk(tree)
  return { width, height }
}

/** The one wording for "the phone's own overlay was in the way", so a log line reads the same from every caller. */
function blockerPhrase(blocker: string): string {
  return `swiped up past the phone's accidental-touch protection ("${blocker}")`
}

/**
 * Swipe past the phone's own touch blocker if one is up, and say what it was — `null` when there
 * was none, which is the usual answer and costs one dump.
 *
 * The narrow half of {@link recoverToApp}, for a caller that already has its own, tested handling
 * for a FOREIGN APP and needs only the case that handling cannot see. `foreignAppOnTop` excludes
 * the system UI on purpose, so Samsung's accidental-touch protection — a full-screen System UI
 * window that swallows every touch — is invisible to it, and a pack's relaunch loop will spend its
 * whole budget pressing BACK at a screen that only answers to a swipe.
 *
 * Deliberately does NOT launch anything or press anything: a caller that wanted that reaches for
 * `recoverToApp`. This one makes the phone touchable again and hands the screen back unchanged.
 */
export async function clearTouchBlocker(
  ctx: ScriptContext<unknown>,
  opts?: { tree?: UiNode | null; rounds?: number; settleMs?: number },
): Promise<string | null> {
  const rounds = opts?.rounds ?? 2
  const settleMs = opts?.settleMs ?? SETTLE_MS
  let tree: UiNode | null = opts?.tree ?? (await ctx.device.dump().catch(() => null))
  let found: string | null = null
  for (let round = 0; round < rounds; round++) {
    if (tree === null) return found
    const blocker = touchBlockerOnTop(tree)
    if (blocker === null) return found
    found = blocker
    await swipePastBlocker(ctx, tree)
    await sleep(settleMs)
    tree = await ctx.device.dump().catch(() => null)
  }
  return found
}
