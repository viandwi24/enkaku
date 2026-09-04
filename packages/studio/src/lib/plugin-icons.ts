import {
  ArrowsClockwiseIcon,
  BellIcon,
  CheckIcon,
  CloudIcon,
  CubeIcon,
  DatabaseIcon,
  DownloadIcon,
  FileTextIcon,
  FolderIcon,
  FunnelIcon,
  GaugeIcon,
  GearIcon,
  GlobeIcon,
  HardDrivesIcon,
  InfoIcon,
  KeyIcon,
  LightningIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  NetworkIcon,
  PauseIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  PulseIcon,
  PuzzlePieceIcon,
  ShareNetworkIcon,
  ShieldIcon,
  StackIcon,
  StackSimpleIcon,
  TableIcon,
  TagIcon,
  TerminalIcon,
  UploadIcon,
  UsersIcon,
  WarningIcon,
  WrenchIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react'
import type { IconName } from '@enkaku/protocol'

/**
 * The allowlist of `ICON_NAMES` (`@enkaku/protocol`'s `plugin-surface.ts`)
 * mapped onto the real components (plan 108 §5 step 108.8; Phosphor since
 * plan 204 §3.7, ids unchanged so a bundled plugin's manifest still parses).
 *
 * A plugin names an icon; Studio draws it. The name is a KEY into this map
 * and nothing else — a plugin never supplies markup, a URL, or an SVG, so
 * there is no path by which a manifest could put arbitrary content in the
 * operator's sidebar.
 *
 * Typed as the exhaustive `Record<IconName, Icon>` on purpose: adding a
 * name to the protocol's allowlist without mapping it here fails `typecheck`
 * rather than shipping a blank square. Two ids have no Phosphor namesake
 * and are mapped by meaning: `activity` → Pulse, `boxes` → Stack.
 */
export const PLUGIN_ICONS: Record<IconName, Icon> = {
  users: UsersIcon,
  database: DatabaseIcon,
  network: NetworkIcon,
  globe: GlobeIcon,
  shield: ShieldIcon,
  activity: PulseIcon,
  box: CubeIcon,
  boxes: StackIcon,
  layers: StackSimpleIcon,
  list: ListIcon,
  table: TableIcon,
  settings: GearIcon,
  wrench: WrenchIcon,
  plug: PlugIcon,
  puzzle: PuzzlePieceIcon,
  key: KeyIcon,
  lock: LockIcon,
  server: HardDrivesIcon,
  cloud: CloudIcon,
  terminal: TerminalIcon,
  'file-text': FileTextIcon,
  folder: FolderIcon,
  search: MagnifyingGlassIcon,
  filter: FunnelIcon,
  zap: LightningIcon,
  gauge: GaugeIcon,
  bell: BellIcon,
  tag: TagIcon,
  link: LinkIcon,
  share: ShareNetworkIcon,
  download: DownloadIcon,
  upload: UploadIcon,
  play: PlayIcon,
  pause: PauseIcon,
  'refresh-cw': ArrowsClockwiseIcon,
  plus: PlusIcon,
  minus: MinusIcon,
  check: CheckIcon,
  x: XIcon,
  info: InfoIcon,
  'alert-triangle': WarningIcon,
}

/** What an unknown or missing name draws — the same mark the static Plugins nav entry uses. */
export const FALLBACK_PLUGIN_ICON: Icon = PuzzlePieceIcon

/**
 * A `Map` rather than an index into `PLUGIN_ICONS`: the name arriving here
 * came off the wire, so it is a `string`, and looking it up needs either a
 * cast (forbidden) or a lookup structure that already accepts one.
 */
const BY_NAME = new Map<string, Icon>(Object.entries(PLUGIN_ICONS))

/**
 * Resolves a wire-supplied icon name. Unknown or absent falls back rather
 * than throwing: a core newer than this Studio build can legitimately name an
 * icon that did not exist when this bundle was compiled, and losing the
 * operator's whole sidebar over a picture is the wrong trade.
 */
export function pluginIcon(name: string | null | undefined): Icon {
  if (!name) return FALLBACK_PLUGIN_ICON
  return BY_NAME.get(name) ?? FALLBACK_PLUGIN_ICON
}
