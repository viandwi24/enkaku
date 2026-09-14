import type { ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { sleep } from './human'
import { centerOf, flatten } from './tree'

/**
 * TikTok's own interruptions over the feed, closed wherever a warm-up reads the screen (1.32.0).
 *
 * Seen on the owner's production farm (2026-09-14), in both languages the fleet runs: a bottom sheet
 * over the For You feed — "Tambah nomor telepon" / "Add phone", a phone-number field and a
 * "Lanjutkan" / "Continue" button, with a close (X) at its top right. It covers only the bottom half,
 * so the feed behind it stays readable and the screenshot above it keeps changing: none of
 * `auto-scroll`'s existing detectors (blind reads, identical frames) ever fired, and the run went on
 * "watching" and swiping into the sheet.
 *
 * ## What this is allowed to do
 *
 * - **Recognised by name, never guessed.** Only the entries below. A generic "close any sheet"
 *   would also close the comment sheet `browseComments` opens on purpose.
 * - **Only the sheet's own close control is tapped** — the close NEAREST the sheet's text, never the
 *   first "Tutup" on screen (the feed's "Dapatkan Reward" badge has a close of its own, top left).
 *   "Lanjutkan"/"Continue" is never a target, and nothing is ever typed into the field: adding a
 *   phone number to an account is the account owner's decision, not a warm-up's.
 * - **BACK when that close is not readable.** A bottom sheet closes on BACK without choosing
 *   anything in it, and on the feed BACK has nowhere else to go.
 */

export interface Interruption {
  id: string
  what: string
  /** Words any one of which, in a node's text or description, identifies it. */
  identity: readonly string[]
}

export const TIKTOK_INTERRUPTIONS: readonly Interruption[] = [
  {
    id: 'tt.phone-prompt',
    what: 'the "add phone number" sheet',
    identity: ['Tambah nomor telepon', 'Tambahkan nomor telepon Anda', 'Add phone number', 'Add your phone number'],
  },
]

/** The labels a sheet's close control carries. Nothing that continues, agrees or submits. */
export const CLOSE_LABELS = ['Tutup', 'Close'] as const

function words(node: UiNode): string[] {
  return [node.text.trim(), node.desc.trim()].filter((w) => w !== '')
}

/**
 * Drawn on screen: a real size, and not placed left of or above it (1.34.1). TikTok keeps pages mounted
 * off to the side, and a sheet there is not on screen — nor is a close there one a tap can reach.
 */
function visible(node: UiNode): boolean {
  const b = node.bounds
  return b.right > b.left && b.bottom > b.top && b.left >= 0 && b.top >= 0
}

/** The first interruption on screen, with the node that identified it. */
export function findInterruption(tree: UiNode, register: readonly Interruption[] = TIKTOK_INTERRUPTIONS): { interruption: Interruption; anchor: UiNode } | null {
  const nodes = flatten(tree).filter(visible)
  for (const interruption of register) {
    const anchor = nodes.find((n) => words(n).some((w) => interruption.identity.some((id) => w.toLowerCase().includes(id.toLowerCase()))))
    if (anchor) return { interruption, anchor }
  }
  return null
}

/**
 * The sheet's own close: a clickable close-labelled node at or above the identifying text and no more than 500px above
 * it, nearest first. Null when none qualifies — the caller then uses BACK rather than tapping some other close.
 */
export function closeNear(tree: UiNode, anchor: UiNode): UiNode | null {
  const candidates = flatten(tree)
    .filter(visible)
    .filter((n) => n.clickable && words(n).some((w) => (CLOSE_LABELS as readonly string[]).includes(w)))
    .filter((n) => n.bounds.top <= anchor.bounds.bottom && n.bounds.bottom >= anchor.bounds.top - 500)
  candidates.sort((a, b) => Math.abs(anchor.bounds.top - a.bounds.bottom) - Math.abs(anchor.bounds.top - b.bounds.bottom))
  return candidates[0] ?? null
}

/**
 * Close every known interruption, re-reading the screen after each. Returns the tree to act on — the one passed in,
 * with no extra dump, when nothing was there. Pass the tree a caller already has; with none, this dumps once.
 */
export async function dismissInterruptions(ctx: ScriptContext<unknown>, tree?: UiNode, opts?: { maxRounds?: number }): Promise<{ tree: UiNode; dismissed: string[] }> {
  const dismissed: string[] = []
  let current = tree ?? (await ctx.device.dump())
  for (let round = 0; round < (opts?.maxRounds ?? 3); round++) {
    const found = findInterruption(current)
    if (!found) return { tree: current, dismissed }
    const close = closeNear(current, found.anchor)
    if (close) {
      await ctx.device.tap({ point: centerOf(close.bounds) })
      ctx.log.info(`closed ${found.interruption.what} with its close button`, { interruption: found.interruption.id })
    } else {
      await ctx.device.key('BACK')
      ctx.log.warn(`closed ${found.interruption.what} with BACK — its close button was not readable`, { interruption: found.interruption.id })
    }
    dismissed.push(found.interruption.id)
    await sleep(1_200)
    current = await ctx.device.dump()
  }
  if (findInterruption(current)) ctx.log.warn('a TikTok interruption was still on screen after closing it — continuing')
  return { tree: current, dismissed }
}
