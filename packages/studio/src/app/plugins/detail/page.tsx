'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { PluginResponseSchema, ScriptsListResponseSchema, type DevSlotView, type PluginRow } from '@enkaku/protocol'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingRows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  api,
  relativeTime,
} from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { PluginActions } from '@/components/plugins/PluginActions'
import { PluginStatusBadge } from '@/components/StatusBadge'
import { paramCount, PluginsListSchema, groupPlugins, type PluginListRow } from '../plugin-list'

/**
 * The plugin detail page (plan 82 §4.6's own "Detail" bullet, which shipped
 * with a list and never with the page it names; asked for again by the farm
 * owner, 2026-08-18: *"kok plugin ga punya halaman details ya"*).
 *
 * **Route.** `/plugins/detail?name=<plugin>[&version=<v>]` — a query parameter,
 * never a dynamic segment, because Studio is `output: 'export'`. `/device?id=…`
 * and `/plugins/view?name=…&view=…` are the precedents, and `scripts/detail`
 * is the shape this page matches: a `PageHeader` whose `meta` is the version
 * picker, the lifecycle actions on the right, and cards below. Nesting under
 * the existing `app/plugins/` keeps `AppShell.test.tsx`'s orphan check (which
 * reads only the TOP level of `src/app/`) satisfied without a nav entry — this
 * page is reached from the Plugins tab's rows.
 *
 * **TWO reads, and the split is the point** (plan 126 §3.3):
 *
 *  - `GET /api/plugins?name=<name>` — the list route's own server-side filter,
 *    which answers every version of ONE plugin as `PluginListItem`s. That is
 *    what the version picker in the header is drawn from, what the lifecycle
 *    actions plan a removal against, and where `scriptCount` comes from. It
 *    carries no manifest.
 *  - `GET /api/plugins/:name/:version` — the one version this page is pointed
 *    at, in full. **This is where `manifest` lives**, and so the Screen and
 *    Service cards below.
 *
 * It used to be one read: this page fetched the LIST and pulled
 * `manifest.surface`/`manifest.service` out of it, which is the only reason
 * those ever rode on a list row at all — every version of every plugin on the
 * Plugins tab paid for a screen and a service declaration so that one detail
 * page could read one row's. Splitting the reads is what let the list shed them
 * (§3.2), and the two must stay split: collapsing them back would put a full
 * JSON Schema per member per version, plus a whole declared surface, back on a
 * response a farm with twenty versions of one plugin downloads to draw twenty
 * `<option>`s.
 *
 * The version read re-fires when the picker moves — that is a request per
 * version an operator deliberately opened, which is the shape the payload
 * should have had all along.
 *
 * **What this page wanted and the API does not give it**, stated here rather
 * than faked or quietly left out:
 *
 *  - **Live service status.** `GET /api/plugins/:name/runtime` is plan 109 step
 *    109.12 and does not exist; `POST /:name/runtime/restart` is the only
 *    runtime route today and returning a status is something it does on the way
 *    out, not something that can be read. So the Service card below says what
 *    the plugin DECLARED and never whether it is running — `starting` is not
 *    `running`, and a card that implied either from a manifest would be exactly
 *    the "degraded state worded as the full one" `docs/design.md` forbids.
 *  - **A member script's own row id.** `manifest.scripts` carries export ids,
 *    not `scripts` row ids, and there is no `GET /api/plugins/:name/scripts`.
 *    The map comes from `GET /api/scripts?group=name` instead, joined on the
 *    `<plugin>/<script>` name; a member with no row is rendered WITHOUT a link
 *    and with the reason, because that is a real state (a superseded or failed
 *    version's members are not registered) and not a broken link.
 */


