import type { Selector } from '@enkaku/protocol'

export class SelectorUnsupportedError extends Error {
  code = 'SELECTOR_UNSUPPORTED'
}

/** uiautomator UiSelector (the subset in use — plan 06 §4.5). */
export interface UiSelector {
  resourceId?: string
  resourceIdMatches?: string
  description?: string
  text?: string
  /** Which of the fields above are actually set — see `SELECTOR_MASK`. Required by the server. */
  mask?: number
}

/**
 * The on-device server does not infer which selector fields you set — it reads a **bitmask**.
 *
 * This is the openatx uiautomator2 wire contract: `Selector` carries a `mask` whose bits say which
 * criteria are active, and the server ANDs only those. A selector sent without one matches on
 * nothing, and — this is the part that cost a day — the server does not answer "no match". It
 * answers with the **root node**: a `FrameLayout` at `0,0,720,1640`, no resource id, no text.
 *
 * Downstream that looked exactly like a real match for a viewport-sized container, so plan 60
 * §3.1's oversized guard rejected it and `find()` returned null. Every selector, every time. The
 * symptoms were everywhere and pointed nowhere near here: `find refused: rejected-oversized
 * (matches=1)` on a node that is plainly 144×86 in the dump, scripts reporting they could not read
 * anything, and the Inspector tab falling back to `uiautomator dump` — which then failed on its own
 * because the healthy ui-server was holding UiAutomation.
 *
 * Verified against a live device: `{resourceId}` alone returned the 720×1640 root; the same
 * selector with `mask: 0x200000` returned `192×39, :id/title, text="kinandaputriii"`.
 */
const SELECTOR_MASK = {
  text: 0x01,
  className: 0x10,
  description: 0x40,
  packageName: 0x080000,
  resourceId: 0x200000,
  resourceIdMatches: 0x400000,
} as const

/**
 * Mapping Selector Enkaku → UiSelector. `{ point }` BUKAN selector server
 * (the caller handles it as a synthetic node).
 */
export function toUiSelector(sel: Selector): UiSelector {
  if ('id' in sel) {
    // Already a full resource-id ("pkg:id/name") → use it as-is.
    return sel.id.includes(':id/') || sel.id.includes('/')
      ? { resourceId: sel.id, mask: SELECTOR_MASK.resourceId }
      : { resourceIdMatches: `.*:id/${escapeRegex(sel.id)}`, mask: SELECTOR_MASK.resourceIdMatches }
  }
  if ('desc' in sel) return { description: sel.desc, mask: SELECTOR_MASK.description }
  if ('text' in sel) return { text: sel.text, mask: SELECTOR_MASK.text }
  throw new SelectorUnsupportedError(`selector not supported by ui-server: ${JSON.stringify(sel)}`)
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
