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
  TerminalIcon,
  TrashIcon,
  UploadSimpleIcon,
  type Icon,
} from '@enkaku/ui'
import type { ActionVerb } from '@enkaku/protocol'

export interface ActionSetItem {
  verb: ActionVerb
  label: string
  icon: Icon
  /** `Forget` only: rendered in `var(--danger)` (design handoff). */
  danger?: boolean
  /**
   * The verb needs parameters this screen does not have, so it opens a dialog
   * plan 216 owns (plan 214 §3.10). Until that plan lands the row is rendered
   * disabled with a title naming it, which is visible rather than silent.
   */
  needsDialog?: boolean
  /** `set-group` only: this screen already knows every group, so it opens a submenu rather than a dialog. */
  submenu?: 'group'
}

/**
 * The generic action set (design handoff, "Generic action set (one list, used
 * everywhere)"): the same twelve rows in the bulk menu and in Device Control
 * -> Actions, "so selecting one device and selecting twenty behave
 * identically". Plan 215 imports this exact array; a second list anywhere is
 * the defect this file exists to prevent.
 */
export const GENERIC_ACTION_SET: readonly ActionSetItem[] = [
  { verb: 'reconnect', label: 'Reconnect', icon: ArrowsClockwiseIcon },
  { verb: 'disconnect', label: 'Disconnect', icon: PlugsIcon },
  { verb: 'install', label: 'Install apk', icon: DownloadSimpleIcon, needsDialog: true },
  { verb: 'adb', label: 'Adb command', icon: TerminalIcon, needsDialog: true },
  { verb: 'run-script', label: 'Run script', icon: PlayIcon, needsDialog: true },
  { verb: 'screenshot', label: 'Screenshot', icon: CameraIcon },
  { verb: 'sleep', label: 'Sleep', icon: MoonIcon },
  { verb: 'set-group', label: 'Move group', icon: FolderSimpleIcon, submenu: 'group' },
  { verb: 'push', label: 'Upload file', icon: UploadSimpleIcon, needsDialog: true },
  { verb: 'clear-cache', label: 'Clear cache', icon: BroomIcon, needsDialog: true },
  { verb: 'settings', label: 'Settings', icon: GearIcon, needsDialog: true },
  { verb: 'forget', label: 'Forget', icon: TrashIcon, danger: true },
]
