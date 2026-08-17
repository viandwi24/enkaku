import {
  Activity,
  AlertTriangle,
  Bell,
  Box,
  Boxes,
  Check,
  Cloud,
  Database,
  Download,
  FileText,
  Filter,
  Folder,
  Gauge,
  Globe,
  Info,
  Key,
  Layers,
  Link as LinkIcon,
  List,
  Lock,
  Minus,
  Network,
  Pause,
  Play,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Settings,
  Share,
  Shield,
  Table,
  Tag,
  Terminal,
  Upload,
  Users,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { IconName } from '@enkaku/protocol'

/**
 * The allowlist of `ICON_NAMES` (`@enkaku/protocol`'s `plugin-surface.ts`)
 * mapped onto the real components (plan 108 §5 step 108.8).
 *
 * A plugin names an icon; Studio draws it. The name is a KEY into this map
 * and nothing else — a plugin never supplies markup, a URL, or an SVG, so
 * there is no path by which a manifest could put arbitrary content in the
 * operator's sidebar.
 *
 * Typed as the exhaustive `Record<IconName, LucideIcon>` on purpose: adding a
 * name to the protocol's allowlist without mapping it here fails `typecheck`
 * rather than shipping a blank square.
 */
export const PLUGIN_ICONS: Record<IconName, LucideIcon> = {
  users: Users,
  database: Database,
  network: Network,
  globe: Globe,
  shield: Shield,
  activity: Activity,
  box: Box,
  boxes: Boxes,
  layers: Layers,
  list: List,
  table: Table,
  settings: Settings,
  wrench: Wrench,
  plug: Plug,
  puzzle: Puzzle,
  key: Key,
  lock: Lock,
  server: Server,
  cloud: Cloud,
  terminal: Terminal,
  'file-text': FileText,
  folder: Folder,
  search: Search,
  filter: Filter,
  zap: Zap,
  gauge: Gauge,
  bell: Bell,
  tag: Tag,
  link: LinkIcon,
  share: Share,
  download: Download,
  upload: Upload,
  play: Play,
  pause: Pause,
  'refresh-cw': RefreshCw,
  plus: Plus,
  minus: Minus,
  check: Check,
  x: X,
  info: Info,
  'alert-triangle': AlertTriangle,
}

/** What an unknown or missing name draws — the same mark the static Plugins nav entry uses. */
export const FALLBACK_PLUGIN_ICON: LucideIcon = Puzzle

/**
 * A `Map` rather than an index into `PLUGIN_ICONS`: the name arriving here
 * came off the wire, so it is a `string`, and looking it up needs either a
 * cast (forbidden) or a lookup structure that already accepts one.
 */
const BY_NAME = new Map<string, LucideIcon>(Object.entries(PLUGIN_ICONS))

/**
 * Resolves a wire-supplied icon name. Unknown or absent falls back rather
 * than throwing: a core newer than this Studio build can legitimately name an
 * icon that did not exist when this bundle was compiled, and losing the
 * operator's whole sidebar over a picture is the wrong trade.
 */
export function pluginIcon(name: string | null | undefined): LucideIcon {
  if (!name) return FALLBACK_PLUGIN_ICON
  return BY_NAME.get(name) ?? FALLBACK_PLUGIN_ICON
}
