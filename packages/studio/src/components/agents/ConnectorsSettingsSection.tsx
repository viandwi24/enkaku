'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { ConnectorResponseSchema, ConnectorTestResultSchema, ListConnectorsResponseSchema } from '@enkaku/protocol'
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingRows,
  PlusIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  useAction,
} from '@enkaku/ui'
import type { Connector, ConnectorKind } from '@/lib/agents'

/**
 * Provider connectors — farm-level, shared across agents (plan 65 §3.6,
 * §4.5). Relocated verbatim from `app/settings/page.tsx`'s `ConnectorsSection`
 * (plan 212 §4.7: "connectors … move only as Studio sections (plan 220)") —
 * logic and copy unchanged, only the file and the exported name moved.
 * Credentials are write-only through this whole screen: nothing here ever
 * reads a `credential` field, only `configured`/`hint`, and the same
 * sentence the network layer already uses is repeated verbatim (§3.6 — "a
 * second, differently-worded security claim about the same mechanism would
 * be a claim someone eventually believes").
 */
export function ConnectorsSettingsSection() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ConnectorKind>('anthropic')
  const [credential, setCredential] = useState('')
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/connectors', ListConnectorsResponseSchema)
      .then((b) => setConnectors(b.connectors))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const create = () =>
    run('create', () => api('/api/connectors', ConnectorResponseSchema, { method: 'POST', json: { name, kind, credential: credential || undefined } }), {
      success: `${name} added`,
      failure: 'Could not add the connector',
      onSuccess: () => {
        setOpen(false)
        setName('')
        setCredential('')
        load()
      },
    })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
          A configured provider endpoint plus credential — an agent names one to run against. A credential here is not readable by
          grepping the database; it is encrypted with a key kept in a file beside enkaku.db. Anyone with read access to the whole
          data directory can still decrypt it — this is not a key management service, and does not claim to be one.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setName('')
            setKind('anthropic')
            setCredential('')
            setOpen(true)
          }}
        >
          <PlusIcon className="size-3.5" aria-hidden />
          Add connector
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : connectors === null ? (
        <LoadingRows rows={3} />
      ) : connectors.length === 0 ? (
        <EmptyState title="No connectors yet" description="Add one to give agents a model and provider to use." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Credential</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connectors.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-[12.5px] text-fg-muted">{c.kind}</TableCell>
                  <TableCell className="readout text-[12px] text-fg-muted">{c.configured ? c.hint : 'not configured'}</TableCell>
                  <TableCell>
                    <Badge variant={c.status === 'ok' ? 'secondary' : c.status === 'unknown' ? 'outline' : 'destructive'}>{c.status}</Badge>
                    {c.statusMessage && <p className="mt-0.5 max-w-xs truncate text-[11px] text-fg-subtle">{c.statusMessage}</p>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[12px]"
                        disabled={isPending('test-' + c.id)}
                        onClick={() =>
                          run('test-' + c.id, () => api(`/api/connectors/${c.id}/test`, ConnectorTestResultSchema, { method: 'POST' }), {
                            success: 'Tested',
                            failure: 'Test failed',
                            onSuccess: load,
                          })
                        }
                      >
                        {isPending('test-' + c.id) ? 'Testing…' : 'Test connection'}
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="sm" className="h-7 text-[12px]">
                            Remove
                          </Button>
                        }
                        title={`Remove ${c.name}?`}
                        description="Agents naming this connector fall back to the farm default until another is chosen."
                        onConfirm={() =>
                          run('del-' + c.id, () => api(`/api/connectors/${c.id}`, z.void(), { method: 'DELETE' }), {
                            success: `${c.name} removed`,
                            failure: 'Could not remove the connector',
                            onSuccess: load,
                          })
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add connector</DialogTitle>
            <DialogDescription>The credential is write-only — it is never shown again after this.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="conn-name" className="text-[13px] font-normal">
                Name
              </Label>
              <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="anthropic-main" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-kind" className="text-[13px] font-normal">
                Kind
              </Label>
              <Select value={kind} onValueChange={(v) => setKind(v as ConnectorKind)}>
                <SelectTrigger id="conn-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-credential" className="text-[13px] font-normal">
                API key
              </Label>
              <Input id="conn-credential" type="password" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder={kind === 'openrouter' ? 'sk-or-…' : 'sk-ant-…'} />
              <p className="text-[11.5px] text-fg-subtle">
                Leave blank to configure {kind === 'openrouter' ? 'ENKAKU_OPENROUTER_API_KEY' : 'ENKAKU_ANTHROPIC_API_KEY'} as an env var fallback instead.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!name || isPending('create')} onClick={() => void create()}>
                {isPending('create') ? 'Adding…' : 'Add connector'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
