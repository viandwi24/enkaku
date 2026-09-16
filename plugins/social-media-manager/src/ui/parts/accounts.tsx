import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { z } from 'zod'
import {
  ArrowsClockwiseIcon,
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingRows,
  SignInIcon,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  cn,
  describeApiError,
  relativeTime,
} from '@enkaku/ui'
import {
  CORE,
  PLATFORMS,
  accountRowKeyOf,
  deviceName,
  listAccountRows,
  listDevices,
  type AccountRow,
  type Device,
  type PlatformId,
} from '../shared'
import { DevicePicker, newPick, pickRefusal, resolvePick, type DevicePick } from './device-picker'

/**
 * The Accounts tab (0.37.0).
 *
 * The owner's request (2026-09-16): for every connected phone, find out how
 * many accounts are signed in on each platform — TikTok holds several in one
 * app — scrape their handles, store them, and mark which one the app is
 * standing in right now.
 *
 * This tab is the READING half of that. `smm/sync-accounts` is what walks the
 * phone; the rows it writes live in this plugin's own KV under `account:`, one
 * per phone and platform, and everything below either sends that member or
 * renders what it last wrote.
 *
 * ## Why the stored table is the page, and the sync is a control above it
 *
 * A handle read an hour ago is still the answer to "who is this phone posting
 * as" — it does not stop being true because nobody pressed Sync today. So the
 * table is always on screen with its own read time per row, and a phone that
 * has never been read is named as such rather than left out: absent is a fact
 * an operator has to be able to see, not a gap they have to notice.
 *
 * The dispatch follows the Cleanup tab exactly — `/api/actions/run-script`,
 * then each job polled to its end so the phone's own words reach the operator
 * — because a sync that walks an app can fail for the same dozen reasons a
 * draft cleaning can, and inventing a second way to report that would be a
 * second vocabulary for one farm.
 *
 * Which phones is asked by the shared `DevicePicker` (0.40.0), in the same four
 * options and the same words as New session and Cleanup. Every option names the
 * phones explicitly, so every platform ticked is read on every phone picked —
 * the operator is looking at both lists as they choose them. The refinement
 * this tab used to apply (asking a phone only about the platforms it carries)
 * went with the label-driven mode that fed it; picking "Phones with the labels
 * I choose" and ticking that platform's own label asks exactly those phones.
 */

/** The platforms a sync can read. All three are label-routed the same way the rest of this page routes. */
const SYNCABLE: readonly { id: PlatformId; title: string }[] = PLATFORMS.map((p) => ({ id: p.id, title: p.title }))

const TITLE_OF: Record<string, string> = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.title]))

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

/** What `smm/sync-accounts` answers with. Read loosely: a newer member may say more, and more is not a failure. */
const SyncResultSchema = z
  .object({
    platforms: z
      .array(
        z.object({
          platform: z.string(),
          accounts: z.number().default(0),
          current: z.string().nullable().default(null),
          error: z.string().nullable().default(null),
        }),
      )
      .default([]),
    reason: z.string().default(''),
  })
  .passthrough()

type SyncResult = z.infer<typeof SyncResultSchema>
type JobStatus = z.infer<typeof JobStateSchema>['job']['status']

interface Dispatch {
  key: string
  deviceId: string
  platforms: PlatformId[]
  jobId: string | null
  status: JobStatus | 'refused'
  detail: string | null
  result: SyncResult | null
}

const TERMINAL: readonly Dispatch['status'][] = ['success', 'failed', 'cancelled', 'expired', 'refused']
const POLL_MS = 2_000
/** The member this tab sends. It runs ON the phone whose accounts it reads — never a bookkeeping host. */
const SYNC_REF = 'smm/sync-accounts@latest'

/** How sure the row is that the account marked `current` is the one the app is standing in. */
const EVIDENCE_WORD: Record<AccountRow['evidence'], string> = {
  confirmed: 'confirmed',
  moved: 'switched during the read',
  assumed: 'assumed',
  none: 'not established',
}

