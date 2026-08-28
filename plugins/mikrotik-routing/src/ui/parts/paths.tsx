import { useState } from 'react'
import { Badge, Button, EmptyState, ErrorState, LoadingRows, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@enkaku/ui'
import { fetchInventory, isRefusal, loadRouterPresence, probeEgress, type EgressProbe, type Iface, type Path, type PathHealth } from './api'
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

/**
 * Why a path is down, in words that name the thing to go and look at
 * (plan 133 §3.3). The first sentence is the one that would have ended the
 * owner's 2026-08-26 debugging session in seconds: two Orbits had been left on
 * the factory-default `192.168.8.0/24`, so the router held no address in the
 * subnet its route pointed at, and both read simply "Down".
 *
 * An unrecognised reason falls through to `null` and the badge stays exactly
 * what it was — a newer core must never blank this cell.
 */
export function describeDownReason(reason: string | undefined, gateway: string | null): string | null {
  switch (reason) {
    case 'no-route-to-gateway':
      return `The router has no address on ${gateway ? subnetOf(gateway) : "this gateway's subnet"}, so it cannot reach this modem at all. Check that port's VLAN and DHCP client on the router — the modem itself may be fine.`
    case 'gateway-unreachable':
      return `${gateway ?? 'The gateway'} did not answer. The modem is off, unplugged, or not responding to check-gateway.`
    case 'no-default-route':
      return 'This routing table has no default route. Nothing can egress through it.'
    default:
      return null
  }
}

/** `192.168.125.1` → `192.168.125.0/24`. Best-effort: anything that is not a dotted quad is returned unchanged. */
function subnetOf(gateway: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(gateway.trim())
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : gateway
}


/**
 * Plan 134 (M99) §4.4 — the egress cell, and the one thing on this screen that
 * costs money to fill in.
 *
 * `unknown` renders as "Not measured" and looks like the absence it is: no
 * tick, no colour, no implication either way. That is the entire reason the
 * three-field model beats the boolean it replaced — device #20's modem
 * answered every ping and had no data plan, and a green chip said so.
 *
 * The probe is a button, never an effect: nothing here may fire on mount, on
 * refresh, or on a timer (§2 — forty modems on metered SIMs).
 */
function EgressCell({ path, health }: { path: Path; health: PathHealth | undefined }) {
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<EgressProbe | null>(null)
  const [error, setError] = useState<string | null>(null)

  const iface = path.wanInterface ?? null
  const status = probe?.status ?? health?.egress ?? 'unknown'

  const run = async () => {
    if (!iface) return
    setBusy(true)
    setError(null)
    try {
      const result = await probeEgress(iface)
      if (isRefusal(result)) {
        setError(result.message)
        return
      }
      setProbe(result.probe)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <Badge variant="outline" className={cn(status === 'ok' ? 'text-led-ok' : status === 'fail' ? 'text-led-danger' : 'text-fg-muted')}>
        <span className={cn('size-1.5 rounded-full', status === 'ok' ? 'bg-led-ok' : status === 'fail' ? 'bg-led-danger' : 'bg-led-off')} aria-hidden />
        {status === 'ok' ? 'Reaches internet' : status === 'fail' ? 'No internet' : 'Not measured'}
      </Badge>
      {probe ? <p className="max-w-[42ch] text-[11px] leading-relaxed text-fg-muted">{probe.message}</p> : null}
      {error ? <p className="max-w-[42ch] text-[11px] leading-relaxed text-led-danger">{error}</p> : null}
      {iface ? (
        <Button size="sm" variant="ghost" onClick={run} disabled={busy} title={`Sends a few packets out of ${iface}. Costs a little mobile data.`}>
          {busy ? 'Probing…' : probe ? 'Probe again' : 'Probe'}
        </Button>
      ) : (
        // No `immediate-gw` means the router could not resolve an uplink for
        // this path — the plan 133 fault. There is nothing to probe THROUGH,
        // and the health cell beside this one already says why.
        <p className="text-[11px] text-fg-muted">No uplink resolved — nothing to probe through.</p>
      )}
    </div>
  )
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
              {/* Plan 134 (M99) — a separate column, not a second chip in
                  "Health": "the modem answers" and "the modem has internet"
                  are different facts, and merging them is the exact mistake
                  that reported device #20 healthy with no data plan. */}
              <TableHead>Egress</TableHead>
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
                  {/* Plan 133 §3.3 — a red chip tells an operator that
                      something is wrong; this tells them what to go and look
                      at. Rendered only when the core actually sent a reason
                      it recognises, so an older core or an unfamiliar value
                      leaves the cell exactly as it was. */}
                  {(() => {
                    const why = describeDownReason(data.health.get(path.id)?.reason, path.gateway)
                    return why ? <p className="mt-1 max-w-[38ch] text-[11px] leading-relaxed text-fg-muted">{why}</p> : null
                  })()}
                  {/* Plan 134 §3.4 — the loudest thing on the screen, because
                      it is the fault that cost the owner a router CLI session:
                      two uplinks holding the same address. It names the other
                      path so nobody has to cross-reference forty rows. */}
                  {(data.health.get(path.id)?.duplicateAddressWith ?? []).length > 0 ? (
                    <p className="mt-1 max-w-[38ch] text-[11px] leading-relaxed text-led-danger">
                      This uplink holds the SAME address as {(data.health.get(path.id)?.duplicateAddressWith ?? []).join(', ')}. Two modems are on one subnet — almost always a modem left on its
                      factory-default LAN range. Change one modem's LAN subnet; the router cannot route to either reliably until you do.
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <EgressCell path={path} health={data.health.get(path.id)} />
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
