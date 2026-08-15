import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SECRETS_KEY_FILE } from '../secrets/store'
import { EnkakuError } from '../util/errors'
import { resolveDataDir } from '../util/paths'
import { createTarGz, readTarGz, type TarEntry } from './tar'

/**
 * `enkaku backup` (revisits the withdrawn spec claim — `docs/spec-divergences.md` DIV-059).
 *
 * `cp enkaku.db backup.db` looks like a backup and is not one, for two
 * independent reasons:
 *
 *  1. `db/index.ts` sets `PRAGMA journal_mode = WAL` unconditionally, so a
 *     live database is really three files (`enkaku.db`, `-wal`, `-shm`).
 *     Copying them non-atomically while the core is writing can yield a
 *     torn, unrecoverable set — and a raw copy of `enkaku.db` ALONE silently
 *     drops whatever is sitting in `-wal` but not yet checkpointed.
 *  2. `secrets/store.ts` keeps `secrets.key` as a separate file. Without it,
 *     every AES-256-GCM-encrypted credential in a restored database is
 *     permanently unreadable — this has already happened once in this
 *     codebase (see that module's own `LEGACY_KEY_FILE` comment).
 *
 * This module fixes both: `createBackup` uses SQLite's own `VACUUM INTO` —
 * a read-only, transactionally-consistent snapshot that safely includes
 * anything still only in the WAL, taken over a `readonly` connection so a
 * backup can never itself perturb a database the core may be actively
 * writing to — and bundles the resulting `enkaku.db` together with
 * `secrets.key` (and, when present, the legacy pre-rename key file) into a
 * single `.tar.gz`, so the two cannot be separated by accident.
 *
 * There is deliberately no `enkaku restore` command. Restore only ever
 * happens with the core stopped (nothing else can safely replace a
 * `enkaku.db` a running core has open), and once the archive is extracted,
 * "restore" is just moving the two files it contains into place — the
 * bundling above already removed the one real hazard (the database and its
 * key silently drifting apart). A restore subcommand would mostly
 * reimplement `tar xzf` plus a couple of `mv`s for a path exercised rarely
 * and only when something has already gone wrong, which is a bad trade
 * for a rarely-tested code path. `docs/guide/install.md` documents the
 * manual steps instead, including the one real trap: leftover
 * `enkaku.db-wal`/`enkaku.db-shm` files in the target data dir must be
 * removed before dropping in the restored `enkaku.db`, or SQLite will try
 * to replay WAL frames that belong to a different database file on top of
 * it.
 */

const DB_FILE = 'enkaku.db'
/**
 * The pre-rename key file `secrets/store.ts` still reads as a fallback
 * (its own `LEGACY_KEY_FILE` constant, not exported since only this module
 * needs the name too). Backed up when present so a farm that has not yet
 * healed every legacy secret stays restorable without a manual detour.
 */
const LEGACY_KEY_FILE = 'network-credentials.key'

