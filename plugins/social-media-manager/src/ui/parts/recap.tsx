import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { z } from 'zod'
import {
  ArrowsClockwiseIcon,
  Badge,
  Button,
  Card,
  CardContent,
  CaretDownIcon,
  CaretRightIcon,
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingRows,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TrashIcon,
  WarningIcon,
  describeApiError,
  relativeTime,
} from '@enkaku/ui'
import {
  PLATFORMS,
  deviceName,
  forgetRecap,
  listDevices,
  listRecapRows,
  pickHost,
  recapRowKeyOf,
  rowDelta,
  rowViews,
  runMember,
  videoDelta,
  type Device,
  type PlatformId,
  type RecapRow,
  type RecapVideo,
} from '../shared'
import { DevicePicker, newPick, pickRefusal, resolvePick, type DevicePick } from './device-picker'

/**
 * The Recap tab (0.60.0).
 *
 * The owner's request, verbatim (2026-09-21): *"saya minta fitur baru dong di
 * smm yaitu rekap video ... goalsnya simpel yaitu nge rekap video dari 3
 * platform viewsnya berapa"* — with the hard part named in the same message:
 * an account with eighty videos cannot be scrolled to the bottom, so read a
 * few and merge.
 *
 * ## What is on this page, and what is not
 *
 * The table is the KNOWLEDGE, not the last run. A view count read this morning
 * is still the answer to "how is that video doing" at lunchtime — it does not
 * stop being true because nobody pressed Refresh — so the rows are always
 * there with their own read time, and a phone that has never been read is
 * named as such rather than left out.
 *
 * What a refresh does NOT do is dispatch. `smm/recap-videos` marks the rows as
 * wanted and the router sends the reads, one phone at a time, around whatever
 * else those phones are doing. So the button answers in a second for
 * seventy-three phones, and the table fills in over the next few minutes with
 * no page open — which is why this panel polls rather than following jobs.
 *
 * ## Why a window, and what happens to what falls out of it
 *
 * Six videos is the default because it is what the owner proposed and because
 * it is one screen on every platform. A video pushed past the window keeps its
 * last known count, greyed, with the date it was last seen: forgetting it
 * would make the account's total drop every time something new was posted,
 * which is the one number an operator would notice and disbelieve.
 */

/** Slower than a job poll: nothing here moves in under a minute, and a farm-wide scan every two seconds is rude. */
const POLL_MS = 10_000

const TITLE_OF: Record<string, string> = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.title]))
const PLATFORM_IDS: readonly PlatformId[] = PLATFORMS.map((p) => p.id)

const RECAP_REF = 'smm/recap-videos@latest'

/** What `smm/recap-videos` answers with. Loose: a newer member may say more, and more is not a failure. */
const RecapQueuedSchema = z.looseObject({ summary: z.string().default(''), reads: z.number().default(0) })

/** Thousands separators, because these are the numbers the page exists for. */
function num(value: number): string {
  return value.toLocaleString('en-US')
}

/** One phone, with whatever each platform last said about it. */
interface PhoneRow {
  deviceId: string
  name: string
  device: Device | null
  byPlatform: Map<PlatformId, RecapRow>
}

