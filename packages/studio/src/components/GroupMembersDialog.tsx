'use client'

import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import type { ActionResult, DeviceInfo } from '@enkaku/protocol'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DeviceName,
  Input,
  formatDeviceName,
  matchesDeviceQuery,
  useAction,
} from '@enkaku/ui'
import { DevicePicker } from '@/components/DevicePicker'
import { DeviceStatusBadge } from '@/components/StatusBadge'
import { runAction } from '@/lib/actions'
import { fetchAllPages } from '@/lib/api'

interface PendingMove {
  ids: string[]
  fromNames: string[]
}

/**
 * `set-group` settles synchronously (`actions/run.ts`'s own dispatch, plan
 * 207 §4.2) — every result is already terminal by the time `runAction`
 * resolves, never `accepted`. This dialog used to report one flat success/
 * failure for the whole batch (a single `POST`); this keeps that shape
 * rather than adopting `ActionResults`' per-device list, which is more than
 * an add/remove-from-a-group action needs.
 */
function assertAllDone(results: ActionResult[]): void {
  const failed = results.filter((r) => r.status !== 'done')
  if (failed.length === 0) return
  throw new Error(failed[0]?.message ?? `${failed.length} device${failed.length === 1 ? '' : 's'} could not be updated`)
}

/**
 * A group's members panel (plan 22.0 §4.5, renamed by plan 207 — MVP 15
 * §0.1 item 3): add and remove devices. Adding a device that already
 * belongs to another group warns "this will move it out of X" before
 * confirming — a move is never a surprise, since setting `devices.group_id`
 * necessarily clears the previous value. Membership is the `set-group`
 * actions verb (`POST /api/actions/set-group`), never a route of its own —
 * `GroupMembersDialog` is the one caller both directions go through.
 */
