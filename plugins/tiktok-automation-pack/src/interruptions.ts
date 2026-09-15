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
  /**
   * The dialog's own REFUSAL, by exact label (1.44.0): tapped when on screen, before any close button or BACK. Only a
   * refusal belongs here — never a label that grants, saves, continues or agrees.
   */
  refuse?: readonly string[]
}

export const TIKTOK_INTERRUPTIONS: readonly Interruption[] = [
  {
    id: 'tt.phone-prompt',
    what: 'the "add phone number" sheet',
    identity: ['Tambah nomor telepon', 'Tambahkan nomor telepon Anda', 'Add phone number', 'Add your phone number'],
  },
  {
    // Seen on the owner's production SM-A075F #9 (2026-09-15) over the own profile as it opened: a bottom sheet
    // "Riwayat penonton diaktifkan" with a `viewer_auth_switch` toggle, a "Simpan" button and an unlabelled close
    // (X) at its top right. It hid "Menu profil", so clearing drafts said "the own profile could not be opened".
    // Its close carries no label, so `dismissInterruptions` closes it with BACK — never "Simpan", never the toggle.
    // The English wording is unverified.
    id: 'tt.viewer-history',
    what: 'the "profile view history turned on" sheet',
    identity: ['Riwayat penonton diaktifkan', 'Profile view history is on', 'Profile view history turned on'],
  },
  /*
    Three more dialogs over the feed that hid the Profil tab (1.44.0), from production SM-A075F dumps (2026-09-15): of 19
    runs that stopped with "the own profile could not be opened", 4 sat under "Simpan info login untuk lain waktu?", 4 under
    "Izinkan TikTok mengakses daftar teman Facebook dan email Anda", and 1 under "Izinkan lokasi presisi" (6 more under
    `tt.viewer-history`, 4 under a system dialog the reader cannot see — `withheldBySystemDialog`). English wording unverified.
  */
  {
    // Buttons measured: "Simpan info login" [97,930][622,1019] and "Tidak sekarang" [97,1020][622,1109].
    id: 'tt.save-login',
    what: 'the "save login info" dialog',
    identity: ['Simpan info login untuk lain waktu', 'Save login info for next time'],
    refuse: ['Tidak sekarang', 'Not now'],
  },
  {
    // Buttons measured: "Jangan izinkan" [97,946][359,1035] and "OK" [360,946][622,1035]. "OK" is never tapped.
    id: 'tt.friends-access',
    what: 'the "let TikTok access your friends list" dialog',
    identity: ['Izinkan TikTok mengakses daftar teman Facebook', 'Izinkan TikTok mengakses daftar kontak', 'Allow TikTok to access your Facebook friends', 'Allow TikTok to access your contacts'],
    refuse: ['Jangan izinkan', "Don't allow"],
  },
  {
    // Buttons measured: "Izinkan" and "Buka pengaturan" — neither refuses, so it is closed with BACK.
    id: 'tt.precise-location',
    what: 'the "allow precise location" dialog',
    identity: ['Izinkan lokasi presisi', 'Allow precise location'],
  },
]

/** A known dialog's refusal on screen — a visible, clickable node labelled exactly one of its `refuse` words. */
export function refusalButton(tree: UiNode, interruption: Interruption): UiNode | null {
  const labels = (interruption.refuse ?? []).map((l) => l.toLowerCase())
  if (labels.length === 0) return null
  return flatten(tree).filter(visible).find((n) => n.clickable && words(n).some((w) => labels.includes(w.toLowerCase()))) ?? null
}

/**
 * Only System UI is readable (1.44.0): a system dialog Android hides from the reader is over TikTok — 4 production runs
 * (2026-09-15) whose Profil tab "was not on screen" read nothing else. BACK refuses such a dialog.
 */
export function withheldBySystemDialog(tree: UiNode): boolean {
  const nodes = flatten(tree)
  return nodes.some((n) => n.packageName === 'com.android.systemui') && !nodes.some((n) => n.packageName !== '' && n.packageName !== 'com.android.systemui')
}

/** The labels a sheet's close control carries. Nothing that continues, agrees or submits. */
export const CLOSE_LABELS = ['Tutup', 'Close'] as const

