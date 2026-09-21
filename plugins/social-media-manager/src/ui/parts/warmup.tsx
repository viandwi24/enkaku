import { Fragment, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  ArrowsClockwiseIcon,
  Badge,
  Button,
  Checkbox,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingRows,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TrashIcon,
  cn,
  relativeTime,
  useAction,
  z,
} from '@enkaku/ui'
import { PLATFORM_IDS, type PlatformId } from '../../platforms'
import { DevicePicker, newPick, pickRefusal, resolvePick, type DevicePick } from './device-picker'
import { readDuration, rollUpByDevice, runsOf, sessionReport, type DeviceRollup } from '../../warmup-report'
import { listDevices, listGroups, listWarmupRows, pickHost, platformLabel, deleteWarmupRun, retryWarmupRun, runMember, runWarmupAgain, setSessionStopped, listAllWarmupRows, stoppedNewestFrom, type Device, type Group, type WarmupRow, type WarmupStep } from '../shared'

/**
 * The Warm-up screen (plan 900 D5, wave 4).
 *
 * ## Why this is a second menu entry, when the last redesign removed two
 *
 * `ui/index.tsx` carries the owner's verdict on the old layout: *"saya minta
 * menunya sama aja jadi satu dong jangan dibedakan"* — three sidebar entries
 * for ONE job. That decision holds and this does not undo it.
 *
 * Warming up is a different job. It takes no videos, produces no posts, and
 * asks a different question of the fleet: not "where did this video get to"
 * but "what did this phone do today". The owner's brief for this screen was
 * exactly that — *"ada sesi auto post dan sesi warmup, jadi biar ga ketukar
 * usernya"*. Two jobs, two entries; one job, one entry. The rule did not
 * change, only which side of it this work falls on.
 *
 * The Social posts screen therefore shows ONLY `kind: 'post'` sessions and this
 * one shows only `kind: 'warmup'`, so neither list can ever offer a row whose
 * buttons belong to the other.
 */

const AddWarmupResultSchema = z.object({
  groupId: z.string(),
  title: z.string(),
  devices: z.number(),
  activities: z.number(),
  phases: z.number(),
  skipped: z.number(),
  summary: z.string(),
  reused: z.boolean().default(false),
})

/**
 * Stop and Start again, on the session LIST — and always aimed at the NEWEST
 * run (0.59.0).
 *
 * A session has runs now, so "stop this session" needs a referent. The owner
 * named it: *"start stop yang di list sesi itu selalu mengarah ke sesi paling
 * baru"*, which is also the only reading that makes sense from a list — the
 * run somebody wants stopped from there is tonight's, never one from last
 * week. Each run has its own Stop on the session page, where which run you
 * mean is on screen.
 *
 * `stopped` here is read from the ROWS of that newest run, not from the
 * session. The session-level flag survives only for sessions stopped before
 * runs existed.
 */
function WarmupControls({ group, newestStopped, busy, onStop }: { group: Group; newestStopped: boolean; busy: boolean; onStop: (action: 'stop' | 'start') => void }): ReactElement {
  if (newestStopped || group.stopped)
    return (
      <Button size="sm" disabled={busy} onClick={() => onStop('start')}>
        <PlayIcon aria-hidden />
        Start again
      </Button>
    )
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" disabled={busy}>
          <PauseIcon aria-hidden />
          Stop
        </Button>
      }
      title={`Stop the newest run of “${group.title}”?`}
      destructive
      confirmLabel="Stop"
      description={
        <>
          Every activity that run has <strong>running right now</strong> is cancelled on its phone and goes back into the queue. Nothing more is sent
          for it until you start it again.
          <br />
          Its earlier runs are untouched, and so is their history. Starting it again carries on from where it stopped, keeping the gaps you chose.
        </>
      }
      onConfirm={() => onStop('stop')}
    />
  )
}

/**
 * How often a MOVING warm-up is re-read, and the line that says so.
 *
 * Ten seconds, the same cadence the Posts page uses and for the same reason: a
 * warm-up moves in minutes, not frames, and a phone that just answered will
 * still be on screen a moment later.
 *
 * The important half is when it does NOT poll. A settled session — every
 * activity answered, or the run stopped — makes no requests at all while this
 * screen is open. A farm whose last warm-up finished yesterday should cost
 * nothing to leave on a monitor, and a screen that keeps asking a question it
 * already has the answer to is how a dashboard turns into load.
 */
const POLL_MS = 10_000

/** Is anything on this screen going to change on its own? */
function isMoving(rows: readonly WarmupRow[]): boolean {
  return rows.some((row) => !row.stopped && row.steps.some((step) => step.state === 'queued' || step.state === 'pending'))
}

/**
 * The one line that tells an operator the screen is alive.
 *
 * Without it, "nothing has changed for two minutes" and "this page stopped
 * updating" look identical, and the only way to tell them apart is to press
 * Refresh — which is exactly the habit auto-refresh exists to remove.
 */
function LiveLine({ moving, updatedAt, now }: { moving: boolean; updatedAt: number | null; now: number }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-dim">
      <span className="inline-flex items-center gap-1.5">
        <span className={cn('size-1.5 shrink-0 rounded-pill', moving ? 'animate-pulse bg-accent' : 'bg-faint-2')} aria-hidden />
        {updatedAt !== null ? <span>Updated {relativeTime(Math.floor(updatedAt / 1000), now)}</span> : <span>Reading…</span>}
      </span>
      <span aria-hidden>·</span>
      <span>{moving ? `checking every ${POLL_MS / 1000}s` : 'nothing is moving — not refreshing'}</span>
    </div>
  )
}

