'use client'

import { z } from 'zod'
import { toast } from 'sonner'
import { KEYCODES, type ActionParams, type ActionResult, type RotationMode } from '@enkaku/protocol'
import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  BellIcon,
  BroomIcon,
  CameraIcon,
  CaretLeftIcon,
  CaretUpIcon,
  CircleIcon,
  DeviceMobileIcon,
  DeviceMobileSlashIcon,
  DownloadSimpleIcon,
  ExportIcon,
  FlowArrowIcon,
  FolderSimpleIcon,
  GearIcon,
  LightningIcon,
  MoonIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlugsIcon,
  PowerIcon,
  RobotIcon,
  RocketIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerSlashIcon,
  SquareIcon,
  SquaresFourIcon,
  SunIcon,
  TagIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
  describeApiError,
  type Icon,
} from '@enkaku/ui'
import { awaitOperation, groupResults, runAction } from '@/lib/actions'
import { newId, ws } from '@/lib/ws'
import { useActionDialogs, type ActionDialogVerb } from '@/components/actions/ActionDialogHost'
import { VERB_DIALOGS } from '@/components/actions/verb-dialogs'
import type { AdbShortcut } from '@/lib/adb-command-memory'

/**
 * The device action registry: ONE typed list of everything an operator can
 * do to a set of devices, and the only place a row is defined (owner,
 * 2026-09-15).
 *
 * Three surfaces draw it and none of them holds a row of its own:
 *
 *  - the floating bulk pill on the Devices screen (`BulkPill`),
 *  - the right-click menu on a device (`DeviceContextMenu`),
 *  - Device Control's Actions tab (`DeviceControl`),
 *
 * through `components/device-actions/DeviceActionList.tsx`. Device Control's
 * shortcut rail reads its buttons from here too, so a rail button and the
 * same row in a menu are one handler.
 *
 * Every handler takes the SET of devices (`DeviceActionContext.deviceIds`)
 * and acts on all of it. That set is the visible selection on the Devices
 * screen, the resolved right-click selection in the context menu, and the
 * host plus every mirrored device in Device Control — so "bulk" is never a
 * mode an action has to be in, and no row quietly reaches only the host.
 * This replaces `lib/generic-actions.ts`, which listed the dialog verbs
 * only: the hardware buttons, rotation and brightness lived in the rail
 * alone, acted on the host alone for half of them, and appeared in no menu.
 *
 * A row that cannot act in a context is drawn disabled with its reason
 * (`unavailable`), never hidden, so the three lists stay identical row for
 * row.
 */

export type DeviceActionSurface = 'control' | 'bulk' | 'context'

export interface DeviceActionContext {
  /** Every device this acts on, subject/host first. */
  deviceIds: readonly string[]
  /** The device under the cursor, or Device Control's host. Null for a bare selection. */
  subjectId: string | null
  surface: DeviceActionSurface
  /** Opens Device Control on `hostId`, mirroring `mirror`. Absent where it means nothing (inside Device Control itself). */
  openControl?: (hostId: string, mirror: readonly string[]) => void
}

/**
 * The runs, in render order. A labelled run is a heading (Device Control) or
 * a submenu (the menus); an unlabelled one is drawn inline. `control` and
 * `labels` lead because they are why most menus are opened; `danger` ends
 * under a rule, because Forget behind a hover is how a device gets deleted by
 * someone who meant to look at it.
 */
export const DEVICE_ACTION_GROUPS = [
  { id: 'control', label: '' },
  { id: 'labels', label: '' },
  { id: 'buttons', label: 'Buttons' },
  { id: 'screen', label: 'Screen' },
  { id: 'connection', label: 'Connection' },
  { id: 'device', label: 'Install & shell' },
  /**
   * The farm's saved adb commands, one row each — the only run in this list
   * whose membership is DATA rather than code (`groupedDeviceActions`).
   *
   * It sits right under "Install & shell" because that is where its own row,
   * Adb command, lives: a shortcut is that dialog with the answer already
   * filled in. Empty when the farm has saved none, and `groupedDeviceActions`
   * then drops the whole run rather than opening a submenu onto nothing.
   */
  { id: 'adb-shortcuts', label: 'Adb shortcuts' },
  { id: 'run', label: 'Run' },
  { id: 'files', label: 'Files & agent' },
  { id: 'config', label: 'Configure' },
  { id: 'rare', label: 'Maintenance' },
  { id: 'danger', label: '' },
] as const
export type DeviceActionGroup = (typeof DEVICE_ACTION_GROUPS)[number]['id']

