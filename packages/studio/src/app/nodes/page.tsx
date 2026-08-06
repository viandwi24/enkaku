'use client'

import { useEffect, useRef, useState } from 'react'
import { Copy, Plus, Server } from 'lucide-react'
import { z } from 'zod'
import { HealthResponseSchema, NodeCreateResponseSchema, pageSchema } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TableCell, TableHead } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { coreBase } from '@/lib/ws'
import { relativeTime } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'

interface Node {
  id: string
  name: string
  status: string
  platform: string | null
  lastSeen: number | null
}

/**
 * `GET /api/nodes` (`packages/core/src/api/nodes.ts`) returns the same
 * keyset envelope every list endpoint does (plan 30 §3.3), but has no
 * shared entity schema in `@enkaku/protocol` — nothing else in Studio reads
 * a node, so it is declared locally rather than added there for one call site.
 */
const NodesPageResponseSchema = pageSchema(
  z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    platform: z.string().nullable(),
    lastSeen: z.number().nullable(),
  }),
)

/**
 * Nodes: the machines that hold devices and dial out to this core.
 *
 * Renamed from "Agents" in plan 61 — the tunnel process is a node everywhere
 * now, so "agent" is free for the AI feature starting in plan 63.
 *
 * This screen used to be hidden unless the core ran as an orchestrator, which
 * was wrong twice over — it made the product look unfinished, and the claim was
 * not even true: the tunnel registry and node auth are built regardless of
 * mode, so a node can attach to a local-mode core and have its devices sit
 * alongside the ones plugged in here.
 */
export default function NodesPage() {
  const tableRef = useRef<PaginatedTableHandle<Node>>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<{ nodeId: string; token: string } | null>(null)
  const [mode, setMode] = useState<string | null>(null)
  const { run, isPending } = useAction()
  // "Last seen" ticks without a refresh (Plan 17 §4.6).
  const now = useNow()

  useEffect(() => {
    void api('/api/health', HealthResponseSchema)
      .then((h) => setMode(h.mode ?? 'local'))
      .catch(() => setMode('local'))
  }, [])

  const create = () =>
    run('create', () => api('/api/nodes', NodeCreateResponseSchema, { method: 'POST', json: { name } }), {
      success: 'Enrollment token created',
      failure: 'Could not create the token',
      onSuccess: (b) => {
        setIssued(b)
        setName('')
        tableRef.current?.reload()
      },
    })

  return (
    <>
      <PageHeader
        title="Nodes"
        description="Machines that hold devices and dial out to this control plane"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-4" aria-hidden />
            New node
          </Button>
        }
      />

      <div className="px-5 py-4">
        {mode === 'local' && (
          <div className="mb-4 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-muted">
            This core runs in <span className="readout">local</span> mode, so it also handles devices plugged in here.
            Nodes still work — a node's devices simply appear alongside the local ones. For a control plane that
            holds no devices of its own, start the core with{' '}
            <code className="readout">ENKAKU_MODE=orchestrator</code>.
          </div>
        )}

        <PaginatedTable<Node>
          ref={tableRef}
          fetchPage={(cursor) => api(`/api/nodes?limit=50${cursor ? `&cursor=${cursor}` : ''}`, NodesPageResponseSchema)}
          rowKey={(a) => a.id}
          header={
            <>
              <TableHead className="w-[40%]">Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Last seen</TableHead>
            </>
          }
          renderRow={(a) => (
            <>
              <TableCell className="font-medium">{a.name}</TableCell>
              <TableCell>
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
                    a.status === 'online'
                      ? 'border-led-ok/35 bg-led-ok/10 text-led-ok'
                      : 'border-line text-fg-subtle',
                  )}
                >
                  <span className="size-1.5 rounded-full bg-current" aria-hidden />
                  {a.status}
                </span>
              </TableCell>
              <TableCell className="readout text-[12px] text-fg-muted">{a.platform ?? '—'}</TableCell>
              <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(a.lastSeen, now)}</TableCell>
            </>
          )}
          empty={{
            icon: <Server className="size-4" aria-hidden />,
            title: 'No nodes yet',
            description: (
              <>
                A node runs next to your phones and opens an outbound tunnel here — no port forwarding, and NAT is
                not a problem. Create one to get a single-use enrollment token.
              </>
            ),
            action: <Button onClick={() => setOpen(true)}>New node</Button>,
          }}
        />
      </div>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setIssued(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{issued ? 'Node created' : 'New node'}</DialogTitle>
            <DialogDescription>
              {issued
                ? 'Copy the token now — it is stored only as a hash and cannot be shown again.'
                : 'Name it after where the devices live, so it is obvious later which rack this is.'}
            </DialogDescription>
          </DialogHeader>

          {issued ? (
            <div className="space-y-3">
              <div className="rounded-lg border bg-surface-2 p-3">
                <p className="rack-label mb-1.5">run this on the node machine</p>
                <pre className="readout overflow-x-auto whitespace-pre text-[11.5px] leading-relaxed">
{`ENKAKU_CP_URL=${coreBase()} \\
ENKAKU_ENROLL_TOKEN=${issued.token} \\
bunx enkaku-node`}
                </pre>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(issued.token)}
              >
                <Copy className="size-4" aria-hidden />
                Copy token
              </Button>
              <div className="flex justify-end border-t pt-3">
                <Button onClick={() => { setOpen(false); setIssued(null) }}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="node-name" className="text-[13px] font-normal">Name</Label>
                <Input
                  id="node-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="lab-jakarta"
                />
              </div>
              <div className="flex justify-end gap-2 border-t pt-3">
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button disabled={!name.trim() || isPending('create')} onClick={() => void create()}>
                  {isPending('create') ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
