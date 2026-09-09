'use client'

import { useEffect, useMemo, useState } from 'react'
import { ScheduleResponseSchema, type DeviceInfo, type GroupInfo, type WorkflowInfo } from '@enkaku/protocol'
import {
  api,
  useAction,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@enkaku/ui'
import { fetchAllPages, fetchDevices, listWorkflows } from '@/lib/api'
import { useLabels } from '@/lib/labels'
import { GroupOrDevicesField, type GroupOrDevicesValue } from './GroupOrDevicesField'

/**
 * Creates a whole rotation in one action (plan 314 §10.12, §7.7).
 *
 * ## Why this exists rather than "make three schedules"
 *
 * Three sessions a day IS three schedule rows, and that is the right shape —
 * each is visible, disableable and separately targetable. But the obvious way
 * a person makes three rows is to build one and duplicate it twice, and if
 * the parameter that distinguishes them is a number they must remember to
 * change, the copies all carry the first one's value. The farm then runs the
 * first branch three times a day, forever, with three green batches and
 * nothing red to notice — the client's own stated fear, reintroduced by a
 * form being too generic.
 *
 * So the rotation is created as a unit, and the slot is filled in by the
 * product rather than by memory: session *n* gets slot *n*. What the operator
 * chooses is the workflow, the devices, and the times.
 *
 * The rows it makes are ordinary schedules with nothing special about them —
 * this is a starting point, not a new kind of object.
 */
export function RotationDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const { run, isPending } = useAction()
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  const [workflowName, setWorkflowName] = useState('')
  const [slotParam, setSlotParam] = useState('')
  const [times, setTimes] = useState<string[]>(['08:00', '13:00', '19:00'])
  const [timezone, setTimezone] = useState('Asia/Jakarta')
  const [target, setTarget] = useState<GroupOrDevicesValue>({ mode: 'group', groupId: null, deviceIds: [], labelIds: [] })
  const [windowMin, setWindowMin] = useState(0)
  /* Sub-groups: how many phones share one rung of the start ladder, and how far apart the rungs are. */
  const [waveSize, setWaveSize] = useState(1)
  const [waveGapMin, setWaveGapMin] = useState(0)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const { labels } = useLabels()

  useEffect(() => {
    if (!open) return
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    void listWorkflows()
      .then(setWorkflows)
      .catch(() => setWorkflows([]))
    void fetchDevices()
      .then(setDevices)
      .catch(() => setDevices([]))
    void fetchAllPages<GroupInfo>('/api/groups')
      .then(setGroups)
      .catch(() => setGroups([]))
  }, [open])

  const chosen = workflows.find((w) => w.name === workflowName) ?? null

  /**
   * A rotation turns on ONE number, so only whole-number parameters qualify.
   * Offering a string here would let an operator build three schedules that
   * differ in a field the workflow never rotates on — a duplicate wearing a
   * disguise.
   */
  const slotCandidates = useMemo(() => (chosen?.doc.params ?? []).filter((p) => p.type === 'integer' || p.type === 'number'), [chosen])

  useEffect(() => {
    // An early `return setSlotParam('')` would hand React a value where it
    // looks for a cleanup function. It happens to be `undefined` and works —
    // which is exactly why it is worth not writing.
    if (slotCandidates.length === 0) {
      setSlotParam('')
      return
    }
    const preferred = slotCandidates.find((p) => p.name === 'slot') ?? slotCandidates[0]
    setSlotParam(preferred?.name ?? '')
  }, [slotCandidates])

  const validTimes = times.every((t) => /^\d{1,2}:\d{2}$/.test(t.trim()))
  const canSubmit =
    !!workflowName &&
    !!slotParam &&
    validTimes &&
    times.length >= 2 &&
    (target.mode === 'group' ? !!target.groupId : target.mode === 'labels' ? target.labelIds.length > 0 : target.deviceIds.length > 0)

  const cronFor = (hhmm: string): string => {
    const [h, m] = hhmm.trim().split(':')
    return `${Number.parseInt(m ?? '0', 10)} ${Number.parseInt(h ?? '0', 10)} * * *`
  }

  const create = () =>
    run('create-rotation', async () => {
      const deviceTarget =
        target.mode === 'group' ? { groupId: target.groupId } : target.mode === 'labels' ? { labelIds: target.labelIds } : { deviceIds: target.deviceIds }
      // Sequentially, not in parallel, so a failure stops at a known point
      // rather than leaving a random subset. It can still leave a PARTIAL
      // rotation — sessions 0 and 1 created, 2 refused — so the error says
      // how many landed. A rotation missing its last session is a real state
      // an operator has to repair, and "could not create the rotation" alone
      // would send them looking for nothing.
      let created = 0
      for (const [slot, hhmm] of times.entries()) {
        try {
          await api('/api/schedules', ScheduleResponseSchema, {
            method: 'POST',
            json: {
              name: `${workflowName} · session ${slot + 1} (${hhmm.trim()})`,
              enabled: true,
              cron: cronFor(hhmm),
              timezone,
              workTarget: { kind: 'workflow', workflowName, params: { [slotParam]: slot } },
              target: deviceTarget,
              deviceDelayMs: [0, windowMin * 60_000],
              waveSize,
              deviceIntervalMs: waveGapMin * 60_000,
            },
          })
          created += 1
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          throw new Error(
            created === 0
              ? `No schedule was created: ${detail}`
              : `Created ${created} of ${times.length} sessions, then session ${slot + 1} failed: ${detail}. The rotation is incomplete — the sessions that exist will run, but the platforms of the missing ones will not be covered.`,
          )
        }
      }
    }, {
      success: `${times.length} schedules created`,
      failure: 'Could not create the rotation',
      onSuccess: () => {
        onCreated()
        onOpenChange(false)
      },
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New rotation</DialogTitle>
          <DialogDescription>
            One schedule per session, each carrying its own slot number. Every device visits every branch across the sessions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-row font-normal">Workflow</Label>
            <Select value={workflowName} onValueChange={setWorkflowName}>
              <SelectTrigger>
                <SelectValue placeholder={workflows.length === 0 ? 'No workflows yet' : 'Pick a workflow'} />
              </SelectTrigger>
              <SelectContent>
                {workflows.map((w) => (
                  <SelectItem key={w.name} value={w.name}>
                    {w.doc.title || w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {chosen && slotCandidates.length === 0 && (
            <p className="rounded-input border border-warn/30 bg-warn-soft px-2.5 py-2 text-meta text-warn">
              {chosen.doc.title || chosen.name} declares no whole-number parameter, so there is nothing for the sessions to differ on. Add one (a
              &ldquo;slot&rdquo;) to the workflow and branch on it — for example <code className="font-mono">($device.number + $params.slot) % 3</code>.
            </p>
          )}

          {slotCandidates.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-row font-normal">Rotate on</Label>
              <Select value={slotParam} onValueChange={setSlotParam}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {slotCandidates.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.title || p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <GroupOrDevicesField value={target} onChange={setTarget} devices={devices} groups={groups} labels={labels} />

          <div className="space-y-1.5">
            <Label className="text-row font-normal">Sessions</Label>
            <div className="space-y-2">
              {times.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-meta text-faint">slot {i}</span>
                  <Input
                    value={t}
                    aria-label={`Session ${i + 1} time`}
                    onChange={(e) => setTimes(times.map((v, j) => (j === i ? e.target.value : v)))}
                    mono
                    className="h-8 w-28 text-body"
                  />
                  {times.length > 2 && (
                    <button type="button" className="text-meta text-faint hover:text-danger" onClick={() => setTimes(times.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="text-meta text-accent hover:underline" onClick={() => setTimes([...times, '22:00'])}>
              Add a session
            </button>
            {!validTimes && <p className="text-meta text-danger">Each session needs a time as HH:MM.</p>}
          </div>

          <div className="space-y-1.5">
            <Label className="text-row font-normal">Timezone</Label>
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} mono className="h-8 text-body" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-row font-normal">Sub-group size (devices)</Label>
              <Input
                type="number"
                min={1}
                value={waveSize}
                onChange={(e) => setWaveSize(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                mono
                className="h-8 w-28 text-body"
              />
              <p className="text-caption text-faint">
                How many phones go out together. 1 sends the whole target in one wave.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-row font-normal">Wait between sub-groups (min)</Label>
              <Input
                type="number"
                min={0}
                value={waveGapMin}
                onChange={(e) => setWaveGapMin(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                mono
                className="h-8 w-28 text-body"
              />
              <p className="text-caption text-faint">
                Sub-group 2 is offered this long after sub-group 1 was — a wait, not a wait-for-finish. Use the schedule's
                concurrency to cap how many actually run at once.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-row font-normal">Spread each session's start across (min)</Label>
            <Input
              type="number"
              min={0}
              value={windowMin}
              onChange={(e) => setWindowMin(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
              mono
              className="h-8 w-28 text-body"
            />
            <p className="text-caption text-faint">Every device draws its own start time inside this window. 0 starts the whole target together.</p>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit || isPending('create-rotation')} onClick={() => void create()}>
            Create {times.length} schedules
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