interface DeviceActionBase {
  id: string
  label: string
  icon: Icon
  iconClassName?: string
  group: DeviceActionGroup
  danger?: boolean
  /** The row's tooltip. A dialog verb's defaults to its own `note`, so the menu and the dialog share one sentence. */
  hint?: string
}

export interface RunDeviceAction extends DeviceActionBase {
  kind: 'run'
  run: (ctx: DeviceActionContext) => void
  /** A short reason this row cannot act in `ctx`, shown on the row; null when it can. */
  unavailable?: (ctx: DeviceActionContext) => string | null
  /** Asked before `run`. Destructive rows only. */
  confirm?: { title: string; description: string; confirmLabel: string }
  /** The dialog verb this row opens, when it opens one. */
  verb?: ActionDialogVerb
}

/** Labels: a panel of checkboxes rather than a handler, because labelling is done dozens of times in a sitting and a modal per label would make it unusable. */
export interface LabelsDeviceAction extends DeviceActionBase {
  kind: 'labels'
}

export type DeviceAction = RunDeviceAction | LabelsDeviceAction

const plural = (n: number) => `${n} device${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Says what came back, grouped the way `ActionDialogHost` groups an immediate verb. Silent on full success when `quiet`. */
function report(label: string, results: readonly ActionResult[], quiet: boolean): void {
  const grouped = groupResults([...results])
  const refused = [...grouped.failed, ...grouped.forbidden, ...grouped.warned]
  const skipped = grouped.skipped
  if (refused.length === 0 && skipped.length === 0) {
    if (!quiet) toast.success(`${label}: ${plural(grouped.done.length)}`)
    return
  }
  const parts = [`${grouped.done.length} done`]
  if (refused.length > 0) parts.push(`${refused.length} refused`)
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`)
  const why = refused[0]?.message ?? skipped[0]?.message
  toast.warning(`${label}: ${parts.join(', ')}`, why ? { description: why } : undefined)
}

/**
 * A button press run through the actions API, with no dialog.
 *
 * A `warned` device is re-sent once with `force`, after saying the policy
 * sentence — `runOnDevice`'s own rule, and the right one here: the usual
 * conflict is the very control session the operator is pressing buttons
 * through. An async verb (`adb`) is waited for in place rather than handed
 * to the operation tray: a Back press does not deserve a card.
 */
async function runQuietly<V extends 'adb' | 'settings'>(
  label: string,
  verb: V,
  deviceIds: readonly string[],
  params: ActionParams<V>,
  opts: { quiet: boolean },
): Promise<ActionResult[] | null> {
  if (deviceIds.length === 0) return null
  try {
    const first = await runAction(verb, { deviceIds: [...deviceIds] }, params)
    const responses = [first]
    let results = first.results
    const warned = results.filter((r) => r.status === 'warned')
    if (warned.length > 0) {
      toast.warning(`${label}: ${warned[0]!.message ?? 'a device is busy'}`)
      const forced = await runAction(verb, { deviceIds: warned.map((r) => r.deviceId) }, params, { force: true })
      responses.push(forced)
      const forcedById = new Map(forced.results.map((r) => [r.deviceId, r]))
      results = results.map((r) => forcedById.get(r.deviceId) ?? r)
    }
    for (const response of responses) {
      if (!response.results.some((r) => r.status === 'accepted')) continue
      const settled = await awaitOperation(response.operationId, { intervalMs: 500, timeoutMs: 120_000 })
      const settledById = new Map(settled.results.map((r) => [r.deviceId, r]))
      results = results.map((r) => settledById.get(r.deviceId) ?? r)
    }
    report(label, results, opts.quiet)
    return results
  } catch (err) {
    toast.error(`${label}: ${describeApiError(err)}`)
    return null
  }
}

