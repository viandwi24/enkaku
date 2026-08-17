'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  PluginActionResponseSchema,
  type ActionSpec,
  type Binding,
  type DeviceInfo,
  type JsonSchemaNode as WireJsonSchemaNode,
} from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { readRowField, rowPayload, type PluginViewRow } from '@/components/plugin-view/rows'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection } from '@/components/target/useTargetSelection'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'

/**
 * Plan 108 §3.4, §4.5, §5 step 108.7 — running ONE declared action.
 *
 * Everything about what the action does lives in the verified surface, on the
 * server. This component decides three things and nothing else: whether to
 * collect a form, whether to collect a target, and how to word the
 * confirmation. It then POSTs `{ row?, form?, deviceIds? }` — the only three
 * members `PluginActionBodySchema` has — and the executor does the rest.
 *
 * ## `confirm` is a sentence, never a template
 *
 * §3.4's rule, and the reason the plan's own worked example (§4.3) carries a
 * comment retracting an earlier `@{{username}}`: bindings are the ONE way a
 * declared value reaches an action, and a second, weaker interpolation path
 * for one string would undo that. So `action.confirm` is rendered verbatim,
 * with no substitution of any kind — this file contains no `{{`, no `replace`
 * over the confirm text, and no template parser.
 *
 * **`ActionRunner` names the target itself instead.** `docs/design.md`
 * requires a confirm dialog to name the thing at stake, and this is how it
 * does so without interpolation: the dialog's own title and its first line
 * are built HERE, from facts this component already has — the row's `rowKey`
 * value and its device label for a row action, the resolved device count for
 * a batch. The author's sentence sits underneath, unchanged.
 *
 * ## Why the confirmation is the LAST gate
 *
 * A confirmation that cannot name its target is not a confirmation. A batch's
 * target is not known until the picker has been answered, so the order is
 * form → target → confirm → POST: every stage that can still CHANGE what is
 * about to happen runs before the one that asks whether to do it.
 */

/** What a click on a toolbar button or a row action hands this component. */
export interface ActionInvocation {
  actionId: string
  action: ActionSpec
  /** `null` for a toolbar action — a toolbar button belongs to the screen, not to a row. */
  row: PluginViewRow | null
  /** The devices the table's own selection currently resolves to (`target: 'selection'`). */
  selectedDeviceIds: string[]
}

/** The action that actually DOES something — a `form` is a dialog wrapped around one. */
type TerminalAction = Exclude<ActionSpec, { kind: 'form' }>

function terminalAction(action: ActionSpec): TerminalAction {
  return action.kind === 'form' ? terminalAction(action.then) : action
}

/**
 * The schema of the outermost `form` in the chain, if there is one.
 *
 * A `form` whose `then` is another `form` collects only the outer one, and
 * that is a protocol fact rather than a renderer shortcut:
 * `PluginActionBodySchema.form` is a SINGLE `unknown`, so there is exactly
 * one form's worth of values on the wire no matter how the chain nests, and
 * the executor binds `$form.*` against that one value.
 */
function formSchemaOf(action: ActionSpec): WireJsonSchemaNode | undefined {
  return action.kind === 'form' ? action.schema : undefined
}

function submitLabelOf(action: ActionSpec): string {
  return action.kind === 'form' ? action.submitLabel : 'Run'
}

/** The author's own confirmation sentence, if the kind can carry one
 *  (`kv.set` cannot — a write with a declared key and value has nothing to
 *  ask about that the dialog's own naming does not already say). */
function confirmOf(action: TerminalAction): string | undefined {
  return action.kind === 'kv.set' ? undefined : action.confirm
}

/**
 * `prefill` — the ONE place a binding is read in the browser, and it is
 * deliberately powerless: its result seeds a form field the operator can then
 * change, and the value that is finally acted on is whatever they submit,
 * re-evaluated server-side by `plugins/binding.ts` against the same closed
 * grammar. Nothing here reaches the farm; a wrong answer here is a wrong
 * DEFAULT, never a wrong action.
 *
 * Written over the same closed forms `BindingSchema` declares (§3.4) and
 * depth-capped for the same reason the server's evaluator is: `$literal` may
 * hold anything, including a shape deep enough to blow the stack.
 */
