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
export interface GenericAction {
  id: ActionVerb
  label: string
  icon: Icon
  /** Rendered in `text-danger`; the handoff paints only Forget this way. */
  danger?: boolean
  /**
   * The verb needs parameters this screen does not have, so it opens a dialog
   * plan 216 owns. Until that plan lands the row is rendered disabled with a
   * title naming it, which is visible rather than silent.
   */
  needsDialog?: boolean
  /** `set-group` only: this screen already knows every group, so it opens a submenu rather than a dialog. */
  submenu?: 'group'
}

export const GENERIC_ACTIONS: readonly GenericAction[] = [
  { id: 'reconnect', label: 'Reconnect', icon: ArrowsClockwiseIcon },
  { id: 'disconnect', label: 'Disconnect', icon: PlugsIcon },
  { id: 'install', label: 'Install apk', icon: DownloadSimpleIcon, needsDialog: true },
  { id: 'adb', label: 'Adb command', icon: TerminalIcon, needsDialog: true },
  { id: 'run-script', label: 'Run script', icon: PlayIcon, needsDialog: true },
  { id: 'screenshot', label: 'Screenshot', icon: CameraIcon },
  { id: 'sleep', label: 'Sleep', icon: MoonIcon },
  { id: 'set-group', label: 'Move group', icon: FolderSimpleIcon, submenu: 'group' },
  { id: 'push', label: 'Upload file', icon: UploadSimpleIcon, needsDialog: true },
  { id: 'clear-cache', label: 'Clear cache', icon: BroomIcon, needsDialog: true },
  { id: 'settings', label: 'Settings', icon: GearIcon, needsDialog: true },
  { id: 'forget', label: 'Forget', icon: TrashIcon, danger: true },
]
export type GenericActionId = GenericAction['id']
