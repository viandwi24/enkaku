'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { Eye, EyeOff, KeyRound, Search, Trash2 } from 'lucide-react'
import {
  KvDeleteResponseSchema,
  KvEntryResponseSchema,
  KvListResponseSchema,
  KvNamespacesResponseSchema,
  KvRevealResponseSchema,
  type KvEntry,
  type KvNamespace,
  type KvRevealResponse,
} from '@enkaku/protocol'
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

/** "4 values · 1 secret" — the secret count is never folded into the total and hidden (see `KvNamespaceSchema`). */
function countLabel(entries: number, secrets: number): string {
  const base = `${entries} value${entries === 1 ? '' : 's'}`
  return secrets > 0 ? `${base} · ${secrets} secret` : base
}

/** A revealed secret is usually a string (a proxy URL, a username, a password) and occasionally
 * whatever JSON a script stored. Both are shown, and copied, as the same text. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * The revealed plaintext, on screen, with the one control that is the actual
 * point of the feature: copy. The owner's case is reading a SOAX credential
 * back out of the farm to paste somewhere else — a value you can see but not
 * copy solves half of that and re-introduces transcription errors into the
 * other half.
 *
 * `select-all` so a click selects the whole value even where the clipboard is
 * unavailable (an insecure origin, a denied permission), which is the fallback
 * rather than a toast about a failure the user can do nothing with.
 */
