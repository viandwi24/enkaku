/**
 * The icon set (plan 204 §4.5). Phosphor regular, `@phosphor-icons/react`
 * 2.1.10 (plan 200 R6), re-exported under the package's current `*Icon`
 * names so a plugin reaches them through `@enkaku/ui` (external at runtime)
 * instead of bundling its own copy of Phosphor.
 *
 * Group 1 is every `ph-*` name the design handoff uses, in the README's
 * alphabetical order; `icons.test.ts` derives that list from the README
 * itself, so a name added to the design and not here fails a test.
 */
export type { Icon, IconProps } from '@phosphor-icons/react'

export {
  ArrowsClockwiseIcon,
  BellIcon,
  BroadcastIcon,
  BroomIcon,
  CameraIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CheckIcon,
  CircleIcon,
  ClipboardIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
  DevicesIcon,
  DotOutlineIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FileIcon,
  FileCodeIcon,
  FilePlusIcon,
  FilmSlateIcon,
  FilmStripIcon,
  FlowArrowIcon,
  FolderSimpleIcon,
  FunnelIcon,
  GearIcon,
  ImageIcon,
  ImagesIcon,
  LightningIcon,
  ListDashesIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PackageIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlugsIcon,
  PlusIcon,
  PowerIcon,
  PuzzlePieceIcon,
  RowsIcon,
  SignInIcon,
  SignOutIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerSlashIcon,
  SquareIcon,
  SquaresFourIcon,
  SunIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TrashIcon,
  TrayArrowDownIcon,
  UploadSimpleIcon,
  XIcon,
} from '@phosphor-icons/react'

/** Group 2: drawn by the primitives, not named by the handoff. */
export {
  CaretRightIcon,
  CaretUpIcon,
  CaretUpDownIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  InfoIcon,
  TrayIcon,
  WarningIcon,
  XCircleIcon,
} from '@phosphor-icons/react'

/**
 * Group 3: names added after the handoff was drawn, each with the reason.
 * A name belongs here only when a screen the handoff does not draw needs it.
 *
 * - `RobotIcon` for the Agents rail entry (MVP 03 §1; the handoff draws no
 *   Agents item because MVP 15 §4.1 left it open). Plan 213 §3.4.
 * - `ClockIcon` for the Schedules tab (MVP 15 §0.1.1) — a correction added
 *   after the design was drawn, so no `ph-*` name for it exists in the
 *   handoff's own README. Plan 217 §4.12.
 * - `ArrowsLeftRightIcon`, `CopyIcon`, `DeviceMobileIcon`, `ExportIcon`,
 *   `PauseIcon` for the Jobs screen's transport pause, its three header
 *   buttons and its Copy JSON / compare controls (plan 218 §4.13). The
 *   prototype file draws them (`Enkaku Device List.dc.html:1400-1401`,
 *   `:1541`); only the README's prose, which group 1 is derived from, does
 *   not name them.
 */
export {
  ArrowsLeftRightIcon,
  ClockIcon,
  CopyIcon,
  DeviceMobileIcon,
  ExportIcon,
  PauseIcon,
  RobotIcon,
} from '@phosphor-icons/react'

/**
 * Plan 220 (Agents page) — a further set the handoff draws no screen for
 * (MVP 15 §2 lists Agents as undesigned). `RobotIcon`/`CopyIcon` above
 * already cover the rail entry and the roster's Duplicate action; these
 * cover the rest of the agent subsystem's lucide-react replacements
 * (Roster, the Workbench, Files, the ai-elements composer/reasoning/
 * conversation controls).
 */
export {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowSquareOutIcon,
  BrainIcon,
  EyeSlashIcon,
  FloppyDiskIcon,
  ImageBrokenIcon,
  PaperPlaneRightIcon,
  PaperclipIcon,
  RocketIcon,
} from '@phosphor-icons/react'

/**
 * The Devices toolbar's fleet menu (owner, 2026-09-04). `DotsThreeIcon` in
 * group 1 is the HORIZONTAL glyph, which is what that toolbar's button first
 * shipped with — but every other overflow control in the product is the
 * vertical kebab, and a row of icons reads as a row whichever way the dots
 * lie. This is the vertical one.
 */
export { DotsThreeVerticalIcon } from '@phosphor-icons/react'
