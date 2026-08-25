'use client'

import { useState } from 'react'
import {
  PluginDataCountResponseSchema,
  PluginResetResponseSchema,
  PluginResponseSchema,
  type PluginDataCountResponse,
  type PluginResetItem,
  type PluginResetResponse,
  type PluginServiceResetData,
} from '@enkaku/protocol'
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  api,
  useAction,
} from '@enkaku/ui'
import type { PluginListRow } from '@/app/plugins/plugin-list'

/**
 * **Reset data** — the operator action that deletes everything a plugin stored
 * and, first, gives the plugin one run to undo what it did to the outside
 * world.
 *
 * ## Two dialogs, and both are load-bearing
 *
 * The confirm is treated with the weight `Forget device` gets, because it is
 * the same kind of act: irreversible, no undo, and the thing it destroys is
 * frequently the only record of something happening on real hardware. It names
 * the plugin, states the entry count in both scopes, and — when the plugin
 * declares a cleanup handler — repeats **the plugin's own sentence** about what
 * that handler will touch, so the operator learns "this will un-route your
 * phones" before pressing, not afterwards.
 *
 * The RESULT is a dialog and not a toast, and that is the half a reset most
 * needs. A toast is a place to say "done"; this action's most important outcome
 * is a list of devices, ordered failures-first, that an operator has to read and
 * act on. Burying "three phones are still carrying routes" in a green
 * three-second notification would be the precise dishonesty this feature exists
 * to prevent — so `blocked` and `reset-with-debts` open a dialog that stays
 * open, and only a clean `reset` with nothing to report settles for a toast.
 */

/** How each outcome is coloured and worded in the result list. Failures read as failures; a debt never reads as a success. */
const OUTCOME: Record<PluginResetItem['outcome'], { label: string; tone: string }> = {
  failed: { label: 'not done', tone: 'text-led-danger' },
  pending: { label: 'owed', tone: 'text-led-warn' },
  cleared: { label: 'undone', tone: 'text-fg-muted' },
  unchanged: { label: 'left alone', tone: 'text-fg-subtle' },
}