/** How long a key press listens for a refusal. `input.key` never answers success, so silence past this is success. */
const KEY_REFUSAL_WINDOW_MS = 1500
/** Refusals arrive within milliseconds of each other; this gathers them into one toast and one fallback request. */
const KEY_BATCH_MS = 120

/**
 * A hardware key on every device, over the live session where there is one.
 *
 * A device with no session — most phones, when this runs from the Devices
 * screen, and a mirrored phone nobody is casting — refuses with
 * `E_DEVICE_NOT_READY`, and gets `input keyevent` through the `adb` action
 * instead. That fallback is governed by the farm's Adb command privacy
 * setting like any other shell command; when it is off, the toast says the
 * request was refused rather than pretending the key was pressed.
 */
export function pressKeyOn(deviceIds: readonly string[], keycode: number, label: string): void {
  const noSession: string[] = []
  const refusals: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    const fallback = noSession.splice(0)
    const reasons = refusals.splice(0)
    if (reasons.length > 0) toast.warning(`${label}: ${reasons.length} of ${plural(deviceIds.length)} refused`, { description: reasons[0] })
    if (fallback.length > 0) void runQuietly(label, 'adb', fallback, { cmd: `input keyevent ${keycode}` }, { quiet: true })
  }
  for (const deviceId of deviceIds) {
    const id = newId()
    const off = ws.on((msg) => {
      if (msg.type !== 'error' || msg.id !== id) return
      off()
      clearTimeout(listening)
      if (msg.payload.code === 'E_DEVICE_NOT_READY') noSession.push(deviceId)
      else refusals.push(msg.payload.message)
      if (timer === null) timer = setTimeout(flush, KEY_BATCH_MS)
    })
    const listening = setTimeout(off, KEY_REFUSAL_WINDOW_MS)
    ws.send({ type: 'input.key', id, payload: { deviceId, keycode } })
  }
}

function shellOn(label: string, cmd: string): (ctx: DeviceActionContext) => void {
  return (ctx) => void runQuietly(label, 'adb', ctx.deviceIds, { cmd }, { quiet: true })
}

/** Steps each device's own brightness 32 → 128 → 255 → 32, from wherever that device is. */
const BRIGHTNESS_CYCLE_CMD = [
  'b=$(settings get system screen_brightness 2>/dev/null); b=${b:-128};',
  'if [ "$b" -lt 96 ]; then n=128; elif [ "$b" -lt 200 ]; then n=255; else n=32; fi;',
  'settings put system screen_brightness_mode 0; settings put system screen_brightness $n; echo $n',
].join(' ')

/** Resolves every device's result, so the rail can show the host's new level. */
export function cycleBrightnessOn(deviceIds: readonly string[]): Promise<ActionResult[] | null> {
  return runQuietly('Brightness', 'adb', deviceIds, { cmd: BRIGHTNESS_CYCLE_CMD }, { quiet: true })
}

export const ROTATION_LABEL: Record<RotationMode, string> = {
  device: 'Auto-rotate',
  'lock-portrait': 'Portrait lock',
  'lock-landscape': 'Landscape lock',
  'lock-current': 'Orientation lock',
}

const RotationDetailSchema = z.object({
  rotation: z.object({ state: z.string(), reason: z.string().optional() }).nullable().optional(),
})

/** The `settings` verb's live re-lock answer for one device: `applied`, `no-session`, `busy`, `failed`, or null when it did not say. */
export function rotationStateOf(result: ActionResult): string | null {
  const parsed = RotationDetailSchema.safeParse(result.detail)
  return parsed.success ? (parsed.data.rotation?.state ?? null) : null
}

