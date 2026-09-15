import type { CSSProperties } from 'react'

/**
 * The one framing helper both panel modes share (plan 501 §4.2, §3.6): PiP
 * and the side panel differ in chrome, never in how the framed document is
 * built. A change to framing lands here once, so it cannot land in one mode
 * and miss the other (G10).
 *
 * `base` is always the caller's own `coreBase()` call (plan 500 §3.4) — this
 * helper owns only the `pip=1` flag (added to whatever query the href already has), not the origin, which is why
 * `coreBase()` itself still reads at each panel's own call site.
 */
export function frameSrc(base: string, href: string): string {
  // A plugin screen's href already carries a query (`/plugins/view?name=proxy-manager&view=proxies`): a second `?`
  // made the flag part of the view name — "no longer declares a screen called proxies?pip=1" (owner, 2026-09-16).
  const hashAt = href.indexOf('#')
  const path = hashAt === -1 ? href : href.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : href.slice(hashAt)
  const params = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '')
  params.set('pip', '1')
  const pathname = path.includes('?') ? path.slice(0, path.indexOf('?')) : path
  return `${base}${pathname}?${params.toString()}${hash}`
}

/** 50 % to 150 %, five steps (plan 500 §3.6). */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5] as const

/**
 * `transform: scale(z)` with inverse `width`/`height` (plan 500 §3.6): without
 * the inverse sizing, zooming out shrinks the framed page into a smaller
 * rectangle in the corner instead of showing MORE of it, which is what an
 * operator wants from zoom-out on a responsive page.
 */
export function frameStyle(zoom: number): CSSProperties {
  return {
    width: `${100 / zoom}%`,
    height: `${100 / zoom}%`,
    transform: `scale(${zoom})`,
    transformOrigin: 'top left',
  }
}