export function AccountsPanel(): ReactElement {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [rows, setRows] = useState<AccountRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    Promise.all([listDevices(), listAccountRows()])
      .then(([fleet, stored]) => {
        setDevices(fleet)
        setRows(stored)
      })
      .catch((err: unknown) => setLoadError(describeApiError(err)))
  }, [])
  useEffect(load, [load])

  /** Only the stored rows — what a finished sync changed. The fleet does not move underneath a sync. */
  const reloadRows = useCallback(() => {
    listAccountRows()
      .then(setRows)
      .catch(() => {
        /* The table on screen is still the last good read; a failed refresh must not blank it. */
      })
  }, [])

  const [platforms, setPlatforms] = useState<Set<PlatformId>>(() => new Set(SYNCABLE.map((p) => p.id)))
  const [pick, setPick] = useState<DevicePick>(() => newPick())
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [dispatches, setDispatches] = useState<Dispatch[]>([])

  const fleet = devices ?? []
  const byId = useMemo(() => new Map(fleet.map((d) => [d.id, d])), [fleet])

  /**
   * Which phones are asked about which platforms.
   *
   * Every phone the pick resolves to is asked about every platform ticked: a
   * pick is an explicit list now, and the operator is looking at both lists
   * while they make them. A phone asked about a platform nobody signed into on
   * it answers "no account signed in", which is a fact worth storing rather
   * than a failure — untick the platform to skip the trip entirely.
   */
  const targets = useMemo((): { deviceId: string; platforms: PlatformId[] }[] => {
    const picked = SYNCABLE.filter((p) => platforms.has(p.id)).map((p) => p.id)
    if (picked.length === 0) return []
    return resolvePick(pick, fleet).map((d) => ({ deviceId: d.id, platforms: picked }))
  }, [platforms, pick, fleet])

  /** One `run-script` call per distinct platform set, so a phone is never sent a platform it does not carry. */
  const batches = useMemo(() => {
    const out = new Map<string, { platforms: PlatformId[]; deviceIds: string[] }>()
    for (const t of targets) {
      const key = t.platforms.join(',')
      const batch = out.get(key) ?? { platforms: t.platforms, deviceIds: [] }
      batch.deviceIds.push(t.deviceId)
      out.set(key, batch)
    }
    return [...out.values()]
  }, [targets])

  const send = useCallback(async () => {
    setSending(true)
    setSendError(null)
    const next: Dispatch[] = []
    try {
      for (const batch of batches) {
        const res = await api(`${CORE}/api/actions/run-script`, RunScriptResult, {
          method: 'POST',
          json: { target: { deviceIds: batch.deviceIds }, scriptRef: SYNC_REF, params: { platforms: batch.platforms } },
        })
        for (const r of res.results) {
          next.push({
            key: `${r.deviceId}:${r.jobId ?? `refused-${Date.now()}`}`,
            deviceId: r.deviceId,
            platforms: batch.platforms,
            jobId: r.jobId,
            status: r.jobId === null ? 'refused' : 'queued',
            detail: r.jobId === null ? (r.message ?? r.status) : null,
            result: null,
          })
        }
      }
    } catch (err) {
      setSendError(describeApiError(err))
    } finally {
      setDispatches((prev) => [...next, ...prev])
      setSending(false)
    }
  }, [batches])

  // Follow every job still out, read its result, and re-read the stored rows the moment the last one lands.
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
            let result: SyncResult | null = null
            if (job.status === 'success' && job.runId) {
              const run = await api(`${CORE}/api/jobs/${encodeURIComponent(d.jobId as string)}/runs/${encodeURIComponent(job.runId)}`, RunResultSchema)
              const parsed = SyncResultSchema.safeParse(run.run.result)
              if (parsed.success) {
                result = parsed.data
                detail = parsed.data.reason === '' ? null : parsed.data.reason
              } else {
                // The rows were written either way — the member owns that, not this screen.
                detail = 'read, but this build could not read what it answered'
              }
            }
            return { ...d, status: job.status, detail, result }
          } catch {
            return d
          }
        }),
      )
      const byKey = new Map(updates.map((u) => [u.key, u]))
      setDispatches((prev) => prev.map((d) => byKey.get(d.key) ?? d))
      if (updates.every((u) => TERMINAL.includes(u.status))) reloadRows()
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [dispatches, reloadRows])

  const blocked = platforms.size === 0 ? 'Pick at least one platform.' : (pickRefusal(pick) ?? (targets.length === 0 ? 'No phone matches — nothing would be read.' : null))
  const summary =
    targets.length === 0
      ? ''
      : `${targets.length} phone${targets.length === 1 ? '' : 's'}, ${[...new Set(targets.flatMap((t) => t.platforms))].map((id) => TITLE_OF[id] ?? id).join(', ')}`

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-4 py-4">
          <div>
            <p className="text-row font-medium text-text">Sync accounts</p>
            <p className="text-[12px] text-dim">
              Opens each platform's app on the phones picked, reads every account signed in there — TikTok can hold several — and stores their handles with the one the app is standing in
              right now. Nothing is posted and nothing is signed out.
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-[12px] font-medium text-text-2">Platforms</p>
            <div className="flex flex-wrap gap-3">
              {SYNCABLE.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-[13px]">
                  <Checkbox
                    checked={platforms.has(p.id)}
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

          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={blocked !== null || sending} onClick={() => void send()}>
              {sending ? <Spinner className="size-3.5" /> : <ArrowsClockwiseIcon aria-hidden />}
              Sync accounts
            </Button>
            <span className="text-[12px] text-dim">{blocked ?? summary}</span>
          </div>
          {sendError ? <p className="text-[12px] text-danger">{sendError}</p> : null}
        </CardContent>
      </Card>

      {dispatches.length > 0 ? <DispatchTable dispatches={dispatches} byId={byId} /> : null}

      <StoredAccounts rows={rows} fleet={fleet} loadError={loadError} onRetry={load} onRefresh={reloadRows} />
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * What each sync did
 * ------------------------------------------------------------------------ */

function DispatchTable({ dispatches, byId }: { dispatches: readonly Dispatch[]; byId: Map<string, Device> }): ReactElement {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11.5px] text-dim">
                <th className="py-1 pr-3 font-medium">Phone</th>
                <th className="py-1 pr-3 font-medium">Platforms</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 font-medium">What it read</th>
              </tr>
            </thead>
            <tbody>
              {dispatches.map((d) => {
                const phone = byId.get(d.deviceId)
                return (
                  <tr key={d.key} className="border-t border-border align-top">
                    <td className="py-1.5 pr-3">{phone ? deviceName(phone) : d.deviceId.slice(0, 8)}</td>
                    <td className="py-1.5 pr-3 text-text-2">{d.platforms.map((id) => TITLE_OF[id] ?? id).join(', ')}</td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={d.status === 'success' ? 'secondary' : d.status === 'failed' || d.status === 'refused' ? 'destructive' : 'default'}>{d.status}</Badge>
                    </td>
                    <td className="py-1.5 text-text-2">
                      {d.result === null ? (
                        (d.detail ?? (TERMINAL.includes(d.status) ? '' : 'working…'))
                      ) : (
                        <div className="space-y-0.5">
                          {d.result.platforms.map((p) => (
                            <p key={p.platform} className={cn('text-[12px]', p.error !== null && 'text-danger')}>
                              {TITLE_OF[p.platform] ?? p.platform}: {p.error ?? `${p.accounts} account${p.accounts === 1 ? '' : 's'}${p.current === null ? '' : `, now ${p.current}`}`}
                            </p>
                          ))}
                          {d.detail !== null && d.result.platforms.length === 0 ? <p className="text-[12px]">{d.detail}</p> : null}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------------ *
 * What is stored
 * ------------------------------------------------------------------------ */

/** One printed line: a phone's platform row, and one of its accounts (or none, when the read found nobody). */
interface AccountLine {
  key: string
  row: AccountRow
  username: string | null
  displayName: string | null
  slot: number | null
  current: boolean
  /** First line of this phone's block — the only one that prints the phone's name. */
  firstOfPhone: boolean
}

const PLATFORM_ORDER: readonly string[] = PLATFORMS.map((p) => p.id)

function StoredAccounts({
  rows,
  fleet,
  loadError,
  onRetry,
  onRefresh,
}: {
  rows: AccountRow[] | null
  fleet: readonly Device[]
  loadError: string | null
  onRetry: () => void
  onRefresh: () => void
}): ReactElement {
  const byId = useMemo(() => new Map(fleet.map((d) => [d.id, d])), [fleet])

  /** A phone's own name wins over the one stored with the row: the phone may have been renamed since the read. */
  const nameOf = useCallback(
    (row: AccountRow): string => {
      const device = byId.get(row.deviceId)
      return device ? deviceName(device) : (row.deviceName ?? row.deviceId.slice(0, 8))
    },
    [byId],
  )

  const lines = useMemo((): AccountLine[] => {
    if (rows === null) return []
    const sorted = [...rows].sort((a, b) => {
      const an = byId.get(a.deviceId)?.number ?? null
      const bn = byId.get(b.deviceId)?.number ?? null
      if (an !== bn) {
        if (an === null) return 1
        if (bn === null) return -1
        return an - bn
      }
      const byName = nameOf(a).localeCompare(nameOf(b))
      if (byName !== 0) return byName
      return PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform)
    })
    const out: AccountLine[] = []
    let lastDevice: string | null = null
    for (const row of sorted) {
      const accounts = [...row.accounts].sort((a, b) => a.slot - b.slot)
      const first = row.deviceId !== lastDevice
      lastDevice = row.deviceId
      if (accounts.length === 0) {
        out.push({ key: `${accountRowKeyOf(row)}:none`, row, username: null, displayName: null, slot: null, current: false, firstOfPhone: first })
        continue
      }
      accounts.forEach((account, i) => {
        out.push({
          key: `${accountRowKeyOf(row)}:${account.slot}:${account.username}`,
          row,
          username: account.username,
          displayName: account.displayName,
          slot: account.slot,
          current: account.current,
          firstOfPhone: first && i === 0,
        })
      })
    }
    return out
  }, [rows, byId, nameOf])

  /** Phones the farm knows and no sync has ever read. Named, because absent is a fact, not a gap. */
  const neverSynced = useMemo(() => {
    if (rows === null) return []
    const read = new Set(rows.map((r) => r.deviceId))
    return fleet.filter((d) => !read.has(d.id))
  }, [rows, fleet])

  const accountCount = (rows ?? []).reduce((n, r) => n + r.accounts.length, 0)
  const phoneCount = new Set((rows ?? []).map((r) => r.deviceId)).size

  if (loadError !== null && rows === null) return <ErrorState message={loadError} onRetry={onRetry} />
  if (rows === null) return <LoadingRows rows={3} />

  return (
    <Card>
      <CardContent className="@container space-y-2 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-row font-medium text-text">Accounts on the phones</p>
          <span className="text-[12px] text-dim">
            {rows.length === 0 ? 'nothing read yet' : `${accountCount} account${accountCount === 1 ? '' : 's'} on ${phoneCount} phone${phoneCount === 1 ? '' : 's'}`}
          </span>
          <div className="grow" />
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <ArrowsClockwiseIcon aria-hidden />
            Refresh
          </Button>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<SignInIcon className="size-4" aria-hidden />}
            title="No accounts read yet"
            description="Sync opens TikTok, YouTube and Instagram on the phones you pick, reads every account signed in on each — TikTok can hold several — and stores their handles here with the one the app is standing in right now. Nothing is posted and nothing is signed out."
          />
        ) : (
          <div className="overflow-hidden rounded-inner border border-line">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Phone</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="hidden @2xl:table-cell">Name</TableHead>
                  <TableHead className="w-16">Slot</TableHead>
                  <TableHead className="w-28">Signed in</TableHead>
                  <TableHead className="w-40">Read</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.key} className={cn(line.firstOfPhone && 'border-t-2 border-line')}>
                    <TableCell className="text-text-2">{line.firstOfPhone ? nameOf(line.row) : ''}</TableCell>
                    <TableCell>{TITLE_OF[line.row.platform] ?? line.row.platform}</TableCell>
                    <TableCell className="font-medium text-text">
                      {line.username ?? <span className="font-normal text-faint">{line.row.error === null ? 'No account signed in' : 'Could not be read'}</span>}
                      {line.row.error !== null && line.slot === null ? <p className="text-[11.5px] font-normal text-danger">{line.row.error}</p> : null}
                    </TableCell>
                    <TableCell className="hidden text-text-2 @2xl:table-cell">{line.displayName ?? '—'}</TableCell>
                    <TableCell className="text-dim">{line.slot === null ? '—' : line.slot}</TableCell>
                    <TableCell>{line.current ? <Badge>Signed in</Badge> : <span className="text-faint">—</span>}</TableCell>
                    <TableCell className="text-dim">
                      {relativeTime(line.row.readAt)}
                      {line.row.evidence !== 'confirmed' ? <p className="text-[11px] text-faint">{EVIDENCE_WORD[line.row.evidence]}</p> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {neverSynced.length > 0 ? (
          <p className="text-[12px] text-dim">
            Never synced ({neverSynced.length}): {neverSynced.slice(0, 8).map(deviceName).join(', ')}
            {neverSynced.length > 8 ? ` and ${neverSynced.length - 8} more` : ''}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