function RevealedSecret({ revealed, onHide }: { revealed: KvRevealResponse; onHide: () => void }) {
  const [copied, setCopied] = useState(false)
  const text = asText(revealed.value)
  return (
    <div className="min-w-0 max-w-[28rem] space-y-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-[12px] text-fg">{text}</code>
        <button
          type="button"
          className="shrink-0 text-[11px] text-fg-muted underline hover:text-fg"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              },
              () => {
                // A clipboard the browser refused is not worth a toast — the value is on screen
                // and selectable, which is the fallback.
              },
            )
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="inline-flex items-center gap-1 text-[11px] text-fg-muted underline hover:text-fg" onClick={onHide}>
          <EyeOff className="size-3" aria-hidden />
          Hide
        </button>
        <span className="text-[11px] text-fg-subtle">Shown at {new Date(revealed.revealedAt * 1000).toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

/**
 * The KV panel — device scope on the device page and in the device popup's
 * Settings → KV section, global scope under Settings → Key/Value store
 * (plan 79 §5.9, step 9).
 *
 * **It used to be a search box with no index.** `GET /api/kv` shipped with no
 * way to enumerate namespaces, so this panel asked the operator to *type* one
 * — and an operator who could not guess `proxy-manager` saw a blank page and
 * concluded the store was empty while five entries sat in it. The panel's own
 * comment defended that as "an honest reflection of the REST surface as it
 * exists today", which was true and was still the wrong thing to ship: the
 * missing route was the defect, not the constraint. `GET /api/kv/namespaces`
 * is that route now, and this is the picker on top of it.
 *
 * **Three states that used to look like one, and must never be conflated
 * again:**
 * - the index came back EMPTY — nothing is stored in this scope at all;
 * - the index has namespaces and none is SELECTED — pick one;
 * - a selected namespace has NO ROWS — it exists (someone typed it, or its
 *   last value was just deleted) and holds nothing.
 *
 * The free-text box below the picker is the escape hatch for the one case the
 * index structurally cannot cover: a namespace with zero rows has nothing to
 * be indexed BY, so a plugin that has declared a namespace and never written
 * to it will not be listed. That is stated on screen, not left to be worked
 * out.
 *
 * **Device scope lists only namespaces with rows for THAT device**, because
 * the index is queried at `scope=device&stableId=…` — the same scope the
 * entry list and every write use. A device panel therefore never advertises a
 * plugin that has only ever written global values.
 *
 * **The rule that used to matter here has become narrower, and the narrowing is
 * deliberate** (plan 79 §3.4, `docs/feat/kv-storage.md` §4). A secret entry
 * still renders as its hint plus a "secret" badge from the LISTING, and this
 * component still never reads `.value` for a row where `.secret` is true —
 * `value` is server-side redacted to `null` there (`redactEntry`), and the
 * listing is not, and never becomes, a way to see a plaintext. What changed is
 * that an admin can now ASK for one value at a time:
 *
 * - the plaintext arrives from `POST /api/kv/entry/reveal` and from nowhere
 *   else — never from the list request, so rendering a row fetches no secrets;
 * - it lives in this component's `revealed` state and nowhere else: not in
 *   `localStorage`, not merged back into `items`, not in a ref. Hide, a
 *   namespace change, a scope change, a write, a delete and a remount all
 *   return it to `null`, which does not hide the value — it removes it from the
 *   DOM;
 * - one at a time, because `revealed` holds a single row. Revealing a second
 *   secret puts the first one away;
 * - the panel says, once, beside the actions, that a reveal is recorded. People
 *   behave differently when they know, which is most of what the audit row is
 *   for.
 */
export function KvPanel({ scope }: { scope: KvPanelScope }) {
  const uid = useId()
  const query = scopeQuery(scope)
  const [index, setIndex] = useState<KvNamespace[] | null>(null)
  const [indexError, setIndexError] = useState<string | null>(null)
  const [namespace, setNamespace] = useState('')
  const [browsedNamespace, setBrowsedNamespace] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [items, setItems] = useState<KvEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [secret, setSecret] = useState(false)
  /**
   * Whether a SECRET write also stores `${first 7}…${last 4}` of the plaintext, in the clear, on
   * the row (`KvSetOptions.hint`; the admin route learned to decline it in hotfix 96.38).
   *
   * **Off is the default here, and that is a choice this panel makes rather than the store's.**
   * The store still defaults to `true`, because an API key with a public prefix is genuinely
   * easier to tell apart with one. What gets typed into THIS form is overwhelmingly a credential
   * — the panel exists for an operator hand-editing a value, and the case it was asked for is a
   * proxy URL, username and password — and for a credential eleven characters is a real
   * disclosure to every unaudited listing. The hint also bought identification, which the reveal
   * button in the table now does properly and on the record. Switch it on for the key that wants
   * it; it is per write, never remembered per key.
   */
  const [storeHint, setStoreHint] = useState(false)
  /** The one revealed secret, or none. Null is where this starts and where every exit returns to. */
  const [revealed, setRevealed] = useState<KvRevealResponse | null>(null)
  const { run, isPending } = useAction()

  // Keyed on the scope query string, so switching devices re-indexes rather than showing the
  // previous device's namespaces — the index is per-scope, exactly like the entry list.
  const loadIndex = useCallback(() => {
    setIndexError(null)
    setIndex(null)
    // A scope change is a different device (or the farm), so a plaintext revealed under the old
    // one has no business surviving into the new screen.
    setRevealed(null)
    api(`/api/kv/namespaces?${query}`, KvNamespacesResponseSchema)
      .then((b) => setIndex(b.items))
      .catch((e) => setIndexError(e instanceof Error ? e.message : String(e)))
  }, [query])

  useEffect(() => {
    loadIndex()
  }, [loadIndex])

  const load = (ns: string, p = prefix) => {
    setError(null)
    setItems(null)
    // Every reload of the table drops the revealed value: after a namespace change it belongs to a
    // row that is no longer on screen, and after a write or a delete it may no longer be what is
    // stored. A stale plaintext presented as the current one is worse than showing nothing.
    setRevealed(null)
    api(`/api/kv?${query}&namespace=${encodeURIComponent(ns)}${p ? `&prefix=${encodeURIComponent(p)}` : ''}`, KvListResponseSchema)
      .then((b) => setItems(b.items))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const open = (ns: string) => {
    setBrowsedNamespace(ns)
    load(ns)
  }

  const browse = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!namespace.trim()) return
    open(namespace.trim())
  }

  const del = (entry: KvEntry) =>
    run(
      'del-' + entry.key,
      () => api(`/api/kv/entry?${query}&namespace=${encodeURIComponent(browsedNamespace ?? '')}&key=${encodeURIComponent(entry.key)}`, KvDeleteResponseSchema, { method: 'DELETE' }),
      {
        success: `"${entry.key}" deleted`,
        failure: 'Could not delete this value',
        onSuccess: () => {
          // The index carries counts, and a delete just changed one — re-read it, or the picker
          // starts quoting a number the table beside it disagrees with.
          loadIndex()
          if (browsedNamespace) load(browsedNamespace)
        },
      },
    )

  /**
   * The deliberate act. One POST, one response, one audit row — never fired by a
   * render, by an effect, or by the list request: only by the click that runs
   * this. Until it runs, the plaintext is not in this browser at all.
   */
  const reveal = (entry: KvEntry) =>
    run(
      'reveal-' + entry.key,
      () =>
        api('/api/kv/entry/reveal', KvRevealResponseSchema, {
          method: 'POST',
          json: { scope: scope.kind, ...(scope.kind === 'device' ? { stableId: scope.stableId } : {}), namespace: browsedNamespace, key: entry.key },
        }),
      {
        failure: 'Could not show this value',
        onSuccess: setRevealed,
      },
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
          json: {
            scope: scope.kind,
            ...(scope.kind === 'device' ? { stableId: scope.stableId } : {}),
            namespace: browsedNamespace,
            key: key.trim(),
            value: parsedValue,
            secret,
            // Sent explicitly, both ways, and only for a secret: the flag is per write, so an
            // omitted field means "the store's default" rather than "what this key had last
            // time". A non-secret row has no hint to decline.
            ...(secret ? { hint: storeHint } : {}),
          },
        }),
      {
        success: `"${key.trim()}" saved`,
        failure: 'Could not save this value',
        onSuccess: () => {
          setFormOpen(false)
          setKey('')
          setValue('')
          setSecret(false)
          setStoreHint(false)
          loadIndex()
          load(browsedNamespace)
        },
      },
    )
  }

  const shownSecrets = items?.filter((i) => i.secret).length ?? 0

  return (
    /* `@container`, not `sm:` — this panel is hosted both on a wide settings
       page and inside the device popup's Settings → KV section (~400px), where
       a viewport breakpoint describes the wrong box. */
    <div className="@container">
      <p className="mb-3 max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
        {scope.kind === 'global'
          ? 'Values written under ctx.kv.global — one set shared by the whole farm.'
          : 'Values written under ctx.kv.device for THIS device only — deleted when the device is forgotten.'}{' '}
        A namespace is the owning plugin&apos;s id: the runtime injects it, a script never types it. A secret value is encrypted at rest and listed only as a hint — you can show one
        value at a time, and each time is recorded.
      </p>

      {indexError ? (
        <ErrorState message={indexError} onRetry={loadIndex} />
      ) : index === null ? (
        <LoadingRows rows={2} />
      ) : index.length > 0 ? (
        <div className="mb-3">
          <p className="rack-label mb-1.5 text-fg-subtle">{scope.kind === 'global' ? 'Namespaces with farm-wide values' : 'Namespaces with values for this device'}</p>
          <div className="flex flex-wrap gap-1.5">
            {index.map((n) => {
              const active = n.namespace === browsedNamespace
              return (
                <button
                  key={n.namespace}
                  type="button"
                  onClick={() => open(n.namespace)}
                  aria-pressed={active}
                  className={`flex min-w-0 max-w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                    active ? 'border-accent bg-accent/10' : 'bg-surface-2 hover:bg-surface-3'
                  }`}
                >
                  <span className="readout min-w-0 truncate text-[12.5px]">{n.namespace}</span>
                  <span className="shrink-0 text-[11.5px] text-fg-muted">{countLabel(n.entries, n.secrets)}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<KeyRound className="size-4" aria-hidden />}
          title={scope.kind === 'global' ? 'Nothing is stored farm-wide yet' : 'This device has no stored values'}
          description={
            scope.kind === 'global'
              ? 'No plugin or script has written a farm-wide value. There is nothing to browse — this is the store being empty, not a namespace waiting to be typed.'
              : 'No plugin or script has written a value for this device. There is nothing to browse — this is the store being empty, not a namespace waiting to be typed.'
          }
        />
      )}

      {index !== null && (
        <>
          <form onSubmit={browse} className="mb-1.5 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-40">
              <Label htmlFor={`${uid}-ns`} className="mb-1 block text-[11.5px] text-fg-muted">
                Browse another namespace
              </Label>
              <Input id={`${uid}-ns`} value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="tiktok" className="h-8 text-[12.5px]" />
            </div>
            <div className="min-w-0 flex-1 basis-32">
              <Label htmlFor={`${uid}-prefix`} className="mb-1 block text-[11.5px] text-fg-muted">
                Key prefix (optional)
              </Label>
              <Input id={`${uid}-prefix`} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="session:" className="h-8 text-[12.5px]" />
            </div>
            <Button type="submit" size="sm" disabled={!namespace.trim()}>
              <Search className="size-3.5" aria-hidden />
              Browse
            </Button>
          </form>
          {/* Worded for whichever state is actually on screen — "the list above" is a lie when
              the index came back empty and there is no list above. */}
          <p className="mb-3 max-w-xl text-[11.5px] leading-relaxed text-fg-subtle">
            {index.length > 0
              ? 'The list above is every namespace that currently holds values. A namespace with none has no rows to be indexed by, so type it here to reach it.'
              : 'A namespace holding nothing has no rows to be indexed by, so it is never listed. If you know one by name, type it here to reach it.'}
          </p>
        </>
      )}

      {browsedNamespace === null ? (
        index !== null && index.length > 0 ? (
          <EmptyState
            icon={<KeyRound className="size-4" aria-hidden />}
            title="Pick a namespace to browse"
            description="Choose one above, or type a namespace that holds nothing yet. Nothing is loaded until you do — this is not the store being empty."
          />
        ) : null
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(browsedNamespace)} />
      ) : items === null ? (
        <LoadingRows rows={3} />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-[12px] text-fg-muted">
              <span className="readout">{browsedNamespace}</span> — {countLabel(items.length, shownSecrets)}
            </p>
            <Button size="sm" variant="outline" onClick={() => setFormOpen((v) => !v)}>
              {formOpen ? 'Cancel' : 'Set a value'}
            </Button>
          </div>

          {formOpen && (
            <form onSubmit={submit} className="@container mb-3 space-y-2 rounded-lg border bg-surface px-3.5 py-3">
              {/* A key field beside the secret switch and its sentence: 2 ×
                  11.5rem + 0.5rem gap ≈ 24rem of the card's own width. */}
              <div className="grid gap-2 @min-[24rem]:grid-cols-2">
                <div className="min-w-0">
                  <Label htmlFor={`${uid}-key`} className="mb-1 block text-[11.5px] text-fg-muted">
                    Key
                  </Label>
                  <Input id={`${uid}-key`} value={key} onChange={(e) => setKey(e.target.value)} className="h-8 text-[12.5px]" required />
                </div>
                <div className="flex min-w-0 items-center gap-2 pt-5">
                  <Switch id={`${uid}-secret`} checked={secret} onCheckedChange={setSecret} />
                  <Label htmlFor={`${uid}-secret`} className="text-[12px] text-fg-muted">
                    Secret — encrypted at rest, shown again only on request
                  </Label>
                </div>
              </div>
              {/* Only for a secret write, because a plain row has never had a hint to decline —
                  and only once the switch above is on, so the form does not ask a question that
                  has no effect on what gets stored. */}
              {secret && (
                <div className="flex min-w-0 items-start gap-2 rounded border bg-bg px-2.5 py-2">
                  <Switch id={`${uid}-hint`} checked={storeHint} onCheckedChange={setStoreHint} className="mt-0.5" />
                  <Label htmlFor={`${uid}-hint`} className="text-[12px] font-normal text-fg-muted">
                    <span className="text-fg">Store a hint</span>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
                      {storeHint
                        ? 'The first 7 and last 4 characters are stored in the clear and appear in every listing of this namespace. Right for an API key you need to tell apart from another; a real disclosure for a password.'
                        : 'Off: nothing about the value is readable without showing it, which is recorded. The row lists as “secret” with no fragment beside it.'}
                    </p>
                  </Label>
                </div>
              )}
              <div className="min-w-0">
                <Label htmlFor={`${uid}-value`} className="mb-1 block text-[11.5px] text-fg-muted">
                  Value (JSON, or a plain string)
                </Label>
                <Textarea id={`${uid}-value`} value={value} onChange={(e) => setValue(e.target.value)} className="min-h-20 font-mono text-[12px]" placeholder={'{"example": true}'} />
              </div>
              <Button type="submit" size="sm" disabled={isPending('set') || !key.trim()}>
                Save
              </Button>
            </form>
          )}

          {items.length === 0 ? (
            <EmptyState
              title="No values under this namespace yet"
              description={`"${browsedNamespace}" holds nothing in this scope. A script writes here through ctx.kv — nothing has, yet.`}
            />
          ) : (
            <>
              {/* The table scrolls inside its own box rather than pushing the page
                 sideways — a long key or a long JSON value must never produce a
                 horizontal scrollbar on the panel around it. */}
              <div className="overflow-x-auto rounded-lg border">
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
                        {/* `whitespace-nowrap` on the key, a width cap on the value: a
                            `folder-posted:<64 hex>` key beside a 200-character JSON value
                            otherwise loses the width fight and renders one character per
                            line. The table grows instead, and scrolls inside its own box. */}
                        <TableCell className="whitespace-nowrap font-medium">{it.key}</TableCell>
                        <TableCell className="text-[12.5px]">
                          {it.secret ? (
                            revealed?.key === it.key ? (
                              <RevealedSecret revealed={revealed} onHide={() => setRevealed(null)} />
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="secondary" className="gap-1">
                                  <Eye className="size-3" aria-hidden />
                                  secret · {it.hint ?? '••••'}
                                </Badge>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-1.5 text-[11.5px]"
                                  disabled={isPending('reveal-' + it.key)}
                                  onClick={() => void reveal(it)}
                                >
                                  {isPending('reveal-' + it.key) ? 'Showing…' : 'Show'}
                                </Button>
                              </div>
                            )
                          ) : (
                            /* `whitespace-normal` undoes `.readout`'s own `white-space: nowrap`
                               (globals.css) — right for a duration or a count, wrong for a
                               200-character JSON object, which otherwise renders as one clipped
                               line no `line-clamp` can ever reach. */
                            <span className="readout line-clamp-3 max-w-[28rem] break-all whitespace-normal text-fg-muted">{JSON.stringify(it.value)}</span>
                          )}
                        </TableCell>
                        <TableCell className="readout whitespace-nowrap text-[11.5px] text-fg-muted">{relativeTime(it.updatedAt)}</TableCell>
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
              {/* Said once, beside the action it describes, in the same voice as the rest of the
                  panel — not a warning banner. It is only rendered when there is something to
                  show, so a namespace of plain values does not carry a sentence about secrets. */}
              {shownSecrets > 0 && (
                <p className="mt-1.5 max-w-xl text-[11.5px] leading-relaxed text-fg-subtle">
                  Show reads one secret back in full. The farm records who showed it, which namespace and key, and when.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