/**
 * What the pick means HERE — the picker's own lines are about posting.
 *
 * Since 0.57.3 the two say the same thing, and that is the point: the
 * operator's choice of phones IS the choice, and the platform label does not
 * narrow it afterwards. These lines exist because the wording still differs —
 * a warm-up has no video to post twice — not because the rule does.
 */
const WARMUP_CONSEQUENCE = {
  all: 'Every phone in the farm, each warmed up on every platform this session covers. A phone not signed in to one fails that activity by name rather than being skipped in silence.',
  devices: 'Exactly the phones ticked, each warmed up on every platform this session covers.',
  labels: 'Every phone carrying one of these labels, each warmed up on every platform this session covers.',
  groups: 'Every phone in these groups, each warmed up on every platform this session covers.',
} as const

/** The colour a state reads as, in the same vocabulary the Posts table uses. */
const RUN_TONE: Record<string, string> = {
  done: 'text-ok',
  partial: 'text-warn',
  failed: 'text-bad',
  running: 'text-dim',
  pending: 'text-faint',
  skipped: 'text-faint',
}

const STEP_TONE: Record<WarmupStep['state'], string> = {
  success: 'text-ok',
  failed: 'text-bad',
  queued: 'text-dim',
  pending: 'text-faint',
  skipped: 'text-faint',
}

