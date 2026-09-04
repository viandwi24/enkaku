'use client'

import { MoonIcon, SunIcon, useResolvedTheme } from '@enkaku/ui'

/** The handoff's key, fixed: `localStorage` under `enkaku-theme` (README, Interactions table). */
export const THEME_STORAGE_KEY = 'enkaku-theme'

/**
 * Flip `data-theme` on `<html>` and persist it (design handoff, Interactions:
 * "Theme toggle | Flip `data-theme` on `<html>`, persisted in `localStorage`
 * under `enkaku-theme`").
 *
 * There is no React state here on purpose. Plan 204's `useResolvedTheme`
 * already watches the attribute with a `MutationObserver` and the system
 * preference with a media query, so writing the attribute IS the state
 * update. A second copy in `useState` would be the thing that drifts the
 * first time something else (the boot script, a devtools poke) sets it.
 *
 * NOT stored through `lib/prefs.ts`: the boot script in `app/layout.tsx` has
 * to read this value before any module loads, so the key is a bare string
 * with a bare value, not a JSON envelope behind a Zod parse.
 */
export function ThemeToggle({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  const theme = useResolvedTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  const title = next === 'dark' ? 'Switch to dark mode' : 'Switch to light mode'

  const flip = () => {
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Private browsing, or storage disabled. The theme still flips for this
      // page; it simply does not survive the reload.
    }
  }

  const Icon = theme === 'dark' ? SunIcon : MoonIcon
  return (
    <button type="button" onClick={flip} title={title} aria-label={title} className={className}>
      <Icon className={iconClassName} aria-hidden />
    </button>
  )
}
