import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Input, Label, LoadingRows, Switch, relativeTime, useAction } from '@enkaku/ui'
import { PLAIN_HTTP_WARNING } from '../../shared'
import {
  DEFAULT_PLUGIN_CONFIG,
  DEFAULT_ROUTER_CONFIG,
  isRouterConfigured,
  loadPluginConfig,
  loadRouterPresence,
  runDoctor,
  runReconcileNow,
  saveRouterConfig,
  savePluginConfig,
  isRefusal,
  type DoctorResult,
  type LocalExceptionResult,
  type PluginConfig,
  type ReconcileResult,
  type RouterConfig,
  type RouterPresence,
} from './api'
import { useLoader } from './bits'

/**
 * Settings — endpoint, username, password (masked), TLS, timeout, reconcile
 * interval, confirm-before-apply, auto-repair, and a Test connection button
 * running `doctor()`. This is where §3.2's local-exception precondition has
 * to be impossible to miss: "the most important paragraph in this plan," and
 * this is the one screen that reads `doctor()`'s own report of it.
 *
 * Step 122.12 corrected the check itself (behaviour-based, per device,
 * position-aware, three states — see `service/local-exception.ts`'s own
 * header for why the old exact-comment match was actively dangerous) and
 * this screen follows: `missing`/`partial`/`ok`, each its own colour and
 * wording, `partial` naming every uncovered device by label AND LAN address
 * rather than saying "some devices" — label alone repeats once a farm has
 * more than one device of the same model.
 */

function localExceptionTone(status: LocalExceptionResult['status']): string {
  if (status === 'ok') return 'text-led-ok'
  if (status === 'partial') return 'text-led-warn'
  return 'text-led-danger'
}

function localExceptionLabel(status: LocalExceptionResult['status']): string {
  if (status === 'ok') return 'Local exception OK'
  if (status === 'partial') return 'Local exception PARTIAL'
  return 'Local exception MISSING'
}

function coreAddressCaption(coreAddress: LocalExceptionResult['coreAddress']): string {
  if (coreAddress.kind === 'derived') return `The controller's own address toward the router was observed as ${coreAddress.address}.`
  return `The controller's own address toward the router could not be observed (${coreAddress.reason}) — falling back to requiring coverage of every RFC1918 private range.`
}

function LocalExceptionWarning({ report }: { report: DoctorResult }) {
  if (isRefusal(report) || report.localException.status === 'ok') return null
  const { localException } = report
  return (
    <div className="space-y-2 rounded-lg border border-led-danger/40 bg-led-danger/5 p-4">
      <p className="text-[13px] font-medium text-led-danger">{localException.status === 'missing' ? 'No local-exception rule protects any device (§3.2)' : 'The local-exception rule does not protect every device (§3.2)'}</p>
      <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">{localException.message}</p>
      {localException.uncoveredDevices.length > 0 && (
        <p className="text-[12px] text-fg-muted">
          {/* `label` alone is useless once a farm has more than one device of the same model — the owner's own farm printed "SM-F721U1, SM-F721U1, SM-F721U1" here. `address` is what a candidate rule's src-address actually has to cover. */}
          Uncovered: <span className="font-medium text-fg">{localException.uncoveredDevices.map((d) => `${d.label} (${d.address})`).join(', ')}</span>
        </p>
      )}
      <p className="text-[12px] text-fg-muted">{coreAddressCaption(localException.coreAddress)}</p>
      {/*
        Why this is refused, not just flagged. The panel used to assert the
        consequence ("would lose ADB") without explaining the mechanism, which
        reads as an arbitrary veto to anyone who has not met policy routing
        before — the owner asked outright what it meant. Explaining it here is
        what turns the block into something an operator can reason about, and
        it is the same explanation `docs/guide/mikrotik-routing.md` gives at
        length.
      */}
      <details className="rounded-md border border-line bg-surface-2/40 p-3">
        <summary className="cursor-pointer text-[12px] font-medium">Why this is required</summary>
        <div className="mt-2 space-y-2 max-w-prose text-[12px] leading-relaxed text-fg-muted">
          <p>
            A rule this plugin writes matches on a device&rsquo;s <span className="font-medium text-fg">source address</span>, so it captures{' '}
            <span className="font-medium text-fg">every packet that device sends</span> — including its replies to this controller. The egress
            table it points into holds a default route and nothing else.
          </p>
          <p>
            So the device&rsquo;s ADB reply, the Studio session and the scrcpy stream all get sent out of the uplink instead of back across the LAN.
            The uplink has no route to a private LAN address, so they are dropped there — and the device goes unreachable until the rule is removed
            by hand.
          </p>
          <p>
            The local-exception rule sits above every device rule and sends locally-destined traffic back through the ordinary table, leaving only
            internet-bound traffic to the uplink. This plugin cannot create it: routing rules are evaluated top-down, this one must be first, and
            RouterOS&rsquo;s REST API has no way to position a rule.
          </p>
        </div>
      </details>
      <p className="text-[12px] font-medium">Add it on the router, in this exact order:</p>
      <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-[11px] leading-relaxed">
        <code>{localException.suggestedFixCommands.join('\n')}</code>
      </pre>
    </div>
  )
}