function StateBadge({ state }: { state: string }): ReactElement {
  return <span className={cn('text-[12px]', RUN_TONE[state] ?? 'text-dim')}>{state}</span>
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function WarmupPanel({ refreshKey, onOpen, onNew }: { refreshKey: number; onOpen: (groupId: string) => void; onNew: () => void }): ReactElement {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const { run, isPending } = useAction()

  /* Stopping needs no phone: it writes this plugin's own rows and cancels the farm's jobs, both as the operator. */
  const stopSession = useCallback(
    (group: Group, action: 'stop' | 'start') => {
      void run(
        `stop:${group.id}`,
        /* No phone needed — see `setSessionStopped`. */
        () => setSessionStopped(group, action),
        {
          success:
            action === 'stop'
              ? `“${group.title}” stopped — anything running was cancelled and put back in the queue`
              : `“${group.title}” started again — the router sends the rest on its next pass`,
          failure: action === 'stop' ? `Could not stop “${group.title}”` : `Could not start “${group.title}”`,
          onSuccess: () => setReloadKey((n) => n + 1),
        },
      )
    },
    [run],
  )
  const busy = useCallback((group: Group) => isPending(`stop:${group.id}`), [isPending])

  /* Which sessions have a stopped NEWEST run — what the list's Stop button is about. */
  const [stoppedNewest, setStoppedNewest] = useState<ReadonlySet<string>>(new Set())
  /*
    The list had NO auto-refresh at all until 0.59.1: a session's Progress
    column sat at whatever it said when the page loaded, and the only way to
    watch a fleet was to keep pressing Refresh. That is the habit this exists
    to remove — see `LiveLine`.
  */
  const [moving, setMoving] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS)
    return () => clearInterval(timer)
  }, [moving])

  useEffect(() => {
    let live = true
    setError(null)
    Promise.all([listGroups(), listAllWarmupRows()])
      .then(([all, rows]) => {
        if (!live) return
        setGroups(all.filter((group) => group.kind === 'warmup'))
        setStoppedNewest(stoppedNewestFrom(rows))
        setMoving(isMoving(rows))
        setUpdatedAt(Date.now())
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [refreshKey, reloadKey, tick])

  if (error !== null) return <ErrorState message={`Could not read the warm-up sessions: ${error}`} />
  if (groups === null) return <LoadingRows rows={3} />
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No warm-up sessions yet"
        description="A warm-up takes every phone you choose through each platform in turn, a few activities on each, spread out so the fleet never moves in lockstep. Start it again whenever you like — every run keeps its own history."
        action={
          <Button size="sm" onClick={onNew}>
            <PlusIcon aria-hidden />
            New warm-up
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <LiveLine moving={moving} updatedAt={updatedAt} now={now} />
      <div className="overflow-hidden rounded-inner border border-line">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>Platforms</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => (
            <TableRow key={group.id} className="cursor-pointer" onClick={() => onOpen(group.id)}>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{group.title}</span>
                  {stoppedNewest.has(group.id) || group.stopped ? (
                    <Badge variant="outline" className="text-warn">
                      newest run stopped
                    </Badge>
                  ) : null}
                </div>
                {group.warmup ? <div className="text-[12px] text-faint">{group.warmup.keywords.slice(0, 4).join(', ')}</div> : null}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {group.platforms.map((id) => (
                    <Badge key={id} variant="outline">
                      {platformLabel(id as PlatformId)}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-[12px] text-dim">{group.summary ?? '—'}</TableCell>
              <TableCell className="text-[12px] text-faint">{relativeTime(group.createdAt * 1000)}</TableCell>
              {/* The row opens the session, so the buttons must not — every one of them stops the click here. */}
              <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                <WarmupControls group={group} newestStopped={stoppedNewest.has(group.id)} busy={busy(group)} onStop={(action) => stopSession(group, action)} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/** The numbers an operator tunes, with the defaults the rotation shipped. */
interface Draft {
  title: string
  platforms: PlatformId[]
  activities: number
  keywords: string
  amount: number
  gapMinSec: number
  gapMaxSec: number
  startJitterSec: number
  slot: number
  phases: number
  likeChance: number
  commentChance: number
  keywordBoost: number
  sequenceMode: 'jobs' | 'workflow'
}

const DEFAULT_DRAFT: Draft = {
  title: '',
  platforms: [...PLATFORM_IDS],
  activities: 4,
  keywords: 'trading, forex, gold, xau, scalping, belajar trading, saham, crypto, investasi',
  amount: 1,
  gapMinSec: 8,
  gapMaxSec: 20,
  startJitterSec: 120,
  slot: -1,
  phases: 3,
  likeChance: 0.1,
  commentChance: 0.05,
  keywordBoost: 3,
  sequenceMode: 'jobs',
}

function NumberField({ label, hint, value, onChange, step = 1, min, max }: { label: string; hint?: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number }): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-dim">{label}</span>
      <Input
        type="number"
        value={String(value)}
        step={step}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        onChange={(e) => {
          const next = Number((e.target as HTMLInputElement).value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
      {hint === undefined ? null : <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  )
}

export function NewWarmupForm({ onCreated }: { onCreated: (groupId: string | null) => void }): ReactElement {
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT)
  const [fleet, setFleet] = useState<Device[]>([])
  const [fleetLoading, setFleetLoading] = useState(true)
  const [fleetError, setFleetError] = useState<string | null>(null)
  const [fleetKey, setFleetKey] = useState(0)
  /* 'all' by default: the owner's case is the whole farm, and a mode with nothing ticked reaches nobody. */
  const [pick, setPick] = useState<DevicePick>(() => newPick('all'))
  const [onlineOnly, setOnlineOnly] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const host = useMemo(() => pickHost(fleet), [fleet])
  const onReloadFleet = useCallback(() => setFleetKey((n) => n + 1), [])

  useEffect(() => {
    let live = true
    setFleetLoading(true)
    setFleetError(null)
    listDevices()
      .then((all) => {
        if (!live) return
        setFleet(all)
        setFleetLoading(false)
      })
      .catch((err: unknown) => {
        if (!live) return
        setFleetError(err instanceof Error ? err.message : String(err))
        setFleetLoading(false)
      })
    return () => {
      live = false
    }
  }, [fleetKey])

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value })), [])

  const keywords = useMemo(
    () =>
      draft.keywords
        .split(',')
        .map((word) => word.trim())
        .filter((word) => word !== '')
        .slice(0, 10),
    [draft.keywords],
  )

  /*
    Counted from the SAME rule the planner uses — a phone is only sent to a
    platform this session covers. Shown before Create because "eighty phones"
    and "eighty phones that can actually do this" are different numbers, and the
    operator should meet the difference here rather than in a session where a
    third of the rows say "no label".
  */
  const reach = useMemo(() => {
    /*
      Every chosen phone does the work now — the labels no longer decide who is
      "able" (0.57.3). What is still worth showing is how many phones carry a
      label for none of the chosen platforms, because those are the ones whose
      activities are most likely to fail on a signed-out app.
    */
    // The same narrowing the member applies, so the count on screen is the
    // count that will actually be planned rather than an optimistic one.
    const chosen = resolvePick(pick, fleet).filter((device) => !onlineOnly || device.status === 'online')
    const unlabelled = chosen.filter((device) => !draft.platforms.some((id) => device.labels.some((l) => l.name.trim().toLowerCase() === id)))
    const perPhone = draft.activities * Math.min(draft.platforms.length, draft.phases)
    return { chosen: chosen.length, unlabelled: unlabelled.length, total: chosen.length * perPhone, perPhone }
  }, [fleet, pick, onlineOnly, draft.platforms, draft.activities, draft.phases])

  const online = useMemo(() => fleet.filter((device) => device.status === 'online').length, [fleet])
  /*
    The pick's own refusal, and then the one the connected-only flag can cause.
    Without the second, ticking it on a farm whose phones are all away left
    Create enabled and the member answered `E_NO_DEVICES` — a refusal the
    screen already had every fact needed to give first, in better words.
  */
  const refusal = useMemo(
    () => pickRefusal(pick) ?? (reach.chosen === 0 ? (onlineOnly ? `None of these phones is connected right now (${online} of ${fleet.length} are). Untick "connected phones only" to plan them anyway.` : 'No phone matches — this session would reach nobody.') : null),
    [pick, reach.chosen, onlineOnly, online, fleet.length],
  )

  const create = useCallback(async () => {
    if (host === null) {
      setError('No phone is online to plan the session on.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const made = await runMember(
        'smm/add-warmup@latest',
        {
          title: draft.title.trim() || 'Warm-up',
          platforms: draft.platforms,
          /*
            The pick's INTENT, not the ids it resolves to right now: a schedule
            that re-runs this session must reach the phones that carry the
            label today, not the ones that carried it when it was set up.
          */
          targetMode: pick.mode,
          targetLabels: [...pick.labelNames],
          targetGroups: [...pick.groupIds],
          targetDeviceIds: [...pick.deviceIds],
          onlineOnly,
          activities: draft.activities,
          keywords,
          amount: draft.amount,
          gapMinSec: draft.gapMinSec,
          gapMaxSec: draft.gapMaxSec,
          startJitterSec: draft.startJitterSec,
          slot: draft.slot,
          phases: draft.phases,
          likeChance: draft.likeChance,
          commentChance: draft.commentChance,
          keywordBoost: draft.keywordBoost,
          sequenceMode: draft.sequenceMode,
        },
        host.id,
        AddWarmupResultSchema,
      )
      onCreated(made?.groupId ?? null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [draft, keywords, host, pick, onCreated])

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3 px-3 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-dim">Title</span>
          <Input value={draft.title} placeholder="Warm-up pagi" onChange={(e) => set('title', (e.target as HTMLInputElement).value)} />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-dim">Platforms</span>
          <div className="flex flex-wrap gap-2">
            {PLATFORM_IDS.map((id) => {
              const on = draft.platforms.includes(id)
              return (
                <Button
                  key={id}
                  size="sm"
                  variant={on ? 'default' : 'outline'}
                  onClick={() => set('platforms', on ? draft.platforms.filter((p) => p !== id) : [...draft.platforms, id])}
                >
                  {platformLabel(id)}
                </Button>
              )
            })}
          </div>
          <span className="text-[11px] text-faint">
            Every phone this session covers warms up all of these, one after another. A phone's own labels only decide which it does first.
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-dim">Which phones</span>
          {/* The SAME picker New session, Cleanup and Accounts sync use — four
              options in four identical words. A warm-up asked for its phones
              with a text box until 0.57.0, which the owner rightly called
              "kurang": the fleet is already on screen everywhere else. */}
          <DevicePicker
            fleet={fleet}
            loading={fleetLoading}
            error={fleetError}
            onRetry={onReloadFleet}
            value={pick}
            onChange={setPick}
            consequence={WARMUP_CONSEQUENCE}
          />
          {/*
            The owner's production case (2026-09-21): 73 phones registered, 20
            connected. Without this, a session aimed at every phone writes a
            row for all 73 and the 53 that are offline wait — correctly, a
            warm-up has no deadline to miss — for ever, so the session never
            finishes. A FLAG rather than a fifth option in the picker above,
            because "which phones" and "only the connected ones" are different
            questions and an operator asks both.
          */}
          <label className="flex items-center gap-2 text-[12px] text-text-2">
            <Checkbox checked={onlineOnly} onCheckedChange={(on) => setOnlineOnly(on === true)} />
            Only the phones connected right now
            <span className="text-faint">
              ({online} of {fleet.length} connected). Worked out again each time this session runs.
            </span>
          </label>
          <span className="text-[11px] text-faint">
            {reach.chosen} phone{reach.chosen === 1 ? '' : 's'} chosen — {reach.perPhone} activities each, about {reach.total} in all.
            {reach.unlabelled > 0
              ? ` ${reach.unlabelled} of them carry a label for none of these platforms; they are still warmed up, and an account they are not signed in to fails that activity by name.`
              : ''}
          </span>
        </div>

        <NumberField
          label="Activities per phone"
          hint="on each platform this session covers"
          value={draft.activities}
          onChange={(n) => set('activities', n)}
          min={1}
          max={12}
        />
      </Card>

      {/*
        Everything below is a default that works. The owner's brief for this
        screen was *"user maunya tinggal start, dan semua sudah diahandle"* —
        so the variation, the shuffling, the rotation and the pacing are the
        system's job, and this is where somebody who wants to argue with it
        can. Collapsed, because an operator who opens it every time is a
        screen that failed.
      */}
      <Card className="flex flex-col gap-3 px-3 py-3">
        <button type="button" className="flex items-center gap-1.5 text-left text-[12px] text-dim outline-none" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}
          Advanced — keywords, pacing and how activities are sent
        </button>

        {advanced ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-dim">Keywords</span>
              <Input value={draft.keywords} onChange={(e) => set('keywords', (e.target as HTMLInputElement).value)} />
              <span className="text-[11px] text-faint">
                Comma separated, up to ten. {keywords.length} in use. These are the account's interests: a caption, author or hashtag matching one of
                them raises that phone's chance of liking and of opening the comments, and they are what it searches for.
              </span>
            </label>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <NumberField label="Platforms per phone" hint="3 covers every one it carries" value={draft.phases} onChange={(n) => set('phases', n)} min={1} max={3} />
              <NumberField label="Watch amount" hint="0.5 short, 2 long" value={draft.amount} onChange={(n) => set('amount', n)} step={0.1} min={0.2} max={3} />
              <NumberField label="Gap min (s)" value={draft.gapMinSec} onChange={(n) => set('gapMinSec', n)} min={0} max={3600} />
              <NumberField label="Gap max (s)" value={draft.gapMaxSec} onChange={(n) => set('gapMaxSec', n)} min={0} max={3600} />
              <NumberField label="Start jitter (s)" hint="so the fleet does not start at once" value={draft.startJitterSec} onChange={(n) => set('startJitterSec', n)} min={0} max={1800} />
              <NumberField label="Like chance" hint="0 never likes" value={draft.likeChance} onChange={(n) => set('likeChance', n)} step={0.05} min={0} max={1} />
              <NumberField label="Comment chance" hint="opens and reads, never types" value={draft.commentChance} onChange={(n) => set('commentChance', n)} step={0.05} min={0} max={1} />
              <NumberField label="Keyword boost" hint="multiplies both on a match" value={draft.keywordBoost} onChange={(n) => set('keywordBoost', n)} step={0.5} min={1} max={10} />
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-dim">Send activities as</span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={draft.sequenceMode === 'jobs' ? 'default' : 'outline'} onClick={() => set('sequenceMode', 'jobs')}>
                  One job per activity
                </Button>
                <Button size="sm" variant={draft.sequenceMode === 'workflow' ? 'default' : 'outline'} onClick={() => set('sequenceMode', 'workflow')}>
                  One workflow per phone
                </Button>
              </div>
              <span className="text-[11px] text-faint">
                {draft.sequenceMode === 'jobs'
                  ? 'A result for every activity, and the gaps are honoured on the router\'s own tick.'
                  : 'Exact gaps and one job per phone — but one result for the whole sequence, with the steps in its own run view.'}
              </span>
            </div>
          </>
        ) : (
          <span className="text-[11px] text-faint">
            The system picks which activities each phone does, shuffles their order, staggers the starts and rotates the platforms between sessions.
          </span>
        )}
      </Card>

      {error === null ? null : <ErrorState message={`Could not create the session: ${error}`} />}

      <div className="flex items-center gap-2">
        <Button onClick={() => void create()} disabled={busy || draft.platforms.length === 0 || keywords.length === 0 || refusal !== null}>
          {busy ? <Spinner className="size-3.5" /> : <PlusIcon aria-hidden />}
          Create warm-up
        </Button>
        {/* Refused here rather than discovered as a session that sits and sends nothing. */}
        <span className="text-[12px] text-faint">{refusal ?? 'Each phone starts at its own moment; nothing goes out all at once.'}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

function StepList({ steps }: { steps: WarmupStep[] }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      {steps.map((step) => (
        <div key={step.activityId} className="flex flex-wrap items-baseline gap-2">
          <span className={cn('text-[12px]', STEP_TONE[step.state])}>{step.state}</span>
          <span className="text-[12px]">{step.title}</span>
          {step.error === null ? null : <span className="text-[11px] text-bad">{step.error}</span>}
        </div>
      ))}
    </div>
  )
}

/**
 * Start this session again — a new run, beside the ones before it.
 *
 * Goes through `smm/run-warmup`, which needs a phone to carry the paperwork
 * like every member does. Refusing early when none is online is better than a
 * button that appears to work on a farm with nothing connected.
 */
function RunAgainButton({ group, onDone }: { group: Group; onDone: () => void }): ReactElement {
  const { run, isPending } = useAction()
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="outline" disabled={isPending(`again:${group.id}`)}>
          <PlusIcon aria-hidden />
          New run
        </Button>
      }
      title={`Start a new run of “${group.title}”?`}
      destructive={false}
      confirmLabel="Start it"
      description={
        <>
          A new run starts now, with this session’s own phones and settings. Everything random is drawn again — which platform each phone gets,
          which activities, in what order, how long it waits — so two runs are two different evenings rather than one repeated.
          <br />
          The runs before it are kept, each with its own progress.
        </>
      }
      onConfirm={() => {
        void run(
          `again:${group.id}`,
          async () => {
            const host = pickHost(await listDevices())
            if (host === null) throw new Error('No phone is online. A run is planned through one of the farm’s own phones, so at least one has to be connected — nothing has been started.')
            return runWarmupAgain(group.id, host.id)
          },
          {
            success: `“${group.title}” started again — this run keeps its own progress beside the ones before it`,
            failure: `Could not start “${group.title}” again`,
            onSuccess: onDone,
          },
        )
      }}
    />
  )
}

/**
 * The runs of a session, newest first — the history the owner asked for.
 *
 * One row each, because a run is a moment and a verdict: when it started, how
 * many phones, how it went. Clicking one shows its own table below.
 */
function RunPicker({
  history,
  shownId,
  newestId,
  onPick,
}: {
  history: { runId: string; plannedAt: number; rows: WarmupRow[]; report: { phones: number; successRate: number | null; finished: boolean } }[]
  shownId: string | null
  newestId: string | null
  onPick: (runId: string) => void
}): ReactElement | null {
  if (history.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {history.map((entry) => {
        const on = entry.runId === shownId
        const stopped = entry.rows.some((row) => row.stopped)
        return (
          <Button key={entry.runId} size="sm" variant={on ? 'default' : 'outline'} onClick={() => onPick(entry.runId)}>
            {entry.plannedAt === 0 ? 'earlier run' : relativeTime(entry.plannedAt * 1000)}
            {entry.runId === newestId && history.length > 1 ? <span className="ml-1 text-[11px] text-faint">newest</span> : null}
            <span className={cn('ml-1.5 text-[11px]', on ? '' : 'text-faint')}>
              {stopped ? 'stopped' : entry.report.successRate === null ? (entry.report.finished ? 'nothing ran' : 'running') : `${Math.round(entry.report.successRate * 100)}%`}
            </span>
          </Button>
        )
      })}
    </div>
  )
}

/**
 * What one run can have done to it: stopped or started, retried, removed.
 *
 * All three run in the BROWSER — none of them needs a phone, and the moment
 * you most want to stop something is the moment you can least count on one
 * being connected. Only STARTING a new run is a member, because a schedule has
 * to be able to do that and a schedule can only run a script.
 */
function RunControls({ group, runId, rows, onDone }: { group: Group; runId: string; rows: WarmupRow[]; onDone: () => void }): ReactElement {
  const { run, isPending } = useAction()
  const stopped = rows.some((row) => row.stopped)
  const busy = isPending(`run:${runId}`)
  const retryable = rows.some((row) => row.steps.some((step) => step.state === 'failed' || step.state === 'skipped'))

  const act = (what: string, doing: () => Promise<unknown>, success: string, failure: string): void => {
    void run(`run:${runId}`, doing, { success, failure, onSuccess: onDone })
    void what
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stopped ? (
        <Button size="sm" disabled={busy} onClick={() => act('start', () => setSessionStopped(group, 'start', runId), 'This run was started again — the router sends the rest on its next pass', 'Could not start this run again')}>
          <PlayIcon aria-hidden />
          Start again
        </Button>
      ) : (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={busy}>
              <PauseIcon aria-hidden />
              Stop
            </Button>
          }
          title="Stop this run?"
          destructive
          confirmLabel="Stop"
          description={
            <>
              Every activity this run has <strong>running right now</strong> is cancelled on its phone and goes back into the queue. Nothing more is
              sent for it until you start it again.
              <br />
              The other runs of this session are untouched.
            </>
          }
          onConfirm={() => act('stop', () => setSessionStopped(group, 'stop', runId), 'This run was stopped — anything running was cancelled and put back in the queue', 'Could not stop this run')}
        />
      )}

      {retryable ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={busy}>
              <ArrowsClockwiseIcon aria-hidden />
              Retry failed
            </Button>
          }
          title="Retry what failed in this run?"
          destructive={false}
          confirmLabel="Retry failed"
          description={
            <>
              Only the activities that <strong>failed</strong>, and the ones a stopped sequence never reached, go again — their turn is now.
              Anything that already ran is left alone.
              <br />
              This run only; the others keep their own history.
            </>
          }
          onConfirm={() => act('retry', () => retryWarmupRun(group.id, runId), 'Re-queued what failed in this run', 'Could not retry this run')}
        />
      ) : null}

      <ConfirmDialog
        trigger={
          <Button size="sm" variant="ghost" disabled={busy} aria-label="Remove this run">
            <TrashIcon aria-hidden />
            Remove
          </Button>
        }
        title="Remove this run?"
        destructive
        confirmLabel="Remove"
        description={
          <>
            This run’s rows are deleted and its history goes with them. The session stays, and so does every other run of it.
            <br />
            Anything still running on a phone is <strong>not</strong> cancelled by this — stop the run first if that is what you want.
          </>
        }
        onConfirm={() => act('remove', () => deleteWarmupRun(group.id, runId), 'That run was removed — the session and its other runs are untouched', 'Could not remove this run')}
      />
    </div>
  )
}

