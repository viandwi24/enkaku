'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bot, Copy, Inbox, MoreVertical, Plus, Trash2 } from 'lucide-react'
import { z } from 'zod'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AgentResponseSchema, ListAgentsResponseSchema, ListThreadsResponseSchema } from '@enkaku/protocol'
import { api, useAction } from '@/lib/actions'
import { duplicateSlug, type Agent } from '@/lib/agents'
import { fetchAgentUsage } from '@/lib/agent-usage'
import { fetchRecentRuns } from '@/lib/agent-runs'
import { formatUsd, relativeTime } from '@/lib/format'

/**
 * The 14-day spend cell (plan 69 §3.4, route table's own "14-day spend"
 * column) — a per-row, bounded fetch (`fetchAgentUsage`'s own
 * `maxThreads` keeps one row cheap; see `lib/agent-usage.ts` for why this
 * is a client-side composition rather than one aggregate query).
 */
function SpendCell({ agentId }: { agentId: string }) {
  const [costUsd, setCostUsd] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setCostUsd(undefined)
    fetchAgentUsage(agentId, { maxThreads: 5 })
      .then((u) => {
        if (!cancelled) setCostUsd(u.total.costUsd)
      })
      .catch(() => {
        if (!cancelled) setCostUsd(null)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  if (costUsd === undefined) return <span className="readout text-fg-subtle">…</span>
  return <span className="readout">{formatUsd(costUsd)}</span>
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'agent'
}

interface DeleteCounts {
  threads: number
  runs: number
  truncated: boolean
}

/**
 * The AI agents list (plan 65 §4.6). Reuses `/agents` — freed by plan 61's
 * node rename specifically so this feature could claim it; the interim
 * redirect to `/nodes` that plan 61 §3.3 opened is removed here rather than
 * waiting for its formal v0.1.7 target, since the path is now claimed by a
 * real screen (see 00-overview.md §9 for the note).
 *
 * Plan 73 §3.3, §4.3 — `DELETE /api/agents/:id` and the button both already
 * existed, on the DETAIL page alone: reachable only by first opening the
 * agent you wanted gone, which is why it read as missing. The row menu adds
 * Open/Duplicate/Delete where a person actually looks for them, and Delete
 * names what goes with the agent before it does anything irreversible.
 */
export default function AgentsPage() {
  const router = useRouter()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  // The agent Delete is about to remove — driving a controlled `AlertDialog` (not the generic
  // `ConfirmDialog`, whose own internal `open` state does not compose cleanly nested inside a
  // `DropdownMenuItem`; `DeviceHeader`'s "Remove from farm…" follows the same controlled-from-the-
  // parent pattern for the same reason).
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null)
  const [deleteCounts, setDeleteCounts] = useState<DeleteCounts | null>(null)
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/agents', ListAgentsResponseSchema)
      .then((b) => setAgents(b.agents))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const create = () =>
    run('create', () => api('/api/agents', AgentResponseSchema, { method: 'POST', json: { name, slug } }), {
      success: `${name} created`,
      failure: 'Could not create the agent',
      onSuccess: (b) => router.push(`/agents/detail?id=${b.agent.id}`),
    })

  // Everything but `id`/`slug`/`name` (criterion 11) — the copy opens its own detail page at once,
  // with the name field focused (`focus=name`), so it is named before anyone relies on it.
  const duplicate = (a: Agent) =>
    run(
      'duplicate-' + a.id,
      () =>
        api('/api/agents', AgentResponseSchema, {
          method: 'POST',
          json: {
            slug: duplicateSlug(a.slug),
            name: `${a.name} copy`,
            description: a.description,
            colour: a.colour,
            enabled: a.enabled,
            connectorId: a.connectorId,
            model: a.model,
            systemPrompt: a.systemPrompt,
            settings: a.settings,
            tools: a.tools,
            requiresApproval: a.requiresApproval,
            deviceGrants: a.deviceGrants,
            workspaceScope: a.workspaceScope,
            permissions: a.permissions,
            wakeOnMessage: a.wakeOnMessage,
          },
        }),
      {
        success: `${a.name} duplicated`,
        failure: 'Could not duplicate the agent',
        onSuccess: (b) => router.push(`/agents/detail?id=${b.agent.id}&tab=settings&focus=name`),
      },
    )

  const openDelete = (a: Agent) => {
    setDeleteTarget(a)
    setDeleteCounts(null)
    void Promise.all([
      api(`/api/v1/threads?agentId=${a.id}`, ListThreadsResponseSchema).then((b) => b.threads.length),
      fetchRecentRuns(a.id),
    ])
      .then(([threads, recent]) => setDeleteCounts({ threads, runs: recent.runs.length, truncated: recent.truncated }))
      .catch(() => setDeleteCounts({ threads: 0, runs: 0, truncated: false }))
  }

  const confirmDelete = () => {
    if (!deleteTarget) return
    void run('delete-' + deleteTarget.id, () => api(`/api/agents/${deleteTarget.id}`, z.void(), { method: 'DELETE' }), {
      success: `${deleteTarget.name} deleted`,
      failure: 'Could not delete the agent',
      onSuccess: () => {
        setDeleteTarget(null)
        load()
      },
    })
  }

  return (
    <>
      <PageHeader
        title="Agents"
        description="Stored, editable AI agents — model, tools, and what they may touch"
        actions={
          <>
            {/* Findable without knowing which thread it is in (plan 69 §3.3) — a pending approval
                three agents deep is otherwise invisible from this list. */}
            <Button asChild variant="outline">
              <Link href="/agents/approvals">
                <Inbox className="size-3.5" aria-hidden />
                Approvals
              </Link>
            </Button>
            <Button
              onClick={() => {
                setName('')
                setSlug('')
                setSlugEdited(false)
                setOpen(true)
              }}
            >
              <Plus className="size-3.5" aria-hidden />
              New agent
            </Button>
          </>
        }
      />

      <div className="px-5 py-4">
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : agents === null ? (
          <LoadingRows rows={4} />
        ) : agents.length === 0 ? (
          <EmptyState
            icon={<Bot className="size-4" aria-hidden />}
            title="No agents yet"
            description="An agent is a stored record — model, provider, tools, and what devices it may touch. Nothing runs until Plan 66 lands."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[30%]">Name</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Devices</TableHead>
                  <TableHead>14-day spend</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((a) => (
                  <TableRow key={a.id} className="cursor-pointer">
                    <TableCell className="font-medium">
                      <Link href={`/agents/detail?id=${a.id}`} className="hover:text-accent">
                        {a.name}
                      </Link>
                      <p className="readout mt-0.5 text-[11px] text-fg-subtle">/agents/{a.slug}/</p>
                    </TableCell>
                    <TableCell className="readout text-[12.5px] text-fg-muted">{a.model ?? <span className="italic text-fg-subtle">farm default</span>}</TableCell>
                    <TableCell>
                      <Badge variant={a.enabled ? 'secondary' : 'outline'}>{a.enabled ? 'enabled' : 'disabled'}</Badge>
                    </TableCell>
                    <TableCell className="text-[12.5px] text-fg-muted">
                      {a.deviceGrants.length === 0 ? 'All devices (no restriction)' : `${a.deviceGrants.length} device${a.deviceGrants.length === 1 ? '' : 's'}`}
                    </TableCell>
                    <TableCell className="text-[12.5px] text-fg-muted">
                      <SpendCell agentId={a.id} />
                    </TableCell>
                    <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(a.updatedAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link href={`/agents/detail?id=${a.id}`} className="text-[12.5px] text-accent hover:underline">
                          Chat
                        </Link>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${a.name}`}>
                              <MoreVertical className="size-4" aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/agents/detail?id=${a.id}`}>Open</Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={isPending('duplicate-' + a.id)} onSelect={() => void duplicate(a)}>
                              <Copy className="size-3.5" aria-hidden />
                              {isPending('duplicate-' + a.id) ? 'Duplicating…' : 'Duplicate'}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-led-danger focus:text-led-danger" onSelect={() => openDelete(a)}>
                              <Trash2 className="size-3.5" aria-hidden />
                              Delete…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>Everything else is configured on the next screen — model, tools, and access.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name" className="text-[13px] font-normal">
                Name
              </Label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (!slugEdited) setSlug(slugify(e.target.value))
                }}
                placeholder="Triage bot"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-slug" className="text-[13px] font-normal">
                Slug
              </Label>
              <Input
                id="agent-slug"
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true)
                  setSlug(e.target.value)
                }}
                placeholder="triage-bot"
              />
              <p className="text-[11.5px] text-fg-subtle">Its workspace home: /agents/{slug || '…'}/</p>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!name || !slug || isPending('create')} onClick={() => void create()}>
                {isPending('create') ? 'Creating…' : 'Create agent'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete (criterion 10) — names what goes with the agent before doing anything irreversible,
          so a person removing an agent after a bad night knows they are also deleting the
          evidence. Counts load asynchronously; the confirm button waits for them rather than
          guessing "0" while they are still in flight. */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCounts === null ? (
                'Counting what goes with it…'
              ) : (
                <>
                  This removes {deleteCounts.threads} conversation{deleteCounts.threads === 1 ? '' : 's'} and{' '}
                  {deleteCounts.truncated ? 'at least ' : ''}
                  {deleteCounts.runs} run{deleteCounts.runs === 1 ? '' : 's'} — their transcript history goes with them.
                </>
              )}{' '}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteCounts === null || isPending('delete-' + (deleteTarget?.id ?? ''))}
              className="bg-led-danger text-white hover:bg-led-danger/90"
              onClick={(e) => {
                e.preventDefault()
                confirmDelete()
              }}
            >
              {isPending('delete-' + (deleteTarget?.id ?? '')) ? 'Deleting…' : 'Delete agent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
