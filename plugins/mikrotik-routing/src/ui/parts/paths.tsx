import { Badge, Button, EmptyState, ErrorState, LoadingRows, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@enkaku/ui'
import { fetchInventory, isRefusal, loadRouterPresence, type Iface, type Path, type PathHealth } from './api'
import { useLoader } from './bits'

/**
 * Paths — the plan's own §5 step 122.3 wording: "each routing table with a
 * default route, its gateway, bound interface, health (up/down/unknown, from
 * §4.5's active flag), and how many devices are assigned to it (zero for
 * now — no assignments exist yet; show the column, don't fake numbers)."
 * A Refresh action re-reads the router.
 */

interface Loaded {
  configured: boolean
  paths: Path[]
  interfaces: Iface[]
  health: Map<string, PathHealth>
}

/**
 * A path's `gateway` (from `/ip/route`) is either a next-hop IP, or —
 * routinely, on the owner's own LTE-modem farm this plan is built for — a
 * bare interface name, because a PPP/LTE uplink has no next-hop IP at all
 * (§0.1's own worked example: `table=via-modem7-p12`). RouterOS also spells a
 * link-local next-hop `<ip>%<interface>`. Either way this is a CLIENT-SIDE
 * join over inventory data already fetched — never a second endpoint, never
 * an invented schema field (`service/schemas.ts`'s own header: only
 * `/routing/rule`'s shape is hardware-verified, the rest is inferred from
 * public docs, so nothing here should assume a shape stronger than that).
 * `null` when nothing in the fetched interface list matches — rendered as
 * "—", never guessed.
 */
function boundInterface(gateway: string | null, interfaces: Iface[]): string | null {
  if (!gateway) return null
  const token = gateway.includes('%') ? (gateway.split('%')[1] ?? '') : gateway
  return interfaces.find((i) => i.name === token)?.name ?? null
}

function HealthBadge({ health }: { health: PathHealth | undefined }) {
  if (!health) {
    return (
      <Badge variant="outline" className="text-fg-muted">
        <span className="size-1.5 rounded-full bg-led-off" aria-hidden />
        Unknown
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={cn(health.up ? 'text-led-ok' : 'text-led-danger')}>
      <span className={cn('size-1.5 rounded-full', health.up ? 'bg-led-ok' : 'bg-led-danger')} aria-hidden />
      {health.up ? 'Up' : 'Down'}
    </Badge>
  )
}

export function PathsTab() {
  const load = async (): Promise<Loaded> => {
    const presence = await loadRouterPresence()
    if (!presence.saved) return { configured: false, paths: [], interfaces: [], health: new Map() }
    const result = await fetchInventory()
    if (isRefusal(result)) throw new Error(result.message)
    return {
      configured: true,
      paths: result.inventory.paths,
      interfaces: result.inventory.interfaces,
      health: new Map(result.inventory.health.map((h) => [h.pathId, h])),
    }
  }
  const { data, error, loading, reload } = useLoader(load, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">
          Every routing table on the router that carries a default route — the egress paths a device can be assigned to. Read live from the router; nothing here is cached.
        </p>
        <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <LoadingRows rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data?.configured ? (
        <EmptyState
          title="No router connection saved yet"
          description="Open the Settings tab and save a router connection — paths are read from the router once one is."
        />
      ) : data.paths.length === 0 ? (
        <EmptyState title="No routing tables with a default route" description="This plugin only lists tables that carry a default route (§4.5) — configure the router's own WAN paths first; this plugin reads them, it does not create them." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Path</TableHead>
              <TableHead>Gateway</TableHead>
              <TableHead>Interface</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Devices assigned</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.paths.map((path) => (
              <TableRow key={path.id}>
                <TableCell className="font-medium">{path.table}</TableCell>
                <TableCell className="text-fg-muted">{path.gateway ?? '—'}</TableCell>
                <TableCell className="text-fg-muted">{boundInterface(path.gateway, data.interfaces) ?? '—'}</TableCell>
                <TableCell>
                  <HealthBadge health={data.health.get(path.id)} />
                </TableCell>
                {/* Always 0 — no group/assignment data model exists yet (plan 122 §5 steps 122.5–122.8). The column is shown, not hidden, so this reads as "not built yet" rather than "silently wrong". */}
                <TableCell className="text-fg-muted" title="No assignments exist yet — this column is not faked.">
                  0
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
