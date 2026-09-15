import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { z } from 'zod'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  ConfirmDialog,
  ErrorState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  api,
  cn,
  describeApiError,
} from '@enkaku/ui'
import { CORE, deviceName, listDevices, platformLabel, type Device, type PlatformId } from '../shared'

/**
 * The drafts cleaner (0.32.0).
 *
 * The owner's request (2026-09-16): *"saya ingin ada script pembersihan draft bisa? semua platform ada dan bisa di
 * trigger juga lewat menu plugin smm"*. Each platform pack now carries a `clear-drafts` member; this tab sends it to the
 * phones the operator picks, the same way the rest of this page reaches the farm — `/api/actions/run-script`, one call
 * per platform — and follows every job to its end, so the operator reads what each phone actually deleted.
 *
 * Deleting a draft is permanent, so a real run asks first; a dry run only opens the lists and counts.
 */

type PhoneMode = 'labelled' | 'devices'

/** The platforms whose pack has a `clear-drafts` member — all three since 0.33.0 (YouTube 0.39.0). */
const CLEANABLE: readonly { id: PlatformId; title: string; ready: boolean }[] = [
  { id: 'tiktok', title: 'TikTok', ready: true },
  { id: 'instagram', title: 'Instagram', ready: true },
  { id: 'youtube', title: 'YouTube', ready: true },
]

const RunScriptResult = z.object({
  results: z.array(z.object({ deviceId: z.string(), status: z.string(), jobId: z.string().nullable().default(null), message: z.string().nullable().default(null) })),
})
const JobStateSchema = z.object({
  job: z.object({
    status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'expired']),
    error: z.string().nullable().default(null),
    runId: z.string().nullable().default(null),
  }),
})
const RunResultSchema = z.object({ run: z.object({ result: z.unknown().nullable().default(null) }) })
const CleanResultSchema = z.object({ reason: z.string() }).passthrough()

type JobStatus = z.infer<typeof JobStateSchema>['job']['status']

interface Dispatch {
  key: string
  platform: PlatformId
  deviceId: string
  jobId: string | null
  status: JobStatus | 'refused'
  detail: string | null
}

const TERMINAL: readonly Dispatch['status'][] = ['success', 'failed', 'cancelled', 'expired', 'refused']
const POLL_MS = 2_000

