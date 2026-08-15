'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowDown, ArrowLeft, ArrowUp, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { RecordingStep } from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { ErrorState, LoadingRows } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAction } from '@/lib/actions'
import { coreBase } from '@/lib/ws'
import {
  deleteRecording,
  detachRecording,
  getRecording,
  patchRecording,
  publishRecording,
  type RecordingDetail,
} from '@/components/recording/recording-api'

/**
 * `/recordings/detail?slug=…` — the review panel (plan 94 §4.10, §5 step
 * 94.5). A `?slug=` query param, not a dynamic route segment — Studio is a
 * static export (`packages/device/page.tsx` set this precedent with `?id=`).
 *
 * Every edit here is LOCAL state until "Save changes" — the server holds one
 * document per slug and the whole panel works off one `hash` (CAS), so two
 * tabs editing the same recording never silently clobber each other (the
 * second Save gets `E_STALE`, surfaced as a plain toast).
 */

function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version)
  if (!m) return version
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

function stepLabel(kind: RecordingStep['kind']): string {
  return { tap: 'Tap', longPress: 'Long press', gesture: 'Gesture', swipe: 'Swipe', key: 'Key', text: 'Text' }[kind]
}

function moveStep<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir
  if (target < 0 || target >= list.length) return list
  const next = [...list]
  const item = next[index] as T
  next[index] = next[target] as T
  next[target] = item
  return next
}

function Screenshot({ blobId }: { blobId?: string }) {
  if (!blobId) return <div className="grid h-16 w-28 shrink-0 place-items-center rounded border border-dashed text-[10px] text-fg-subtle">no image</div>
  // eslint-disable-next-line @next/next/no-img-element -- a plain content-addressed blob URL, not a Next-optimisable local asset
  return <img src={`${coreBase()}/api/v1/blobs/${blobId}`} alt="screen at this step" className="h-16 w-28 shrink-0 rounded border object-cover" />
}

