import type { Selector } from '@enkaku/protocol'

export class SelectorUnsupportedError extends Error {
  code = 'SELECTOR_UNSUPPORTED'
}

/** UiSelector uiautomator (subset yang dipakai — plan 06 §4.5). */
export interface UiSelector {
  resourceId?: string
  resourceIdMatches?: string
  description?: string
  text?: string
}

/**
 * Mapping Selector Enkaku → UiSelector. `{ point }` BUKAN selector server
 * (di-handle pemanggil sebagai node sintetis).
 */
export function toUiSelector(sel: Selector): UiSelector {
  if ('id' in sel) {
    // Sudah full resource-id ("pkg:id/nama") → pakai apa adanya.
    return sel.id.includes(':id/') || sel.id.includes('/')
      ? { resourceId: sel.id }
      : { resourceIdMatches: `.*:id/${escapeRegex(sel.id)}` }
  }
  if ('desc' in sel) return { description: sel.desc }
  if ('text' in sel) return { text: sel.text }
  throw new SelectorUnsupportedError(`selector tidak didukung ui-server: ${JSON.stringify(sel)}`)
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