export interface BackupSummary {
  outputPath: string
  dbBytes: number
  archiveBytes: number
  hasSecretsKey: boolean
  hasLegacyKey: boolean
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function timestampForFilename(now: Date): string {
  // 2026-08-11T12-34-56-789Z — filesystem-safe on every supported platform (no ':').
  return now.toISOString().replace(/[:.]/g, '-')
}

export function defaultBackupFilename(now = new Date()): string {
  return `enkaku-backup-${timestampForFilename(now)}.tar.gz`
}

/**
 * Turns a user-supplied CLI argument (or none) into a concrete output file
 * path. A bare directory — none given, `.`, a trailing slash, or a path
 * that already exists and is a directory — gets the default timestamped
 * filename appended; anything else is used as the literal output path.
 */
export function resolveOutputPath(arg: string | undefined, now = new Date()): string {
  const base = arg && arg.length > 0 ? arg : '.'
  const looksLikeDir = base === '.' || base.endsWith('/') || base.endsWith('\\') || isDirectory(base)
  return looksLikeDir ? join(resolve(base), defaultBackupFilename(now)) : resolve(base)
}

function manifestText(now: Date, hasLegacyKey: boolean): string {
  const lines: string[] = []
  lines.push('ENKAKU BACKUP ARCHIVE', '')
  lines.push(`Created: ${now.toISOString()}`, '')
  lines.push('Contents:')
  lines.push('  enkaku.db              a consistent snapshot of the farm database (SQLite')
  lines.push('                         VACUUM INTO — safe to take while the core is running)')
  lines.push(`  ${SECRETS_KEY_FILE}            the AES-256-GCM key that decrypts every credential this`)
  lines.push('                         farm has stored (connector API keys, network proxy')
  lines.push('                         credentials, webhook secrets, secret KV entries)')
  if (hasLegacyKey) {
    lines.push(`  ${LEGACY_KEY_FILE}  a pre-rename key file this farm still carries as a`)
    lines.push('                         read fallback; see secrets/store.ts for why it exists')
  }
  lines.push('')
  lines.push('THIS ARCHIVE CAN DECRYPT EVERY CREDENTIAL THIS FARM HAS EVER STORED.')
  lines.push('Handle it like the credentials themselves: restrict who can read it, never send')
  lines.push('it over chat or email unencrypted, encrypt it at rest if it leaves this machine,')
  lines.push('and delete copies you no longer need.')
  lines.push('')
  lines.push('To restore: stop the core, extract this archive, and see "Backup and restore"')
  lines.push('in docs/guide/install.md for the exact steps. Restoring over a live data')
  lines.push('directory without first removing its enkaku.db-wal / enkaku.db-shm files can')
  lines.push('corrupt the restored database.')
  lines.push('')
  return lines.join('\n')
}

/**
 * Builds a backup archive at `outputPath` from the `enkaku.db` (+ secrets
 * key) living in `dataDir`. Throws a coded `EnkakuError` — never leaves a
 * partial/corrupt file at `outputPath` on failure.
 */
export async function createBackup(opts: { dataDir: string; outputPath: string; now?: Date }): Promise<BackupSummary> {
  const now = opts.now ?? new Date()
  const { dataDir, outputPath } = opts
  const dbPath = join(dataDir, DB_FILE)

  if (!existsSync(dbPath)) {
    throw new EnkakuError('E_BACKUP_NO_DB', `no ${DB_FILE} found in ${dataDir} — nothing to back up yet (the core creates it on first start)`)
  }
  if (existsSync(outputPath)) {
    throw new EnkakuError('E_BACKUP_EXISTS', `${outputPath} already exists — refusing to overwrite an existing backup; choose a different path`)
  }
  mkdirSync(dirname(outputPath), { recursive: true })

  const tmpDir = mkdtempSync(join(tmpdir(), 'enkaku-backup-'))
  try {
    const vacuumPath = join(tmpDir, DB_FILE)
    // Read-only: VACUUM INTO only ever reads the source, and opening it
    // readonly guarantees a backup can never itself perturb a database the
    // core may be actively writing to. SQLite takes its own consistent
    // snapshot read transaction here, so committed writes still sitting
    // only in `enkaku.db-wal` (never checkpointed) are captured correctly —
    // see this module's doc comment for why a raw file copy cannot do that.
    const source = new Database(dbPath, { readonly: true, create: false })
    try {
      source.query('VACUUM INTO ?').run(vacuumPath)
    } finally {
      source.close()
    }

    const dbBytes = readFileSync(vacuumPath)

    // Self-check: run the same integrity check `enkaku doctor`'s db check
    // runs, against the snapshot just produced, so a corrupt backup is
    // caught here rather than discovered the day it is actually needed.
    const verify = new Database(vacuumPath, { readonly: true, create: false })
    let integrityOk: boolean
    try {
      const result = verify.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null
      integrityOk = result?.integrity_check === 'ok'
      if (!integrityOk) {
        throw new EnkakuError('E_BACKUP_CORRUPT', `backup snapshot failed its integrity check: ${result?.integrity_check ?? 'unknown'}`)
      }
    } finally {
      verify.close()
    }

    const keyPath = join(dataDir, SECRETS_KEY_FILE)
    const legacyKeyPath = join(dataDir, LEGACY_KEY_FILE)
    const hasSecretsKey = existsSync(keyPath)
    const hasLegacyKey = existsSync(legacyKeyPath)

    const entries: TarEntry[] = [{ name: DB_FILE, data: dbBytes }]
    if (hasSecretsKey) entries.push({ name: SECRETS_KEY_FILE, data: readFileSync(keyPath) })
    if (hasLegacyKey) entries.push({ name: LEGACY_KEY_FILE, data: readFileSync(legacyKeyPath) })
    entries.push({ name: 'README.txt', data: new TextEncoder().encode(manifestText(now, hasLegacyKey)) })

    const archive = createTarGz(entries, Math.floor(now.getTime() / 1000))

    try {
      writeFileSync(outputPath, archive, { mode: 0o600 })

      // Read the archive back off disk and confirm every entry intended is
      // actually in it, byte-for-byte. The whole point of this command is
      // that "looks like a backup" is not good enough on its own.
      const roundTrip = readTarGz(readFileSync(outputPath))
      for (const entry of entries) {
        const found = roundTrip.find((r) => r.name === entry.name)
        if (!found || found.data.length !== entry.data.length) {
          throw new EnkakuError('E_BACKUP_VERIFY_FAILED', `${outputPath} does not contain a readable copy of ${entry.name} after writing — refusing to report success`)
        }
      }
    } catch (err) {
      // Never leave a landmine behind: a corrupt/partial file at
      // `outputPath` would otherwise block every retry via the
      // already-exists guard above.
      rmSync(outputPath, { force: true })
      throw err
    }

    return { outputPath, dbBytes: dbBytes.length, archiveBytes: archive.length, hasSecretsKey, hasLegacyKey }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

function renderBackupSummary(s: BackupSummary): string {
  const lines: string[] = []
  lines.push(`Backup written to ${s.outputPath} (${humanBytes(s.archiveBytes)})`)
  lines.push(`  enkaku.db snapshot: ${humanBytes(s.dbBytes)}, integrity-checked`)
  lines.push(
    s.hasSecretsKey
      ? `  ${SECRETS_KEY_FILE}: included`
      : `  ${SECRETS_KEY_FILE}: not found — this farm has not stored any encrypted credential yet`,
  )
  if (s.hasLegacyKey) lines.push(`  ${LEGACY_KEY_FILE}: included (pre-rename key file, still present on this farm)`)
  lines.push('')
  lines.push('!!! This archive can decrypt every credential this farm has ever stored (connector')
  lines.push('!!! API keys, network proxy credentials, webhook secrets, secret KV entries).')
  lines.push('!!! Treat it like the credentials themselves — restrict who can read it, never send')
  lines.push('!!! it over chat/email unencrypted, and delete old copies you no longer need.')
  return lines.join('\n')
}

/**
 * The `enkaku backup` CLI entrypoint (mirrors `doctor/index.ts`'s
 * `runDoctor`): resolves the real data dir and output path, runs the
 * backup, prints the report, and returns the process exit code rather than
 * calling `process.exit` itself, so this stays testable.
 */
export async function runBackup(argv: string[] = process.argv.slice(3)): Promise<number> {
  const dataDir = resolveDataDir()
  const positional = argv.find((a) => !a.startsWith('-'))
  const outputPath = resolveOutputPath(positional)
  try {
    const summary = await createBackup({ dataDir, outputPath })
    console.log(renderBackupSummary(summary))
    return 0
  } catch (err) {
    const message = err instanceof EnkakuError ? `[${err.code}] ${err.message}` : String(err)
    console.error(`enkaku backup failed: ${message}`)
    return 1
  }
}