/**
 * One rotation mode on every device, through the `settings` verb — which
 * saves `prep.rotation` and re-locks a live session in the same call, and
 * answers per device whether the screen actually turned.
 *
 * `no-session` and `busy` are not failures: the setting is saved and lands
 * when the device is online and its job is done. They are still said, or a
 * screen that did not move reads as a broken button.
 */
export async function setRotationOn(deviceIds: readonly string[], mode: RotationMode, opts: { quiet: boolean }): Promise<ActionResult[] | null> {
  const label = ROTATION_LABEL[mode]
  const results = await runQuietly(label, 'settings', deviceIds, { settings: { prep: { rotation: mode } } }, { quiet: true })
  if (!results) return null
  const done = results.filter((r) => r.status === 'done')
  const didNotTake = done.filter((r) => rotationStateOf(r) === 'failed')
  const later = done.filter((r) => rotationStateOf(r) === 'no-session' || rotationStateOf(r) === 'busy')
  if (didNotTake.length > 0) {
    const reason = RotationDetailSchema.safeParse(didNotTake[0]!.detail).data?.rotation?.reason
    toast.error(`${label} did not take on ${plural(didNotTake.length)}`, { description: reason ?? 'the device did not report the requested orientation' })
  }
  if (later.length > 0) toast.info(`${label} saved on ${plural(later.length)} — it applies once ${later.length === 1 ? 'that device is' : 'they are'} online and free.`)
  if (!opts.quiet && didNotTake.length === 0 && later.length === 0 && done.length === results.length) toast.success(`${label}: ${plural(done.length)}`)
  return results
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

const openVerb =
  (verb: ActionDialogVerb) =>
  (ctx: DeviceActionContext): void =>
    useActionDialogs().open(verb, { deviceIds: [...ctx.deviceIds] })

function verbRow(verb: ActionDialogVerb, label: string, icon: Icon, group: DeviceActionGroup, extra: Partial<RunDeviceAction> = {}): RunDeviceAction {
  return { kind: 'run', id: verb, verb, label, icon, group, run: openVerb(verb), ...extra }
}

const KEY_HINT = 'Pressed over the live session; a device without one gets `input keyevent` through the Adb command action.'

function keyRow(id: string, label: string, icon: Icon, keycode: number): RunDeviceAction {
  return { kind: 'run', id, label, icon, group: 'buttons', hint: KEY_HINT, run: (ctx) => pressKeyOn(ctx.deviceIds, keycode, label) }
}

function rotationRow(id: string, mode: RotationMode, icon: Icon, iconClassName?: string): RunDeviceAction {
  return {
    kind: 'run',
    id,
    label: ROTATION_LABEL[mode],
    icon,
    ...(iconClassName ? { iconClassName } : {}),
    group: 'screen',
    hint: mode === 'device' ? 'Hands rotation back to each device’s own sensor.' : `Locks each screen ${mode === 'lock-portrait' ? 'upright' : 'sideways'}, and keeps it locked across sessions.`,
    run: (ctx) => void setRotationOn(ctx.deviceIds, mode, { quiet: ctx.surface === 'control' }),
  }
}

export const DEVICE_ACTIONS: readonly DeviceAction[] = [
  {
    kind: 'run',
    id: 'open-control',
    label: 'Open Device Control',
    icon: DeviceMobileIcon,
    iconClassName: 'text-accent',
    group: 'control',
    hint: 'Casts the device under the cursor (or the first selected) and mirrors input to the rest.',
    unavailable: (ctx) => (ctx.surface === 'control' ? 'This window' : ctx.openControl ? null : 'Unavailable'),
    run: (ctx) => {
      const host = ctx.subjectId ?? ctx.deviceIds[0]
      if (host) ctx.openControl?.(host, ctx.deviceIds)
    },
  },

  { kind: 'labels', id: 'labels', label: 'Labels', icon: TagIcon, group: 'labels', hint: 'Tick the labels every targeted device should carry.' },

  // The hardware buttons. The rail had these for the host window only; they
  // are just as much a bulk action as Wake.
  keyRow('back', 'Back', CaretLeftIcon, KEYCODES.BACK),
  keyRow('home', 'Home', CircleIcon, KEYCODES.HOME),
  keyRow('recents', 'Recent apps', SquareIcon, KEYCODES.APP_SWITCH),
  keyRow('power', 'Power button', PowerIcon, KEYCODES.POWER),
  keyRow('volume-up', 'Volume up', SpeakerHighIcon, KEYCODES.VOLUME_UP),
  keyRow('volume-down', 'Volume down', SpeakerLowIcon, KEYCODES.VOLUME_DOWN),
  keyRow('mute', 'Mute', SpeakerSlashIcon, KEYCODES.VOLUME_MUTE),
  { kind: 'run', id: 'notifications', label: 'Notifications', icon: BellIcon, group: 'buttons', hint: 'Pulls down the notification shade, through the Adb command action.', run: shellOn('Notifications', 'cmd statusbar expand-notifications') },
  { kind: 'run', id: 'quick-settings', label: 'Quick settings', icon: SquaresFourIcon, group: 'buttons', hint: 'Opens the quick settings panel, through the Adb command action.', run: shellOn('Quick settings', 'cmd statusbar expand-settings') },
  { kind: 'run', id: 'collapse-panels', label: 'Collapse panels', icon: CaretUpIcon, group: 'buttons', hint: 'Closes the notification shade and quick settings, through the Adb command action.', run: shellOn('Collapse panels', 'cmd statusbar collapse') },

  // Screen state. Wake and Sleep are the readiness-aware actions, not the raw
  // keyevents: a phone held lit by `svc power stayon` turns a KEYCODE_SLEEP
  // straight back on, so the action drops always-on first and restores it on
  // wake. Screen off/on darken the panel and leave the mirror running.
  verbRow('wake', 'Wake', LightningIcon, 'screen'),
  verbRow('sleep', 'Sleep', MoonIcon, 'screen'),
  verbRow('screen-on', 'Screen on', DeviceMobileIcon, 'screen'),
  verbRow('screen-off', 'Screen off', DeviceMobileSlashIcon, 'screen'),
  rotationRow('rotate-portrait', 'lock-portrait', DeviceMobileIcon),
  rotationRow('rotate-landscape', 'lock-landscape', DeviceMobileIcon, 'rotate-90'),
  rotationRow('rotate-auto', 'device', ArrowsClockwiseIcon),
  { kind: 'run', id: 'brightness', label: 'Brightness', icon: SunIcon, group: 'screen', hint: 'Steps each device’s brightness 32 → 128 → 255, through the Adb command action.', run: (ctx) => void cycleBrightnessOn(ctx.deviceIds) },

  // Connection — nothing else works until these do.
  verbRow('reconnect', 'Reconnect', ArrowsClockwiseIcon, 'connection'),
  verbRow('disconnect', 'Disconnect', PlugsIcon, 'connection'),
  verbRow('set-network', 'Network', PlugsIcon, 'connection'),
  // The pair. Quarantine pulls a device out of the scheduler's pool without
  // deleting or un-enrolling it — the reversible answer to a phone that must
  // not be picked next, where Forget and Block are not — and is skipped for a
  // device that is not online. Return is the way back, and is skipped for a
  // device that is not quarantined.
  verbRow('quarantine', 'Quarantine', WarningIcon, 'connection'),
  verbRow('unquarantine', 'Return from quarantine', ArrowCounterClockwiseIcon, 'connection'),

  verbRow('install', 'Install apk', DownloadSimpleIcon, 'device'),
  verbRow('adb', 'Adb command', TerminalIcon, 'device'),

  verbRow('run-script', 'Run script', PlayIcon, 'run'),
  verbRow('run-workflow', 'Run workflow', FlowArrowIcon, 'run'),

  verbRow('push', 'Upload file', UploadSimpleIcon, 'files'),
  verbRow('pull', 'Download file', ExportIcon, 'files'),
  verbRow('install-agent', 'Install guest agent', RobotIcon, 'files'),
  verbRow('uninstall-agent', 'Uninstall guest agent', RobotIcon, 'files', { danger: true }),

  verbRow('settings', 'Settings', GearIcon, 'config'),
  verbRow('set-group', 'Move group', FolderSimpleIcon, 'config'),
  verbRow('apply-screen-label', 'Screen label', PencilSimpleIcon, 'config'),

  // Screenshot writes a PNG into each device's artifacts — not the browser
  // screenshot its name suggests — so it sits with the things you go looking for.
  verbRow('screenshot', 'Screenshot', CameraIcon, 'rare'),
  verbRow('prepare', 'Prepare', RocketIcon, 'rare'),
  verbRow('clear-cache', 'Clear cache', BroomIcon, 'rare'),

  verbRow('forget', 'Forget', TrashIcon, 'danger', {
    danger: true,
    confirm: { title: 'Forget these devices?', description: 'Their history stays. A phone that reconnects appears in Discovered again.', confirmLabel: 'Forget' },
  }),
]

/**
 * One row per saved adb shortcut.
 *
 * Clicking it opens the Adb command dialog with that command already in the
 * box AND submits it (`autoRun`) — the owner's ask on 2026-09-16 was for the
 * fast path: "langsung dieksekusi… dan langsung dijalankan". The dialog still
 * opens rather than the command being fired silently in the background,
 * because the OUTPUT is the reason to run an adb command, and a busy device's
 * confirmation still has somewhere to appear.
 *
 * It reaches all three surfaces for free: the menus draw a labelled run as a
 * hover submenu and Device Control draws it as a section, so "hover the
 * shortcuts item to get the sub-items" is what a menu already does with
 * Buttons, Screen and Connection.
 */
function shortcutRow(shortcut: AdbShortcut): RunDeviceAction {
  return {
    kind: 'run',
    // Namespaced so a shortcut can never collide with a verb row's id.
    id: `adb-shortcut:${shortcut.id}`,
    label: shortcut.name,
    icon: TerminalWindowIcon,
    group: 'adb-shortcuts',
    hint: `Runs \`${shortcut.cmd}\` straight away, through the Adb command action.`,
    run: (ctx) => useActionDialogs().open('adb', { deviceIds: [...ctx.deviceIds] }, { cmd: shortcut.cmd }, { autoRun: true }),
  }
}

/**
 * The groups in render order, each with its rows; empty groups dropped. Every
 * surface renders exactly this.
 *
 * `shortcuts` is the farm's saved adb commands (`lib/adb-command-memory.ts`),
 * passed in rather than read here: this module is a plain registry with no
 * hooks in it, and `DeviceActionList` — the ONE component all three surfaces
 * draw through — is where the subscription belongs.
 */
export function groupedDeviceActions(shortcuts: readonly AdbShortcut[] = []): { group: (typeof DEVICE_ACTION_GROUPS)[number]; items: DeviceAction[] }[] {
  const rows: DeviceAction[] = [...DEVICE_ACTIONS, ...shortcuts.map(shortcutRow)]
  return DEVICE_ACTION_GROUPS.map((group) => ({ group, items: rows.filter((a) => a.group === group.id) })).filter((g) => g.items.length > 0)
}

/** The row's tooltip: its own hint (or its dialog's note), and how many devices it will reach. */
export function deviceActionHint(item: DeviceAction, ctx: DeviceActionContext): string | undefined {
  const base = item.hint ?? (item.kind === 'run' && item.verb ? VERB_DIALOGS[item.verb]?.note : undefined)
  const reach = ctx.deviceIds.length > 1 ? `Acts on all ${ctx.deviceIds.length} devices.` : undefined
  return [base, reach].filter(Boolean).join(' ') || undefined
}

/** A run row by id, for a surface that draws one row on its own (Device Control's rail). */
export function findDeviceAction(id: string): RunDeviceAction {
  const item = DEVICE_ACTIONS.find((a) => a.id === id)
  if (!item || item.kind !== 'run') throw new Error(`no runnable device action ${id}`)
  return item
}