function evaluatePrefill(binding: Binding, row: PluginViewRow | null, depth = 0): unknown {
  if (depth > 8) return undefined
  if (Array.isArray(binding)) return binding.map((member) => evaluatePrefill(member, row, depth + 1))
  if (typeof binding !== 'object' || binding === null) return undefined

  // `Binding`'s object-map member has an index signature, so `'$row' in b`
  // narrows the union only as far as `string | Binding` — the marker forms and
  // the map form are indistinguishable to `in` alone. Reading the marker and
  // checking it is a string is what separates them, and it is also what makes
  // a hand-written `{ $row: { ... } }` (which the schema refuses anyway) fall
  // through to the map branch rather than crash.
  const marked = binding as Record<string, unknown>
  if ('$literal' in marked) return marked.$literal
  if (typeof marked.$row === 'string') return row ? readRowField(row, marked.$row) : undefined
  if (typeof marked.$device === 'string') return row ? readRowField(row, `$device.${marked.$device}`) : undefined
  if (typeof marked.$entry === 'string') return row ? readRowField(row, `$entry.${marked.$entry}`) : undefined
  // `$form` cannot resolve while the form is still being filled in — the
  // server binds it afterward, from what was submitted.
  if (typeof marked.$form === 'string') return undefined

  const out: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(binding as Record<string, Binding>)) out[key] = evaluatePrefill(member, row, depth + 1)
  return out
}

/** A device as an operator recognises it — its label, else the stable id it was enrolled under. */
function deviceName(row: PluginViewRow | null): string | null {
  const device = row?.device
  if (!device) return null
  return device.label && device.label.length > 0 ? device.label : device.stableId
}

/** The row, as the view's own `rowKey` names it. `null` when the row carries nothing at that path. */
function rowName(row: PluginViewRow | null, rowKey: string): string | null {
  if (!row) return null
  const value = readRowField(row, rowKey)
  if (value === undefined || value === null) return null
  const text = String(value)
  return text.length > 0 ? text : null
}

type Stage = 'form' | 'target' | 'confirm'

export interface ActionRunnerProps {
  plugin: string
  /** The view's own `table.rowKey` — what a row is CALLED, used to name it in the confirmation. */
  rowKey: string
  invocation: ActionInvocation
  onClose(): void
  onDone(): void
}

