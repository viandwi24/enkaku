'use client'

import Link from 'next/link'
import { GearIcon, cn } from '@enkaku/ui'
import { pluginIcon } from '@/lib/plugin-icons'
import { AvatarMenu } from './AvatarMenu'
import { ThemeToggle } from './ThemeToggle'
import { NAV, SETTINGS_HREF, isNavActive, type PluginNavItem } from './nav'

/**
 * The 60px icon rail (design handoff, "Global shell"):
 *   width: 60px; background: var(--panel); border: 1px solid var(--border);
 *   border-radius: 16px; padding: 10px 0 12px; gap: 6px; centered column.
 * No logo: "the first item is the first nav entry". The brand mark the old,
 * deleted 14-item nav carried is gone with it.
 */
const ITEM = 'flex size-9 shrink-0 items-center justify-center rounded-button transition-colors'
const IDLE = 'text-faint hover:bg-muted-2 hover:text-text'
const ACTIVE = 'bg-accent-soft text-accent'

export function Rail({
  pathname,
  pluginItems,
  activeView,
}: {
  pathname: string
  /** Already flattened; empty when no plugin contributes one AND when the read failed. */
  pluginItems: PluginNavItem[]
  /** `"<plugin>::<view>"` or null. */
  activeView: string | null
}) {
  return (
    <nav
      aria-label="Main navigation"
      className="flex w-[60px] shrink-0 flex-col items-center gap-[6px] rounded-panel border border-border bg-panel pt-[10px] pb-[12px]"
    >
      {NAV.map((item) => {
        const active = isNavActive(item.href, pathname)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            className={cn(ITEM, active ? ACTIVE : IDLE)}
          >
            <Icon className="size-[17px]" aria-hidden />
          </Link>
        )
      })}

      {/* The dynamic menu section the handoff reserves ("plugins may register
          their own view pages, appended under the static nav"), rendered per
          spec §19 and MVP 03 §1: ONE group BELOW the static nav, never
          interleaved. Two operational reasons: the core nav must not shift
          when a plugin is installed or removed, and an operator can see which
          entries are the product and which came from a plugin. Absent
          entirely when nothing contributes one: a farm with no plugins and a
          farm whose `/api/plugins/ui` read failed render identically, which
          is the point. At 60px there is no room for the handoff's labelled
          group heading, so the separation is a rule instead. */}
      {pluginItems.length > 0 && (
        <>
          <div aria-hidden className="my-[2px] h-px w-5 shrink-0 bg-line-2" />
          <div role="group" aria-label="Plugin views" className="flex flex-col items-center gap-[6px]">
            {pluginItems.map((item) => {
              const active = activeView === `${item.plugin}::${item.view}`
              // The name came off the wire, so it is resolved through the
              // allowlist map (plan 204 §4.5); an unrecognised or missing one
              // falls back. A plugin never supplies markup here.
              const Icon = pluginIcon(item.icon)
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  title={item.isDev ? `${item.label} (DEV) · ${item.plugin}` : `${item.label} · ${item.plugin}`}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(ITEM, 'relative', active ? ACTIVE : IDLE)}
                >
                  <Icon className="size-[17px]" aria-hidden />
                  {item.isDev && (
                    <span aria-hidden className="absolute top-[5px] right-[5px] size-[5px] rounded-pill bg-warn" />
                  )}
                </Link>
              )
            })}
          </div>
        </>
      )}

      <div className="flex-1" />

      <ThemeToggle className={cn(ITEM, IDLE)} iconClassName="size-[17px]" />

      <Link
        href={SETTINGS_HREF}
        title="Settings"
        aria-label="Settings"
        aria-current={isNavActive(SETTINGS_HREF, pathname) ? 'page' : undefined}
        className={cn(ITEM, isNavActive(SETTINGS_HREF, pathname) ? ACTIVE : IDLE)}
      >
        <GearIcon className="size-[17px]" aria-hidden />
      </Link>

      <AvatarMenu />
    </nav>
  )
}