function DoctorSummary({ report, loading, error, onRetest }: { report: DoctorResult | null; loading: boolean; error: string | null; onRetest: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Safety check</CardTitle>
        <CardDescription>Reachability, authentication, the local-exception rule, and how many rules on the router are already managed by this plugin.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" size="sm" onClick={onRetest} disabled={loading}>
          Test connection
        </Button>
        {loading ? (
          <LoadingRows rows={2} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetest} />
        ) : report && isRefusal(report) ? (
          <p className="text-[12px] text-led-danger">{report.message}</p>
        ) : report ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={report.reachable ? 'text-led-ok' : 'text-led-danger'}>
                {report.reachable ? 'Reachable' : 'Not reachable'}
              </Badge>
              <Badge variant="outline" className={report.authenticated ? 'text-led-ok' : 'text-led-danger'}>
                {report.authenticated ? 'Authenticated' : 'Not authenticated'}
              </Badge>
              {report.restVersion && <Badge variant="secondary">RouterOS {report.restVersion}</Badge>}
              <Badge variant="outline" className={localExceptionTone(report.localException.status)}>
                {localExceptionLabel(report.localException.status)}
              </Badge>
            </div>
            <p className="text-[12px] text-fg-muted">
              {report.managedRuleCount} managed rule{report.managedRuleCount === 1 ? '' : 's'}, {report.foreignRuleCount} foreign rule{report.foreignRuleCount === 1 ? '' : 's'} on the router right now.
            </p>
            {report.errors.length > 0 && (
              <ul className="list-inside list-disc text-[12px] text-led-warn">
                {report.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            <LocalExceptionWarning report={report} />
          </div>
        ) : (
          <p className="text-[12px] text-fg-muted">Save a connection below, then test it.</p>
        )}
      </CardContent>
    </Card>
  )
}

function ConnectionCard({ presence, onSaved }: { presence: RouterPresence | undefined; onSaved: () => void }) {
  const [draft, setDraft] = useState<RouterConfig>(DEFAULT_ROUTER_CONFIG)
  const { run, isPending } = useAction()

  const canSave = isRouterConfigured(draft)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Router connection</CardTitle>
        <CardDescription>
          {presence?.saved
            ? `Connection saved${presence.updatedAt ? ` · updated ${relativeTime(presence.updatedAt)}` : ''}. These fields are never read back (§4.10) — re-enter every one of them to change any.`
            : 'Nothing saved yet.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mikrotik-base-url">Router address</Label>
            <Input id="mikrotik-base-url" placeholder="192.168.88.1 or 192.168.88.1:8729" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
            <p className="text-[11px] text-fg-muted">Host, or host:port — no scheme. TLS below picks http vs. https.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mikrotik-username">Username</Label>
            <Input id="mikrotik-username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mikrotik-password">Password</Label>
            <Input id="mikrotik-password" type="password" placeholder="Required — never read back" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mikrotik-timeout">Request timeout (ms)</Label>
            <Input
              id="mikrotik-timeout"
              type="number"
              min={500}
              max={60_000}
              value={draft.timeoutMs}
              onChange={(e) => setDraft({ ...draft, timeoutMs: Number.parseInt(e.target.value, 10) || DEFAULT_ROUTER_CONFIG.timeoutMs })}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="mikrotik-tls" checked={draft.tls} onCheckedChange={(checked) => setDraft({ ...draft, tls: checked })} />
          <Label htmlFor="mikrotik-tls">Use TLS (https)</Label>
        </div>
        <p className="max-w-prose text-[11px] leading-relaxed text-fg-muted">{PLAIN_HTTP_WARNING}</p>
        <Button
          size="sm"
          disabled={!canSave || isPending('save-router')}
          onClick={() =>
            void run('save-router', () => saveRouterConfig(draft), {
              success: 'Router connection saved',
              failure: 'Could not save the router connection',
              onSuccess: () => {
                setDraft(DEFAULT_ROUTER_CONFIG)
                onSaved()
              },
            })
          }
        >
          Save connection
        </Button>
      </CardContent>
    </Card>
  )
}

function PreferencesCard({ config, onSaved }: { config: PluginConfig | undefined; onSaved: () => void }) {
  const [draft, setDraft] = useState<PluginConfig>(DEFAULT_PLUGIN_CONFIG)
  const seeded = useRef(false)
  const { run, isPending } = useAction()

  useEffect(() => {
    if (config && !seeded.current) {
      setDraft(config)
      seeded.current = true
    }
  }, [config])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
        <CardDescription>
          Reconcile cadence and the two apply-safety switches (§4.4, §4.7). The reconcile loop (122.9) reads both "Reconcile interval" and "Auto-repair" below, fresh, on every tick — a change here takes effect on the very next tick, with nothing to invalidate. Apply and group activation still do NOT read "Require confirmation": a preview is always shown before either one writes to the router, on purpose, since an unreviewed write is the exact risk §3.2/§4.4 exist to prevent — that switch remains saved but unread.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mikrotik-reconcile-interval">Reconcile interval (seconds)</Label>
            <Input
              id="mikrotik-reconcile-interval"
              type="number"
              min={5}
              max={3600}
              value={draft.reconcileIntervalSec}
              onChange={(e) => setDraft({ ...draft, reconcileIntervalSec: Number.parseInt(e.target.value, 10) || DEFAULT_PLUGIN_CONFIG.reconcileIntervalSec })}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="mikrotik-require-confirm" checked={draft.requireConfirm} onCheckedChange={(checked) => setDraft({ ...draft, requireConfirm: checked })} />
          <Label htmlFor="mikrotik-require-confirm">Require confirmation before every apply</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="mikrotik-auto-repair" checked={draft.autoRepair} onCheckedChange={(checked) => setDraft({ ...draft, autoRepair: checked })} />
          <Label htmlFor="mikrotik-auto-repair">Auto-repair missing or wrong-path rules during reconcile</Label>
        </div>
        <Button
          size="sm"
          disabled={isPending('save-config')}
          onClick={() =>
            void run('save-config', () => savePluginConfig(draft), {
              success: 'Preferences saved',
              failure: 'Could not save preferences',
              onSuccess: onSaved,
            })
          }
        >
          Save preferences
        </Button>
      </CardContent>
    </Card>
  )
}

