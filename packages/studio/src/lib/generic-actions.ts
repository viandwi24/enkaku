import {
  ArrowsClockwiseIcon,
  BroomIcon,
  CameraIcon,
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
  PlugsIcon as NetworkIcon,
  RobotIcon,
  SunIcon,
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
  /**
   * Which run of rows this belongs to. Rendered in this order, each run
   * separated by a rule — a flat list of eighteen rows is a list nobody
   * reads, and the owner asked for exactly this shape (2026-09-05).
   *
   * The runs are by WHEN you reach for them, not by what subsystem they
   * touch: connection first (the thing you do before anything else works),
   * then what you do TO the phone, then what you run ON it, then files and
   * the agent, then the rare and the destructive.
   */
  group: ActionGroup
  /**
   * Rendered under the last separator, after every group: rarely reached,
   * reached deliberately. `overflow` is now a group like any other and this
   * flag is gone — see `ActionGroup`.
   */
}

/**
 * The runs, in render order. `danger` is last and holds only Forget.
 */
export const ACTION_GROUPS = ['connection', 'device', 'run', 'files', 'config', 'rare', 'danger'] as const
export type ActionGroup = (typeof ACTION_GROUPS)[number]

export const GENERIC_ACTIONS: readonly GenericAction[] = [
  // Connection — nothing else on this menu works until these do.
  { id: 'reconnect', label: 'Reconnect', icon: ArrowsClockwiseIcon, group: 'connection' },
  { id: 'disconnect', label: 'Disconnect', icon: PlugsIcon, group: 'connection' },
  { id: 'set-network', label: 'Network', icon: NetworkIcon, group: 'connection' },

  // Things you do TO the phone.
  { id: 'install', label: 'Install apk', icon: DownloadSimpleIcon, group: 'device' },
  { id: 'adb', label: 'Adb command', icon: TerminalIcon, group: 'device' },
  { id: 'wake', label: 'Wake', icon: SunIcon, group: 'device' },
  { id: 'sleep', label: 'Sleep', icon: MoonIcon, group: 'device' },

  // Things you run ON it.
  { id: 'run-script', label: 'Run script', icon: PlayIcon, group: 'run' },
  { id: 'run-workflow', label: 'Run workflow', icon: FlowArrowIcon, group: 'run' },

  // Files, both directions, and the agent that is itself a file.
  { id: 'push', label: 'Upload file', icon: UploadSimpleIcon, group: 'files' },
  { id: 'pull', label: 'Download file', icon: ExportIcon, group: 'files' },
  { id: 'install-agent', label: 'Install guest agent', icon: RobotIcon, group: 'files' },
  { id: 'uninstall-agent', label: 'Uninstall guest agent', icon: RobotIcon, group: 'files', danger: true },

  // How the phone is set up and named.
  { id: 'settings', label: 'Settings', icon: GearIcon, group: 'config' },
  { id: 'set-group', label: 'Move group', icon: FolderSimpleIcon, submenu: 'group', group: 'config' },
  { id: 'set-label', label: 'Label', icon: PencilSimpleIcon, group: 'config' },

  // Reached deliberately, not in the course of ordinary work. Screenshot
  // moved here from the main set (owner, 2026-09-05): it is not the browser
  // screenshot its name suggests — it writes a PNG into this device's
  // artifacts — so it belongs beside the other things you go looking for
  // rather than in the first run of every menu.
  { id: 'screenshot', label: 'Screenshot', icon: CameraIcon, group: 'rare' },
  { id: 'prepare', label: 'Prepare', icon: LightningIcon, group: 'rare' },
  { id: 'clear-cache', label: 'Clear cache', icon: BroomIcon, group: 'rare' },

  { id: 'forget', label: 'Forget', icon: TrashIcon, danger: true, group: 'danger' },
]
export type GenericActionId = GenericAction['id']
