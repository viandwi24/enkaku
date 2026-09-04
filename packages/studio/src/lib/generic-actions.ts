import {
  ArrowsClockwiseIcon,
  BroomIcon,
  CameraIcon,
  DownloadSimpleIcon,
  FolderSimpleIcon,
  GearIcon,
  MoonIcon,
  PlayIcon,
  PlugsIcon,
  RobotIcon,
  TerminalIcon,
  TrashIcon,
  UploadSimpleIcon,
  type Icon,
} from '@enkaku/ui'
import type { ActionDialogVerb } from '@/components/actions/verb-dialogs'
import type { ActionVerb } from '@enkaku/protocol'

/**
 * The generic action set (design handoff README.md:189-196): "The same twelve
 * actions appear in the bulk menu and in Device Control → Actions, so
 * selecting one device and selecting twenty behave identically."
 *
 * One list, one order, one set of icons. The bulk pill's menu and Device
 * Control's Actions tab both render THIS array; a second copy is the exact
 * defect the handoff's sentence rules out.
 *
 * Moved here from `components/devices/action-set.ts` (plan 214's own copy of
 * this exact rule) by plan 215 step 215.6, renamed to match this plan's
 * field names (`id`, not `verb`) so the file this plan's G23 checks
 * (`rg -c "id: '"`) matches. `needsDialog` and `submenu` are plan 214's own
 * additions, kept because the bulk menu (`ActionMenu.tsx`) still reads them;
 * plan 216's dialogs replace `needsDialog` with a real action.
 */
/**
 * The id is narrowed to the verbs that actually have a dialog (plan 216's
 * `VERB_DIALOGS`), not to every `ActionVerb` the actions API accepts: this
 * list is what a menu renders, and a row whose dialog does not exist could
 * only be dead. Reconciled at the R5 gate, where plan 215's `GenericAction`
 * (id, submenu) met plan 216's `ActionSetItem` (verb, overflow).
 */
export interface GenericAction {
  id: ActionDialogVerb
  label: string
  icon: Icon
  /** Rendered in `text-danger`; the handoff paints only Forget this way. */
  danger?: boolean
  /** `set-group` only: this screen already knows every group, so it opens a submenu rather than a dialog. */
  submenu?: 'group'
  /** Rendered under a `border-t` separator, after the twelve of the generic set (MVP 15 §1, plan 216). */
  overflow?: boolean
}

export const GENERIC_ACTIONS: readonly GenericAction[] = [
  { id: 'reconnect', label: 'Reconnect', icon: ArrowsClockwiseIcon },
  { id: 'disconnect', label: 'Disconnect', icon: PlugsIcon },
  { id: 'install', label: 'Install apk', icon: DownloadSimpleIcon },
  { id: 'adb', label: 'Adb command', icon: TerminalIcon },
  { id: 'run-script', label: 'Run script', icon: PlayIcon },
  { id: 'screenshot', label: 'Screenshot', icon: CameraIcon },
  { id: 'sleep', label: 'Sleep', icon: MoonIcon },
  { id: 'set-group', label: 'Move group', icon: FolderSimpleIcon, submenu: 'group' },
  { id: 'push', label: 'Upload file', icon: UploadSimpleIcon },
  { id: 'clear-cache', label: 'Clear cache', icon: BroomIcon },
  { id: 'settings', label: 'Settings', icon: GearIcon },
  // The guest agent, by hand (CEO, 2026-09-04). An outdated agent is already
  // reinstalled automatically; these are for when production disagrees with
  // the happy path — an install that reported success and did not stick, a
  // local build the version check cannot see — and for turning the agent off
  // on one phone. Overflow, because an operator reaches for them rarely and
  // deliberately, never in the course of ordinary work.
  { id: 'install-agent', label: 'Install guest agent', icon: RobotIcon, overflow: true },
  { id: 'uninstall-agent', label: 'Uninstall guest agent', icon: RobotIcon, overflow: true, danger: true },
  { id: 'forget', label: 'Forget', icon: TrashIcon, danger: true },
]
export type GenericActionId = GenericAction['id']