export function ResetPluginAction({
  selected,
  onChanged,
  dense = true,
}: {
  /** The version whose row/page this sits on. Reset always acts on the plugin's ACTIVE version, whichever row it was pressed from — see below. */
  selected: PluginListRow
  onChanged: () => void
  dense?: boolean
}) {
  const p = selected
  const { run, isPending } = useAction()
  const btn = dense ? 'h-7 text-[12px]' : undefined
  const [open, setOpen] = useState(false)
  const [dataCount, setDataCount] = useState<PluginDataCountResponse | null>(null)
  const [countState, setCountState] = useState<'loading' | 'known' | 'unavailable'>('loading')
  const [result, setResult] = useState<PluginResetResponse | null>(null)

  /**
   * The plugin's own account of what its cleanup handler will do, straight off
   * the manifest an operator consented to at install. `null` means the plugin
   * declares no handler — which is a real and complete answer, not a gap: it has
   * nothing to undo, so a reset is a plain deletion.
   *
   * **Read when the dialog opens, not off the row** (plan 126 §3.2). It used to
   * come from `selected.manifest.service.resetData`, which meant every version
   * of every plugin on the Plugins tab carried a whole service declaration — and
   * the surface and the member schemas beside it — so that a button rendered on
   * at most one of those rows could describe itself if pressed. The declaration
   * now travels with the one version an operator opened, exactly as the entry
   * count beside it does.
   *
   * Three states and not a nullable value, because the loading one must not be
   * spelled the same as "declares no handler": that sentence promises nothing
   * outside this farm's database will be touched, and saying it while the answer
   * is still in flight would be a false promise at the moment it matters most.
   */
  const [handler, setHandler] = useState<{ state: 'loading' | 'unavailable' } | { state: 'known'; resetData: PluginServiceResetData | null }>({
    state: 'loading',
  })
  const reset = handler.state === 'known' ? handler.resetData : null
  const borrowed = reset?.permissions ?? []

  const openConfirm = () => {
    setOpen(true)
    setDataCount(null)
    setCountState('loading')
    setHandler({ state: 'loading' })
    // Optional by construction, exactly as the Remove dialog's own count is: an
    // older core answers 404 and the dialog still renders, saying plainly that
    // the number could not be read rather than hiding the action behind it.
    api(`/api/plugins/${encodeURIComponent(p.name)}/data/count`, PluginDataCountResponseSchema)
      .then((c) => {
        setDataCount(c)
        setCountState('known')
      })
      .catch(() => setCountState('unavailable'))
    // `p.version` IS the active version here: this button renders only on an
    // `active` row (`PluginActions`), which is the same row `POST /:name/reset`
    // reads the handler off server-side. Asking for any other version would
    // describe a manifest the reset will not run.
    api(`/api/plugins/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}`, PluginResponseSchema)
      .then((r) => setHandler({ state: 'known', resetData: r.plugin.manifest?.service?.resetData ?? null }))
      .catch(() => setHandler({ state: 'unavailable' }))
  }

  const reset_ = () =>
    run('reset-' + p.name, () => api(`/api/plugins/${encodeURIComponent(p.name)}/reset`, PluginResetResponseSchema, { method: 'POST' }), {
      failure: 'Could not reset this plugin',
      onSuccess: (r) => {
        /**
         * **The screen says which of the three happened, and never softens the
         * middle one.** A pass that recorded debts deleted the data AND left
         * phones carrying routes until they are next admitted; calling that
         * "Reset ✓" would be true about the database and false about the farm.
         *
         * Only a clean pass with nothing to report closes quietly. Anything
         * with an item in it opens the result dialog, because a per-device list
         * is not a thing a toast can hold.
         */
        if (r.status === 'blocked' || r.status === 'reset-with-debts' || r.handler.items.length > 0) setResult(r)
        onChanged()
      },
    })

  const counted =
    countState === 'known' && dataCount
      ? `${dataCount.global + dataCount.device} stored ${dataCount.global + dataCount.device === 1 ? 'entry' : 'entries'} (${dataCount.global} farm-wide, ${dataCount.device} across your devices)`
      : countState === 'loading'
        ? 'its stored data — counting it now…'
        : 'its stored data (this farm could not report how many entries there are)'

  return (
    <>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setOpen(false)
        }}
        trigger={
          <Button size="sm" variant="ghost" className={btn} disabled={isPending('reset-' + p.name)} onClick={openConfirm}>
            Reset data
          </Button>
        }
        title={`Reset ${p.name}'s data?`}
        description={
          <>
            <p>
              This deletes {counted} under the <span className="readout">{p.name}</span> namespace — farm-wide and on every device.{' '}
              <span className="font-medium text-fg">There is no undo.</span> Every version of {p.name} shares that one namespace, so this
              deletes what the other versions wrote too. The plugin itself stays installed and active.
            </p>
            {reset ? (
              <div className="mt-2.5 space-y-2 rounded border border-line bg-surface-2 px-3 py-2 text-[12.5px]">
                <p className="text-fg">
                  <span className="font-medium">{p.name} cleans up first.</span> {reset.description ?? 'It declares a cleanup handler and no description of what it does.'}
                </p>
                {borrowed.length > 0 && (
                  <p className="text-fg-muted">
                    For this one pass it may use{' '}
                    {borrowed.map((perm, i) => (
                      <span key={perm}>
                        {i > 0 ? ', ' : ''}
                        <span className="readout">{perm}</span>
                      </span>
                    ))}
                    {borrowed.length === 1 ? ', which it' : ', which it'} cannot use at any other time.
                  </p>
                )}
                <p className="text-fg-muted">
                  If any part of that cleanup fails, <span className="font-medium text-fg">nothing is deleted</span> — the data is the only
                  record of what is still out there, and you can fix the cause and reset again.
                </p>
              </div>
            ) : handler.state === 'loading' ? (
              <p className="mt-2.5 text-[12.5px] text-fg-subtle">Reading what {p.name} cleans up first…</p>
            ) : handler.state === 'unavailable' ? (
              /*
                The honest third state. "Declares no cleanup handler" is a
                promise that nothing outside the database is touched, and this
                farm could not check it — so it is not said. The action stays
                available, exactly as it does when the entry count cannot be
                read: what the reset actually runs is decided server-side off
                the active row's own manifest, and this dialog only describes it.
              */
              <p className="mt-2.5 text-[12.5px] text-fg-subtle">
                This farm could not read whether {p.name} declares a cleanup handler, so this dialog cannot say what it will undo first. The
                reset itself still runs whatever the active version declares.
              </p>
            ) : (
              <p className="mt-2.5 text-[12.5px] text-fg-subtle">
                {p.name} declares no cleanup handler, so nothing outside this farm&apos;s database is touched — there is nothing for it to
                undo.
              </p>
            )}
          </>
        }
        confirmLabel="Reset data"
        onConfirm={reset_}
      />

      <ResetResultDialog result={result} onClose={() => setResult(null)} />
    </>
  )
}

