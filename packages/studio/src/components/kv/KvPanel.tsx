'use client'

import { useState } from 'react'
import { Eye, KeyRound, Search, Trash2 } from 'lucide-react'
import { KvDeleteResponseSchema, KvEntryResponseSchema, KvListResponseSchema, type KvEntry } from '@enkaku/protocol'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingRows,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  api,
  relativeTime,
  useAction,
} from '@enkaku/ui'

export type KvPanelScope = { kind: 'global' } | { kind: 'device'; stableId: string }

function scopeQuery(scope: KvPanelScope): string {
  return scope.kind === 'global' ? 'scope=global' : `scope=device&stableId=${encodeURIComponent(scope.stableId)}`
}

/**
 * The KV panel — device scope on the device page, global scope under
 * Settings (plan 79 §5.9, step 9; the store and its REST surface,
 * `packages/core/src/api/kv.ts`, were built and tested in plan 79, but no
 * UI ever called it — this is that UI).
 *
 * `GET /api/kv` has no "list every namespace" endpoint (a script's runtime
 * supplies its own namespace; nothing in plan 79 ever needed to enumerate
 * them from the outside — §3.2's own words: "a script never types it").
 * So this panel asks for a namespace to browse rather than pretending to
 * discover one — an honest reflection of the REST surface as it exists
 * today, not a gap this pass invented.
 *
 * THE ONE RULE THAT MATTERS HERE (plan 79 §3.4): a secret entry renders as
 * its hint plus a "secret" badge, NEVER its value — `value` is server-side
 * redacted to `null` for a secret already (`packages/core/src/api/kv.ts`'s
 * `redactEntry`), and this component never reads `.value` for a row where
 * `.secret` is true, even defensively.
 */