/**
 * One number, with the word that says what it counts.
 *
 * Five of these sit above the table. The set was chosen from what the owner
 * asked to see — *"success rates, waktu, elapsed, estimated"* — and then cut
 * to what the stored rows can answer HONESTLY. There is no "finishes at", for
 * instance: the rows know when an activity is due to go out, and nothing here
 * knows how long a script will take on a phone.
 */
function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string | null; tone?: string }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] tracking-wide text-faint uppercase">{label}</span>
      <span className={cn('text-[15px] font-medium tabular-nums', tone)}>{value}</span>
      {hint ? <span className="text-[11px] text-faint">{hint}</span> : null}
    </div>
  )
}

/** A bar and a count. `total` of 0 draws an empty track rather than dividing by it. */
function Progress({ done, failed, total }: { done: number; failed: number; total: number }): ReactElement {
  const pct = (n: number): string => (total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-1.5 w-full overflow-hidden rounded-pill bg-line">
        <div className="bg-ok" style={{ width: pct(done) }} />
        <div className="bg-bad" style={{ width: pct(failed) }} />
      </div>
      <span className="text-[11px] text-faint tabular-nums">
        {done + failed} of {total} answered
      </span>
    </div>
  )
}

/** The Jobs screen, with this run selected. A plugin view cannot reach `next/link`; leaving for the farm's own screen is a real navigation anyway. */
function JobLink({ jobId }: { jobId: string }): ReactElement {
  return (
    <a
      href={`/jobs?job=${encodeURIComponent(jobId)}`}
      className="rounded-small text-[11px] text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/40"
      title={`Open job ${jobId} on the Jobs screen`}
    >
      logs
    </a>
  )
}

