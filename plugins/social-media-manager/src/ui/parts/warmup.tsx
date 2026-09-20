import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  Badge,
  Button,
  CaretLeftIcon,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingRows,
  PlusIcon,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  relativeTime,
  z,
} from '@enkaku/ui'
import { PLATFORM_IDS, type PlatformId } from '../../platforms'
import { listDevices, listGroups, listWarmupRuns, pickHost, platformLabel, runMember, type Device, type Group, type WarmupRun, type WarmupStep } from '../shared'

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

  useEffect(() => {
    let live = true
    setError(null)
    listGroups()
      .then((all) => {
        if (live) setGroups(all.filter((group) => group.kind === 'warmup'))
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [refreshKey])

  if (error !== null) return <ErrorState message={`Could not read the warm-up sessions: ${error}`} />
  if (groups === null) return <LoadingRows rows={3} />
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No warm-up sessions yet"
        description="A warm-up gives each phone one platform it carries and a few activities on it, spread out so the fleet does not move in lockstep."
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Session</TableHead>
          <TableHead>Platforms</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <TableRow key={group.id} className="cursor-pointer" onClick={() => onOpen(group.id)}>
            <TableCell>
              <div className="font-medium">{group.title}</div>
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/** The numbers an operator tunes, with the defaults the rotation shipped. */
interface Draft {
  title: string
  platforms: PlatformId[]
  label: string
  keywords: string
  amount: number
  gapMinSec: number
  gapMaxSec: number
  startJitterSec: number
  slot: number
  phases: number
  likeChance: number
  keywordBoost: number
  sequenceMode: 'jobs' | 'workflow'
}

const DEFAULT_DRAFT: Draft = {
  title: '',
  platforms: [...PLATFORM_IDS],
  label: '',
  keywords: 'trading, forex, gold, xau, scalping, belajar trading, saham, crypto, investasi',
  amount: 1,
  gapMinSec: 8,
  gapMaxSec: 20,
  startJitterSec: 120,
  slot: 0,
  phases: 1,
  likeChance: 0.1,
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const host = useMemo(() => pickHost(fleet), [fleet])

  useEffect(() => {
    let live = true
    listDevices()
      .then((all) => {
        if (live) setFleet(all)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

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
    platform it carries a label for. Shown before Create because "eighty phones"
    and "eighty phones that can actually do this" are different numbers, and the
    operator should meet the difference here rather than in a session where a
    third of the rows say "no label".
  */
  const reach = useMemo(() => {
    const wanted = draft.label.trim().toLowerCase()
    const chosen = fleet.filter((device) => wanted === '' || device.labels.some((l) => l.name.trim().toLowerCase() === wanted))
    const able = chosen.filter((device) => draft.platforms.some((id) => device.labels.some((l) => l.name.trim().toLowerCase() === id)))
    return { chosen: chosen.length, able: able.length }
  }, [fleet, draft.label, draft.platforms])

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
          label: draft.label.trim(),
          keywords,
          amount: draft.amount,
          gapMinSec: draft.gapMinSec,
          gapMaxSec: draft.gapMaxSec,
          startJitterSec: draft.startJitterSec,
          slot: draft.slot,
          phases: draft.phases,
          likeChance: draft.likeChance,
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
  }, [draft, keywords, host, onCreated])

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3 p-3">
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
          <span className="text-[11px] text-faint">A phone is only sent to a platform it carries a label for.</span>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-dim">Only phones labelled</span>
          <Input value={draft.label} placeholder="leave empty for the whole fleet" onChange={(e) => set('label', (e.target as HTMLInputElement).value)} />
          <span className="text-[11px] text-faint">
            {reach.chosen} phone{reach.chosen === 1 ? '' : 's'} chosen, {reach.able} of them carry one of these platforms.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-dim">Keywords</span>
          <Input value={draft.keywords} onChange={(e) => set('keywords', (e.target as HTMLInputElement).value)} />
          <span className="text-[11px] text-faint">Comma separated, up to ten. {keywords.length} in use.</span>
        </label>
      </Card>

      <Card className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">
        <NumberField label="Activity amount" hint="0.5 short, 2 long" value={draft.amount} onChange={(n) => set('amount', n)} step={0.1} min={0.2} max={3} />
        <NumberField label="Phases" hint="3 covers every platform" value={draft.phases} onChange={(n) => set('phases', n)} min={1} max={3} />
        <NumberField label="Session slot" hint="0 for the day's first" value={draft.slot} onChange={(n) => set('slot', n)} min={0} max={5} />
        <NumberField label="Gap min (s)" value={draft.gapMinSec} onChange={(n) => set('gapMinSec', n)} min={0} max={3600} />
        <NumberField label="Gap max (s)" value={draft.gapMaxSec} onChange={(n) => set('gapMaxSec', n)} min={0} max={3600} />
        <NumberField label="Start jitter (s)" hint="so the fleet does not start at once" value={draft.startJitterSec} onChange={(n) => set('startJitterSec', n)} min={0} max={1800} />
        <NumberField label="Like chance" hint="0 never likes" value={draft.likeChance} onChange={(n) => set('likeChance', n)} step={0.05} min={0} max={1} />
        <NumberField label="Keyword boost" value={draft.keywordBoost} onChange={(n) => set('keywordBoost', n)} step={0.5} min={1} max={10} />
      </Card>

      <Card className="flex flex-col gap-1 p-3">
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
      </Card>

      {error === null ? null : <ErrorState message={`Could not create the session: ${error}`} />}

      <div className="flex items-center gap-2">
        <Button onClick={() => void create()} disabled={busy || draft.platforms.length === 0 || keywords.length === 0}>
          {busy ? <Spinner className="size-3.5" /> : <PlusIcon aria-hidden />}
          Create warm-up
        </Button>
        <span className="text-[12px] text-faint">Each phone starts at its own moment; nothing goes out all at once.</span>
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

export function WarmupDetail({ groupId, refreshKey, onBack }: { groupId: string; refreshKey: number; onBack: () => void }): ReactElement {
  const [group, setGroup] = useState<Group | null>(null)
  const [runs, setRuns] = useState<WarmupRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setError(null)
    Promise.all([listGroups(), listWarmupRuns(groupId)])
      .then(([groups, rows]) => {
        if (!live) return
        setGroup(groups.find((g) => g.id === groupId) ?? null)
        setRuns(rows)
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [groupId, refreshKey])

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={onBack}>
        <CaretLeftIcon aria-hidden />
        All warm-ups
      </Button>
      <span className="text-[12px] text-dim">{group?.title ?? groupId}</span>
      {group?.summary === null || group?.summary === undefined ? null : <span className="text-[12px] text-faint">{group.summary}</span>}
    </div>
  )

  if (error !== null)
    return (
      <div className="flex flex-col gap-3">
        {header}
        <ErrorState message={`Could not read this session: ${error}`} />
      </div>
    )
  if (runs === null)
    return (
      <div className="flex flex-col gap-3">
        {header}
        <LoadingRows rows={4} />
      </div>
    )

  return (
    <div className="flex flex-col gap-3">
      {header}
      {runs.length === 0 ? (
        <EmptyState title="This session has no phones" description="Nothing was planned for it — the fleet may have had no phone carrying one of its platforms." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Phone</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Style</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Activities</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={`${run.phase}:${run.deviceId}`}>
                <TableCell>
                  <div className="font-medium">{run.deviceName ?? run.deviceId}</div>
                  {runs.some((other) => other.phase !== run.phase) ? <div className="text-[11px] text-faint">phase {run.phase + 1}</div> : null}
                </TableCell>
                <TableCell>{run.platform === null ? <span className="text-[12px] text-faint">—</span> : <Badge variant="outline">{platformLabel(run.platform as PlatformId)}</Badge>}</TableCell>
                <TableCell className="text-[12px] text-dim">{run.styleTitle ?? '—'}</TableCell>
                <TableCell>
                  <StateBadge state={run.state} />
                </TableCell>
                <TableCell>{run.steps.length === 0 ? <span className="text-[12px] text-faint">{run.note ?? 'Nothing to do'}</span> : <StepList steps={run.steps} />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