function isoTime(v: string | null | undefined): string {
  if (!v) return '—'
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? v : relativeTime(Math.floor(ms / 1000))
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="@container rounded-lg border bg-surface p-4">
      <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
      {hint && <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y overflow-hidden rounded border">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2">
          <dt className="text-[12px] text-fg-muted">{k}</dt>
          <dd className="readout min-w-0 wrap-anywhere text-[12px]">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function PluginDetail() {
  const params = useSearchParams()
  const router = useRouter()
  const name = params.get('name')
  const wantVersion = params.get('version')

  const [versions, setVersions] = useState<PluginListRow[] | null>(null)
  const [devSlot, setDevSlot] = useState<DevSlotView | null>(null)
  const [scriptIds, setScriptIds] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  /** The selected version IN FULL, manifest included — `GET /:name/:version`. `null` until it lands. */
  const [detail, setDetail] = useState<PluginRow | null>(null)

  const load = () => {
    if (!name) return
    setError(null)
    api(`/api/plugins?name=${encodeURIComponent(name)}`, PluginsListSchema)
      .then((b) => {
        setVersions(groupPlugins(b.items)[0]?.versions ?? [])
        setDevSlot(b.dev.find((s) => s.pluginName === name) ?? null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [name])

  // The version this page is POINTED AT: the one asked for, else the live one,
  // else the newest — the same rule the list row uses, so a link from one lands
  // on what the other was showing. Computed before the manifest read below
  // rather than after the early returns, because it is what that read is keyed
  // on and a hook cannot live behind a `return`.
  const selected = versions === null ? null : (versions.find((v) => v.version === wantVersion) ?? versions.find((v) => v.status === 'active') ?? versions[0] ?? null)
  const selectedVersion = selected?.version ?? null

  /**
   * The manifest for that one version (plan 126 §3.3). Re-runs when the picker
   * moves, and `stale` drops a reply that arrived after the operator had already
   * moved on — otherwise a slow response for 0.3.0 could paint its screen and
   * service under a header reading 0.3.1.
   *
   * A failure here costs the Screen and Service cards and nothing else, so it
   * degrades to "still reading" rather than taking the page down: everything
   * above them came from the list read, which has its own error state.
   */
  useEffect(() => {
    setDetail(null)
    if (!name || !selectedVersion) return
    let stale = false
    void api(`/api/plugins/${encodeURIComponent(name)}/${encodeURIComponent(selectedVersion)}`, PluginResponseSchema)
      .then((b) => {
        if (!stale) setDetail(b.plugin)
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [name, selectedVersion])

  // The `<plugin>/<script>` → row id map, so a member can be opened. A failure
  // here costs the links and nothing else, so it degrades silently rather than
  // taking the page down with it.
  useEffect(() => {
    void api('/api/scripts', ScriptsListResponseSchema)
      .then((page) => {
        const map: Record<string, string> = {}
        for (const s of page.items) map[s.name] = s.id
        setScriptIds(map)
      })
      .catch(() => undefined)
  }, [])

  if (!name) {
    return (
      <>
        <PageHeader title="Plugin" />
        <div className="px-5 py-4">
          <EmptyState
            title="The address is missing a plugin name"
            description="A plugin's page is opened from its row on the Plugins tab, which carries it — /plugins/detail?name=…"
          />
        </div>
      </>
    )
  }
  if (error) {
    return (
      <>
        <PageHeader title={name} description="Plugin" />
        <div className="px-5 py-4">
          <ErrorState message={error} onRetry={load} />
        </div>
      </>
    )
  }
  if (versions === null) {
    return (
      <>
        <PageHeader title={name} description="Plugin" />
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      </>
    )
  }
  if (versions.length === 0 || !selected) {
    return (
      <>
        <PageHeader title={name} description="Plugin" />
        <div className="px-5 py-4">
          <EmptyState
            title={`No plugin named “${name}” on this farm`}
            description={
              devSlot
                ? 'It has a dev slot but no published version — a dev slot is not a plugins row and disappears on a core restart.'
                : 'It was removed, or the name is misspelled. The Plugins tab lists everything this farm has.'
            }
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/plugins">All plugins</Link>
              </Button>
            }
          />
        </div>
      </>
    )
  }

  const p = selected

  /**
   * The manifest half of this page, and `null` while `GET /:name/:version` is in
   * flight or after it failed. Every card below that reads it says "still
   * reading" for that window rather than rendering its empty state — "this
   * version contributes no screen" and "declares no service" are ANSWERS, and
   * showing either before the answer is known would be a plain falsehood on the
   * screen where an operator audits what a plugin may do.
   *
   * Guarded on the version too: `detail` is cleared when the picker moves, but a
   * reply for the version we just left must never paint under the new header.
   */
  const full = detail && detail.version === p.version && detail.name === p.name ? detail : null

  /**
   * The member list renders from the LIST row's `declaredScripts` immediately
   * (id + title — plan 126 §3.2) and is upgraded in place when the manifest
   * lands with each member's description, param schema and runtime envelope. The
   * cheap half of the answer is on screen at once; the half that costs a JSON
   * Schema per member arrives when it arrives.
   */
  const declared: { id: string; title?: string; description?: string; paramsSchema?: unknown; runtime?: unknown }[] =
    full?.manifest?.scripts ?? p.declaredScripts
  const surface = full?.manifest?.surface
  const service = full?.manifest?.service
  const isActive = p.status === 'active'

  return (
    <>
      <PageHeader
        title={p.title?.trim() || p.name}
        description={`${p.createdBy ? `published by ${p.createdBy} · ` : ''}published ${isoTime(p.createdAt)}`}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <PluginStatusBadge status={p.status} />
            {versions.length > 1 ? (
              <Select
                value={p.version}
                onValueChange={(v) => router.push(`/plugins/detail?name=${encodeURIComponent(p.name)}&version=${encodeURIComponent(v)}`)}
              >
                <SelectTrigger className="readout h-8 w-40 text-[12.5px]" aria-label={`Version of ${p.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v, i) => (
                    <SelectItem key={v.id} value={v.version} className="readout">
                      {v.version}
                      {i === 0 ? ' · latest' : ''}
                      {v.status === 'active' ? ' · active' : v.status === 'failed' ? ' · failed' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="readout text-[12.5px] text-fg-muted">{p.version}</span>
            )}
          </span>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/plugins">
                <ArrowLeft className="size-4" aria-hidden />
                All plugins
              </Link>
            </Button>
            <PluginActions versions={versions} selected={p} onChanged={load} where="page" dense={false} />
          </>
        }
      />

      <div className="max-w-3xl space-y-4 px-5 py-4">
        {/* FIRST, always — the single most useful thing on this page when
            something is wrong, and verbatim with its code, never summarised
            (plan 82 §4.6). `wrap-anywhere`, not `break-words`: a verify error
            routinely carries an unbroken module path or a bundle hash, and
            only `overflow-wrap: anywhere` lowers min-content enough to keep a
            narrow column from scrolling sideways. */}
        {p.status === 'failed' && (
          <section className="rounded-lg border border-led-danger/40 bg-led-danger/5 p-4">
            <h2 className="text-[14px] font-semibold tracking-tight text-led-danger">This version failed to register</h2>
            <p className="readout mt-2 wrap-anywhere text-[12px] text-led-danger">{p.verifyErrorCode ?? 'E_PLUGIN_VERIFY_FAILED'}</p>
            <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-[12.5px] leading-relaxed text-led-danger">{p.verifyError}</p>
            <p className="mt-3 text-[12px] leading-relaxed text-fg-muted">
              Registration is all-or-nothing per plugin, so none of its {declared.length || 'declared'} script
              {declared.length === 1 ? '' : 's'} registered. Every other plugin on this farm, and every script they registered, is
              unaffected. Reload, above, re-runs verification against the same bundle.
            </p>
          </section>
        )}

        <Card
          title="Identity"
          hint="The identifier is what a script reference and the key/value namespace are keyed on — the title is only what it is called."
        >
          <Rows
            rows={[
              ['identifier', p.name],
              ['version', p.version],
              ['status', p.status],
              ['published by', p.createdBy ?? '—'],
              ['published', isoTime(p.createdAt)],
              ['verified', isoTime(p.verifiedAt)],
              ['key/value namespace', p.name],
              ['row id', p.id],
            ]}
          />
          <p className="mt-3 text-[11.5px] leading-relaxed text-fg-subtle">
            Every version of {p.name} shares one key/value namespace. Only one version of a name is ever live, which is why Enable is
            refused while another one holds the slot.
          </p>
        </Card>

        <Card
          title="Scripts"
          hint={
            declared.length > 0
              ? 'What this version declared. A member is an ordinary scripts row once registered, with its own detail page, versions and run history.'
              : 'What this version declared.'
          }
        >
          {declared.length === 0 ? (
            <p className="text-[12.5px] text-fg-subtle">
              {!full
                ? 'Reading this version…'
                : full.manifest
                  ? 'This version declares no scripts.'
                  : 'This version never reported a manifest, so there is no member list to show — see the error above.'}
            </p>
          ) : (
            <ul className="divide-y overflow-hidden rounded border">
              {declared.map((s) => {
                const full = `${p.name}/${s.id}`
                const rowId = scriptIds[full]
                const nParams = paramCount(s.paramsSchema)
                return (
                  <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                    <span className="min-w-0 flex-1 basis-full @sm:basis-auto">
                      {rowId ? (
                        <Link href={`/scripts/detail?id=${rowId}`} className="readout wrap-anywhere text-[12.5px] hover:text-accent">
                          {full}
                        </Link>
                      ) : (
                        <span className="readout wrap-anywhere text-[12.5px] text-fg-muted">{full}</span>
                      )}
                      {s.title && <span className="ml-2 text-[12px] text-fg">{s.title}</span>}
                    </span>
                    {/* Only once the manifest is here. Before that the params
                        are not "unknown", they are simply not read yet, and
                        `params ?` would state a defect where there is none. */}
                    {full && (
                      <span className="rack-label shrink-0">
                        {nParams === null ? 'params ?' : `${nParams} param${nParams === 1 ? '' : 's'}`}
                      </span>
                    )}
                    {s.runtime ? <span className="rack-label shrink-0">runtime</span> : null}
                    {s.description && <p className="w-full text-[11.5px] leading-relaxed text-fg-muted">{s.description}</p>}
                    {!rowId && (
                      <p className="w-full text-[11px] leading-relaxed text-fg-subtle">
                        Not registered on this farm right now, so it has no page of its own — only the live version of a plugin registers
                        its members.
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="mt-3 text-[11.5px] leading-relaxed text-fg-subtle">
            {(p.scriptCount ?? 0)} registered from this version{declared.length > 0 ? ` of ${declared.length} declared` : ''}.
          </p>
        </Card>

        <Card
          title="Screen"
          hint="A plugin can contribute its own page to Studio, with its own sidebar entry (plan 108). Only the live version's screen is reachable — the address resolves against whichever version is active."
        >
          {!full ? (
            /* Not "contributes no screen" — that is an answer, and it is not
               known yet (plan 126 §3.3: the surface arrives with the version
               read, not with the list). */
            <p className="text-[12.5px] text-fg-subtle">Reading this version…</p>
          ) : !surface || surface.nav.length === 0 ? (
            <p className="text-[12.5px] text-fg-subtle">
              This version contributes no screen — it adds nothing to the sidebar and has no page of its own.
            </p>
          ) : (
            <ul className="divide-y overflow-hidden rounded border">
              {surface.nav.map((entry) => {
                const view = surface.views[entry.view]
                const href = `/plugins/view?name=${encodeURIComponent(p.name)}&view=${encodeURIComponent(entry.view)}`
                return (
                  <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      {isActive ? (
                        <Link href={href} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium hover:text-accent">
                          {entry.label}
                          <ExternalLink className="size-3" aria-hidden />
                        </Link>
                      ) : (
                        <span className="text-[12.5px] font-medium text-fg-muted">{entry.label}</span>
                      )}
                      <span className="readout ml-2 text-[11.5px] text-fg-subtle">{entry.view}</span>
                    </span>
                    <span className="rack-label shrink-0">{view?.react ? 'react' : 'table'}</span>
                    {view?.description && <p className="w-full text-[11.5px] leading-relaxed text-fg-muted">{view.description}</p>}
                    {!isActive && (
                      <p className="w-full text-[11px] leading-relaxed text-fg-subtle">
                        Not reachable while this version is {p.status} — a plugin screen resolves against the active version only.
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card
          title="Service"
          hint="The long-lived half a plugin declares (plan 109) — what it asked for at install, and what an operator consented to. Declared, not observed: this farm has no route yet that reports whether the service is actually running, and “declares a listener” is not “the port is bound”."
        >
          {!full ? (
            /* The same rule as the Screen card above, and it matters more here:
               "declares no service" tells an operator nothing of this plugin
               runs inside the core, and that sentence must never be printed
               before the manifest that decides it has arrived. */
            <p className="text-[12.5px] text-fg-subtle">Reading this version…</p>
          ) : !service ? (
            <p className="text-[12.5px] text-fg-subtle">
              This version declares no service. Nothing of it runs inside the core between jobs; its scripts run in their own job processes
              as usual.
            </p>
          ) : (
            <div className="space-y-3">
              <Rows
                rows={[
                  ['isolation', service.isolation],
                  ['permissions', service.permissions.length],
                  ['listeners', service.listeners.length],
                  ['farm events', service.events.length],
                  ['webhooks', service.webhooks.length],
                ]}
              />

              <div>
                <h3 className="rack-label mb-1.5">permissions</h3>
                {service.permissions.length === 0 ? (
                  <p className="text-[12px] text-fg-subtle">None — its service cannot call the farm at all.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {service.permissions.map((perm) => (
                      <Badge key={perm} variant="outline" className="readout text-[11px]">
                        {perm}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">
                  Exhaustive: the service is refused any capability absent from this list before the call is made.
                </p>
              </div>

              {/*
                Reset data's own block, kept apart from `permissions` above and
                never merged into it. The two lists have different lifetimes —
                one is what this plugin may call at any moment for as long as it
                runs, the other is what it may call during one
                operator-initiated Reset data pass and at no other time — and
                showing them as one list would tell an operator they had
                consented to something wider than they did. This is the screen
                where that distinction has to be legible, because it is where a
                person decides whether to keep the plugin installed.
              */}
              {service.resetData && (
                <div>
                  <h3 className="rack-label mb-1.5">reset data</h3>
                  <p className="text-[12px] leading-relaxed text-fg-muted">
                    {service.resetData.description ??
                      'This plugin declares a cleanup handler for Reset data, and no description of what it undoes.'}
                  </p>
                  {service.resetData.permissions.length > 0 && (
                    <>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {service.resetData.permissions.map((perm) => (
                          <Badge key={perm} variant="outline" className="readout text-[11px]">
                            {perm}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">
                        Borrowed for the length of one Reset data pass, through the context that pass hands the handler — not part of the
                        list above, and refused everywhere else, including this plugin&apos;s own screens and scripts.
                      </p>
                    </>
                  )}
                </div>
              )}

              {service.listeners.length > 0 && (
                <div>
                  <h3 className="rack-label mb-1.5">listeners</h3>
                  <ul className="divide-y overflow-hidden rounded border">
                    {service.listeners.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                        <span className="readout min-w-0 flex-1 wrap-anywhere text-[12px]">{l.id}</span>
                        <span className="rack-label shrink-0">{l.proto}</span>
                        <span className="rack-label shrink-0">{l.deviceReachable ? 'device-reachable' : 'host-only'}</span>
                        {l.description && <p className="w-full text-[11.5px] leading-relaxed text-fg-muted">{l.description}</p>}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">
                    Declaring a port grants and reserves nothing — the plugin opens it itself. This list is what it said it intends to open.
                  </p>
                </div>
              )}

              {service.events.length > 0 && (
                <div>
                  <h3 className="rack-label mb-1.5">farm events</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {service.events.map((e) => (
                      <Badge key={e} variant="outline" className="readout text-[11px]">
                        {e}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">
                    Observation only — a handler cannot veto, delay, or rewrite one.
                  </p>
                </div>
              )}

              {service.webhooks.length > 0 && (
                <div>
                  <h3 className="rack-label mb-1.5">webhooks</h3>
                  <ul className="divide-y overflow-hidden rounded border">
                    {service.webhooks.map((w) => (
                      <li key={w.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                        <span className="readout min-w-0 flex-1 wrap-anywhere text-[12px]">{w.id}</span>
                        {w.description && <p className="w-full text-[11.5px] leading-relaxed text-fg-muted">{w.description}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>

        {devSlot && (
          <Card
            title="Dev slot"
            hint="An unpublished build of this name, which SHADOWS every published version while it exists. It is not a plugins row and does not survive a core restart."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">DEV</Badge>
              <span className="readout text-[12px]">{devSlot.buildVersion}</span>
              <span className="text-[11.5px] text-fg-muted">
                {devSlot.lastBuildOk ? 'built' : 'build failed'} {relativeTime(devSlot.lastBuildAt)}
              </span>
            </div>
            <p className="mt-2 text-[12px] text-fg-muted">
              owned by {devSlot.owner.kind === 'workspace' ? 'workspace' : 'enkaku dev'}{' '}
              <span className="readout wrap-anywhere">{devSlot.owner.label}</span> — shares this plugin&apos;s key/value namespace (
              <span className="readout">{devSlot.kvNamespace}</span>). Drop it from the Plugins tab.
            </p>
            {!devSlot.lastBuildOk && devSlot.lastError && (
              <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-[12px] text-led-danger">{devSlot.lastError}</p>
            )}
          </Card>
        )}
      </div>
    </>
  )
}

export default function PluginDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      }
    >
      <PluginDetail />
    </Suspense>
  )
}
