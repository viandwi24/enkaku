'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, MonitorSmartphone, FileCode2, ListChecks, Layers, Boxes, CalendarClock, Wrench, SlidersHorizontal, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { coreBase, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

const NAV = [
  { href: '/', label: 'Devices', icon: MonitorSmartphone, countKey: 'devices' as const },
  { href: '/scripts', label: 'Scripts', icon: FileCode2, countKey: 'scripts' as const },
  { href: '/jobs', label: 'Jobs', icon: ListChecks, countKey: 'activeJobs' as const },
  { href: '/clusters', label: 'Clusters', icon: Layers, countKey: null },
  { href: '/batches', label: 'Batches', icon: Boxes, countKey: null },
  { href: '/schedules', label: 'Schedules', icon: CalendarClock, countKey: null },
  { href: '/tools', label: 'Tools', icon: Wrench, countKey: null },
  { href: '/agents', label: 'Agents', icon: Server, countKey: null },
  { href: '/settings', label: 'Settings', icon: SlidersHorizontal, countKey: null },
]

interface Counts {
  devices: number
  scripts: number
  activeJobs: number
}

/**
 * App frame: fixed sidebar plus page content.
 *
 * The sidebar carries three things a top nav has no room for: counts next to
 * each item (you can see a job is queued without opening it), a permanent
 * spot for core connection status, and room to grow as sections are added.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Counts>({ devices: 0, scripts: 0, activeJobs: 0 })
  const [connected, setConnected] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [mode, setMode] = useState<string>('local')
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    const load = async () => {
      try {
        const [d, s, j, h] = await Promise.all([
          fetch(`${coreBase()}/api/devices`).then((r) => r.json()),
          fetch(`${coreBase()}/api/scripts`).then((r) => r.json()),
          fetch(`${coreBase()}/api/jobs?limit=200`).then((r) => r.json()),
          fetch(`${coreBase()}/api/health`).then((r) => r.json()),
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
          activeJobs: (j.jobs ?? []).filter((x: { status: string }) => x.status === 'queued' || x.status === 'running')
            .length,
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
    <SidebarBody counts={counts} connected={connected} version={version} pathname={pathname} mode={mode} />
  )

  return (
    <div className="flex min-h-dvh">
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
        </div>

        <main className="min-w-0 flex-1">{children}</main>
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
}: {
  counts: Counts
  connected: boolean
  version: string | null
  pathname: string
  mode: string
}) {
  return (
    <>
      <div className="flex h-12 items-center border-b px-4">
        <Brand />
      </div>

      <nav className="flex-1 space-y-0.5 p-2" aria-label="Main navigation">
        {NAV.map((item) => {
          const active = item.href === '/' ? pathname === '/' || pathname === '/device' : pathname.startsWith(item.href)
          const count = item.countKey ? counts[item.countKey] : null
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
                <span className="readout rounded bg-surface-3 px-1.5 text-[11px] text-fg-muted">
                  {count}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="border-t p-3">
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
