'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, MonitorSmartphone, FileCode2, FolderTree, ListChecks, Layers, Boxes, CalendarClock, Wrench, SlidersHorizontal, Server, Bot, Puzzle, LogOut, Terminal, Workflow, CircleDot, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { NotificationBell } from '@/components/NotificationBell'
import { ProvisioningBanner } from '@/components/ProvisioningBanner'
import { AdbServerBanner } from '@/components/layout/AdbServerBanner'
import { useAuth, type AuthUser } from '@/lib/auth'
import { coreBase, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

const NAV = [
  { href: '/', label: 'Devices', icon: MonitorSmartphone, countKey: 'devices' as const },
  { href: '/scripts', label: 'Scripts', icon: FileCode2, countKey: 'scripts' as const },
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
  { href: '/plugins', label: 'Plugins', icon: Puzzle, countKey: 'failedPlugins' as const },
  { href: '/workspace', label: 'Workspace', icon: FolderTree, countKey: null },
  { href: '/jobs', label: 'Jobs', icon: ListChecks, countKey: 'activeJobs' as const },
  // The fleet command console (plan 93 §3.16, §4.8, step 93.7) — one adb
  // command to one device or the whole farm, with history and saved
  // commands. Distinct from a device's own Terminal tab, which stays put.
  { href: '/console', label: 'Console', icon: Terminal, countKey: null },
  { href: '/clusters', label: 'Clusters', icon: Layers, countKey: null },
  // Topology — devices grouped by cluster, plus the node/transport view.
  // It had no nav entry AND no link from anywhere else in Studio, so the
  // page was reachable only by typing the URL. Placed next to Clusters
  // because it is the same data seen spatially.
  { href: '/topology', label: 'Topology', icon: Network, countKey: null },
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
 * App frame: fixed sidebar plus page content.
 *
 * The sidebar carries three things a top nav has no room for: counts next to
 * each item (you can see a job is queued without opening it), a permanent
 * spot for core connection status, and room to grow as sections are added.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Counts>({ devices: 0, scripts: 0, activeJobs: 0, failedPlugins: 0 })
  const [connected, setConnected] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [mode, setMode] = useState<string>('local')
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()
  // Who is signed in, from `AuthGate` (plan 09 §4.14) — `authMode` here is
  // 'local'|'server' (is a login wall in effect at all), a different axis
  // from the `mode` state above ('local'|'orchestrator', which core binary
  // this is talking to). `authMode === 'local'` hides the user menu
  // entirely: local mode's implicit admin has no session to sign out of.
  const { user, authMode, logout } = useAuth()

  useEffect(() => {
    const load = async () => {
      try {
        const [d, s, j, h, p] = await Promise.all([
          fetch(`${coreBase()}/api/devices`).then((r) => r.json()),
          fetch(`${coreBase()}/api/scripts`).then((r) => r.json()),
          fetch(`${coreBase()}/api/jobs?limit=200`).then((r) => r.json()),
          fetch(`${coreBase()}/api/health`).then((r) => r.json()),
          // Plan 82 §4.6, criterion 30 — a farm-health warning while any
          // plugin is `failed`. Best-effort: an older core with no
          // `/api/plugins` route (or a request that simply fails) leaves
          // the badge at 0 rather than breaking the whole sidebar.
          fetch(`${coreBase()}/api/plugins`).then((r) => r.json()).catch(() => ({ items: [] })),
        ])
        setCounts({
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
          failedPlugins: ((p.items ?? []) as { status: string }[]).filter((x) => x.status === 'failed').length,
        })
        setVersion(h.version ?? null)
        setMode(h.mode ?? 'local')
      } catch {
        // The sidebar must not take the page down when the core is unreachable.
      }
    }
    void load()
    const offStatus = ws.onStatus(setConnected)
    // Counts update on events rather than on a polling timer.
    const off = ws.on((m) => {
      if (m.type === 'device.added' || m.type === 'device.removed' || m.type === 'job.status') void load()
    })
    return () => {
      off()
      offStatus()
    }
  }, [])

  useEffect(() => setMobileOpen(false), [pathname])

  const body = (
    <SidebarBody
      counts={counts}
      connected={connected}
      version={version}
      pathname={pathname}
      mode={mode}
      user={user}
      authMode={authMode}
      onLogout={() => void logout()}
    />
  )

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-surface lg:flex">{body}</aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b bg-surface px-3 py-2 lg:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-56 bg-surface p-0">
              <SheetTitle className="sr-only">Main menu</SheetTitle>
              {body}
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
    </div>
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
}: {
  counts: Counts
  connected: boolean
  version: string | null
  pathname: string
  mode: string
  user: AuthUser | null
  authMode: string
  onLogout: () => void
}) {
  return (
    <>
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <Brand />
        <div className="ml-auto">
          <NotificationBell />
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 p-2" aria-label="Main navigation">
        {NAV.map((item) => {
          const active = item.href === '/' ? pathname === '/' || pathname === '/device' : pathname.startsWith(item.href)
          const count = item.countKey ? counts[item.countKey] : null
          // The Plugins badge is a WARNING (criterion 30), not a neutral
          // count — a farm operator needs it to read as "something is
          // wrong here," the same visual language `DeviceStatusBadge`'s
          // `quarantined` tone already uses, not "here is a number."
          const isWarning = item.countKey === 'failedPlugins'
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors',
                active
                  ? 'bg-surface-2 font-medium text-fg'
                  : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="flex-1">{item.label}</span>
              {count !== null && count > 0 && (
                <span
                  role={isWarning ? 'status' : undefined}
                  title={isWarning ? `${count} plugin${count === 1 ? '' : 's'} failed to register` : undefined}
                  className={cn(
                    'readout rounded px-1.5 text-[11px]',
                    isWarning ? 'bg-led-danger/15 text-led-danger font-medium' : 'bg-surface-3 text-fg-muted',
                  )}
                >
                  {count}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="border-t p-3">
        {/* Signed-in user + logout (plan 09 §4.14) — hidden entirely in
            local mode, where there is no session to sign out of. Lives here,
            not in a new place: this footer is already where "facts about
            this instance" (connection, version) sit. */}
        {authMode === 'server' && user && (
          <div className="mb-2 flex items-center justify-between gap-2 border-b pb-2">
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
        <div className="flex items-center gap-2 text-[11px]">
          <span
            className={cn('size-1.5 rounded-full', connected ? 'bg-led-ok' : 'bg-led-danger')}
            aria-hidden
          />
          <span className={connected ? 'text-fg-muted' : 'text-led-danger'}>
            {connected ? 'core connected' : 'core offline'}
          </span>
        </div>
        {version && <p className="rack-label mt-1.5">version {version}</p>}
      </div>
    </>
  )
}