/**
 * What actually happened, per device, failures first.
 *
 * The order comes from the SERVER (`api/plugins.ts` sorts before answering), so
 * a CLI, a log and this list agree — and so a reset over forty devices where two
 * failed does not put those two on line thirty-eight.
 */
export function ResetResultDialog({ result, onClose }: { result: PluginResetResponse | null; onClose: () => void }) {
  if (!result) return null
  const blocked = result.status === 'blocked'
  const debts = result.status === 'reset-with-debts'
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className={blocked ? 'text-led-danger' : debts ? 'text-led-warn' : undefined}>
            {blocked ? `${result.plugin} was not reset` : debts ? `${result.plugin} was reset — with ${result.handler.counts.pending} still owed` : `${result.plugin} was reset`}
          </DialogTitle>
          {/* The server's own sentence, verbatim. Re-wording it here would give
              the same outcome two spellings — one in the browser and one in the
              audit log — and the one an operator quotes back would be the wrong
              one half the time. */}
          <DialogDescription className="text-[13px] leading-relaxed">{result.message}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-[12.5px]">
          {/* Named before the list, because "the handler never ran" explains
              every empty list below it and is not something to infer. */}
          {(result.handler.skipped ?? result.handler.error) && (
            <p className="rounded border border-led-danger/40 bg-led-danger/5 px-3 py-2 leading-relaxed text-led-danger">
              <span className="readout">{(result.handler.skipped ?? result.handler.error)?.code}</span>{' '}
              {(result.handler.skipped ?? result.handler.error)?.message}
            </p>
          )}

          {result.handler.note && <p className="leading-relaxed text-fg-muted">{result.handler.note}</p>}

          {result.handler.items.length > 0 && (
            <ul className="divide-y overflow-hidden rounded border">
              {result.handler.items.map((item) => (
                <li key={`${item.kind}:${item.id}`} className="px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`rack-label shrink-0 ${OUTCOME[item.outcome].tone}`}>{OUTCOME[item.outcome].label}</span>
                    <span className="readout min-w-0 flex-1 wrap-anywhere text-[12px]">{item.label ?? item.id}</span>
                  </div>
                  <p className={`mt-0.5 leading-relaxed ${item.outcome === 'failed' ? 'text-led-danger' : 'text-fg-muted'}`}>{item.message}</p>
                </li>
              ))}
            </ul>
          )}

          {/* Said plainly and separately from the message, because "was my data
              deleted" is the one question this dialog must never leave to
              inference. */}
          <p className={blocked ? 'font-medium text-led-danger' : 'text-fg-muted'}>
            {result.data.deleted
              ? `${result.data.entries} stored ${result.data.entries === 1 ? 'entry' : 'entries'} deleted — ${result.data.global} farm-wide, ${result.data.device} across ${result.data.devices} device${result.data.devices === 1 ? '' : 's'}.`
              : 'Nothing was deleted. Every entry this plugin stored is still there, including the ones for the parts that did clean up — the cleanup handler is safe to run again.'}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
