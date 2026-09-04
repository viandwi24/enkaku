import {
  ArrowsClockwiseIcon,
  BroadcastIcon,
  BroomIcon,
  CameraIcon,
  DownloadSimpleIcon,
  FolderSimpleIcon,
  GearIcon,
  MoonIcon,
  PackageIcon,
  PencilSimpleIcon,
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
  /** Rendered under a `border-t` separator, after the twelve of the generic set (MVP 15 §1). */
  overflow?: boolean
}

/**
 * The generic action set (design handoff, "Generic action set (one list,
 * used everywhere)"): the same twelve rows in the bulk menu and in Device
 * Control -> Actions, "so selecting one device and selecting twenty behave
 * identically", plus the three overflow entries (Prepare, Label, Network —
 * MVP 15 §1) that the handoff itself does not draw. Every row now opens
 * `ActionDialog` (plan 216 §3.6): a verb with no fields still gets the
 * picker row, so the container is identical whether or not the verb needs
 * one.
 */
export const GENERIC_ACTION_SET: readonly ActionSetItem[] = [
  { verb: 'reconnect', label: 'Reconnect', icon: ArrowsClockwiseIcon },
  { verb: 'disconnect', label: 'Disconnect', icon: PlugsIcon },
  { verb: 'install', label: 'Install apk', icon: DownloadSimpleIcon },
  { verb: 'adb', label: 'Adb command', icon: TerminalIcon },
  { verb: 'run-script', label: 'Run script', icon: PlayIcon },
  { verb: 'screenshot', label: 'Screenshot', icon: CameraIcon },
  { verb: 'sleep', label: 'Sleep', icon: MoonIcon },
  { verb: 'set-group', label: 'Move group', icon: FolderSimpleIcon },
  { verb: 'push', label: 'Upload file', icon: UploadSimpleIcon },
  { verb: 'clear-cache', label: 'Clear cache', icon: BroomIcon },
  { verb: 'settings', label: 'Settings', icon: GearIcon },
  { verb: 'forget', label: 'Forget', icon: TrashIcon, danger: true },
  { verb: 'prepare', label: 'Prepare', icon: PackageIcon, overflow: true },
  { verb: 'set-label', label: 'Label', icon: PencilSimpleIcon, overflow: true },
  { verb: 'set-network', label: 'Network', icon: BroadcastIcon, overflow: true },
]