function groupByPhone(rows: readonly RecapRow[], fleet: readonly Device[]): PhoneRow[] {
  const byId = new Map(fleet.map((d) => [d.id, d]))
  const out = new Map<string, PhoneRow>()
  for (const row of rows) {
    const found = out.get(row.deviceId)
    const phone: PhoneRow = found ?? {
      deviceId: row.deviceId,
      name: byId.get(row.deviceId) ? deviceName(byId.get(row.deviceId) as Device) : row.deviceName || row.deviceId,
      device: byId.get(row.deviceId) ?? null,
      byPlatform: new Map(),
    }
    phone.byPlatform.set(row.platform, row)
    out.set(row.deviceId, phone)
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function RecapPanel(): ReactElement {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [rows, setRows] = useState<RecapRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    Promise.all([listDevices(), listRecapRows()])
      .then(([fleet, stored]) => {
        setDevices(fleet)
        setRows(stored)
      })
      .catch((err: unknown) => setLoadError(describeApiError(err)))
  }, [])
  useEffect(load, [load])

  /** Only the rows. A failed refresh must never blank the table on screen. */
  const reloadRows = useCallback(() => {
    listRecapRows()
      .then(setRows)
      .catch(() => {})
  }, [])

  const fleet = devices ?? []
  const phones = useMemo(() => groupByPhone(rows ?? [], fleet), [rows, fleet])
  const reading = useMemo(() => (rows ?? []).filter((row) => row.state === 'reading' && row.jobId !== '').length, [rows])
  const waiting = useMemo(() => (rows ?? []).filter((row) => row.state === 'reading' && row.jobId === '').length, [rows])

  /*
    Poll while anything is out. Not a fixed timer: an idle farm with a recap
    tab left open should cost the core nothing, and a farm mid-read should not
    need the operator to press anything. The owner asked for exactly this on
    the warm-up tab — *"ga realtime membuat user harus refresh page terus nah
    itu jelek"* — and it is the same answer here.
  */
  useEffect(() => {
    if (reading === 0 && waiting === 0) return
    const timer = setInterval(reloadRows, POLL_MS)
    return () => clearInterval(timer)
  }, [reading, waiting, reloadRows])

  const [platforms, setPlatforms] = useState<Set<PlatformId>>(() => new Set(PLATFORM_IDS))
  /*
    Every phone, by default — unlike the Accounts and Cleanup tabs, which open
    on "phones with the labels I choose" and are right to. Those SEND work to
    the phones they pick; a recap is a report about the whole farm, and opening
    it with its own button disabled until the operator has ticked a label makes
    the commonest case the one that takes the most clicks.
  */
  const [pick, setPick] = useState<DevicePick>(() => newPick('all'))
  const [maxVideos, setMaxVideos] = useState(6)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  const targets = useMemo(() => resolvePick(pick, fleet), [pick, fleet])

  const send = useCallback(async () => {
    const host = pickHost(fleet)
    if (!host) {
      setSendError('No phone is online, and queueing the reads needs one to carry the bookkeeping.')
      return
    }
    setSending(true)
    setSendError(null)
    setSent(null)
    try {
      const answer = await runMember(
        RECAP_REF,
        {
          platforms: [...platforms],
          maxVideos,
          targetMode: 'devices',
          targetDeviceIds: targets.map((d) => d.id),
        },
        host.id,
        RecapQueuedSchema,
      )
      setSent(answer?.summary || 'The reads are queued.')
      reloadRows()
    } catch (err) {
      setSendError(describeApiError(err))
    } finally {
      setSending(false)
    }
  }, [fleet, platforms, maxVideos, targets, reloadRows])

  const blocked = platforms.size === 0 ? 'Pick at least one platform.' : (pickRefusal(pick) ?? (targets.length === 0 ? 'No phone matches — nothing would be read.' : null))
  const summary = targets.length === 0 ? '' : `${targets.length} phone${targets.length === 1 ? '' : 's'} × ${[...platforms].map((id) => TITLE_OF[id] ?? id).join(', ')}`

  const totals = useMemo(() => {
    let videos = 0
    let views = 0
    let growth = 0
    let anyGrowth = false
    for (const row of rows ?? []) {
      videos += row.videos.length
      views += rowViews(row)
      const delta = rowDelta(row)
      if (delta !== null) {
        growth += delta
        anyGrowth = true
      }
    }
    return { videos, views, growth: anyGrowth ? growth : null }
  }, [rows])

  return (
    <div className="space-y-3">
      <Card className="gap-0 py-0">
        <CardContent className="space-y-4 p-4">
          <div>
            <p className="text-row font-medium text-text">Refresh the recap</p>
            <p className="text-[12px] text-dim">
              Asks each phone how many views its newest posts have, on each platform. Nothing is opened or played — opening a video would add a view to the number being counted. The reads
              go out around whatever else the phones are doing, so this answers straight away and the table fills in after.
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-[12px] font-medium text-text-2">Platforms</p>
            <div className="flex flex-wrap gap-3">
              {PLATFORMS.map((p) => (
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
            <p className="text-[12px] font-medium text-text-2">Videos per account</p>
            <div className="flex flex-wrap items-center gap-2">
              {[3, 6, 9, 12].map((n) => (
                <Button key={n} size="sm" variant={maxVideos === n ? 'default' : 'outline'} onClick={() => setMaxVideos(n)}>
                  {n}
                </Button>
              ))}
              <span className="text-[12px] text-dim">The newest ones. Anything older keeps the count it had when it was last seen.</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-[12px] font-medium text-text-2">Which phones</p>
            <DevicePicker fleet={fleet} loading={devices === null} error={loadError} onRetry={load} value={pick} onChange={setPick} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={blocked !== null || sending} onClick={() => void send()}>
              {sending ? <Spinner className="size-3.5" /> : <ArrowsClockwiseIcon aria-hidden />}
              Refresh recap
            </Button>
            <span className="text-[12px] text-dim">{blocked ?? summary}</span>
          </div>
          {sendError ? <p className="text-[12px] text-danger">{sendError}</p> : null}
          {sent ? <p className="text-[12px] text-dim">{sent}</p> : null}
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-row font-medium text-text">What has been posted</p>
            <div className="grow" />
            {reading > 0 || waiting > 0 ? (
              <span className="flex items-center gap-1.5 text-[12px] text-dim">
                <Spinner className="size-3.5" />
                {reading > 0 ? `${reading} read${reading === 1 ? '' : 's'} out` : ''}
                {reading > 0 && waiting > 0 ? ', ' : ''}
                {waiting > 0 ? `${waiting} waiting for a phone` : ''}
              </span>
            ) : null}
            <span className="text-[12px] text-dim">
              {num(totals.videos)} video{totals.videos === 1 ? '' : 's'} · {num(totals.views)} view{totals.views === 1 ? '' : 's'}
              {totals.growth !== null ? ` · ${totals.growth >= 0 ? '+' : ''}${num(totals.growth)} since the read before` : ''}
            </span>
          </div>

          {loadError !== null && rows === null ? (
            <ErrorState message={loadError} onRetry={load} />
          ) : rows === null ? (
            <LoadingRows rows={4} />
          ) : phones.length === 0 ? (
            <EmptyState
              title="No account has been read yet"
              description="Pick the phones and platforms above and press Refresh recap. Each phone opens its own profile, reads the newest posts' view counts, and closes it again."
            />
          ) : (
            <PhoneTable phones={phones} onChanged={reloadRows} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function PhoneTable({ phones, onChanged }: { phones: readonly PhoneRow[]; onChanged: () => void }): ReactElement {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = useCallback((deviceId: string) => {
    setOpen((prev) => {
      const copy = new Set(prev)
      if (copy.has(deviceId)) copy.delete(deviceId)
      else copy.add(deviceId)
      return copy
    })
  }, [])

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Phone</TableHead>
          {PLATFORMS.map((p) => (
            <TableHead key={p.id}>{p.title}</TableHead>
          ))}
          <TableHead>Last read</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {phones.map((phone) => {
          const expanded = open.has(phone.deviceId)
          const readAt = Math.max(0, ...[...phone.byPlatform.values()].map((row) => row.readAt))
          return (
            <>
              <TableRow key={phone.deviceId} className="cursor-pointer" onClick={() => toggle(phone.deviceId)}>
                <TableCell>{expanded ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}</TableCell>
                <TableCell className="font-medium text-text">{phone.name}</TableCell>
                {PLATFORMS.map((p) => (
                  <TableCell key={p.id}>
                    <PlatformCell row={phone.byPlatform.get(p.id) ?? null} />
                  </TableCell>
                ))}
                <TableCell className="text-dim">{readAt > 0 ? relativeTime(readAt * 1000) : '—'}</TableCell>
              </TableRow>
              {expanded ? (
                <TableRow key={`${phone.deviceId}-detail`}>
                  <TableCell colSpan={3 + PLATFORMS.length}>
                    <PhoneDetail phone={phone} onChanged={onChanged} />
                  </TableCell>
                </TableRow>
              ) : null}
            </>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** One platform's cell: the two numbers that matter, or why there are none. */
function PlatformCell({ row }: { row: RecapRow | null }): ReactElement {
  if (row === null) return <span className="text-faint">—</span>
  if (row.state === 'reading') {
    /*
      "Waiting" and "reading" are different states and were shown as one.
      A row with no job is queued — most often for a phone that is offline,
      which on a fleet-wide refresh is most of them — and calling that
      "reading" made a farm look busy for hours when nothing was happening.
    */
    if (row.jobId === '') return <span className="text-[12px] text-faint">waiting for the phone</span>
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-dim">
        <Spinner className="size-3" />
        reading
      </span>
    )
  }
  if (row.state === 'failed') {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-warn" title={row.note}>
        <WarningIcon aria-hidden />
        {row.videos.length > 0 ? `${num(rowViews(row))} (stale)` : 'could not read'}
      </span>
    )
  }
  if (row.state === 'never') return <span className="text-faint">not read</span>
  if (row.videos.length === 0) return <span className="text-faint">nothing posted</span>
  const delta = rowDelta(row)
  return (
    <span className="text-[13px] text-text">
      {num(rowViews(row))}
      <span className="text-faint"> · {row.videos.length}v</span>
      {delta !== null && delta !== 0 ? <span className="text-ok"> +{num(delta)}</span> : null}
    </span>
  )
}

function PhoneDetail({ phone, onChanged }: { phone: PhoneRow; onChanged: () => void }): ReactElement {
  return (
    <div className="space-y-3 py-1">
      {PLATFORMS.map((p) => {
        const row = phone.byPlatform.get(p.id)
        if (!row) return null
        return <PlatformDetail key={p.id} title={p.title} row={row} onChanged={onChanged} />
      })}
    </div>
  )
}

function PlatformDetail({ title, row, onChanged }: { title: string; row: RecapRow; onChanged: () => void }): ReactElement {
  const [forgetting, setForgetting] = useState(false)
  const forget = useCallback(async () => {
    setForgetting(true)
    try {
      await forgetRecap(row)
      onChanged()
    } finally {
      setForgetting(false)
    }
  }, [row, onChanged])

  const inWindow = row.videos.filter((video) => video.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
  const gone = row.videos.filter((video) => video.rank === null).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  /*
    Said once, here, rather than on every line. TikTok and Instagram give a
    grid cell a play count and NOTHING else, so nine videos used to carry nine
    copies of "no title on this platform" — which is a fact about the platform,
    not about any of those videos.
  */
  const unnamed = row.videos.length > 0 && row.videos.every((video) => video.title === '')

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{title}</Badge>
        {row.account ? <span className="text-[12px] text-dim">{row.account}</span> : null}
        {unnamed ? <span className="text-[12px] text-faint">newest first — this platform does not name its videos</span> : null}
        {row.truncated ? <span className="text-[12px] text-warn">the list stopped early — two scrolls could not be joined</span> : null}
        <div className="grow" />
        <Button variant="ghost" size="sm" disabled={forgetting} onClick={() => void forget()} title="Forget what is stored for this account and start again from the next read">
          {forgetting ? <Spinner className="size-3.5" /> : <TrashIcon aria-hidden />}
          Forget
        </Button>
      </div>
      {row.note ? <p className="text-[12px] text-warn">{row.note}</p> : null}
      {row.videos.length === 0 ? (
        <p className="text-[12px] text-faint">{row.state === 'ok' ? 'This account has posted nothing.' : 'Nothing read yet.'}</p>
      ) : (
        <div className="space-y-0.5">
          {inWindow.map((video) => (
            <VideoLine key={video.key} video={video} />
          ))}
          {gone.length > 0 ? (
            <>
              <p className="pt-1 text-[11px] text-faint">Past the window — last known counts:</p>
              {gone.map((video) => (
                <VideoLine key={video.key} video={video} faded />
              ))}
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

function VideoLine({ video, faded = false }: { video: RecapVideo; faded?: boolean }): ReactElement {
  const delta = videoDelta(video)
  return (
    <div className={`flex flex-wrap items-baseline gap-2 text-[12px] ${faded ? 'text-faint' : 'text-text-2'}`}>
      <span className="w-6 shrink-0 text-right text-faint">{video.rank === null ? '·' : `#${video.rank + 1}`}</span>
      <span className="min-w-0 grow truncate">{video.title}</span>
      <span className={faded ? '' : 'font-medium text-text'}>{num(video.views)}</span>
      {video.approx ? <span className="text-faint" title={`the phone drew "${video.viewsText}"`}>≈</span> : null}
      {delta !== null && delta !== 0 && !faded ? <span className="text-ok">+{num(delta)}</span> : null}
      <span className="text-faint">{video.rank === null ? `last seen ${relativeTime(video.lastSeenAt * 1000)}` : `since ${relativeTime(video.firstSeenAt * 1000)}`}</span>
    </div>
  )
}
