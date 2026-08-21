import { Badge, Button, EmptyState, ErrorState, LoadingRows, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@enkaku/ui'
import { fetchRules, isRefusal, loadRouterPresence, type RuleRow } from './api'
import { useLoader } from './bits'

/**
 * Rules — the plan's own §5 step 122.3 wording: "every router rule split
 * Managed | Foreign, foreign rows greyed and non-actionable, precisely so an
 * operator can see the plugin is not touching them." §3.1: this plugin
 * writes to exactly one endpoint, `/routing/rule`, and the write-scope
 * comment marker (§4.2) is the whole reason a human reading the router can
 * tell the two apart — this tab is that same boundary, shown rather than
 * merely documented. No row here is actionable yet (no write path exists,
 * §5 step 122.3's own scope), so nothing on this tab is a button.
 */

interface Loaded {
  configured: boolean
  managed: RuleRow[]
  foreign: RuleRow[]
}

function MarkerCell({ row }: { row: RuleRow }) {
  if (row.marker) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{row.marker.groupId}</Badge>
        <span className="text-[11px] text-fg-muted">{row.marker.endpointKey}</span>
      </div>
    )
  }
  if (row.markerIssue) {
    return (
      <span className="text-[11px] text-led-warn" title={row.markerIssue}>
        {row.markerIssue}
      </span>
    )
  }
  return <span className="text-fg-muted">—</span>
}

function RuleTable({ rows, foreign }: { rows: RuleRow[]; foreign: boolean }) {
  if (rows.length === 0) {
    return <p className="px-1 text-[12px] text-fg-muted">{foreign ? 'No foreign rules on this router.' : 'No managed rules yet — nothing has ever written one.'}</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Comment</TableHead>
          <TableHead>Source address</TableHead>
          <TableHead>Table</TableHead>
          <TableHead>{foreign ? '' : 'Group · endpoint'}</TableHead>
          <TableHead>Disabled</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className={foreign ? 'text-fg-muted opacity-70' : undefined}>
            <TableCell className="max-w-xs truncate font-mono text-[12px]" title={row.comment}>
              {row.comment || '—'}
              {row.isLocalException && (
                <Badge variant="outline" className="ml-2 text-led-warn">
                  local exception (§3.2) — never touched
                </Badge>
              )}
            </TableCell>
            <TableCell>{row.srcAddress ?? '—'}</TableCell>
            <TableCell>{row.table ?? '—'}</TableCell>
            <TableCell>{foreign ? null : <MarkerCell row={row} />}</TableCell>
            <TableCell>{row.disabled ? 'Yes' : 'No'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function RulesTab() {
  const load = async (): Promise<Loaded> => {
    const presence = await loadRouterPresence()
    if (!presence.saved) return { configured: false, managed: [], foreign: [] }
    const result = await fetchRules()
    if (isRefusal(result)) throw new Error(result.message)
    return { configured: true, managed: result.items.filter((r) => r.managed), foreign: result.items.filter((r) => !r.managed) }
  }
  const { data, error, loading, reload } = useLoader(load, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">
          Every rule on the router, split by whether its comment carries this plugin's own marker (§4.2). Foreign rows are greyed and have no action here — this plugin only ever writes a comment starting with{' '}
          <span className="font-mono">enkaku:mikrotik-routing:</span>.
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
        <EmptyState title="No router connection saved yet" description="Open the Settings tab and save a router connection — rules are read from the router once one is." />
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-[13px] font-medium">Managed ({data.managed.length})</h3>
            <RuleTable rows={data.managed} foreign={false} />
          </section>
          <section className="space-y-2">
            <h3 className="text-[13px] font-medium">Foreign ({data.foreign.length})</h3>
            <RuleTable rows={data.foreign} foreign />
          </section>
        </>
      )}
    </div>
  )
}
