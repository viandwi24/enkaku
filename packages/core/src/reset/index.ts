import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from '../util/paths'
import { dataDirHolder } from '../util/data-dir-lock'

/**
 * `enkaku reset` — delete parts of a data directory, on purpose, from the
 * release binary.
 *
 * Until this existed the only reset in the repo was the root `package.json`'s
 * `bun run reset`, an `rm -rf .dev-data .dev-cloud .dev-node .dev-agent` that
 * a released binary does not ship and that names dev paths nobody running a
 * farm has. So an operator whose database would not open had a choice
 * between guessing which files under their data directory were safe to
 * remove and starting over from nothing (owner, 2026-09-05).
 *
 * Three rules it follows, because this command deletes things:
 *
 * 1. **Nothing happens without `--yes`.** With no flag it prints what each
 *    scope holds and how big it is, and exits 0. A destructive default is
 *    how a command like this eats a farm.
 * 2. **It refuses while a core is running.** Deleting `enkaku.db` out from
 *    under a live SQLite connection does not stop that core — it leaves it
 *    writing to an unlinked inode and losing everything on exit.
 * 3. **It never deletes the encryption keys.** `secrets.key` and
 *    `network-credentials.key` decrypt stored credentials, including in a
 *    backup taken before the reset. A reset that removed them would silently
 *    turn every existing backup into an unreadable one, which is the exact
 *    failure `backup/index.ts` exists to prevent.
 */

interface Scope {
  id: string
  /** Files and directories, relative to the data dir. */
  entries: readonly string[]
  what: string
  /** Said before deleting, when the consequence is not obvious from the name. */
  consequence?: string
}

const DB_ENTRIES = ['enkaku.db', 'enkaku.db-wal', 'enkaku.db-shm'] as const

const SCOPES: readonly Scope[] = [
  {
    id: 'db',
    entries: DB_ENTRIES,
    what: 'the database — devices, groups, jobs, runs, scripts, users, tokens, settings, audit log',
    consequence: 'The next start creates an empty one and runs every migration from scratch. Phones come back as Discovered; everything else is gone.',
  },
  {
    id: 'artifacts',
    entries: ['artifacts'],
    what: 'stored artifacts — screenshots, pulled files, APKs, job outputs',
    consequence: 'Rows in the database that point at these become dead links until you reset the database too.',
  },
  { id: 'traces', entries: ['traces'], what: 'job traces — the frame-by-frame timeline behind each run' },
  { id: 'cache', entries: ['cache'], what: 'the cache — safe to delete at any time, it is rebuilt on demand' },
  { id: 'logs', entries: ['logs'], what: 'log files' },
  {
    id: 'plugins',
    entries: ['plugins'],
    what: 'installed plugin bundles',
    consequence: 'The bundled packs re-seed on the next start, but a plugin installed by hand has to be installed again, and its stored data lives in the database, not here.',
  },
  {
    id: 'tools',
    entries: ['tools'],
    what: 'the downloaded toolchain — adb, scrcpy-server, ui-server',
    consequence: 'The next start downloads and sha256-verifies them again. Minutes, and it needs the network.',
  },
  { id: 'workspace', entries: ['workspace-content'], what: 'agent workspace content' },
]

/** Never removed by any scope, including `--all`. See rule 3 above. */
const PROTECTED = ['secrets.key', 'network-credentials.key', '.guest-agent-token', 'enkaku.config.json'] as const

function sizeOf(path: string): number {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const child of readdirSync(path)) total += sizeOf(join(path, child))
  return total
}

function human(bytes: number): string {
  if (bytes === 0) return '0'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function presentEntries(dataDir: string, scope: Scope): { entry: string; bytes: number }[] {
  return scope.entries
    .map((entry) => ({ entry, bytes: sizeOf(join(dataDir, entry)) }))
    .filter(({ entry }) => existsSync(join(dataDir, entry)))
}

function usage(): string {
  return [
    'Usage: enkaku reset <scope…> [--yes]',
    '',
    'Scopes:',
    ...SCOPES.map((s) => `  --${s.id.padEnd(10)} ${s.what}`),
    '  --all        every scope above',
    '',
    'Without --yes nothing is deleted: the scopes you named are listed with their sizes.',
    `Never deleted, by any scope: ${PROTECTED.join(', ')}.`,
    '',
    'Take a backup first if the data still matters:  enkaku backup',
  ].join('\n')
}

export async function runReset(argv: string[] = process.argv.slice(3)): Promise<number> {
  const dataDir = resolveDataDir()
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '')))
  const confirmed = flags.delete('yes')
  const all = flags.delete('all')

  const unknown = [...flags].filter((f) => !SCOPES.some((s) => s.id === f))
  if (unknown.length > 0) {
    console.error(`enkaku reset: unknown scope${unknown.length === 1 ? '' : 's'}: ${unknown.map((f) => `--${f}`).join(', ')}\n`)
    console.error(usage())
    return 1
  }

  const selected = all ? SCOPES : SCOPES.filter((s) => flags.has(s.id))
  if (selected.length === 0) {
    console.log(usage())
    console.log(`\nData directory: ${dataDir}`)
    for (const scope of SCOPES) {
      const present = presentEntries(dataDir, scope)
      const bytes = present.reduce((sum, e) => sum + e.bytes, 0)
      console.log(`  --${scope.id.padEnd(10)} ${present.length === 0 ? 'nothing here' : human(bytes)}`)
    }
    return 0
  }

  // Rule 2: never touch a running farm's files.
  const holder = dataDirHolder(dataDir)
  if (holder) {
    console.error(
      `enkaku reset: a core (pid ${holder.pid}, started ${holder.startedAt}) is using ${dataDir}.\n` +
        'Stop it first. Deleting these files under a running core does not stop it — it keeps writing to files that no longer have names, and loses the lot on exit.',
    )
    return 1
  }

  const plan = selected.map((scope) => ({ scope, present: presentEntries(dataDir, scope) })).filter((p) => p.present.length > 0)
  if (plan.length === 0) {
    console.log(`Nothing to delete in ${dataDir} for the scopes you named.`)
    return 0
  }

  const total = plan.reduce((sum, p) => sum + p.present.reduce((s, e) => s + e.bytes, 0), 0)
  console.log(`Data directory: ${dataDir}\n`)
  for (const { scope, present } of plan) {
    const bytes = present.reduce((s, e) => s + e.bytes, 0)
    console.log(`  ${scope.id} (${human(bytes)}) — ${scope.what}`)
    for (const { entry } of present) console.log(`      ${entry}`)
    if (scope.consequence) console.log(`      ${scope.consequence}`)
  }
  console.log(`\n  ${human(total)} in total.`)

  if (!confirmed) {
    console.log('\nNothing was deleted. Re-run with --yes to actually delete it, and consider `enkaku backup` first.')
    return 0
  }

  let removed = 0
  for (const { scope, present } of plan) {
    for (const { entry } of present) {
      // Belt for rule 3: a scope may never name a protected file, and this
      // check is what makes that true rather than merely intended.
      if ((PROTECTED as readonly string[]).includes(entry)) continue
      try {
        rmSync(join(dataDir, entry), { recursive: true, force: true })
        removed += 1
      } catch (err) {
        console.error(`  could not delete ${entry}: ${err instanceof Error ? err.message : String(err)}`)
        return 1
      }
    }
    console.log(`  reset ${scope.id}`)
  }

  console.log(`\nDeleted ${removed} item(s), ${human(total)}. The next start rebuilds what it needs.`)
  return 0
}