const DRIFT_KIND_LABELS: Record<string, string> = {
  'missing-rule': 'Missing rule',
  'wrong-path': 'Wrong path',
  'path-missing': 'Path missing',
  duplicate: 'Duplicate',
  'unexpected-managed-rule': 'Orphan',
  'stale-owner': 'Stale owner',
}

function driftKindLabel(kind: string): string {
  return DRIFT_KIND_LABELS[kind] ?? kind
}

/** One row per drift KIND present, with its count — never a per-item list, since `Drift`'s other fields are kept loosely typed here (`api.ts`'s own header) and this screen only ever needs "how much of what", not a full render of each item (that is a future step's job, not this one's). */
function summariseDriftKinds(drifts: readonly { kind: string }[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const d of drifts) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1)
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }))
}

function ReconcileCard() {
  const [result, setResult] = useState<ReconcileResult | null>(null)
  const { run, isPending } = useAction()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reconcile</CardTitle>
        <CardDescription>
          Runs on its own every "Reconcile interval" seconds above (§4.7). This button runs one tick right now, sharing the SAME loop, rather than waiting. Report-only by default — a newly-detected drift item is also sent as a notification, once, not on every tick it stays standing — and nothing is repaired unless "Auto-repair" above is on, and even then only missing-rule/wrong-path; duplicates, orphans, and stale owners (§3.5) always stay a human decision.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          variant="outline"
          size="sm"
          disabled={isPending('reconcile-now')}
          onClick={() =>
            void run('reconcile-now', () => runReconcileNow(), {
              success: 'Reconcile tick complete',
              failure: 'Reconcile tick failed',
              onSuccess: setResult,
            })
          }
        >
          Reconcile now
        </Button>
        {result && isRefusal(result) && <p className="text-[12px] text-led-danger">{result.message}</p>}
        {result && !isRefusal(result) && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={result.drifts.length === 0 ? 'text-led-ok' : 'text-led-warn'}>
                {result.drifts.length} drift item{result.drifts.length === 1 ? '' : 's'}
              </Badge>
              {result.newDrifts.length > 0 && (
                <Badge variant="outline" className="text-led-warn">
                  {result.newDrifts.length} newly detected
                </Badge>
              )}
              {result.autoRepaired.length > 0 && <Badge variant="outline">{result.autoRepaired.length} auto-repaired</Badge>}
            </div>
            {result.drifts.length > 0 && (
              <ul className="list-inside list-disc text-[12px] text-fg-muted">
                {summariseDriftKinds(result.drifts).map((row) => (
                  <li key={row.kind}>
                    {driftKindLabel(row.kind)} × {row.count}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function SettingsTab() {
  const { data: base, error: baseError, loading: baseLoading, reload: reloadBase } = useLoader(async () => {
    const [presence, config] = await Promise.all([loadRouterPresence(), loadPluginConfig()])
    return { presence, config }
  }, [])

  const configured = base?.presence.saved ?? false

  const {
    data: doctorReport,
    error: doctorError,
    loading: doctorLoading,
    reload: reloadDoctor,
  } = useLoader(async () => {
    if (!configured) return null
    return runDoctor()
  }, [configured])

  return (
    <div className="space-y-6">
      <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">
        The router-side API user should be scoped with <span className="font-mono">address=</span> to the controller's own subnet, and given write access to{' '}
        <span className="font-mono">/routing/rule</span> only (§4.10).
      </p>

      {baseLoading ? (
        <LoadingRows rows={4} />
      ) : baseError ? (
        <ErrorState message={baseError} onRetry={reloadBase} />
      ) : (
        <>
          <ConnectionCard
            presence={base?.presence}
            onSaved={() => {
              reloadBase()
              reloadDoctor()
            }}
          />
          <DoctorSummary report={doctorReport ?? null} loading={configured && doctorLoading} error={doctorError} onRetest={reloadDoctor} />
          <PreferencesCard config={base?.config} onSaved={reloadBase} />
          <ReconcileCard />
        </>
      )}
    </div>
  )
}