export function ActionRunner({ plugin, rowKey, invocation, onClose, onDone }: ActionRunnerProps) {
  const { action, actionId, row, selectedDeviceIds } = invocation
  const terminal = terminalAction(action)
  const formSchema = formSchemaOf(action)

  // A picker needs the device list; `target: 'all'` needs only its size, so
  // both are served by the one fetch every other picker in Studio uses.
  const needsDevices =
    (terminal.kind === 'job' && terminal.device === 'picker') || (terminal.kind === 'batch' && (terminal.target === 'picker' || terminal.target === 'all'))
  const needsPicker = (terminal.kind === 'job' && terminal.device === 'picker') || (terminal.kind === 'batch' && terminal.target === 'picker')

  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [formValue, setFormValue] = useState<unknown>(() => (action.kind === 'form' && action.prefill ? evaluatePrefill(action.prefill, row) : undefined))
  const [formCanSubmit, setFormCanSubmit] = useState(true)
  const [stage, setStage] = useState<Stage>(formSchema ? 'form' : needsPicker ? 'target' : 'confirm')
  const { run, pending } = useAction()

  const selection = useTargetSelection({ usableCount: devices?.length ?? 0 })
  const { reset } = selection

  useEffect(() => {
    if (!needsDevices) return
    let cancelled = false
    void fetchDevices()
      .then((list) => {
        if (cancelled) return
        setDevices(list)
        if (needsPicker) reset({ devices: list, allow: terminal.kind === 'job' ? ['single'] : ['devices'] })
      })
      .catch(() => {
        if (!cancelled) setDevices([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsDevices, needsPicker])

  /** Which devices this run targets, as the body's `deviceIds`. Empty for
   *  `device: 'row'` (the server takes it from `$device.id`) and for
   *  `target: 'all'` (the server enumerates the farm itself). */
  const deviceIds = useMemo(() => {
    if (terminal.kind === 'job' && terminal.device === 'picker') return selection.deviceId ? [selection.deviceId] : []
    if (terminal.kind === 'batch') {
      if (terminal.target === 'selection') return selectedDeviceIds
      if (terminal.target === 'picker') return selection.deviceIds
    }
    return []
  }, [terminal, selection.deviceId, selection.deviceIds, selectedDeviceIds])

  /**
   * The thing at stake, in words, built from facts — never from the author's
   * `confirm` string. This is the sentence `docs/design.md` requires a
   * confirmation to carry.
   */
  const targetName = useMemo(() => {
    const name = rowName(row, rowKey)
    const device = deviceName(row)
    if (terminal.kind === 'batch') {
      if (terminal.target === 'all') return devices === null ? 'every enrolled device' : `every enrolled device (${devices.length})`
      const count = deviceIds.length
      return `${count} device${count === 1 ? '' : 's'}`
    }
    if (name && device) return `${name} on ${device}`
    if (name) return name
    if (device) return device
    if (terminal.kind === 'job' && terminal.device === 'picker') {
      const picked = devices?.find((d) => d.id === selection.deviceId)
      return picked ? picked.label || picked.stableId : 'no device chosen yet'
    }
    return null
  }, [row, rowKey, terminal, devices, deviceIds.length, selection.deviceId])

  const successMessage =
    terminal.kind === 'job' ? 'Job created' : terminal.kind === 'batch' ? 'Batch created' : terminal.kind === 'kv.set' ? 'Saved' : 'Deleted'

  const submit = () =>
    run(
      actionId,
      () =>
        api(`/api/plugins/${encodeURIComponent(plugin)}/action/${encodeURIComponent(actionId)}`, PluginActionResponseSchema, {
          method: 'POST',
          json: {
            ...(row ? { row: rowPayload(row) } : {}),
            ...(formValue !== undefined ? { form: formValue } : {}),
            ...(deviceIds.length > 0 ? { deviceIds } : {}),
          },
        }),
      {
        success: successMessage,
        failure: `Could not run “${action.label}”`,
        onSuccess: onDone,
      },
    )

  if (stage === 'confirm') {
    return (
      <ConfirmDialog
        open
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
        trigger={<span className="hidden" />}
        title={targetName ? `${action.label} — ${targetName}?` : `${action.label}?`}
        description={
          <>
            {/* Named by this component, from the row and the resolved target
                — the author's own sentence is never rewritten to say it. */}
            <p>
              This runs <span className="text-fg">{action.label}</span>
              {targetName ? (
                <>
                  {' '}
                  on <span className="text-fg">{targetName}</span>
                </>
              ) : null}
              .
            </p>
            {/* Verbatim. No interpolation — plan 108 §3.4. */}
            {confirmOf(terminal) && <p className="mt-1.5">{confirmOf(terminal)}</p>}
          </>
        }
        confirmLabel={action.label}
        destructive={terminal.kind === 'kv.delete'}
        onConfirm={submit}
      />
    )
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>
            {stage === 'form'
              ? `Fill this in, then ${plugin} runs the action with what you enter.`
              : terminal.kind === 'job'
                ? 'Choose the device to run this on.'
                : 'Choose the devices to run this on.'}
          </DialogDescription>
        </DialogHeader>

        {stage === 'form' && formSchema && (
          <SchemaForm
            // The reconciliation between `@enkaku/protocol`'s bare-index-signature
            // `JsonSchemaNode` and this package's narrower one, the same cast
            // `RunScriptDialog` and `JobResultSection` already document.
            schema={formSchema as JsonSchemaNode}
            value={formValue}
            onChange={setFormValue}
            onCanSubmitChange={setFormCanSubmit}
          />
        )}

        {stage === 'target' &&
          (devices === null ? (
            <p className="text-[12.5px] text-fg-muted">Loading devices…</p>
          ) : (
            <TargetPicker selection={selection} devices={devices} allow={terminal.kind === 'job' ? ['single'] : ['devices']} />
          ))}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => setStage(stage === 'form' && needsPicker ? 'target' : 'confirm')}
            disabled={pending === actionId || (stage === 'form' ? !formCanSubmit : !selection.hasTarget || !selection.fleetConfirmed)}
          >
            {stage === 'form' && !needsPicker ? submitLabelOf(action) : 'Continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { evaluatePrefill, terminalAction }
