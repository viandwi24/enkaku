import type { LucideIcon } from 'lucide-react'
import { EthernetPort, Network, Usb, Wifi } from 'lucide-react'
import { connectionBadge, type DeviceConnection, type DeviceInfo } from '@enkaku/protocol'

/**
 * One adapter for the two fields plan 92 §4.8 lays a tile's line 1 out
 * around — the number and the connection glyph — so `WallTile` and
 * `DeviceCard` never read either field off `DeviceInfo` directly.
 *
 * Plan 88 (connection) has landed: `connection` is always present on a
 * parsed `DeviceInfo` (`DeviceConnectionSchema.default(...)`), so it is read
 * straight through, non-null.
 *
 * Plan 89 (a short per-device number — "nomor urut dari ketika awal koneksi,
 * incremental") has landed on `DeviceInfoSchema.number` (nullable, §3.1/§3.2).
 * `deviceNumberOf` reads the real field straight through — a caller still
 * renders a dash for `null`, which is honest, not a "plan 89 hasn't landed"
 * placeholder.
 *
 * `null` has TWO causes, and a reader who assumes only the first will be
 * wrong on a cloud node:
 *
 *  1. An admitted device whose reservation was explicitly released
 *     (`DELETE /api/devices/numbers/:stableId`) — rare, operator-initiated.
 *  2. **Every device on a cloud node**, always. Plan 89 §3.1 allocates at
 *     admission because `admitDevice()` is the only creator of a `devices`
 *     row — finding F2 proves that for local mode. It is not true in cloud
 *     mode: `packages/node/src/tunnel/registry.ts`'s `syncDevices` inserts
 *     rows itself and never reserves a number. Register entry 96.21 holds
 *     the two candidate fixes; the choice is the owner's, so until then a
 *     cloud fleet renders dashes and that is the truth, not a bug in this
 *     adapter.
 */
export interface TileIdentity {
  /** The device's short operator-facing number (plan 89 §3.1) — `null` only if its reservation was explicitly released. */
  number: number | null
  /** Plan 88's connection fact — always present today. */
  connection: DeviceConnection
}

/**
 * The exact fallback `DeviceInfoSchema.default(...)` uses for a row with no
 * connection info at all — mirrored here (not imported: the schema's
 * default is a factory closed over the schema, not an exported constant) so
 * a `DeviceInfo` built by hand for a test, the same convention this
 * workspace's OTHER component tests already lean on for every field they do
 * not care about, still renders a real glyph instead of throwing.
 */
const DEFAULT_CONNECTION: DeviceConnection = {
  kind: 'usb',
  medium: null,
  mediumSource: 'unknown',
  address: null,
  port: null,
  networkLabel: null,
}

export function tileIdentityOf(device: DeviceInfo): TileIdentity {
  // `?? null` guards a hand-built test fixture that omits the field
  // entirely (undefined) — `DeviceInfoSchema.number` is `.default(null)` on
  // a real parse, but a fixture built with `as DeviceInfo` bypasses that.
  return { number: device.number ?? null, connection: device.connection ?? DEFAULT_CONNECTION }
}

/**
 * USB | OTG | WI-FI | TCP → one glyph, no text (plan 92 §4.8: "a text badge
 * on a 180px tile costs roughly a third of line 1"). Keyed off the SAME
 * `connectionBadge()` classification `ConnectionBadge` uses for its own
 * text badge, so a tile's glyph and a device card's badge can never
 * disagree about what kind of connection a device has — only how many
 * pixels they spend saying so.
 */
export const TILE_CONNECTION_ICON: Record<ReturnType<typeof connectionBadge>, LucideIcon> = {
  USB: Usb,
  OTG: EthernetPort,
  'WI-FI': Wifi,
  TCP: Network,
}
