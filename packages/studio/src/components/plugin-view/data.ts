import { PluginDataListResponseSchema, PluginDataScanResponseSchema, type DataSource } from '@enkaku/protocol'
import { rowsFromList, rowsFromScan, type PluginViewRow } from '@/components/plugin-view/rows'
import { api } from '@/lib/actions'

/**
 * Plan 108 §4.5, §4.7 — turning a view's DECLARED data source into rows, over
 * the two routes the surface vocabulary can name and no others.
 *
 * | `data.kind` | route | one row is |
 * |---|---|---|
 * | `kv.scan` | `GET /:name/data/scan?key=…` | one device, or one element of `itemsAt` inside that device's entry |
 * | `kv.list` | `GET /:name/data?scope=global` | one entry in the plugin's global namespace |
 *
 * Split out of `ViewRenderer` at step 108.10 so the tier-B frame's
 * `data.query` RPC reaches the SAME code path a tier-A table does
 * (`FrameView.tsx`). That is not a tidy-up: §4.4's whole claim is that the
 * frame changes the rendering and never the authority, and the cheapest way
 * for that claim to quietly stop being true is a second fetch helper that
 * grows a parameter the first one does not have.
 *
 * The namespace is never a parameter here either — it is the `:name` path
 * segment, exactly as §3.7 requires of the routes themselves.
 */

/** One page of whichever route this view's data source names. */
export async function fetchPluginPage(
  plugin: string,
  source: DataSource,
  cursor: string | null,
): Promise<{ rows: PluginViewRow[]; nextCursor: string | null }> {
  if (source.kind === 'kv.scan') {
    const qs = new URLSearchParams({ key: source.key, limit: '200', ...(cursor ? { cursor } : {}) })
    const body = await api(`/api/plugins/${encodeURIComponent(plugin)}/data/scan?${qs.toString()}`, PluginDataScanResponseSchema)
    return { rows: rowsFromScan(body.items, source), nextCursor: body.nextCursor }
  }
  const qs = new URLSearchParams({ scope: 'global', limit: '200', ...(source.prefix ? { prefix: source.prefix } : {}), ...(cursor ? { cursor } : {}) })
  const body = await api(`/api/plugins/${encodeURIComponent(plugin)}/data?${qs.toString()}`, PluginDataListResponseSchema)
  return { rows: rowsFromList(body.items), nextCursor: body.nextCursor }
}

/**
 * Every page, walked internally. Capped for the same reason `fetchAllPages`
 * is: a farm with a runaway row count must not hang the tab, and a cap that
 * is hit shows the rows it did get rather than nothing at all.
 */
export async function fetchPluginRows(plugin: string, source: DataSource): Promise<PluginViewRow[]> {
  const all: PluginViewRow[] = []
  let cursor: string | null = null
  for (let page = 0; page < 25; page++) {
    const next: { rows: PluginViewRow[]; nextCursor: string | null } = await fetchPluginPage(plugin, source, cursor)
    all.push(...next.rows)
    if (!next.nextCursor) break
    cursor = next.nextCursor
  }
  return all
}
