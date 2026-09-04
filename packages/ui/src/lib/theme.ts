'use client'

import { useSyncExternalStore } from 'react'

/**
 * Which palette the document is showing (plan 204 §3.3). An explicit
 * `data-theme` on `<html>` wins; with no attribute the page follows
 * `prefers-color-scheme`, which is exactly the rule `palette.css`'s three
 * selectors implement. Nothing here WRITES the attribute: the toggle and its
 * `enkaku-theme` persistence are plan 213's.
 */
export type ResolvedTheme = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function resolveTheme(root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): ResolvedTheme {
  const explicit = root?.getAttribute('data-theme')
  if (explicit === 'dark' || explicit === 'light') return explicit
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  media?.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    media?.removeEventListener('change', onChange)
  }
}

/** The resolved theme as React state; re-renders when the attribute or the system preference changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => resolveTheme(), () => 'light')
}