export function DraftsPanel(): ReactElement {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const load = useCallback(() => {
    setLoadError(null)
    listDevices()
      .then(setDevices)
      .catch((err: unknown) => setLoadError(describeApiError(err)))
  }, [])
  useEffect(load, [load])

  const [platforms, setPlatforms] = useState<Set<PlatformId>>(new Set(['tiktok', 'instagram', 'youtube']))
  const [mode, setMode] = useState<PhoneMode>('labelled')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [dryRun, setDryRun] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [dispatches, setDispatches] = useState<Dispatch[]>([])

  const fleet = devices ?? []
  const byId = useMemo(() => new Map(fleet.map((d) => [d.id, d])), [fleet])

  /** Per platform, the phones it goes to: the platform's label, or exactly the phones chosen. */
  const targets = useMemo(() => {
    const out = new Map<PlatformId, Device[]>()
    for (const id of platforms) {
      const phones = mode === 'devices' ? fleet.filter((d) => chosen.has(d.id)) : fleet.filter((d) => d.labels.some((l) => l.name.trim().toLowerCase() === platformLabel(id)))
      out.set(id, phones)
    }
    return out
  }, [platforms, mode, chosen, fleet])
  const total = [...targets.values()].reduce((n, phones) => n + phones.length, 0)

  const send = useCallback(async () => {
    setSending(true)
    setSendError(null)
    const next: Dispatch[] = []
    try {
      for (const [platform, phones] of targets) {
        if (phones.length === 0) continue
        const res = await api(`${CORE}/api/actions/run-script`, RunScriptResult, {
          method: 'POST',
          json: { target: { deviceIds: phones.map((d) => d.id) }, scriptRef: `${platform}/clear-drafts@latest`, params: { dryRun } },
        })
        for (const r of res.results) {
          next.push({
            key: `${platform}:${r.deviceId}:${r.jobId ?? 'refused'}`,
            platform,
            deviceId: r.deviceId,
            jobId: r.jobId,
            status: r.jobId === null ? 'refused' : 'queued',
            detail: r.jobId === null ? (r.message ?? r.status) : null,
          })
        }
      }
    } catch (err) {
      setSendError(describeApiError(err))
    } finally {
      setDispatches((prev) => [...next, ...prev])
      setSending(false)
    }
  }, [targets, dryRun])

  // Follow every job still out, and read its result's reason once it ends.
  useEffect(() => {
    const open = dispatches.filter((d) => d.jobId !== null && !TERMINAL.includes(d.status))
    if (open.length === 0) return
    const timer = setTimeout(async () => {
      const updates = await Promise.all(
        open.map(async (d): Promise<Dispatch> => {
          try {
            const { job } = await api(`${CORE}/api/jobs/${encodeURIComponent(d.jobId as string)}`, JobStateSchema)
            if (!TERMINAL.includes(job.status)) return { ...d, status: job.status }
            let detail = job.error
            if (job.status === 'success' && job.runId) {
              const run = await api(`${CORE}/api/jobs/${encodeURIComponent(d.jobId as string)}/runs/${encodeURIComponent(job.runId)}`, RunResultSchema)
              const parsed = CleanResultSchema.safeParse(run.run.result)
              detail = parsed.success ? parsed.data.reason : null
            }
            return { ...d, status: job.status, detail }
          } catch {
            return d
          }
        }),
      )
      const byKey = new Map(updates.map((u) => [u.key, u]))
      setDispatches((prev) => prev.map((d) => byKey.get(d.key) ?? d))
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [dispatches])

  const visible = fleet.filter((d) => {
    const q = query.trim().toLowerCase()
    if (q === '') return true
    const bare = q.startsWith('#') ? q.slice(1) : q
    if (d.number !== null && String(d.number) === bare) return true
    return [deviceName(d), d.label ?? '', d.group?.name ?? '', ...d.labels.map((l) => l.name)].some((h) => h.toLowerCase().includes(q))
  })

  const blocked = platforms.size === 0 ? 'Pick at least one platform.' : total === 0 ? 'No phone matches — nothing would be sent.' : null
  const summary = [...targets.entries()].map(([id, phones]) => `${CLEANABLE.find((p) => p.id === id)?.title ?? id} on ${phones.length} phone${phones.length === 1 ? '' : 's'}`).join(', ')

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-4 py-4">
          <div>
            <p className="text-row font-medium text-text">Clear drafts</p>
            <p className="text-[12px] text-dim">Deletes every draft each platform keeps on the phone's account. Permanent — a dry run only opens the lists and counts.</p>
          </div>

          <div className="space-y-1.5">
            <p className="text-[12px] font-medium text-text-2">Platforms</p>
            <div className="flex flex-wrap gap-3">
              {CLEANABLE.map((p) => (
                <label key={p.id} className={cn('flex items-center gap-2 text-[13px]', !p.ready && 'opacity-60')}>
                  <Checkbox
                    checked={platforms.has(p.id)}
                    disabled={!p.ready}
                    onCheckedChange={(on) =>
                      setPlatforms((prev) => {
                        const copy = new Set(prev)
                        if (on === true) copy.add(p.id)
                        else copy.delete(p.id)
                        return copy
                      })
                    }
                  />
                  {p.title}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-[12px] font-medium text-text-2">Which phones</p>
            <Select value={mode} onValueChange={(next) => setMode(next as PhoneMode)}>
              <SelectTrigger className="w-full @md:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="labelled">Every phone carrying the platform's label</SelectItem>
                <SelectItem value="devices">Only the phones I choose</SelectItem>
              </SelectContent>
            </Select>
            {loadError ? (
              <ErrorState message={loadError} onRetry={load} />
            ) : devices === null ? (
              <p className="flex items-center gap-2 text-[12px] text-dim">
                <Spinner className="size-3" /> Reading the farm's phones…
              </p>
            ) : mode === 'devices' ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by #, name, label or group…" className="w-full @md:w-72" />
                  <Button size="sm" variant="outline" onClick={() => setChosen(new Set(visible.map((d) => d.id)))}>
                    Select shown
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setChosen(new Set())}>
                    Clear
                  </Button>
                  <span className="text-[11.5px] text-dim">{chosen.size} chosen</span>
                </div>
                <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-card border border-border px-2 py-1.5">
                  {visible.map((d) => (
                    <label key={d.id} className="flex items-center gap-2 py-0.5 text-[13px]">
                      <Checkbox
                        checked={chosen.has(d.id)}
                        onCheckedChange={(on) =>
                          setChosen((prev) => {
                            const copy = new Set(prev)
                            if (on === true) copy.add(d.id)
                            else copy.delete(d.id)
                            return copy
                          })
                        }
                      />
                      <span className="min-w-0 truncate">{deviceName(d)}</span>
                      <span className={cn('text-[11px]', d.status === 'online' ? 'text-dim' : 'text-danger')}>{d.status}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <label className="flex items-center gap-2 text-[13px]">
            <Switch checked={dryRun} onCheckedChange={setDryRun} />
            Dry run — count only, delete nothing
          </label>

          <div className="flex flex-wrap items-center gap-2">
            {dryRun ? (
              <Button disabled={blocked !== null || sending} onClick={() => void send()}>
                {sending ? <Spinner className="size-3.5" /> : null}
                Count drafts
              </Button>
            ) : (
              <ConfirmDialog
                trigger={
                  <Button variant="destructive" disabled={blocked !== null || sending}>
                    {sending ? <Spinner className="size-3.5" /> : null}
                    Clear drafts
                  </Button>
                }
                title="Delete every draft?"
                description={`${summary}. Every draft on those accounts is deleted, and a deleted draft cannot be recovered.`}
                confirmLabel="Delete drafts"
                onConfirm={send}
              />
            )}
            <span className="text-[12px] text-dim">{blocked ?? summary}</span>
          </div>
          {sendError ? <p className="text-[12px] text-danger">{sendError}</p> : null}
        </CardContent>
      </Card>

      {dispatches.length > 0 ? (
        <Card>
          <CardContent className="py-3">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11.5px] text-dim">
                    <th className="py-1 pr-3 font-medium">Phone</th>
                    <th className="py-1 pr-3 font-medium">Platform</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 font-medium">What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {dispatches.map((d) => {
                    const phone = byId.get(d.deviceId)
                    return (
                      <tr key={d.key} className="border-t border-border">
                        <td className="py-1.5 pr-3">{phone ? deviceName(phone) : d.deviceId.slice(0, 8)}</td>
                        <td className="py-1.5 pr-3">{CLEANABLE.find((p) => p.id === d.platform)?.title ?? d.platform}</td>
                        <td className="py-1.5 pr-3">
                          <Badge variant={d.status === 'success' ? 'secondary' : d.status === 'failed' || d.status === 'refused' ? 'destructive' : 'default'}>
                            {d.status}
                          </Badge>
                        </td>
                        <td className="py-1.5 text-text-2">{d.detail ?? (TERMINAL.includes(d.status) ? '' : 'working…')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
