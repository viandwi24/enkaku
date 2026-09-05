import { CodeIcon, DevicesIcon, LightningIcon, PuzzlePieceIcon, RobotIcon, type Icon } from '@enkaku/ui'
import { z } from 'zod'

/**
 * Agents in the rail is an OPEN decision (MVP 15 §4.1, MVP 16 §4.1): a fifth
 * static icon, or the first entry of the dynamic plugin menu. One constant,
 * one row of data, one rail. There is deliberately no second variant to keep
 * true (plan 213 §3.5). Setting this to `false` and shipping an `agents`
 * plugin that declares a nav entry is the whole of the other answer; nothing
 * else in the shell changes.
 */
export const AGENTS_IN_RAIL = true

export interface NavItem {
  href: string
  /** The rail has no labels; this is the `title` and the `aria-label`. */
  label: string
  icon: Icon
  /**
   * Whether this entry may be opened as a picture-in-picture panel (plan 500
   * §3.7). Absent or `false` on Devices only: a framed copy of that screen
   * would mount a SECOND Device Control window against the same phone — a
   * second scrcpy session, not a picture the operator does not already have.
   * `Rail.tsx` reads this flag rather than testing `href === '/'` so the
   * exclusion is data, not a special case at the call site.
   */
  pip?: boolean
}

/**
 * The static rail, in the handoff's order (README "Global shell", rows 1-4)
 * with Agents inserted at MVP 03 §1's position: between Jobs and Plugins.
 * Settings is NOT here: the handoff puts it in the footer group below the
 * spacer, beside the theme toggle and the avatar (`Rail.tsx`).
 *
 * No counts, no badges. The old, deleted 14-item nav carried a number on
 * four of its items and a warning tone on one; at 36x36 with no label there
 * is nowhere to put one, and the two numbers an operator actually watches
 * are in the status bar instead.
 */
export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Devices', icon: DevicesIcon },
  { href: '/scripts', label: 'Scripts & workflows', icon: CodeIcon, pip: true },
  { href: '/jobs', label: 'Jobs', icon: LightningIcon, pip: true },
  ...(AGENTS_IN_RAIL ? [{ href: '/agents', label: 'Agents', icon: RobotIcon, pip: true }] : []),
  { href: '/plugins', label: 'Plugins', icon: PuzzlePieceIcon, pip: true },
]

/** The gear below the spacer. Kept out of `NAV` so the four-or-five count above stays readable. */
export const SETTINGS_HREF = '/settings'
/** Settings is eligible for the picture-in-picture panel too (plan 500 §4.1); it is rendered separately from `NAV` in `Rail.tsx`. */
export const SETTINGS_PIP = true

/**
 * The shell's own read of `GET /api/plugins/ui`. Deliberately LOOSER than
 * `@enkaku/protocol`'s `PluginUiResponseSchema` in exactly one place: `icon`
 * is a plain string here, not `IconNameSchema`.
 *
 * The strict enum is right at the boundary that ACCEPTS a plugin
 * (`definePlugin`, verify and the surface registry, all of which refuse an
 * unknown name and say so). Re-imposing it here would mean a Studio bundle
 * older than the core silently dropping a whole plugin's nav group because it
 * had never heard of one picture; `pluginIcon` falls back instead. Everything
 * else is still parsed, never `as`-cast, and a response that fails this parse
 * leaves the rail with no plugin group at all.
 */
export const PluginNavResponseSchema = z.object({
  items: z.array(
    z.object({
      plugin: z.string().min(1),
      origin: z.string().default('plugin'),
      nav: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          icon: z.string().default(''),
          view: z.string().min(1),
        }),
      ),
    }),
  ),
})
export type PluginNavGroup = z.infer<typeof PluginNavResponseSchema>['items'][number]

export interface PluginNavItem {
  key: string
  label: string
  href: string
  icon: string
  /** `origin: 'dev'`: an unpublished dev slot, marked with a warn dot at rail width. */
  isDev: boolean
  plugin: string
  view: string
}

/**
 * One flat list of links out of the per-plugin groups. Static export, so a
 * plugin screen is one page taking query parameters, the way `/device?id=…`
 * established (plan 108 §3.5), which is also why `activePluginView` below
 * has to read the query and cannot go by pathname.
 */
export function pluginNavItems(groups: PluginNavGroup[]): PluginNavItem[] {
  return groups.flatMap((group) =>
    group.nav.map((entry) => ({
      key: `${group.plugin}:${entry.id}`,
      label: entry.label,
      href: `/plugins/view?name=${encodeURIComponent(group.plugin)}&view=${encodeURIComponent(entry.view)}`,
      icon: entry.icon,
      isDev: group.origin === 'dev',
      plugin: group.plugin,
      view: entry.view,
    })),
  )
}

/** `"<plugin>::<view>"` when a plugin screen is the current page, else `null`. */
export function activePluginView(pathname: string, params: URLSearchParams): string | null {
  if (pathname !== '/plugins/view') return null
  return `${params.get('name') ?? ''}::${params.get('view') ?? ''}`
}

/**
 * The static rail's active test. `/` matches only itself: `/device` used to be
 * folded in here, on the old, deleted nav, and no longer exists as a route
 * after plan 215: Device Control is a window over the Devices page, not an
 * address. Everything else is a prefix match so a nested route lights its
 * own entry.
 */
export function isNavActive(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}
