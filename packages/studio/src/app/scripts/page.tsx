'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ClockIcon, FilePlusIcon, FlowArrowIcon, MagnifyingGlassIcon, XIcon, Button, api, cn } from '@enkaku/ui'
import { ScriptsListResponseSchema, type ScriptListItem, type ScheduleInfo } from '@enkaku/protocol'
import { InstallPluginDialog } from '@/components/plugins/InstallPluginDialog'
import { ScriptsTable } from '@/components/scripts/ScriptsTable'
import { WorkflowsGrid } from '@/components/scripts/WorkflowsGrid'
import { SchedulesList } from '@/components/schedules/SchedulesList'
import { ScheduleDialog, type ScheduleRow } from '@/components/schedules/ScheduleDialog'
import { listWorkflows, fetchAllPages, type WorkflowInfo } from '@/lib/api'
import { matchesScript, matchesWorkflow, matchesSchedule } from './matchers'

type TabKey = 'scripts' | 'workflows' | 'schedules'

const TAB_LABEL: Record<TabKey, string> = { scripts: 'Scripts', workflows: 'Workflows', schedules: 'Schedules' }
const TAB_SUBTITLE: Record<TabKey, string> = {
  scripts: 'The scripts your active plugins register.',
  workflows: 'Pipelines of scripts on one device.',
  schedules: 'Recurring runs of a script or an agent, on a cron expression.',
}
const SEARCH_PLACEHOLDER: Record<TabKey, string> = {
  scripts: 'Search scripts…',
  workflows: 'Search workflows…',
  schedules: 'Search schedules…',
}

function ScriptsWorkflowsScreen() {
  const params = useSearchParams()
  const tabParam = params.get('tab')
  const tab: TabKey = tabParam === 'workflows' || tabParam === 'schedules' ? tabParam : 'scripts'

  const [scripts, setScripts] = useState<ScriptListItem[] | null>(null)
  const [workflows, setWorkflows] = useState<WorkflowInfo[] | null>(null)
  const [schedules, setSchedules] = useState<ScheduleInfo[] | null>(null)
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [creatingSchedule, setCreatingSchedule] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<ScheduleRow | null>(null)

  const loadScripts = () => void api('/api/scripts', ScriptsListResponseSchema).then((b) => setScripts(b.items))
  const loadWorkflows = () => void listWorkflows().then(setWorkflows)
  const loadSchedules = () => void fetchAllPages<ScheduleInfo>('/api/schedules').then(setSchedules)

  // All three load on mount, not on tab switch — the counts in the tab strip
  // must be right the instant the screen paints (design handoff: "each with
  // a count"), and every one of the three lists is small (plan 217 §3.2, §3.7).
  useEffect(() => {
    loadScripts()
    loadWorkflows()
    loadSchedules()
  }, [])

  // `?q=` mirrored with `replaceState`, matching `app/plugins/page.tsx`'s
  // existing convention: a reload or a shared link must land on the same
  // filtered screen without the router re-resolving the route under a live
  // list.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const next = new URLSearchParams(window.location.search)
    if (query) next.set('q', query)
    else next.delete('q')
    const search = next.toString()
    const url = search ? `${window.location.pathname}?${search}` : window.location.pathname
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, '', url)
  }, [query])

  const hrefFor = (key: TabKey) => {
    const next = new URLSearchParams(params.toString())
    next.set('tab', key)
    return `/scripts?${next.toString()}`
  }

  const counts: Record<TabKey, number | null> = {
    scripts: scripts?.length ?? null,
    workflows: workflows?.length ?? null,
    schedules: schedules?.length ?? null,
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 px-[14px] pt-[14px]">
        <div className="min-w-0">
          <h1 className="text-title font-semibold text-text">Scripts & workflows</h1>
          <p className="mt-0.5 truncate text-meta text-dim">{TAB_SUBTITLE[tab]}</p>
        </div>
        {tab === 'scripts' && (
          <InstallPluginDialog
            onInstalled={loadScripts}
            trigger={
              <Button className="rounded-button bg-accent text-on-accent hover:bg-accent-2">
                <FilePlusIcon className="size-4" aria-hidden />
                New script
              </Button>
            }
          />
        )}
        {tab === 'workflows' && (
          <Button asChild className="rounded-button bg-accent text-on-accent hover:bg-accent-2">
            <Link href="/scripts/editor">
              <FlowArrowIcon className="size-4" aria-hidden />
              New workflow
            </Link>
          </Button>
        )}
        {tab === 'schedules' && (
          <Button className="rounded-button bg-accent text-on-accent hover:bg-accent-2" onClick={() => setCreatingSchedule(true)}>
            <ClockIcon className="size-4" aria-hidden />
            New schedule
          </Button>
        )}
      </div>

      <div className="mt-3 flex items-center gap-1 border-b border-line px-[14px]">
        {(['scripts', 'workflows', 'schedules'] as const).map((key) => (
          <Link
            key={key}
            href={hrefFor(key)}
            data-tab={key}
            className={cn('rounded-t-[9px] px-[12px] py-[7px] text-row', tab === key ? 'bg-accent-soft text-accent' : 'text-dim hover:text-text')}
          >
            {TAB_LABEL[key]}
            {counts[key] !== null && <span className="ml-1.5 text-label text-faint">{counts[key]}</span>}
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-2 px-[14px] py-3">
        <div className="relative min-w-0 max-w-sm flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={SEARCH_PLACEHOLDER[tab]}
            aria-label={SEARCH_PLACEHOLDER[tab]}
            className="h-9 w-full rounded-input border-0 bg-muted pr-8 pl-8 text-body text-text placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-text"
            >
              <XIcon className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
        <span className="shrink-0 text-meta text-faint">
          {tab === 'scripts' && scripts !== null && `${scripts.filter((s) => matchesScript(s, query)).length} shown`}
          {tab === 'workflows' && workflows !== null && `${workflows.filter((w) => matchesWorkflow(w, query)).length} shown`}
          {tab === 'schedules' && schedules !== null && `${schedules.filter((s) => matchesSchedule(s, query)).length} shown`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[14px] pb-[14px]">
        {tab === 'scripts' && <ScriptsTable items={scripts} query={query} onReload={loadScripts} />}
        {tab === 'workflows' && <WorkflowsGrid items={workflows} query={query} onReload={loadWorkflows} />}
        {tab === 'schedules' && (
          <SchedulesList items={schedules} query={query} onReload={loadSchedules} onEdit={(s) => setEditingSchedule(s)} />
        )}
      </div>

      <ScheduleDialog
        schedule={creatingSchedule ? 'new' : editingSchedule}
        onClose={() => {
          setCreatingSchedule(false)
          setEditingSchedule(null)
        }}
        onSaved={loadSchedules}
      />
    </div>
  )
}

export default function ScriptsPage() {
  return (
    <Suspense fallback={null}>
      <ScriptsWorkflowsScreen />
    </Suspense>
  )
}
