import { useCallback, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingRows,
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
  Textarea,
  api,
  relativeTime,
} from '@enkaku/ui'
import {
  CATALOGUE_EMPTY_HINT,
  CREDENTIAL_NOT_STORED,
  DEFAULT_BIND_HOST,
  DEFAULT_DRAIN_MS,
  DEFAULT_MAX_CONNECTIONS,
  LISTEN_PROTOS,
  LISTEN_PROTO_LABELS,
  PROXY_KEY_HINT,
  PROXY_KEY_PREFIX,
  PROXY_KIND_LABELS,
  PROXY_KINDS,
  isStorableRecord,
  proxyIdFromKey,
  validateProxyRecord,
  type ListenProto,
  type ProxyKind,
} from '../../shared'
import { IgnoredSchema, KvPageSchema, PLUGIN_API, readProxy, writeProxy, type ProxyRecord } from './api'
import { useLoader } from './bits'

/**
 * The catalogue — the tab that does what the tier-A version of this pack did,
 * so the two can be compared honestly (plan 111 §4.3, `docs/design.md`'s
 * "Tier A or tier C").
 *
 * Everything below is ordinary React over ordinary `fetch`. The write path is
 * `PUT /api/plugins/proxy-manager/data/entry`, the operator-facing
 * (`plugin.data`) door onto this plugin's own namespace: the namespace is
 * taken from the URL server-side and cannot be another plugin's, and every
 * write is audited as `plugin.data.set`.
 */

interface Row {
  key: string
  version: number
  updatedAt: number
  record: ProxyRecord
}

/** A row being edited. `key` is empty for a row that does not exist yet. */
interface Draft extends ProxyRecord {
  key: string
  /** Whether the key field is editable — `kv.set` upserts and cannot MOVE an entry, so an edit must never offer a rename. */
  isNew: boolean
}

const BLANK: Draft = {
  key: PROXY_KEY_PREFIX,
  isNew: true,
  label: '',
  listen: { proto: 'http', bindHost: DEFAULT_BIND_HOST, port: null },
  upstream: { proto: 'socks5', host: '', port: 1080, username: '' },
  enabled: false,
  logDestinations: false,
  maxConnections: DEFAULT_MAX_CONNECTIONS,
  drainMs: DEFAULT_DRAIN_MS,
  notes: '',
}