/** The farm's own keyboard, the guest agent's IME ("Enkaku input — driven by the farm host", "Switch keyboard"). */
export const FARM_IME_PACKAGE = 'dev.enkaku.guestagent'

/** The phones' own soft keyboards: Gboard, Samsung's honeyboard, SwiftKey, anything else that says "keyboard" (`post-video.ts`'s rule). */
const KEYBOARD_PACKAGES = /inputmethod|honeyboard|swiftkey|keyboard/i

/**
 * A keyboard window is drawn on screen (1.45.0). The farm's IME is the guest agent's package, which the phones' keyboard
 * rule never matched: `screen-feed-samsung-phone-sheet.json` carries it as `android:id/inputArea` with `ime_notice` and
 * `ime_switch_keyboard_button` under `dev.enkaku.guestagent`. Only those input-area nodes count for that package, so
 * nothing else the guest agent might draw reads as a keyboard.
 */
export function keyboardWindowShowing(tree: UiNode): boolean {
  return flatten(tree).some(
    (n) =>
      visible(n) &&
      (KEYBOARD_PACKAGES.test(n.packageName) ||
        (n.packageName === FARM_IME_PACKAGE && (n.resourceId === 'android:id/inputArea' || n.resourceId.includes(':id/ime_')))),
  )
}

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
  // What each interruption was last answered with, so one still up is not given the same answer that did not take.
  const answered = new Map<string, 'refuse' | 'close' | 'back'>()
  let current = tree ?? (await ctx.device.dump())
  for (let round = 0; round < (opts?.maxRounds ?? 3); round++) {
    let found = findInterruption(current)
    if (!found) return { tree: current, dismissed }
    const previous = answered.get(found.interruption.id)
    /*
      Still up after an answer, with a keyboard showing (1.45.0): the "Add phone" sheet on a production English build
      (job bf283f3d, 2026-09-15) sat with its phone field focused and the farm keyboard up, and four close taps in a row
      left it there. BACK first puts the keyboard away — it goes to the keyboard, not the sheet — and the sheet is then
      answered as usual. Nothing is ever typed into the field.
    */
    let keyboardPutAway = false
    if (previous !== undefined && keyboardWindowShowing(current)) {
      await ctx.device.key('BACK')
      ctx.log.warn(`${found.interruption.what} was still up with a keyboard showing — BACK to put the keyboard away first`, { interruption: found.interruption.id })
      keyboardPutAway = true
      await sleep(1_000)
      current = await ctx.device.dump()
      const again = findInterruption(current)
      if (!again || again.interruption.id !== found.interruption.id) {
        if (!dismissed.includes(found.interruption.id)) dismissed.push(found.interruption.id)
        continue
      }
      found = again
    }
    const refusal = refusalButton(current, found.interruption)
    // A close tap that left the sheet up is not repeated (1.45.0) unless the keyboard was just put away: BACK instead.
    const close = refusal || (previous === 'close' && !keyboardPutAway) ? null : closeNear(current, found.anchor)
    if (refusal) {
      await ctx.device.tap({ point: centerOf(refusal.bounds) })
      ctx.log.info(`refused ${found.interruption.what} with "${(refusal.text || refusal.desc).trim()}"`, { interruption: found.interruption.id })
      answered.set(found.interruption.id, 'refuse')
    } else if (close) {
      await ctx.device.tap({ point: centerOf(close.bounds) })
      ctx.log.info(`closed ${found.interruption.what} with its close button`, { interruption: found.interruption.id })
      answered.set(found.interruption.id, 'close')
    } else {
      await ctx.device.key('BACK')
      const why = previous === 'close' && !keyboardPutAway ? 'its close button did not take' : 'its close button was not readable'
      ctx.log.warn(`closed ${found.interruption.what} with BACK — ${why}`, { interruption: found.interruption.id })
      answered.set(found.interruption.id, 'back')
    }
    if (!dismissed.includes(found.interruption.id)) dismissed.push(found.interruption.id)
    await sleep(1_200)
    current = await ctx.device.dump()
  }
  if (findInterruption(current)) ctx.log.warn('a TikTok interruption was still on screen after closing it — continuing')
  return { tree: current, dismissed }
}
