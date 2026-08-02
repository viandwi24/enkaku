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
}

/**
 * Mapping Selector Enkaku → UiSelector. `{ point }` BUKAN selector server
 * (the caller handles it as a synthetic node).
 */
export function toUiSelector(sel: Selector): UiSelector {
  if ('id' in sel) {
    // Already a full resource-id ("pkg:id/name") → use it as-is.
    return sel.id.includes(':id/') || sel.id.includes('/')
      ? { resourceId: sel.id }
      : { resourceIdMatches: `.*:id/${escapeRegex(sel.id)}` }
  }
  if ('desc' in sel) return { description: sel.desc }
  if ('text' in sel) return { text: sel.text }
  throw new SelectorUnsupportedError(`selector not supported by ui-server: ${JSON.stringify(sel)}`)
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