export function CatalogueTab({ query, onQueryChange }: { query: string; onQueryChange: (next: string) => void }) {
  const load = useCallback(async (): Promise<Row[]> => {
    const page = await api(`${PLUGIN_API}/data?scope=global&prefix=${encodeURIComponent(PROXY_KEY_PREFIX)}&limit=200`, KvPageSchema)
    return page.items.map((entry) => ({ key: entry.key, version: entry.version, updatedAt: entry.updatedAt, record: readProxy(entry.value) }))
  }, [])
  const { data, error, loading, reload } = useLoader(load, [])

  const [draft, setDraft] = useState<Draft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)

  /**
   * The filter is a plain client-side `includes` over the page already
   * fetched, and says so in its placeholder rather than implying a search of
   * the whole namespace: the list route is capped at 200 rows, so a farm with
   * more proxies than that would have this box quietly miss them.
   */
  const rows = useMemo(() => {
    const all = data ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter((row) => `${row.key} ${row.record.label} ${row.record.upstream.host} ${row.record.notes}`.toLowerCase().includes(needle))
  }, [data, query])

  /**
   * Every row, so `validateProxyRecord` can answer `E_PROXY_PORT_CONFLICT` —
   * which is the one refusal that cannot be decided from a record alone. The
   * supervisor asks the same question again at start, against the catalogue as
   * it is then, so a record edited around this screen still cannot bind.
   */
  const catalogue = useMemo(() => (data ?? []).map((row) => ({ id: proxyIdFromKey(row.key) ?? row.key, record: row.record })), [data])

  async function save(next: Draft): Promise<void> {
    setBusy(true)
    setWriteError(null)
    try {
      await api(`${PLUGIN_API}/data/entry`, IgnoredSchema, {
        method: 'PUT',
        json: {
          scope: 'global',
          key: next.key,
          // Exactly the record's own fields, through the one function that
          // decides what those are. A host and a port are not credentials, so
          // `secret` stays false — marking them secret would redact the very
          // columns this table draws.
          value: writeProxy(next),
          secret: false,
        },
      })
      setDraft(null)
      reload()
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(row: Row): Promise<void> {
    setBusy(true)
    setWriteError(null)
    try {
      await api(`${PLUGIN_API}/data/entry?scope=global&key=${encodeURIComponent(row.key)}`, IgnoredSchema, { method: 'DELETE' })
      setPendingDelete(null)
      reload()
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter the rows below by name, host or note"
          className="h-8 max-w-xs text-[12.5px]"
          aria-label="Filter proxies"
        />
        <span className="readout text-[11.5px] text-fg-muted">
          {rows.length} of {data?.length ?? 0}
        </span>
        <div className="grow" />
        <Button size="sm" onClick={() => setDraft(BLANK)}>
          Add proxy
        </Button>
      </div>

      {writeError ? <ErrorState message={writeError} onRetry={() => setWriteError(null)} /> : null}

      {loading ? (
        <LoadingRows />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={data && data.length > 0 ? 'No proxy matches that filter' : 'No proxies saved yet'}
          description={data && data.length > 0 ? 'Clear the filter to see every saved record.' : CATALOGUE_EMPTY_HINT}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-48">Listens on</TableHead>
                <TableHead>Upstream</TableHead>
                <TableHead className="w-24">Enabled</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-40">Updated</TableHead>
                <TableHead className="w-32 text-right">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                // Both kinds, and they are drawn differently on purpose: a
                // refusal is a choice the product will not honour, a
                // precondition is a fact that is not true yet (plan 59). A
                // migrated row with no local port is the second, and rendering
                // it as an error would be a lie about whose fault it is.
                const problems = validateProxyRecord(row.record, { id: proxyIdFromKey(row.key) ?? row.key, catalogue })
                const refusals = problems.filter((p) => p.kind === 'refusal')
                const preconditions = problems.filter((p) => p.kind === 'precondition')
                return (
                  <TableRow key={row.key}>
                    <TableCell>
                      <div className="font-medium">{row.record.label || '—'}</div>
                      <div className="readout text-[11px] text-fg-muted">{row.key}</div>
                    </TableCell>
                    <TableCell>
                      {row.record.listen.port === null ? (
                        <span className="text-[11.5px] text-fg-muted">Needs a local port</span>
                      ) : (
                        <span className="readout">
                          <Badge variant="outline">{LISTEN_PROTO_LABELS[row.record.listen.proto]}</Badge>{' '}
                          {row.record.listen.bindHost}:{row.record.listen.port}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="readout">
                      <Badge variant="outline">{PROXY_KIND_LABELS[row.record.upstream.proto]}</Badge> {row.record.upstream.host || '—'}
                      {row.record.upstream.port ? `:${row.record.upstream.port}` : ''}
                      {row.record.upstream.username ? <span className="ml-1 text-fg-muted">as {row.record.upstream.username}</span> : null}
                    </TableCell>
                    <TableCell>
                      {/* INTENT, never observation — the word is "enabled",
                          not "running". This screen cannot yet observe what a
                          bridge is actually doing (step 112.9), and labelling
                          an intent as a state would be the exact thing
                          docs/design.md forbids. */}
                      <Badge variant={row.record.enabled ? 'default' : 'outline'}>{row.record.enabled ? 'Enabled' : 'Off'}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[24ch] truncate text-fg-muted">
                      {refusals.length > 0 ? (
                        <span className="text-destructive">{refusals[0]?.code}</span>
                      ) : preconditions.length > 0 ? (
                        <span className="text-fg-muted">{preconditions[0]?.code}</span>
                      ) : (
                        row.record.notes || '—'
                      )}
                    </TableCell>
                    <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(row.updatedAt)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => setDraft({ ...row.record, key: row.key, isNew: false })}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setPendingDelete(row)}>
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ProxyDialog draft={draft} catalogue={catalogue} busy={busy} onCancel={() => setDraft(null)} onSave={save} />

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{pendingDelete?.record.label || pendingDelete?.key}”?</DialogTitle>
            <DialogDescription>
              It is removed from the catalogue. If a bridge is listening for this record, the farm stops it the next time the plugin reloads — deleting
              the row does not close a live socket today. No device is reconfigured, because nothing here ever configured one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => pendingDelete && void remove(pendingDelete)} disabled={busy}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * One dialog for Add and Edit, because they write the same shape and differ in
 * exactly one thing: whether the storage key can be typed.
 *
 * This is the half plan 111 §4.3 called "a form that is more than a flat
 * schema" — tier A drew it from `z.toJSONSchema(AddFormSchema)` through the
 * shared resolver, which is genuinely good and genuinely fixed. Here the key
 * field carries its own live hint about the prefix, the port is bounded by the
 * input rather than by prose, and Add and Edit are one component instead of
 * two declarations that have to be kept in step.
 */
function ProxyDialog({
  draft,
  catalogue,
  busy,
  onCancel,
  onSave,
}: {
  draft: Draft | null
  catalogue: readonly { id: string; record: ProxyRecord }[]
  busy: boolean
  onCancel: () => void
  onSave: (draft: Draft) => Promise<void>
}) {
  const [local, setLocal] = useState<Draft>(BLANK)
  const [openedFor, setOpenedFor] = useState<Draft | null>(null)

  // Reset when a different row is opened, without a `useEffect`: React's own
  // "adjusting state when a prop changes" pattern, which renders once instead
  // of twice and never shows the previous row's values for a frame.
  if (draft !== openedFor) {
    setOpenedFor(draft)
    if (draft) setLocal(draft)
  }

  const keyLooksWrong = local.isNew && !local.key.startsWith(PROXY_KEY_PREFIX)
  const incomplete = local.key.trim().length === 0 || local.label.trim().length === 0 || local.upstream.host.trim().length === 0

  /**
   * The same four coded refusals the supervisor applies at start, applied here
   * at write — never only at start, or a record saved through this dialog
   * would be refused later by something the operator cannot see (plan 112
   * §4.2). A refusal blocks Save and names itself; a precondition does not,
   * because a record with no local port is perfectly storable and simply
   * cannot listen yet.
   */
  const problems = validateProxyRecord(local, { id: proxyIdFromKey(local.key) ?? local.key, catalogue })
  const refusals = problems.filter((p) => p.kind === 'refusal')
  const preconditions = problems.filter((p) => p.kind === 'precondition')

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{local.isNew ? 'Add proxy' : `Edit ${local.label || local.key}`}</DialogTitle>
          <DialogDescription>
            Saving records a bridge. It starts listening only when it is enabled, and enabling one from this screen is not built yet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pm-key" className="text-[13px] font-normal">
              Storage key
            </Label>
            <Input
              id="pm-key"
              value={local.key}
              disabled={!local.isNew}
              onChange={(e) => setLocal({ ...local, key: e.target.value })}
              className="readout"
            />
            <p className="text-[11.5px] leading-relaxed text-fg-muted">
              {local.isNew
                ? keyLooksWrong
                  ? PROXY_KEY_HINT
                  : 'Append a name. The prefix is what this list filters on.'
                : 'A record cannot be renamed: the write upserts and cannot move an entry, so a new key would leave the old row behind.'}
            </p>
          </div>

          {/* The plugin's OWN Tailwind class, and one Studio has never compiled:
              a two-column field grid sized to its labels. If `ui/index.css` did
              not reach the page these two fields would stack, which is exactly
              the silent failure step 111.9 exists to prevent. */}
          <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2">
            <Label htmlFor="pm-label" className="text-[13px] font-normal">
              Name
            </Label>
            <Input id="pm-label" value={local.label} onChange={(e) => setLocal({ ...local, label: e.target.value })} placeholder="Office UK" />

            <Label htmlFor="pm-listen-proto" className="text-[13px] font-normal">
              Listens as
            </Label>
            <Select value={local.listen.proto} onValueChange={(v) => setLocal({ ...local, listen: { ...local.listen, proto: v as ListenProto } })}>
              <SelectTrigger id="pm-listen-proto" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LISTEN_PROTOS.map((proto) => (
                  <SelectItem key={proto} value={proto}>
                    {LISTEN_PROTO_LABELS[proto]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label htmlFor="pm-listen-port" className="text-[13px] font-normal">
              Local port
            </Label>
            <Input
              id="pm-listen-port"
              type="number"
              min={1}
              max={65535}
              value={local.listen.port ?? ''}
              placeholder="9902"
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10)
                setLocal({ ...local, listen: { ...local.listen, port: Number.isInteger(next) ? next : null } })
              }}
              className="readout"
            />

            <Label htmlFor="pm-kind" className="text-[13px] font-normal">
              Upstream type
            </Label>
            <Select value={local.upstream.proto} onValueChange={(v) => setLocal({ ...local, upstream: { ...local.upstream, proto: v as ProxyKind } })}>
              <SelectTrigger id="pm-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROXY_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {PROXY_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label htmlFor="pm-host" className="text-[13px] font-normal">
              Upstream host
            </Label>
            <Input
              id="pm-host"
              value={local.upstream.host}
              onChange={(e) => setLocal({ ...local, upstream: { ...local.upstream, host: e.target.value } })}
              placeholder="10.4.0.9"
              className="readout"
            />

            <Label htmlFor="pm-port" className="text-[13px] font-normal">
              Upstream port
            </Label>
            <Input
              id="pm-port"
              type="number"
              min={1}
              max={65535}
              value={local.upstream.port || ''}
              onChange={(e) => setLocal({ ...local, upstream: { ...local.upstream, port: Number.parseInt(e.target.value, 10) || 0 } })}
              className="readout"
            />

            <Label htmlFor="pm-username" className="text-[13px] font-normal">
              Upstream user
            </Label>
            <Input
              id="pm-username"
              value={local.upstream.username}
              onChange={(e) => setLocal({ ...local, upstream: { ...local.upstream, username: e.target.value } })}
              placeholder="Leave empty if the upstream needs no account"
              className="readout"
            />
          </div>

          {/* The one caveat plan 112 ADDED rather than narrowed. There is no
              password field, and this says why in plain words instead of
              leaving an operator to wonder where it went. */}
          <p className="text-[11.5px] leading-relaxed text-fg-muted">{CREDENTIAL_NOT_STORED}</p>

          <div className="space-y-1.5">
            <Label htmlFor="pm-notes" className="text-[13px] font-normal">
              Notes
            </Label>
            <Textarea
              id="pm-notes"
              value={local.notes}
              onChange={(e) => setLocal({ ...local, notes: e.target.value })}
              placeholder="Who it belongs to, when it expires, where the credentials live."
              rows={2}
            />
          </div>

          {refusals.map((problem) => (
            <p key={problem.code} className="text-[11.5px] leading-relaxed text-destructive">
              <span className="readout">{problem.code}</span> — {problem.message}
            </p>
          ))}
          {preconditions.map((problem) => (
            <p key={problem.code} className="text-[11.5px] leading-relaxed text-fg-muted">
              {problem.message}
            </p>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void onSave(local)} disabled={busy || incomplete || !isStorableRecord(problems)}>
            {local.isNew ? 'Save proxy' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
