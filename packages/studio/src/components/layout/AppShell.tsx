'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { ChevronsLeft, Menu, MonitorSmartphone, FolderTree, ListChecks, Layers, Boxes, CalendarClock, Wrench, SlidersHorizontal, Server, Bot, Puzzle, LogOut, Workflow, CircleDot, type LucideIcon } from 'lucide-react'
import { z } from 'zod'
import { HealthResponseSchema } from '@enkaku/protocol'
import {
  Button,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from '@enkaku/ui'
import { NotificationBell } from '@/components/NotificationBell'
import { OperationTray } from '@/components/operations/OperationTray'
import { ProvisioningBanner } from '@/components/ProvisioningBanner'
import { AdbServerBanner } from '@/components/layout/AdbServerBanner'
import { useAuth, type AuthUser } from '@/lib/auth'
import { coreBase, ws } from '@/lib/ws'
import { pluginIcon } from '@/lib/plugin-icons'
import { readLocalPrefs, writeLocalPrefs } from '@/lib/prefs'

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  countKey: keyof Counts | null
  /**
   * Shown when `countKey`'s own count is 0 — the ONE place a nav item is
   * allowed two numbers, and only because one of them is a warning and the
   * other is a plain count. See the `/plugins` entry below for why.
   */
  fallbackCountKey?: keyof Counts
}

const NAV: NavItem[] = [
  { href: '/', label: 'Devices', icon: MonitorSmartphone, countKey: 'devices' as const },
  // No `/scripts` entry — Scripts merged INTO the Plugins screen (owner's own
  // ask, 2026-08-17), and `/scripts` is now a redirect there. See
  // `AppShell.test.tsx`'s `NOT_IN_NAV_BY_DESIGN` for why a compatibility
  // redirect must not get a nav item of its own.
  // Workflows sit at the SAME level as scripts, not underneath them — the
  // owner's own ruling, and the reason `RunScriptDialog` offers a
  // Workflow | Script choice rather than burying one inside the other. The
  // list page existed from plan 99 §5 step 99.9 but had no nav entry, so the
  // only way in was `RunScriptDialog`'s "Open the workflow editor" link:
  // a workflow could be created and edited, never browsed.
  { href: '/workflows', label: 'Workflows', icon: Workflow, countKey: null },
  // Recordings (plan 94 §5 step 94.5). Same gap: `/recordings/detail?slug=`
  // was linked from `RecordPanel` right after a capture, so an operator
  // could review the recording they had just made and never find an older
  // one again. It sits beside Scripts because publishing a recording is how
  // a script gets made here.
  { href: '/recordings', label: 'Recordings', icon: CircleDot, countKey: null },
  // Plan 82 §4.6, criterion 30 — the badge is a farm-health WARNING (danger
  // tone, not the neutral count every other item uses) while any plugin is
  // `failed`, and it already links to the page: this nav entry IS the
  // warning, not a separate banner living somewhere else.
  //
  // The label names both halves because the screen behind it holds both now.
  // `fallbackCountKey` is where the old Scripts entry's `scripts` count went,
  // rather than being dropped: it is FOLDED IN, not stacked beside the
  // warning. A nav item with two numbers on it is unreadable at 13px, and
  // these two never compete for attention — "3 plugins are broken" outranks
  // "41 scripts exist" every time, so the count only shows while there is no
  // warning to show instead. Nothing an operator could see before is gone;
  // the number they could see is simply no longer allowed to hide the fault.
  {
    href: '/plugins',
    label: 'Plugins & scripts',
    icon: Puzzle,
    countKey: 'failedPlugins' as const,
    fallbackCountKey: 'scripts' as const,
  },
  { href: '/workspace', label: 'Workspace', icon: FolderTree, countKey: null },
  { href: '/jobs', label: 'Jobs', icon: ListChecks, countKey: 'activeJobs' as const },
  // The fleet command console (plan 93 §3.16, §4.8, step 93.7) is gone
  // entirely (plan 207 — MVP 13 A.5, A.6a): the `adb` verb through
  // `POST /api/actions/adb` replaces it, reached from a device's own Terminal
  // tab (`AdbCommandDialog`), which stays put. No nav item for it any more.
  { href: '/groups', label: 'Groups', icon: Layers, countKey: null },
  // No `/topology` entry — that page is gone too (plan 207 §4.7): it was a
  // 22-line compatibility redirect to `/?view=wall&group=cluster`, and that
  // view already has its own front door in the grid's `GroupBy` control.
  { href: '/batches', label: 'Batches', icon: Boxes, countKey: null },
  { href: '/schedules', label: 'Schedules', icon: CalendarClock, countKey: null },
  { href: '/tools', label: 'Tools', icon: Wrench, countKey: null },
  { href: '/nodes', label: 'Nodes', icon: Server, countKey: null },
  // AI agents (plan 65) — reuses the `/agents` path plan 61 freed by moving
  // the tunnel process to "node"; its interim redirect-to-/nodes page is
  // removed by this plan rather than waiting for its v0.1.7 target.
  { href: '/agents', label: 'Agents', icon: Bot, countKey: null },
  { href: '/settings', label: 'Settings', icon: SlidersHorizontal, countKey: null },
]