export function KvPanel({ scope }: { scope: KvPanelScope }) {
  const [namespace, setNamespace] = useState('')
  const [browsedNamespace, setBrowsedNamespace] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [items, setItems] = useState<KvEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [secret, setSecret] = useState(false)
  const { run, isPending } = useAction()

  const load = (ns: string, p = prefix) => {
    setError(null)
    setItems(null)
    api(`/api/kv?${scopeQuery(scope)}&namespace=${encodeURIComponent(ns)}${p ? `&prefix=${encodeURIComponent(p)}` : ''}`, KvListResponseSchema)
      .then((b) => setItems(b.items))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const browse = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!namespace.trim()) return
    setBrowsedNamespace(namespace.trim())
    load(namespace.trim())
  }

  const del = (entry: KvEntry) =>
    run(
      'del-' + entry.key,
      () => api(`/api/kv/entry?${scopeQuery(scope)}&namespace=${encodeURIComponent(browsedNamespace ?? '')}&key=${encodeURIComponent(entry.key)}`, KvDeleteResponseSchema, { method: 'DELETE' }),
      { success: `"${entry.key}" deleted`, failure: 'Could not delete this value', onSuccess: () => browsedNamespace && load(browsedNamespace) },
    )

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!browsedNamespace || !key.trim()) return
    let parsedValue: unknown = value
    try {
      parsedValue = value.trim().length ? JSON.parse(value) : null
    } catch {
      // Not valid JSON — stored as the raw string, same as a script writing a plain string value.
    }
    void run(
      'set',
      () =>
        api('/api/kv/entry', KvEntryResponseSchema, {
          method: 'PUT',
          json: { scope: scope.kind, ...(scope.kind === 'device' ? { stableId: scope.stableId } : {}), namespace: browsedNamespace, key: key.trim(), value: parsedValue, secret },
        }),
      {
        success: `"${key.trim()}" saved`,
        failure: 'Could not save this value',
        onSuccess: () => {
          setFormOpen(false)
          setKey('')
          setValue('')
          setSecret(false)
          load(browsedNamespace)
        },
      },
    )
  }

  return (
    <div>
      <p className="mb-3 max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
        {scope.kind === 'global'
          ? 'Values a script wrote under ctx.kv.global — shared across every device (plan 79 §3.2).'
          : "Values a script wrote under ctx.kv.device for THIS device only — cleared if the device is forgotten."}{' '}
        A secret value is encrypted at rest and never shown here — only its hint.
      </p>

      <form onSubmit={browse} className="mb-3 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-40">
          <Label htmlFor="kv-namespace" className="mb-1 block text-[11.5px] text-fg-muted">
            Namespace
          </Label>
          <Input id="kv-namespace" value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="tiktok" className="h-8 text-[12.5px]" />
        </div>
        <div className="flex-1 min-w-32">
          <Label htmlFor="kv-prefix" className="mb-1 block text-[11.5px] text-fg-muted">
            Key prefix (optional)
          </Label>
          <Input id="kv-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="session:" className="h-8 text-[12.5px]" />
        </div>
        <Button type="submit" size="sm" disabled={!namespace.trim()}>
          <Search className="size-3.5" aria-hidden />
          Browse
        </Button>
      </form>

      {browsedNamespace === null ? (
        <EmptyState
          icon={<KeyRound className="size-4" aria-hidden />}
          title="Enter a namespace to browse"
          description="A namespace is the owning plugin's id — whatever the script passed to ctx.kv."
        />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(browsedNamespace)} />
      ) : items === null ? (
        <LoadingRows rows={3} />
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[12px] text-fg-muted">
              <span className="readout">{browsedNamespace}</span> — {items.length} value{items.length === 1 ? '' : 's'}
            </p>
            <Button size="sm" variant="outline" onClick={() => setFormOpen((v) => !v)}>
              {formOpen ? 'Cancel' : 'Set a value'}
            </Button>
          </div>

          {formOpen && (
            <form onSubmit={submit} className="mb-3 space-y-2 rounded-lg border bg-surface px-3.5 py-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label htmlFor="kv-key" className="mb-1 block text-[11.5px] text-fg-muted">
                    Key
                  </Label>
                  <Input id="kv-key" value={key} onChange={(e) => setKey(e.target.value)} className="h-8 text-[12.5px]" required />
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <Switch id="kv-secret" checked={secret} onCheckedChange={setSecret} />
                  <Label htmlFor="kv-secret" className="text-[12px] text-fg-muted">
                    Secret — encrypted at rest, never shown again
                  </Label>
                </div>
              </div>
              <div>
                <Label htmlFor="kv-value" className="mb-1 block text-[11.5px] text-fg-muted">
                  Value (JSON, or a plain string)
                </Label>
                <Textarea id="kv-value" value={value} onChange={(e) => setValue(e.target.value)} className="min-h-20 font-mono text-[12px]" placeholder={'{"example": true}'} />
              </div>
              <Button type="submit" size="sm" disabled={isPending('set') || !key.trim()}>
                Save
              </Button>
            </form>
          )}

          {items.length === 0 ? (
            <EmptyState title="No values under this namespace yet" description="A script writes here through ctx.kv — nothing has, yet." />
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.key}>
                      <TableCell className="font-medium">{it.key}</TableCell>
                      <TableCell className="text-[12.5px]">
                        {it.secret ? (
                          <Badge variant="secondary" className="gap-1">
                            <Eye className="size-3" aria-hidden />
                            secret · {it.hint ?? '••••'}
                          </Badge>
                        ) : (
                          <span className="readout break-all text-fg-muted">{JSON.stringify(it.value)}</span>
                        )}
                      </TableCell>
                      <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(it.updatedAt)}</TableCell>
                      <TableCell className="text-right">
                        <ConfirmDialog
                          trigger={
                            <Button variant="ghost" size="sm" className="h-7 text-[12px]" disabled={isPending('del-' + it.key)}>
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          }
                          title={`Delete "${it.key}"?`}
                          description="A script reading this key afterward gets null. This cannot be undone."
                          onConfirm={() => del(it)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
