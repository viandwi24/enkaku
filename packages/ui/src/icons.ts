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