interface Counts {
  devices: number
  scripts: number
  activeJobs: number
  failedPlugins: number
}

/**
 * The sidebar's own read of `GET /api/plugins/ui` (plan 108 §3.5, §5 step
 * 108.8) — deliberately LOOSER than `@enkaku/protocol`'s own
 * `PluginUiResponseSchema`, in exactly one place: `icon` is a plain string
 * here, not `IconNameSchema`.
 *
 * The strict enum is the right shape at the boundary that ACCEPTS a plugin
 * (`definePlugin`, verify, the surface registry — all of which refuse an
 * unknown name and say so). Re-imposing it here would mean a Studio bundle
 * older than the core silently dropped a whole plugin's nav group because it
 * had never heard of one picture; `pluginIcon` falls back instead. Everything
 * else a nav entry carries is still parsed, never `as`-cast, and a response
 * that fails this parse leaves the sidebar with no plugin group at all.
 */
const PluginNavResponseSchema = z.object({
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
type PluginNavGroup = z.infer<typeof PluginNavResponseSchema>['items'][number]

interface PluginNavItem {
  key: string
  label: string
  href: string
  icon: string
  /** `origin: 'dev'` — an unpublished dev slot, flagged with a `DEV` chip (criterion 7). */
  isDev: boolean
  plugin: string
  view: string
}

/**
 * One flat list of links out of the per-plugin groups. Static export, so a
 * plugin screen is one page taking query parameters, the way `/device?id=…`
 * already establishes (plan 108 §3.5).
 */
function pluginNavItems(groups: PluginNavGroup[]): PluginNavItem[] {
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

/**
 * App frame: fixed sidebar plus page content.
 *
 * The sidebar carries three things a top nav has no room for: counts next to
 * each item (you can see a job is queued without opening it), a permanent
 * spot for core connection status, and room to grow as sections are added.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Counts>({ devices: 0, scripts: 0, activeJobs: 0, failedPlugins: 0 })
  // Plan 108 §5 step 108.8 — what the live plugins contribute to the nav.
  // Empty until it loads, empty forever if the read fails: a farm with no
  // plugins and a farm whose plugin list could not be read look the same
  // here, which is the point — neither is allowed to disturb the static nav.
  const [pluginNav, setPluginNav] = useState<PluginNavGroup[]>([])
  const [connected, setConnected] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [mode, setMode] = useState<string>('local')
  const [mobileOpen, setMobileOpen] = useState(false)
  // Plan 101 §3.4, step 101.2 — starts expanded (the server-rendered/first-
  // paint state, since `localStorage` does not exist during the static
  // export's prerender) and reads the real preference once mounted, exactly
  // the same "default, then correct after mount" shape a `localStorage`-backed
  // value always needs in a statically-exported app.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    setCollapsed(readLocalPrefs().sidebarCollapsed)
  }, [])
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev
      writeLocalPrefs({ sidebarCollapsed: next })
      return next
    })
  }
  const pathname = usePathname()
  // A plugin screen is `/plugins/view?name=…&view=…` (plan 108 §3.5), so the
  // path alone cannot say WHICH entry is the current one — the query is the
  // whole address. Safe to read here: `AppShell` only ever renders inside
  // `AuthGate`'s own `<Suspense>` boundary, which is what a static export
  // needs before it will prerender a `useSearchParams()` caller at all.
  const searchParams = useSearchParams()
  // Who is signed in, from `AuthGate` (plan 09 §4.14) — `authMode` here is
  // 'local'|'server' (is a login wall in effect at all), a different axis
  // from the `mode` state above ('local'|'orchestrator', which core binary
  // this is talking to). `authMode === 'local'` hides the user menu
  // entirely: local mode's implicit admin has no session to sign out of.
  const { user, authMode, logout } = useAuth()

  // ── The two loads are SEPARATE effects on purpose (plan 126 §0.4, §3.5,
  // steps 126.3 and 126.5). They used to be one `Promise.all` of six requests
  // re-fired by every `device.added`, `device.removed` AND `job.status`, which
  // meant the sidebar re-downloaded the whole plugin list — at the time, every
  // plugin's full built bundle, ~1 MB per version row — several times a
  // second on a farm running batches. Splitting them is what lets the two
  // halves have the cadence each actually needs: the counts genuinely change
  // on job and device events, and the plugin nav genuinely does not.
  useEffect(() => {
    // One controller for the LIFETIME OF THE EFFECT, aborted only on unmount.
    // Deliberately NOT one per pass: aborting the in-flight pass whenever a
    // newer event arrives would mean a farm emitting `job.status` faster than
    // the round trip completes never lands a single count — the counts would
    // freeze precisely on the busy farm they matter on. Staleness is handled
    // by never having two passes in flight at once (below) instead.
    const ctrl = new AbortController()
    let disposed = false
    // The stale-response guard the old effect had none of. `running` means a
    // pass owns the state; a burst of events while it is in flight collapses
    // into ONE follow-up pass (`queued`) rather than N parallel ones whose
    // replies could land in any order and leave the badge showing whichever
    // answer happened to be slowest.
    let running = false
    let queued = false
    const load = async () => {
      if (running) {
        queued = true
        return
      }
      running = true
      try {
        const [d, s, j, h] = await Promise.all([
          fetch(`${coreBase()}/api/devices`, { signal: ctrl.signal }).then((r) => r.json()),
          fetch(`${coreBase()}/api/scripts`, { signal: ctrl.signal }).then((r) => r.json()),
          fetch(`${coreBase()}/api/jobs?limit=200`, { signal: ctrl.signal }).then((r) => r.json()),
          fetch(`${coreBase()}/api/health`, { signal: ctrl.signal }).then((r) => r.json()),
        ])
        if (disposed) return
        setCounts((prev) => ({
          ...prev,
          // Both endpoints paginate now (plan 30 §4.2) — `total` is the true
          // farm-wide count; `.devices`/`.scripts` would silently cap at the
          // first page's size on a farm bigger than the default limit.
          devices: d.total ?? (d.devices ?? []).length,
          scripts: s.total ?? (s.scripts ?? []).length,
          // No cheap "how many are active" total exists, so this still scans
          // a bounded recent window (the system's own 200-row cap, not an
          // unbounded fetch) rather than every job ever run.
          // `.items`, not `.jobs` — list endpoints return the keyset envelope (plan 30). Reading
          // the old key here did not throw, it just made this badge silently count zero, which is
          // worse: a wrong number nobody questions. `.jobs` is kept as a fallback only so an older
          // core still reports something rather than nothing.
          activeJobs: ((j.items ?? j.jobs ?? []) as { status: string }[]).filter(
            (x) => x.status === 'queued' || x.status === 'running',
          ).length,
          // Plan 126 §3.5, step 126.5 — the farm-health warning badge, now
          // an integer on the health response this pass already makes rather
          // than a filter over a plugin list this component downloaded on
          // every page to compute it (§0.4). Parsed, never `as`-cast, and
          // `?? prev.failedPlugins` on failure: a core too old to report the
          // field, or a body that is not this shape at all, must leave the
          // badge where it was rather than assert a confident zero.
          failedPlugins: HealthResponseSchema.safeParse(h).data?.failedPlugins ?? prev.failedPlugins,
        }))
        setVersion(h.version ?? null)
        setMode(h.mode ?? 'local')
      } catch {
        // The sidebar must not take the page down when the core is unreachable.
      } finally {
        running = false
        if (queued && !disposed) {
          queued = false
          void load()
        }
      }
    }
    void load()
    const offStatus = ws.onStatus(setConnected)
    // Counts update on events rather than on a polling timer. `job.status`
    // stays a trigger HERE — `activeJobs` is exactly "how many jobs are
    // queued or running", so a job changing state is the only thing that can
    // change it. What must never come back is the plugin list riding along on
    // this pass; see the effect below.
    const off = ws.on((m) => {
      if (m.type === 'device.added' || m.type === 'device.removed' || m.type === 'job.status') void load()
    })
    return () => {
      disposed = true
      ctrl.abort()
      off()
      offStatus()
    }
  }, [])

  /**
   * The plugin nav group — plan 108 §5 step 108.8, plan 126 §3.5, steps
   * 126.3 and 126.5.
   *
   * **This effect no longer fetches `GET /api/plugins`, and it must not fetch
   * it again.** It used to, on every Studio page, for one integer:
   * `failedPlugins`, the count of plugin rows in `failed`. That list carried
   * every plugin's full built bundle at the time — ~1 MB per version row,
   * 37 MB on a farm with twenty versions (plan 126 §0.4, §0.3) — and the
   * whole payload was discarded on the next line. Step 126.5 moved the
   * integer onto `GET /api/health`, which the counts effect above already
   * polls, so the request is gone rather than merely rarer. Anything the
   * sidebar needs about plugins beyond the nav belongs on health as another
   * scalar, not as a list read reinstated here.
   *
   * `/api/plugins/ui` stays, and it is a different animal: it returns nav
   * entries only — plugin, version, origin, and each entry's id/label/icon/
   * view (`packages/core/src/plugins/surface-registry.ts`) — never a
   * manifest, a settings schema or a bundle. It is genuinely needed on every
   * page, because it is the nav.
   *
   * **`job.status` is not a trigger here, and restoring it would be a
   * regression, not a fix.** The screens a plugin declares cannot change
   * because a job moved from `queued` to `running`, so every one of those
   * re-fetches was pure waste — and on a farm running batches `job.status`
   * fires several times a second, which made this the most expensive request
   * in Studio (plan 126 §0.4). `device.added`/`device.removed` are gone for
   * the same reason: plugging a phone in cannot add a plugin screen either.
   *
   * `pathname` is the dependency instead, so the nav refreshes on every
   * client-side navigation. That is deliberate and it is the cheapest trigger
   * that still covers the one flow that DOES change this answer — an operator
   * installing, publishing, disabling or restarting a plugin on `/plugins`
   * and then going somewhere else. Human-paced, bounded by clicks, and no
   * longer coupled to farm throughput.
   */
  useEffect(() => {
    const ctrl = new AbortController()
    let disposed = false
    const loadPluginNav = async () => {
      // Plan 108 §5 step 108.8 (G8) — the nav contributions, with their own
      // `catch`: a core too old to know this route, or an operator whose
      // token cannot read it, gets the static nav and nothing extra — never
      // a sidebar that failed to draw.
      const u = await fetch(`${coreBase()}/api/plugins/ui`, { signal: ctrl.signal })
        .then((r) => r.json())
        .catch(() => null)
      // The abort path lands here too (the `catch` swallows it), so the guard
      // is what stops an unmounted — or superseded — pass from writing an
      // empty nav over a good one.
      if (disposed) return
      // Parsed, never `as`-cast: a 404/403 body is a perfectly valid JSON
      // document that simply is not this shape, and `safeParse` is what
      // turns that into "no plugin group" instead of a render-time throw.
      const ui = PluginNavResponseSchema.safeParse(u)
      setPluginNav(ui.success ? ui.data.items : [])
    }
    void loadPluginNav()
    return () => {
      disposed = true
      ctrl.abort()
    }
  }, [pathname])

  useEffect(() => setMobileOpen(false), [pathname])

  const pluginItems = pluginNavItems(pluginNav)
  const activePluginView =
    pathname === '/plugins/view' ? `${searchParams.get('name') ?? ''}::${searchParams.get('view') ?? ''}` : null

  // The mobile sheet (below 1024px, design.md's own unchanged rule) is
  // always the full, uncollapsed sidebar — "collapsed" is a floating-desktop
  // rail concept (plan 101 §3.4), and a full-screen overlay menu has no
  // width to reclaim by collapsing it.
  const mobileBody = (
    <SidebarBody
      counts={counts}
      connected={connected}
      version={version}
      pathname={pathname}
      mode={mode}
      user={user}
      authMode={authMode}
      onLogout={() => void logout()}
      collapsed={false}
      pluginItems={pluginItems}
      activePluginView={activePluginView}
    />
  )

  return (
    // A LOCAL provider (nesting inside `layout.tsx`'s app-wide one is
    // harmless — radix resolves to the nearest ancestor) so `AppShell`
    // renders correctly in isolation, e.g. under `AppShell.test.tsx`, which
    // does not itself supply one.
    <TooltipProvider delayDuration={200}>
    <div className="flex h-dvh overflow-hidden">
      {/* Plan 101 §3.4, §4.2, step 101.2 — the collapsible, floating,
          rounded sidebar. Width transitions 222px <-> 72px over 0.18s; the
          14px outer margin and 22px radius separate it from the page body
          the same way the reference's rack-mounted look does. The ONE
          backdrop blur this refresh permits anywhere (plan 101 §3.6) — an
          arbitrary-value Tailwind utility (allowed), not the bracket form
          that names a custom-property COLOUR inside the brackets (that is
          the specific v3 pattern `design-rules.test.ts` forbids — this is
          a length/percentage value, a different thing entirely). */}
      <aside
        className={cn(
          'relative m-3.5 hidden shrink-0 flex-col overflow-hidden rounded-[22px] border border-line bg-surface-2/70 backdrop-blur-[20px] backdrop-saturate-[150%] shadow-2xl transition-[width] duration-[180ms] lg:flex',
          collapsed ? 'w-[72px]' : 'w-[222px]',
        )}
      >
        <SidebarBody
          counts={counts}
          connected={connected}
          version={version}
          pathname={pathname}
          mode={mode}
          user={user}
          authMode={authMode}
          onLogout={() => void logout()}
          collapsed={collapsed}
          pluginItems={pluginItems}
          activePluginView={activePluginView}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-pressed={collapsed}
              className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
            >
              <ChevronsLeft className={cn('size-3.5 transition-transform', collapsed && 'rotate-180')} aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</TooltipContent>
        </Tooltip>
      </aside>

      {/* Plan 101 §5 step 101.8 (owner-specified, 2026-08-16) — the content
          area's visual counterpart to the sidebar's own float (step 101.2):
          in `refs/ui` the whole content pane is a large rounded panel inset
          from the window edge, with its own recessed background and a soft
          ambient glow, sitting on the dot-grid page — not flush edge-to-edge
          the way this shell rendered before. Desktop only (`lg:`), matching
          the sidebar's own `lg:flex` — below that breakpoint the sidebar
          becomes a full-width sheet and the mobile top bar already reads as
          its own flush surface, so there is no floating "page" to counter.
          `bg-surface-2/40` is `--color-surface-2` (converted from the
          reference's own recessed value per plan 101 §4.1's mapping table)
          at the reference's own alpha — a token, not a pasted hex literal
          (plan 101 §3.1; see `globals.css` for the exact conversion, the
          only file allowed to state one). No `backdrop-filter`
          here: the reference's own container has none either (only the glow
          blobs below use `filter: blur()`, a different, cheaper property
          that never forces a compositing layer the way `backdrop-filter`
          does), so this costs nothing `design-rules.test.ts` would flag and
          nothing plan 101 §3.6's "nothing that scales with device count"
          rule is even about — it is one fixed panel, not a per-device one. */}
      <div className="relative flex min-w-0 flex-1 flex-col lg:my-3.5 lg:mr-3.5 lg:overflow-hidden lg:rounded-[22px] lg:border lg:border-line lg:bg-surface-2/40 lg:shadow-2xl">
        {/* The ambient glow (`refs/ui`'s own three radial blobs, reduced to
            two): built from `--color-accent`/`--color-led-warn` tokens, never
            a hex literal. The reference's third blob is the logo mark's own
            pink accent — `docs/design.md` deliberately does not promote
            that colour to a token ("naming it invites its use as a second
            accent"), so it is left out here rather than reintroducing the
            exact thing that rule exists to prevent. `-z-10` and
            `pointer-events-none` keep it decorative, under everything real. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-[8%] -z-10 hidden size-[420px] rounded-full bg-accent/25 blur-[110px] lg:block"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-36 right-[15%] -z-10 hidden size-[420px] rounded-full bg-led-warn/15 blur-[120px] lg:block"
        />

        <div className="flex items-center gap-2 border-b bg-surface px-3 py-2 lg:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-56 bg-surface p-0">
              <SheetTitle className="sr-only">Main menu</SheetTitle>
              {mobileBody}
            </SheetContent>
          </Sheet>
          <Brand />
          <div className="ml-auto">
            <NotificationBell />
          </div>
        </div>

        {/* Above `main` and outside its scroll container: first-run
            provisioning is the one thing an operator needs to see before
            they have navigated anywhere, and it must not scroll away. */}
        <ProvisioningBanner />
        {/* Same reasoning, same placement (plan 88 §3.10, §5 step 88.8): a
            restart drops every device on every page, not just Tools. */}
        <AdbServerBanner />

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      {/* Plan 107 (M72) §1, §3.1, §4, step 107.3 — one floating, farm-wide
          tray for every long operation, mounted ONCE here rather than per
          screen (§9 Q3, recorded as a proposal, not a settled ruling — see
          that component's own doc comment). Sibling to both the sidebar and
          the content pane, not nested inside either, so its own `fixed`
          positioning is never affected by an ancestor gaining a
          containing-block-creating `filter`/`transform` later. */}
      <OperationTray />
    </div>
    </TooltipProvider>
  )
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-6 place-items-center rounded bg-accent text-[11px] font-bold text-accent-fg">
        E
      </span>
      Enkaku
    </Link>
  )
}

function SidebarBody({
  counts,
  connected,
  version,
  pathname,
  mode,
  user,
  authMode,
  onLogout,
  collapsed,
  pluginItems,
  activePluginView,
}: {
  counts: Counts
  connected: boolean
  version: string | null
  pathname: string
  mode: string
  user: AuthUser | null
  authMode: string
  onLogout: () => void
  /** Plan 101 §3.4, step 101.2 — the 72px rail: icons only, a tooltip names
   *  every item so nothing moves into a hidden overflow menu. */
  collapsed: boolean
  /** Plan 108 §5 step 108.8 — what the live plugins contribute, already flattened. */
  pluginItems: PluginNavItem[]
  /** `"<plugin>::<view>"` when a plugin screen is the current page, else `null`. */
  activePluginView: string | null
}) {
  return (
    <>
      <div className={cn('flex h-12 items-center gap-2 border-b border-line px-4', collapsed && 'justify-center px-0')}>
        {collapsed ? (
          <Link href="/" aria-label="Enkaku" className="grid size-6 place-items-center rounded bg-accent text-[11px] font-bold text-accent-fg">
            E
          </Link>
        ) : (
          <>
            <Brand />
            <div className="ml-auto">
              <NotificationBell />
            </div>
          </>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main navigation">
        {NAV.map((item) => {
          const active = item.href === '/' ? pathname === '/' || pathname === '/device' : pathname.startsWith(item.href)
          const primary = item.countKey ? counts[item.countKey] : null
          // The Plugins badge is a WARNING (criterion 30), not a neutral
          // count — a farm operator needs it to read as "something is
          // wrong here," the same visual language `DeviceStatusBadge`'s
          // `quarantined` tone already uses, not "here is a number."
          const isWarning = item.countKey === 'failedPlugins' && primary !== null && primary > 0
          // Fall back to the neutral count only when the warning has nothing
          // to say — the two are never shown together (see `NAV` above).
          const count = primary === 0 && item.fallbackCountKey ? counts[item.fallbackCountKey] : primary
          const Icon = item.icon
          const link = (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors',
                collapsed && 'justify-center px-0',
                active
                  ? 'bg-surface-2 font-medium text-fg'
                  : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {!collapsed && <span className="flex-1">{item.label}</span>}
              {count !== null && count > 0 && !collapsed && (
                <span
                  role={isWarning ? 'status' : undefined}
                  title={
                    isWarning
                      ? `${count} plugin${count === 1 ? '' : 's'} failed to register`
                      : item.fallbackCountKey === 'scripts'
                        ? `${count} script${count === 1 ? '' : 's'} published`
                        : undefined
                  }
                  className={cn(
                    'readout rounded px-1.5 text-[11px]',
                    isWarning ? 'bg-led-danger/15 text-led-danger font-medium' : 'bg-surface-3 text-fg-muted',
                  )}
                >
                  {count}
                </span>
              )}
              {/* Collapsed: the same fact (a badge exists) as a plain dot —
                  no count is legible at 72px, but its EXISTENCE still is,
                  so nothing that mattered at full width silently vanishes. */}
              {count !== null && count > 0 && collapsed && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute right-1.5 top-1.5 size-1.5 rounded-full',
                    isWarning ? 'bg-led-danger' : 'bg-accent',
                  )}
                />
              )}
            </Link>
          )
          if (!collapsed) return link
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">
                {item.label}
                {count !== null && count > 0 ? ` (${count})` : ''}
              </TooltipContent>
            </Tooltip>
          )
        })}

        {/* Plan 108 §3.5, §5 step 108.8, criterion 7 — the plugins' own
            entries, in ONE labelled group BELOW the static nav and never
            interleaved with it. Two reasons, both operational: the core nav
            must not shift position when a plugin is installed or removed
            (muscle memory for "Jobs is the seventh item" survives), and an
            operator can see at a glance which entries are the product and
            which came from a plugin. Absent entirely when no plugin
            contributes one — a farm with no plugins, and a farm whose
            `/api/plugins/ui` read failed, render identically. */}
        {pluginItems.length > 0 && (
          <div className="space-y-0.5 pt-2" role="group" aria-label="Plugin views">
            {collapsed ? (
              // No room for the label at 72px, so the group keeps its
              // SEPARATION as a rule instead. Nothing is hidden by this: every
              // entry below is still an icon with a tooltip, same as the
              // static items.
              <div className="mx-auto mb-1.5 h-px w-6 bg-line" aria-hidden />
            ) : (
              <p className="rack-label px-2.5 pb-1">Plugin views</p>
            )}
            {pluginItems.map((item) => {
              const active = activePluginView === `${item.plugin}::${item.view}`
              // The name came off the wire, so it is resolved through the
              // allowlist map — an unrecognised or missing one falls back to
              // a default icon. A plugin never supplies markup here.
              const Icon = pluginIcon(item.icon)
              const link = (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={cn(
                    'relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors',
                    collapsed && 'justify-center px-0',
                    active
                      ? 'bg-surface-2 font-medium text-fg'
                      : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                  {/* An unpublished dev slot (plan 82 §3.5's own precedence,
                      criterion 7) — the same chip the run dialog already uses
                      for a dev script, so "this is not the published thing"
                      reads the same way in both places. */}
                  {item.isDev && !collapsed && (
                    <span className="readout rounded bg-led-warn/15 px-1 text-[10px] text-led-warn">DEV</span>
                  )}
                  {item.isDev && collapsed && (
                    <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-led-warn" />
                  )}
                </Link>
              )
              if (!collapsed) return link
              return (
                <Tooltip key={item.key}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">
                    {item.label}
                    {item.isDev ? ' (DEV)' : ''} — {item.plugin}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        )}
      </nav>

      <div className={cn('border-t border-line p-3', collapsed && 'px-0')}>
        {/* Signed-in user + logout (plan 09 §4.14) — hidden entirely in
            local mode, where there is no session to sign out of. Lives here,
            not in a new place: this footer is already where "facts about
            this instance" (connection, version) sit. Collapsed to just the
            logout icon (with a tooltip) at 72px, same as every nav item. */}
        {authMode === 'server' && user && !collapsed && (
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-line pb-2">
            <div className="min-w-0">
              <p className="truncate text-[12px] font-medium text-fg">{user.email}</p>
              <p className="rack-label text-fg-subtle">{user.role}</p>
            </div>
            <button
              type="button"
              onClick={onLogout}
              title="Log out"
              aria-label="Log out"
              className="shrink-0 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <LogOut className="size-3.5" aria-hidden />
            </button>
          </div>
        )}
        {authMode === 'server' && user && collapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onLogout}
                aria-label="Log out"
                className="mb-2 flex w-full items-center justify-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <LogOut className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Log out ({user.email})</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn('flex items-center gap-2 text-[11px]', collapsed && 'justify-center')}>
              <span
                className={cn('size-1.5 rounded-full', connected ? 'bg-led-ok' : 'bg-led-danger')}
                aria-hidden
              />
              {!collapsed && (
                <span className={connected ? 'text-fg-muted' : 'text-led-danger'}>
                  {connected ? 'core connected' : 'core offline'}
                </span>
              )}
            </div>
          </TooltipTrigger>
          {collapsed && <TooltipContent side="right">{connected ? 'core connected' : 'core offline'}</TooltipContent>}
        </Tooltip>
        {version && !collapsed && <p className="rack-label mt-1.5">version {version}</p>}
      </div>
    </>
  )
}
