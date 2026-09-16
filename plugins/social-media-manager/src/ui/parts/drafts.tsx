import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { z } from 'zod'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  ConfirmDialog,
  Input,
  Spinner,
  Switch,
  api,
  cn,
  describeApiError,
} from '@enkaku/ui'
import { CORE, deviceName, listDevices, platformLabel, type Device, type PlatformId } from '../shared'
import { DevicePicker, newPick, normaliseLabel, pickRefusal, resolvePick, type DevicePick } from './device-picker'

/**
 * The drafts cleaner (0.32.0).
 *
 * The owner's request (2026-09-16): *"saya ingin ada script pembersihan draft bisa? semua platform ada dan bisa di
 * trigger juga lewat menu plugin smm"*. Each platform pack now carries a `clear-drafts` member; this tab sends it to the
 * phones the operator picks, the same way the rest of this page reaches the farm — `/api/actions/run-script`, one call
 * per platform — and follows every job to its end, so the operator reads what each phone actually deleted.
 *
 * Deleting a draft is permanent, so a real run asks first; a dry run only opens the lists and counts.
 *
 * Which phones is asked by the shared `DevicePicker` (0.39.0) — the same five options in the same words as New session
 * and Accounts sync. This tab dispatches straight to `/api/actions/run-script` with device ids, so every mode but the
 * default is simply a filter over the fleet; nothing here goes through `add-group`'s empty-list meaning.
 */

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
  /** A platform's clear-drafts, or `videos` — the farm-pushed video sweep (0.35.0). */
  platform: PlatformId | 'videos'
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
  const [pick, setPick] = useState<DevicePick>(() => newPick())
  const [dryRun, setDryRun] = useState(false)
  // The farm-pushed videos left in each phone's DCIM/Camera (0.35.0), swept by `smm/clean-phone-videos`.
  const [cleanVideos, setCleanVideos] = useState(false)
  const [olderThanHours, setOlderThanHours] = useState(6)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [dispatches, setDispatches] = useState<Dispatch[]>([])

  const fleet = devices ?? []
  const byId = useMemo(() => new Map(fleet.map((d) => [d.id, d])), [fleet])

  /** The phones the picker's own mode resolves to — the whole fleet on the default, where the label decides instead. */
  const picked = useMemo(() => resolvePick(pick, fleet), [pick, fleet])

  /** Per platform, the phones it goes to: the platform's label on the default, or exactly the phones the pick resolved to. */
  const targets = useMemo(() => {
    const out = new Map<PlatformId, Device[]>()
    for (const id of platforms) {
      const want = normaliseLabel(platformLabel(id))
      const phones = pick.mode === 'labelled' ? fleet.filter((d) => d.labels.some((l) => normaliseLabel(l.name) === want)) : picked
      out.set(id, phones)
    }
    return out
  }, [platforms, pick.mode, picked, fleet])
  /** The videos sweep goes to every phone any picked platform reaches — each phone once. */
  const videoPhones = useMemo(() => {
    const seen = new Map<string, Device>()
    for (const phones of targets.values()) for (const d of phones) seen.set(d.id, d)
    return [...seen.values()]
  }, [targets])
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
      if (cleanVideos && videoPhones.length > 0) {
        const res = await api(`${CORE}/api/actions/run-script`, RunScriptResult, {
          method: 'POST',
          json: { target: { deviceIds: videoPhones.map((d) => d.id) }, scriptRef: 'smm/clean-phone-videos@latest', params: { dryRun, olderThanHours } },
        })
        for (const r of res.results) {
          next.push({
            key: `videos:${r.deviceId}:${r.jobId ?? 'refused'}`,
            platform: 'videos',
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
  }, [targets, dryRun, cleanVideos, videoPhones, olderThanHours])

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

  const blocked = platforms.size === 0 ? 'Pick at least one platform.' : (pickRefusal(pick) ?? (total === 0 ? 'No phone matches — nothing would be sent.' : null))
  const summary = [
    ...[...targets.entries()].map(([id, phones]) => `${CLEANABLE.find((p) => p.id === id)?.title ?? id} drafts on ${phones.length} phone${phones.length === 1 ? '' : 's'}`),
    ...(cleanVideos ? [`old farm videos (over ${olderThanHours} h) on ${videoPhones.length} phone${videoPhones.length === 1 ? '' : 's'}`] : []),
  ].join(', ')

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-4 py-4">
          <div>
            <p className="text-row font-medium text-text">Clean up</p>
            <p className="text-[12px] text-dim">Deletes every draft each platform keeps on the phone's account, and optionally the old videos the post scripts left on the phone. Permanent — a dry run only counts.</p>
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
            <DevicePicker fleet={fleet} loading={devices === null} error={loadError} onRetry={load} value={pick} onChange={setPick} />
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={cleanVideos} onCheckedChange={(on) => setCleanVideos(on === true)} />
              Also delete old videos the post scripts left on these phones
            </label>
            {cleanVideos ? (
              <div className="flex flex-wrap items-center gap-2 pl-6 text-[12px] text-dim">
                Older than
                <Input
                  type="number"
                  min={1}
                  max={2160}
                  value={olderThanHours}
                  onChange={(e) => setOlderThanHours(Math.max(1, Math.min(2160, Math.round(Number(e.target.value) || 1))))}
                  className="h-7 w-20"
                />
                hours — only the farm's own post-/ig-/yt- files in DCIM/Camera; a fresher one may still be uploading, and nothing else on the phone is touched.
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
                title={cleanVideos ? 'Delete drafts and old videos?' : 'Delete every draft?'}
                description={`${summary}. Deleted drafts and videos cannot be recovered.`}
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
                        <td className="py-1.5 pr-3">{d.platform === 'videos' ? 'Phone videos' : (CLEANABLE.find((p) => p.id === d.platform)?.title ?? d.platform)}</td>
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
