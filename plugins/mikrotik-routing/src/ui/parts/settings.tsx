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
  saveRouterConfig,
  savePluginConfig,
  isRefusal,
  type DoctorResult,
  type PluginConfig,
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
 */

function LocalExceptionWarning({ report }: { report: DoctorResult }) {
  if (isRefusal(report) || report.localException.present) return null
  return (
    <div className="space-y-2 rounded-lg border border-led-danger/40 bg-led-danger/5 p-4">
      <p className="text-[13px] font-medium text-led-danger">The local-exception rule is missing (§3.2)</p>
      <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">
        Without it, a device rule this plugin writes would drag that device's own traffic to the controller — ADB, Studio, the scrcpy stream — into the assigned modem's routing table, and control of that device would be lost until the rule is added by hand. This plugin cannot create it (RouterOS's REST API has no way to position a rule), so it only ever checks for it. No apply exists in this build yet, but this check is what will block one the moment it does.
      </p>
      <p className="text-[12px] font-medium">Add it on the router, in this exact order:</p>
      <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-[11px] leading-relaxed">
        <code>{report.fixCommands.join('\n')}</code>
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
              <Badge variant="outline" className={report.localException.present ? 'text-led-ok' : 'text-led-danger'}>
                {report.localException.present ? 'Local exception present' : 'Local exception MISSING'}
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
        <CardDescription>Reconcile cadence and the two apply-safety switches (§4.4, §4.7). Nothing here does anything yet — no apply and no reconcile loop exist in this build.</CardDescription>
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
        </>
      )}
    </div>
  )
}
