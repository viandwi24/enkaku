/**
 * Delete every script row that no plugin owns.
 *
 * Plan 110 made a plugin the only publish unit, and the registry now ignores a
 * `kind: 'script'` row with no owning plugin — it stops listing and stops
 * resolving. Ignoring is not removing, though: the rows stay in the database,
 * and a farm upgraded from before the rule still carries whatever it published
 * under the old model. This removes them.
 *
 * ## Why it reads the DATABASE to find them, and the API to delete them
 *
 * The obvious implementation — list the scripts over HTTP and keep the ones
 * with no plugin — **cannot work, and failing to notice that is the trap this
 * comment exists to stop.** `GET /api/scripts` and `?group=name` now apply the
 * registry's own rule and hide exactly these rows; a script deriving its list
 * from them is blind to its own targets. (Written that way first; it reported
 * "nothing to delete" on a farm holding five.)
 *
 * `GET /api/scripts/:name/versions` IS deliberately left unfiltered, precisely
 * so an operator can still resolve ids to delete — but it is a lookup BY NAME,
 * so something has to supply the names. That is the database, opened
 * read-only.
 *
 * Deletion then goes back through `DELETE /api/scripts/:id` rather than SQL,
 * so the core's own guard still applies: a row a queued or running job still
 * references is refused (`script_in_use`), and that refusal is reported here
 * rather than bulldozed. Read from the DB, write through the API.
 *
 * A `kind: 'workflow'` row is skipped in the query. A workflow legitimately has
 * no owning plugin (plan 110 §3.3 — its bundle is a WorkflowDoc, it has no
 * `run()` and no members, so there is no plugin for it to be a member of), and
 * a blanket "no plugin ⇒ delete" rule would take every workflow on the farm.
 *
 * ## What survives
 *
 * Job history. `jobs.script_name`/`script_version` are denormalised at enqueue
 * precisely so a deleted script does not erase what already ran (plan 82 §3.4).
 * The core also refuses to delete a row a queued or running job still
 * references (`script_in_use`) — that refusal is reported here, never
 * swallowed.
 *
 * Usage:
 *   bun scripts/delete-unowned-scripts.ts --dry-run      # show what would go
 *   bun scripts/delete-unowned-scripts.ts                # do it
 *   bun scripts/delete-unowned-scripts.ts --farm http://host:7700 --data-dir .dev-data
 */
import { Database } from 'bun:sqlite'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const farmIndex = argv.indexOf('--farm')
const farm = (farmIndex >= 0 ? argv[farmIndex + 1] : undefined) ?? process.env.ENKAKU_FARM_URL ?? 'http://localhost:7700'
const token = process.env.ENKAKU_TOKEN

const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}

const dataDirIndex = argv.indexOf('--data-dir')
const dataDir = (dataDirIndex >= 0 ? argv[dataDirIndex + 1] : undefined) ?? process.env.ENKAKU_DATA_DIR ?? '.dev-data'
const dbPath = join(dataDir, 'enkaku.db')

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${farm.replace(/\/$/, '')}${path}`, { headers })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}

// Read-only, and only this one query: which script NAMES have no owning plugin.
// The core is running against this same file — `readonly` keeps us out of its
// way, and the deletes below go over HTTP so the core stays the only writer.
const db = new Database(dbPath, { readonly: true })
const unowned = db
  .query<{ name: string; versions: number }, []>(
    `SELECT name, COUNT(*) AS versions
       FROM scripts
      WHERE plugin_id IS NULL AND kind = 'script'
      GROUP BY name
      ORDER BY name`,
  )
  .all()
db.close()

console.log(`farm     : ${farm}`)
console.log(`database : ${dbPath} (read-only)`)

if (unowned.length === 0) {
  console.log('\nnothing to delete — every script row on this farm belongs to a plugin.')
  process.exit(0)
}

const totalVersions = unowned.reduce((n, g) => n + g.versions, 0)
console.log(`\nto delete: ${unowned.length} name(s), ${totalVersions} version(s)`)
for (const g of unowned) console.log(`  ${g.name.padEnd(24)} ${g.versions} version(s)`)

if (dryRun) {
  console.log('\n--dry-run: nothing was deleted.')
  process.exit(0)
}

let deleted = 0
const refused: string[] = []

for (const group of unowned) {
  // Unfiltered on purpose (see this file's header) — the one endpoint that can
  // still see a row the listings now hide.
  const versions = (await getJson<{ items: { id: string; version: string }[] }>(`/api/scripts/${encodeURIComponent(group.name)}/versions`)).items
  for (const v of versions) {
    const res = await fetch(`${farm.replace(/\/$/, '')}/api/scripts/${encodeURIComponent(v.id)}`, { method: 'DELETE', headers })
    if (res.ok) {
      deleted++
      continue
    }
    // A refusal is reported with the core's own coded message — chiefly
    // `script_in_use`, which means a queued or running job still references
    // this exact version. That is the core protecting a live job, not a bug.
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    refused.push(`${group.name}@${v.version}: ${body?.error?.code ?? res.status} — ${body?.error?.message ?? 'no message'}`)
  }
}

console.log(`\ndeleted  : ${deleted} version(s)`)
if (refused.length > 0) {
  console.log(`refused  : ${refused.length}`)
  for (const r of refused) console.log(`  ${r}`)
  process.exit(1)
}
console.log('every unowned script is gone.')