function StepRow({
  step,
  index,
  total,
  priorLiteral,
  onPromote,
  onDemote,
  onParameterise,
  onRevertLiteral,
  onClearLiteral,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  step: RecordingStep
  index: number
  total: number
  /** The exact text this step held before it was parameterised, IF this browser tab was the one that did it (see the page-level `priorLiteralRef` doc comment). `undefined` means genuinely not known — never guessed. */
  priorLiteral: string | undefined
  onPromote: () => void
  onDemote: () => void
  onParameterise: (name: string) => void
  /** Restores `priorLiteral` verbatim. Only ever wired up when `priorLiteral !== undefined`. */
  onRevertLiteral: () => void
  /** Honestly blanks the value so the operator can type a fresh literal — used instead of `onRevertLiteral` when there is nothing to revert TO. */
  onClearLiteral: () => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const [paramName, setParamName] = useState('')
  const target = step.kind === 'tap' || step.kind === 'longPress' ? step.target : null
  const candidate = step.kind === 'tap' || step.kind === 'longPress' ? step.candidate : undefined
  const screenshotBlobId = step.kind !== 'key' && step.kind !== 'text' ? step.screenshotBlobId : undefined
  const canPromote = Boolean(candidate) && candidate?.count === 1 && target?.kind === 'point'
  const promoteDisabledReason =
    target?.kind === 'point' && candidate && candidate.count !== 1
      ? `${candidate.count} elements match this selector — promoting would tap a different one depending on the screen`
      : undefined

  return (
    <li className="flex gap-3 rounded-lg border bg-surface p-3">
      <Screenshot blobId={screenshotBlobId} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="readout text-[11px] text-fg-subtle">
            {index + 1}/{total}
          </span>
          <span className="text-[12.5px] font-medium">{stepLabel(step.kind)}</span>
          <span className="text-[11px] text-fg-muted">gap {step.gapMs} ms</span>
        </div>

        {target && (
          <p className="truncate text-[11px] text-fg-muted">
            {target.kind === 'point' ? `point (${target.pos.x.toFixed(3)}, ${target.pos.y.toFixed(3)})` : `selector ${JSON.stringify(target.selector)}`}
          </p>
        )}

        {candidate && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-fg-muted">candidate {JSON.stringify(candidate.selector)}</span>
            <Badge variant={candidate.count === 1 ? 'secondary' : 'outline'}>{candidate.count} match{candidate.count === 1 ? '' : 'es'}</Badge>
            <span className="text-fg-subtle">anchor {candidate.anchorAgeMs} ms old, {candidate.anchorStepsSince} step(s) since</span>
          </div>
        )}
        {target?.kind === 'point' && !candidate && (step.kind === 'tap' || step.kind === 'longPress') && (
          <p className="text-[11px] text-fg-subtle">No candidate — no inspector was attached when this step landed.</p>
        )}

        {step.kind === 'text' && typeof step.value === 'string' && (
          <div className="space-y-1.5 rounded-md border border-led-warn/40 bg-led-warn/5 p-2">
            <p className="text-[11px] font-medium text-led-warn">
              Stored verbatim — this exact text is saved to the workspace and will appear in the published script&apos;s source, regardless of the farm&apos;s
              &quot;log typed text&quot; setting.
            </p>
            <p className="readout truncate text-[12px]">&quot;{step.value}&quot;</p>
            <div className="flex items-center gap-1.5">
              <Input
                value={paramName}
                onChange={(e) => setParamName(e.target.value)}
                placeholder="parameter name, e.g. caption"
                className="h-7 max-w-48 text-[11.5px]"
              />
              <Button size="sm" variant="outline" disabled={!/^[a-z][a-zA-Z0-9]*$/.test(paramName)} onClick={() => onParameterise(paramName)}>
                Parameterise
              </Button>
            </div>
          </div>
        )}
        {step.kind === 'text' && typeof step.value === 'object' && (
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <Badge variant="secondary">param: {step.value.param}</Badge>
            {priorLiteral !== undefined ? (
              <Button size="sm" variant="ghost" onClick={onRevertLiteral} title={`Restores the text this step held before it was parameterised: "${priorLiteral}"`}>
                Revert to literal
              </Button>
            ) : (
              <>
                <span className="text-[11px] text-fg-subtle">original text not kept — nothing to revert to</span>
                <Button size="sm" variant="ghost" onClick={onClearLiteral} title="Blanks the value so you can type a new literal">
                  Clear and re-type as literal
                </Button>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {(step.kind === 'tap' || step.kind === 'longPress') && target?.kind === 'point' && (
            <Button size="sm" variant="outline" disabled={!canPromote} title={promoteDisabledReason} onClick={onPromote}>
              Promote
            </Button>
          )}
          {(step.kind === 'tap' || step.kind === 'longPress') && target?.kind === 'selector' && (
            <Button size="sm" variant="ghost" onClick={onDemote}>
              Demote to point
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={index === 0} onClick={onMoveUp}>
            <ArrowUp className="size-3.5" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" disabled={index === total - 1} onClick={onMoveDown}>
            <ArrowDown className="size-3.5" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </li>
  )
}

function RecordingDetailInner() {
  const slug = useSearchParams().get('slug')
  const router = useRouter()
  const { run, isPending } = useAction()

  const [detail, setDetail] = useState<RecordingDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [steps, setSteps] = useState<RecordingStep[]>([])
  const [speed, setSpeed] = useState(1)
  const [maxGapMs, setMaxGapMs] = useState(15_000)
  const [cleanup, setCleanup] = useState<'force-stop' | 'none'>('force-stop')
  const [description, setDescription] = useState('')
  const [hash, setHash] = useState('')
  const [dirty, setDirty] = useState(false)
  const [publishVersion, setPublishVersion] = useState('')

  /**
   * `RecordingStep` (`@enkaku/protocol`) only ever stores a `text` step's value
   * as EITHER a literal string OR `{ param }` — there is no third field that
   * keeps both, on the wire or at rest, by design (plan 94 decision 4 / spec
   * §11.8: a parameterised value must not survive on disk as its own literal).
   * So the moment `onParameterise` below replaces a step's `value`, the old
   * string is gone from every place this component's state gets sent to.
   *
   * "Revert to literal" therefore restores from exactly one place: THIS
   * browser tab's own short-term memory of the edit it just made, keyed on
   * the actual step object reference so it survives the step being moved up
   * or down (`moveStep` swaps positions, not identity) without surviving a
   * page reload or a step that arrived from the server already parameterised
   * — for either of those, there is truly nothing to revert to (96.17), and
   * the UI says so instead of quietly emptying the field.
   */
  const priorLiteralRef = useRef(new WeakMap<RecordingStep, string>())

  const load = () => {
    if (!slug) return
    setError(null)
    getRecording(slug)
      .then((d) => {
        setDetail(d)
        setSteps(d.doc.steps)
        setSpeed(d.doc.speed)
        setMaxGapMs(d.doc.maxGapMs)
        setCleanup(d.doc.cleanup)
        setDescription(d.doc.description)
        setHash(d.hash)
        setDirty(false)
        setPublishVersion(bumpPatch(d.doc.version))
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(load, [slug])

  const literalUnparameterisedCount = steps.filter((s) => s.kind === 'text' && typeof s.value === 'string').length

  const updateStep = (index: number, next: RecordingStep) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? next : s)))
    setDirty(true)
  }

  const save = () =>
    run(
      'save',
      () => {
        if (!slug) throw new Error('no slug')
        return patchRecording(slug, hash, { steps, speed, maxGapMs, cleanup, description })
      },
      {
        success: 'Recording saved',
        failure: 'Could not save — reload and try again',
        onSuccess: (res) => {
          setHash(res.hash)
          setDirty(false)
        },
      },
    )

  const publish = () =>
    run(
      'publish',
      async () => {
        if (!slug) throw new Error('no slug')
        if (dirty) await patchRecording(slug, hash, { steps, speed, maxGapMs, cleanup, description }).then((res) => setHash(res.hash))
        return publishRecording(slug, publishVersion)
      },
      {
        success: 'Published',
        failure: 'Could not publish',
        onSuccess: () => {
          setDirty(false)
          load()
          toast.success(`Published ${detail?.doc.name}@${publishVersion} — it now appears in the scripts list`)
        },
      },
    )

  const detach = () =>
    run('detach', () => {
      if (!slug) throw new Error('no slug')
      return detachRecording(slug)
    }, {
      success: 'Detached — the recording no longer regenerates its compiled entry',
      failure: 'Could not detach',
      onSuccess: () => load(),
    })

  if (!slug) return <ErrorState message="No recording specified." />
  if (error) return <ErrorState message={error} onRetry={load} />
  if (!detail) return <div className="px-5 py-4"><LoadingRows rows={4} /></div>

  return (
    <>
      <PageHeader
        title={detail.doc.name}
        description={detail.doc.description || undefined}
        meta={
          detail.detached ? (
            <Badge variant="outline">detached</Badge>
          ) : detail.publishedVersion ? (
            <Badge variant="secondary">published {detail.publishedVersion}</Badge>
          ) : (
            <Badge variant="outline">not published</Badge>
          )
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/recordings">
              <ArrowLeft className="size-3.5" aria-hidden />
              Recordings
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3">
          <p className="text-[11.5px] text-fg-muted">
            Recorded on {detail.doc.recordedOn.model} at {detail.doc.recordedOn.width}×{detail.doc.recordedOn.height}. Coordinates are stored normalised
            (0..1), so this replays correctly on a device with a different screen size.
          </p>

          {literalUnparameterisedCount > 0 && (
            <p className="text-[11.5px] text-led-warn">
              {literalUnparameterisedCount} step{literalUnparameterisedCount === 1 ? '' : 's'} below store typed text verbatim — see each step for detail.
            </p>
          )}

          {detail.detached && (
            <p className="rounded-md border bg-surface-2 px-3 py-2 text-[11.5px] text-fg-muted">
              This recording was detached — its compiled entry no longer regenerates. Edit /scripts/{detail.slug}.ts directly instead.
            </p>
          )}

          <ol className="space-y-2">
            {steps.map((step, i) => (
              <StepRow
                key={i}
                step={step}
                index={i}
                total={steps.length}
                priorLiteral={step.kind === 'text' && typeof step.value === 'object' ? priorLiteralRef.current.get(step) : undefined}
                onPromote={() => {
                  if (step.kind !== 'tap' && step.kind !== 'longPress') return
                  if (step.target.kind !== 'point' || !step.candidate) return
                  updateStep(i, { ...step, target: { kind: 'selector', selector: step.candidate.selector, fallback: step.target.pos } })
                }}
                onDemote={() => {
                  if (step.kind !== 'tap' && step.kind !== 'longPress') return
                  if (step.target.kind !== 'selector') return
                  updateStep(i, { ...step, target: { kind: 'point', pos: step.target.fallback } })
                }}
                onParameterise={(name) => {
                  if (step.kind !== 'text' || typeof step.value !== 'string') return
                  const literal = step.value
                  const next = { ...step, value: { param: name } }
                  priorLiteralRef.current.set(next, literal)
                  updateStep(i, next)
                }}
                onRevertLiteral={() => {
                  if (step.kind !== 'text' || typeof step.value !== 'object') return
                  const prior = priorLiteralRef.current.get(step)
                  if (prior === undefined) return
                  priorLiteralRef.current.delete(step)
                  updateStep(i, { ...step, value: prior })
                }}
                onClearLiteral={() => {
                  if (step.kind !== 'text') return
                  updateStep(i, { ...step, value: '' })
                }}
                onDelete={() => {
                  setSteps((prev) => prev.filter((_, idx) => idx !== i))
                  setDirty(true)
                }}
                onMoveUp={() => {
                  setSteps((prev) => moveStep(prev, i, -1))
                  setDirty(true)
                }}
                onMoveDown={() => {
                  setSteps((prev) => moveStep(prev, i, 1))
                  setDirty(true)
                }}
              />
            ))}
          </ol>
          {steps.length === 0 && <p className="text-[12px] text-fg-muted">Every step has been removed.</p>}
        </div>

        <aside className="space-y-4">
          <div className="space-y-2.5 rounded-lg border bg-surface p-3">
            <p className="rack-label text-fg">Replay</p>
            <div className="space-y-1">
              <Label className="text-[11px] text-fg-muted">Speed (× recorded gaps)</Label>
              <Input
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                value={speed}
                disabled={detail.detached}
                onChange={(e) => {
                  setSpeed(Number(e.target.value))
                  setDirty(true)
                }}
                className="h-8 text-[12px]"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-fg-muted">Max gap (ms)</Label>
              <Input
                type="number"
                min="0"
                value={maxGapMs}
                disabled={detail.detached}
                onChange={(e) => {
                  setMaxGapMs(Number(e.target.value))
                  setDirty(true)
                }}
                className="h-8 text-[12px]"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-fg-muted">Cleanup on finish</Label>
              <Select
                value={cleanup}
                disabled={detail.detached}
                onValueChange={(v) => {
                  setCleanup(v as 'force-stop' | 'none')
                  setDirty(true)
                }}
              >
                <SelectTrigger className="h-8 w-full text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="force-stop">Force-stop {detail.doc.packages.join(', ') || 'recorded packages'}</SelectItem>
                  <SelectItem value="none">Leave the device as-is</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-fg-muted">Description</Label>
              <Textarea
                value={description}
                disabled={detail.detached}
                onChange={(e) => {
                  setDescription(e.target.value)
                  setDirty(true)
                }}
                className="min-h-16 text-[12px]"
              />
            </div>
            <Button size="sm" className="w-full" disabled={!dirty || detail.detached || isPending('save')} onClick={save}>
              Save changes
            </Button>
          </div>

          {!detail.detached && (
            <div className="space-y-2.5 rounded-lg border bg-surface p-3">
              <p className="rack-label text-fg">Publish</p>
              <div className="space-y-1">
                <Label className="text-[11px] text-fg-muted">Version</Label>
                <Input value={publishVersion} onChange={(e) => setPublishVersion(e.target.value)} className="h-8 text-[12px]" />
              </div>
              <Button size="sm" className="w-full" disabled={isPending('publish') || !/^\d+\.\d+\.\d+/.test(publishVersion)} onClick={publish}>
                Publish as script
              </Button>
              <p className="text-[10.5px] leading-relaxed text-fg-subtle">
                Publishes an ordinary script row — it appears in the scripts list, resolves as {detail.doc.name}@latest, and runs from the run dialog like
                any other script.
              </p>
            </div>
          )}

          <div className="space-y-2.5 rounded-lg border bg-surface p-3">
            <p className="rack-label text-fg">Ownership</p>
            {!detail.detached ? (
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="outline" className="w-full" disabled={isPending('detach')}>
                    Detach
                  </Button>
                }
                title={`Detach ${detail.doc.name}?`}
                description="Writes a plain script file to /scripts that you own from that point on. The recording stops regenerating it — this cannot be undone."
                confirmLabel="Detach"
                onConfirm={detach}
              />
            ) : (
              <p className="text-[11px] text-fg-muted">Already detached — owned as an ordinary script file.</p>
            )}
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" className="w-full">
                  Delete recording
                </Button>
              }
              title={`Delete ${detail.doc.name}?`}
              description="Removes the recording document and its compiled entry from the workspace. Already-published script versions are not affected."
              onConfirm={() =>
                run('delete', () => deleteRecording(slug), {
                  success: 'Deleted',
                  failure: 'Could not delete',
                  onSuccess: () => router.push('/recordings'),
                })
              }
            />
          </div>
        </aside>
      </div>
    </>
  )
}

export default function RecordingDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      }
    >
      <RecordingDetailInner />
    </Suspense>
  )
}
