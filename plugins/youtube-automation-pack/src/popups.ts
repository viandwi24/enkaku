import type { ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { flatten } from './tree'

/**
 * YouTube's own promotional popups, closed wherever this pack waits for a screen (0.29.0).
 *
 * Seen on the owner's production farm (2026-09-14): a full-screen "Coba paket keluarga YouTube
 * Premium" sheet over the app, with a "Coba 1 bulan" call to action and a "Tutup" close button.
 * Nothing in this pack knew it, so a run that met it waited for its own anchor behind the sheet and
 * failed with a message about that anchor.
 *
 * ## What this is allowed to do
 *
 * Close a popup it recognises by name, and nothing else:
 *
 * - **Recognised, never guessed.** A popup is only one of the entries below — never "any dialog with
 *   a close button". The comment sheet also has "Tutup", and `post-video` waits for the "resume draft"
 *   prompt on purpose; a generic sweeper would close both out from under the flow that opened them.
 * - **Only close labels are ever tapped** (`CLOSE_LABELS`), and a test proves none of them contains a
 *   word that subscribes, buys, starts a trial or accepts terms (`NEVER_TERMS`). The sheet's own call
 *   to action is never a target, whatever it says.
 * - **BACK when the close control cannot be found** — the sheet is a dialog, and BACK dismisses a
 *   dialog without choosing anything in it.
 */

export interface KnownPopup {
  id: string
  /** Said in the run's log when it is closed. */
  what: string
  matches(nodes: readonly UiNode[]): boolean
}

/** What a close control may be labelled — the only labels this file ever taps. */
export const CLOSE_LABELS = ['Tutup', 'Close', 'Nanti saja', 'Lain kali', 'Bukan sekarang', 'Tidak, terima kasih', 'No thanks', 'Not now'] as const

/** Words a tapped label must never contain — the upsell's own actions, in both languages this farm meets. */
export const NEVER_TERMS = ['coba', 'try', 'langganan', 'subscribe', 'beli', 'buy', 'bayar', 'pay', 'trial', 'gabung', 'join', 'mulai', 'start', 'dapatkan', 'get', 'upgrade', 'setuju', 'agree', 'premium'] as const

/** A call to action an upsell sheet carries — used only to RECOGNISE the sheet, never tapped. */
const UPSELL_ACTIONS = ['coba ', 'try ', 'dapatkan ', 'get ', 'mulai uji coba', 'start trial', 'start free trial'] as const

function label(node: UiNode): string {
  return (node.text || node.desc).trim()
}

function visible(node: UiNode): boolean {
  return node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top
}

function isCloseControl(node: UiNode): boolean {
  const own = [node.text.trim().toLowerCase(), node.desc.trim().toLowerCase()]
  return visible(node) && CLOSE_LABELS.some((l) => own.includes(l.toLowerCase()))
}

export const YOUTUBE_POPUPS: readonly KnownPopup[] = [
  {
    id: 'yt.premium-upsell',
    what: 'the YouTube Premium offer ("Coba paket keluarga YouTube Premium")',
    matches(nodes) {
      const mentionsPremium = nodes.some((n) => label(n).toLowerCase().includes('youtube premium'))
      const offersTrial = nodes.some((n) => UPSELL_ACTIONS.some((a) => label(n).toLowerCase().startsWith(a)))
      return mentionsPremium && offersTrial && nodes.some(isCloseControl)
    },
  },
]

/** The first known popup on screen, or null. */
export function findPopup(tree: UiNode, register: readonly KnownPopup[] = YOUTUBE_POPUPS): KnownPopup | null {
  const nodes = flatten(tree)
  return register.find((p) => p.matches(nodes)) ?? null
}

/**
 * The control that closes it: a close-labelled node, the clickable one first. Refuses — returns null — for a label that
 * contains a never term, so a future entry added to `CLOSE_LABELS` cannot quietly point at the offer itself.
 */
export function closeTargetOf(tree: UiNode): UiNode | null {
  const candidates = flatten(tree).filter(isCloseControl)
  const safe = candidates.filter((n) => !NEVER_TERMS.some((t) => label(n).toLowerCase().includes(t)))
  return safe.find((n) => n.clickable) ?? safe[0] ?? null
}

/**
 * Close every known popup in `tree`, re-reading the screen after each. Returns the tree to act on — `tree` itself, with
 * no extra dump, when nothing was there, which is what keeps this cheap enough to run on every poll of `waitForTree`.
 */
export async function dismissPopups(ctx: ScriptContext<unknown>, tree: UiNode, opts?: { maxRounds?: number }): Promise<{ tree: UiNode; dismissed: string[] }> {
  const dismissed: string[] = []
  let current = tree
  for (let round = 0; round < (opts?.maxRounds ?? 3); round++) {
    const popup = findPopup(current)
    if (popup === null) return { tree: current, dismissed }
    const target = closeTargetOf(current)
    if (target) {
      const { left, top, right, bottom } = target.bounds
      await ctx.device.tap({ point: { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) } })
      ctx.log.info(`closed ${popup.what} with its "${label(target)}" button`, { popup: popup.id })
    } else {
      await ctx.device.key('BACK')
      ctx.log.warn(`closed ${popup.what} with BACK — its close button was not readable`, { popup: popup.id })
    }
    dismissed.push(popup.id)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    current = await ctx.device.dump()
  }
  if (findPopup(current) !== null) ctx.log.warn('a YouTube popup was still on screen after closing it — continuing; the next step will say where the device is')
  return { tree: current, dismissed }
}