/** One phone's phases, opened out — the detail the grouped row folds away. */
function PhaseDetail({ device, phases }: { device: DeviceRollup<WarmupRow>; phases: number }): ReactElement {
  return (
    <div className="flex flex-col gap-2.5 py-1">
      {device.phases.map((run) => (
        <div key={run.phase} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-2">
            {phases > 1 ? <span className="text-[11px] text-faint">phase {run.phase + 1}</span> : null}
            {run.platform === null ? null : <span className="text-[11px] text-dim">{platformLabel(run.platform as PlatformId)}</span>}
            {run.styleTitle === null ? null : <span className="text-[11px] text-faint">{run.styleTitle}</span>}
          </div>
          {run.steps.length === 0 ? (
            <span className="text-[12px] text-faint">{run.note ?? 'Nothing to do'}</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              {run.steps.map((step) => (
                <div key={step.activityId} className="flex flex-wrap items-baseline gap-2">
                  <span className={cn('w-14 shrink-0 text-[12px]', STEP_TONE[step.state])}>{step.state}</span>
                  <span className="text-[12px]">{step.title}</span>
                  {step.jobId === null ? null : <JobLink jobId={step.jobId} />}
                  {step.error === null ? null : <span className="text-[11px] text-bad">{step.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * One session.
 *
 * ## Why the table is one row per PHONE
 *
 * The rows are stored per phone PER PHASE, which is what the dispatcher needs
 * and not what a person needs: a three-phase session over fourteen phones drew
 * forty-two lines, three of them carrying the same phone's name with nothing
 * saying they belonged together. The owner asked for the obvious thing —
 * *"bisa di gruping lagi ngga ... biar enak per 1 devices 1 field"* — so
 * `warmup-report.ts` folds the rows by device and this table draws one line
 * each, opening to the phases on click.
 *
 * ## Why the phones given nothing are folded away
 *
 * They are the majority on any farm whose fleet is bigger than one platform's
 * labels, they all say the same sentence, and none of them is news. One
 * summary line carries the count and the reason, and opens if anyone wants the
 * names.
 */
export function WarmupDetail({ groupId, refreshKey, onBack }: { groupId: string; refreshKey: number; onBack: () => void }): ReactElement {
  const [group, setGroup] = useState<Group | null>(null)
  /** Which run is on screen. `null` means the newest, which is what somebody opening a session wants nine times out of ten. */
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [runs, setRuns] = useState<WarmupRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [showIdle, setShowIdle] = useState(false)
  /* Re-read on a timer as well as on the page's Refresh, because elapsed and "due in" are only true at the moment they were drawn. */
  const [tick, setTick] = useState(0)
  /** Bumped by an action, so its result appears without waiting for the timer. */
  const [refresh, setRefresh] = useState(0)
  /** When the last read landed, and a clock for the relative times on screen. */
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  /* A second hand for "updated 12s ago" and the elapsed counter — cheap, and never a fetch. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let live = true
    setError(null)
    Promise.all([listGroups(), listWarmupRows(groupId)])
      .then(([groups, rows]) => {
        if (!live) return
        setGroup(groups.find((g) => g.id === groupId) ?? null)
        setRuns(rows)
        setUpdatedAt(Date.now())
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [groupId, refreshKey, tick, refresh])

  const toggle = useCallback((deviceId: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(deviceId)) next.delete(deviceId)
      else next.add(deviceId)
      return next
    })
  }, [])

  /*
    Every run of this session, newest first — and the one being looked at.

    A session is a thing you start again, so the rows under it belong to
    several evenings. Showing them all in one table would add yesterday's
    failures to today's success rate, which is the single most misleading
    number this screen could print.
  */
  const history = useMemo(() => (runs === null ? [] : runsOf(runs, Math.floor(Date.now() / 1000))), [runs])
  const shown = useMemo(() => history.find((entry) => entry.runId === openRun) ?? history[0] ?? null, [history, openRun])
  const rows = shown?.rows ?? []

  /*
    Poll only while something is going to change on its own, and stop when it
    is not — see `isMoving`. The old timer ticked every ten seconds for ever,
    including on a session that finished last week.
  */
  const moving = useMemo(() => isMoving(runs ?? []), [runs])
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS)
    return () => clearInterval(timer)
  }, [moving])

  const devices = useMemo(() => rollUpByDevice(rows), [rows])
  const report = shown?.report ?? null
  const phases = useMemo(() => (rows.length === 0 ? 1 : Math.max(1, ...rows.map((row) => row.phase + 1))), [rows])
  const working = devices.filter((device) => !device.idle)
  const idle = devices.filter((device) => device.idle)

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={onBack}>
        <CaretLeftIcon aria-hidden />
        All warm-ups
      </Button>
      <span className="text-[13px] font-medium">{group?.title ?? groupId}</span>
      {phases > 1 ? <span className="text-[11px] text-faint">{phases} platforms per phone</span> : null}
      {group !== null ? <RunAgainButton group={group} onDone={() => setRefresh((n) => n + 1)} /> : null}
    </div>
  )

  if (error !== null)
    return (
      <div className="flex flex-col gap-3">
        {header}
        <ErrorState message={`Could not read this session: ${error}`} />
      </div>
    )
  if (runs === null || report === null)
    return (
      <div className="flex flex-col gap-3">
        {header}
        <LoadingRows rows={4} />
      </div>
    )

  return (
    <div className="flex flex-col gap-3">
      {header}

      {/*
        The runs of this session, and what can be done to the one on screen.
        Together rather than apart, because "which night" and "stop that night"
        are one thought — and putting the controls on the session header instead
        would leave the operator guessing which run they aimed at.
      */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RunPicker history={history} shownId={shown?.runId ?? null} newestId={history[0]?.runId ?? null} onPick={setOpenRun} />
        {group !== null && shown !== null ? <RunControls group={group} runId={shown.runId} rows={shown.rows} onDone={() => setRefresh((n) => n + 1)} /> : null}
      </div>

      <LiveLine moving={moving} updatedAt={updatedAt} now={now} />

      <Card className="grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Phones" value={String(report.working)} hint={report.idle === 0 ? null : `${report.idle} given nothing`} />
        <Stat label="Activities" value={String(report.activities)} hint={`${report.settled} answered`} />
        <Stat
          /* Null, not 0, until something has answered — see `sessionReport`. */
          label="Success"
          value={report.successRate === null ? '—' : `${Math.round(report.successRate * 100)}%`}
          hint={report.successRate === null ? 'nothing answered yet' : `${report.counts.success} good, ${report.counts.failed} failed`}
          tone={report.successRate === null ? 'text-faint' : report.successRate >= 0.8 ? 'text-ok' : report.successRate >= 0.5 ? 'text-warn' : 'text-bad'}
        />
        <Stat
          label="Elapsed"
          value={report.elapsedSec === null ? '—' : readDuration(report.elapsedSec)}
          hint={report.elapsedSec === null ? 'not started' : report.finished ? 'finished' : 'running'}
        />
        <Stat
          /* The rows know when the next activity is DUE. They do not know how long a script takes, so this is never worded as a finish time. */
          label="Last due"
          value={report.lastDueInSec === null ? '—' : report.lastDueInSec === 0 ? 'now' : `in ${readDuration(report.lastDueInSec)}`}
          hint={report.counts.pending + report.counts.queued === 0 ? 'nothing waiting' : `${report.counts.pending + report.counts.queued} waiting`}
        />
      </Card>

      {devices.length === 0 ? (
        <EmptyState title="This session has no phones" description="Nothing was planned for it — the fleet may have had no phone carrying one of its platforms." />
      ) : (
        <div className="overflow-hidden rounded-inner border border-line">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Phone</TableHead>
                <TableHead>Platforms</TableHead>
                <TableHead className="w-44">Progress</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Activities</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {working.map((device) => {
                const isOpen = open.has(device.deviceId)
                return (
                  <Fragment key={device.deviceId}>
                    <TableRow className="cursor-pointer" onClick={() => toggle(device.deviceId)}>
                      <TableCell className="text-faint">{isOpen ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}</TableCell>
                      <TableCell>
                        <div className="font-medium">{device.deviceName ?? device.deviceId}</div>
                        {device.covered.length > 1 ? (
                          <div className="text-[11px] text-faint">
                            {device.covered.length} platform{device.covered.length === 1 ? '' : 's'}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {/*
                          One chip per PHASE, tinted by how that phase went — so
                          the column answers "which platforms has this phone
                          already warmed up", which is the question the owner
                          asked it to answer. A chip per distinct platform could
                          not: two phases on one platform, or a platform still
                          waiting, would both read as done.
                        */}
                        {/*
                          A phase with NO platform is not a chip. A session
                          covering three platforms writes three phases per
                          phone, and a phone carrying two of them has a third
                          that was deliberately given nothing — drawing it as
                          "—" made the table ask a question ("what is that?")
                          whose answer is "nothing is wrong".
                        */}
                        <div className="flex flex-wrap gap-1">
                          {device.covered.length === 0 ? (
                            <span className="text-[12px] text-faint">none</span>
                          ) : (
                            device.covered.map((run) => (
                              <Badge key={run.phase} variant="outline" className={RUN_TONE[run.state] ?? ''} title={`${run.platform} — ${run.state}`}>
                                {platformLabel(run.platform as PlatformId)}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Progress done={device.counts.success} failed={device.counts.failed} total={device.activities} />
                      </TableCell>
                      <TableCell>
                        <StateBadge state={device.state} />
                      </TableCell>
                      <TableCell className="text-[12px] text-dim">
                        {device.counts.success > 0 ? <span className="text-ok">{device.counts.success} done</span> : null}
                        {device.counts.failed > 0 ? <span className="ml-2 text-bad">{device.counts.failed} failed</span> : null}
                        {device.counts.skipped > 0 ? <span className="ml-2 text-faint">{device.counts.skipped} skipped</span> : null}
                        {device.counts.pending + device.counts.queued > 0 ? <span className="ml-2 text-faint">{device.counts.pending + device.counts.queued} waiting</span> : null}
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell />
                        <TableCell colSpan={5}>
                          <PhaseDetail device={device} phases={phases} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                )
              })}

              {idle.length === 0 ? null : (
                <>
                  <TableRow className="cursor-pointer" onClick={() => setShowIdle((v) => !v)}>
                    <TableCell className="text-faint">{showIdle ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}</TableCell>
                    <TableCell colSpan={5} className="text-[12px] text-faint">
                      {idle.length} {idle.length === 1 ? 'phone was' : 'phones were'} given nothing — {idle[0]?.note ?? 'no reason recorded'}
                    </TableCell>
                  </TableRow>
                  {showIdle
                    ? idle.map((device) => (
                        <TableRow key={device.deviceId} className="hover:bg-transparent">
                          <TableCell />
                          <TableCell className="text-[12px] text-dim">{device.deviceName ?? device.deviceId}</TableCell>
                          <TableCell colSpan={4} className="text-[12px] text-faint">
                            {device.note ?? 'Nothing to do'}
                          </TableCell>
                        </TableRow>
                      ))
                    : null}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