export function GroupMembersDialog({
  group,
  allDevices,
  onClose,
  onChanged,
}: {
  group: { id: string; name: string } | null
  allDevices: DeviceInfo[]
  onClose: () => void
  onChanged: () => void
}) {
  const [members, setMembers] = useState<DeviceInfo[] | null>(null)
  /**
   * Plan 124 §4.5, step 124.3 — the left pane's own filter.
   *
   * The asymmetry this fixes was the bug: the right-hand "add devices" pane
   * has been a `DevicePicker` since plan 22.0, so it has always had a search
   * box AND the device number, while the left-hand "current members" pane
   * rendered every device in the group unfiltered. On a group of forty
   * phones that made removing ONE of them a scroll hunt through repeated
   * model names — the exact operation this dialog exists for.
   *
   * Client-side over the already-loaded members (plan 124 §2's non-goal:
   * no server-side keyset search anywhere in this plan), matching on number,
   * label, stableId and tag through the one shared predicate.
   */
  const [memberQuery, setMemberQuery] = useState('')
  const [adding, setAdding] = useState<string[]>([])
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const { run, isPending } = useAction()

  const open = group !== null

  const load = (id: string) => {
    void fetchAllPages<DeviceInfo>(`/api/groups/${id}/devices`)
      .then(setMembers)
      .catch(() => setMembers([]))
  }

  useEffect(() => {
    setAdding([])
    setMembers(null)
    setMemberQuery('')
    setPendingMove(null)
    if (group) load(group.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.id])

  if (!open || !group) return null
  const activeGroup = group

  const memberIds = new Set((members ?? []).map((d) => d.id))
  const candidates = allDevices.filter((d) => !memberIds.has(d.id))

  // A plain expression, not `useMemo` — the early return two lines above means
  // any hook here would be conditional, and filtering a group's members (tens,
  // not thousands, and already in memory) costs nothing per render.
  const visibleMembers = (members ?? []).filter((d) => matchesDeviceQuery(d, memberQuery))

  const doAssign = (ids: string[]) =>
    run(
      'assign',
      async () => {
        const response = await runAction('set-group', { deviceIds: ids }, { groupId: activeGroup.id })
        assertAllDone(response.results)
      },
      {
        success: `${ids.length} device${ids.length === 1 ? '' : 's'} added to ${activeGroup.name}`,
        failure: 'Could not add those devices',
        onSuccess: () => {
          setAdding([])
          load(activeGroup.id)
          onChanged()
        },
      },
    )

  const addSelected = () => {
    if (adding.length === 0) return
    const movers = adding
      .map((id) => allDevices.find((d) => d.id === id))
      .filter((d): d is DeviceInfo & { group: { id: string; name: string } } => Boolean(d?.group) && d!.group!.id !== activeGroup.id)
    if (movers.length > 0) {
      setPendingMove({ ids: adding, fromNames: [...new Set(movers.map((d) => d.group.name))] })
      return
    }
    void doAssign(adding)
  }

  const remove = (device: DeviceInfo) =>
    run(
      'remove-' + device.id,
      async () => {
        const response = await runAction('set-group', { deviceIds: [device.id] }, { groupId: null })
        assertAllDone(response.results)
      },
      {
        success: `${formatDeviceName(device.number, device.label)} removed from ${activeGroup.name}`,
        failure: 'Could not remove that device',
        onSuccess: () => {
          load(activeGroup.id)
          onChanged()
        },
      },
    )

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{activeGroup.name} — members</DialogTitle>
            <DialogDescription>Add and remove devices. A device belongs to at most one group at a time.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="rack-label">current members</h3>
                {/* The live count, next to the heading rather than under the
                    box: plan 124 §4.5 asks every filtered device list for one,
                    and it is what stops a query that matches nothing from
                    reading as "this group is empty". Shown only while a
                    query is active — `N of M` over an unfiltered list is
                    noise, and `M` alone is already implied by the rows. */}
                {memberQuery.trim() && members !== null && (
                  <span className="readout text-[11px] text-fg-subtle">{`${visibleMembers.length} of ${members.length}`}</span>
                )}
              </div>
              {/* Plan 124 §4.5 — the same search-input shape `DevicePicker`
                  uses on the OTHER side of this dialog (a `Search` icon
                  absolutely positioned inside a `relative` wrapper, `pl-8` on
                  the input, an explicit `aria-label` because the placeholder
                  is not a label). Rendered only once there is more than one
                  member: §3.3's threshold rule works both ways, and a filter
                  above a one-row list is pure noise. */}
              {members !== null && members.length > 1 && (
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
                  <Input
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder="Search number, label, stable id, or tag…"
                    aria-label="Search current members"
                    className="h-8 pl-8 text-[12.5px]"
                  />
                </div>
              )}
              {members === null ? (
                <p className="px-2 py-3 text-center text-[12px] text-fg-muted">Loading…</p>
              ) : members.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[12px] text-fg-muted">
                  No devices yet — add some from the right.
                </p>
              ) : visibleMembers.length === 0 ? (
                // Distinct from the empty-group copy above, deliberately: a
                // filter that hides everything must never be worded as
                // "there is nothing here", or the operator's next move is to
                // add a device that is already in the group.
                <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[12px] text-fg-muted">
                  No member matches “{memberQuery.trim()}”.
                </p>
              ) : (
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1">
                  {visibleMembers.map((d) => (
                    <div key={d.id} className="flex items-center justify-between gap-2 rounded-md px-2.5 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {/* Plan 124 §4.4 — `<DeviceName>` (not
                              `formatDeviceName`) so the number is a dimmed
                              span beside the label, matching how the
                              `DevicePicker` rows on the right of this same
                              dialog have always drawn it. */}
                          <DeviceName number={d.number} label={d.label} className="text-[13px] font-medium" />
                          <DeviceStatusBadge status={d.status} />
                        </div>
                        <span className="readout text-[11px] text-fg-subtle">{d.stableId}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 shrink-0 text-[11.5px]"
                        disabled={isPending('remove-' + d.id)}
                        onClick={() => void remove(d)}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <h3 className="rack-label">add devices</h3>
              <DevicePicker devices={candidates} value={adding} onChange={setAdding} multiple />
              <Button size="sm" className="w-full" disabled={adding.length === 0 || isPending('assign')} onClick={addSelected}>
                {isPending('assign')
                  ? 'Adding…'
                  : adding.length === 0
                    ? 'Add devices'
                    : `Add ${adding.length} device${adding.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </div>

          <div className="flex justify-end border-t pt-3">
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingMove !== null} onOpenChange={(v) => !v && setPendingMove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move {pendingMove?.ids.length ?? 0} device{(pendingMove?.ids.length ?? 0) === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-[13px] leading-relaxed text-fg-muted">
                This will move {(pendingMove?.ids.length ?? 0) === 1 ? 'it' : 'them'} out of{' '}
                {pendingMove?.fromNames.join(', ')} and into {activeGroup.name}.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                const ids = pendingMove?.ids ?? []
                setPendingMove(null)
                void doAssign(ids)
              }}
            >
              Move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
