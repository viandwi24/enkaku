/**
 * A standalone worker process for `job-store.test.ts`'s "genuine multi-process
 * race" test (plan 98 §3.7, §4.6, step 98.5). NOT a test file itself (no
 * `describe`/`test`, so `bun test`'s file matcher never picks it up) — a
 * plain script the test spawns via `Bun.spawn(['bun', <this file>, ...])`,
 * one per OS process, each opening its OWN `bun:sqlite` connection to the
 * SAME on-disk database file the parent test seeded and migrated.
 *
 * This is what makes the race genuine rather than sequential-calls-dressed-
 * up-as-parallel: a single Bun process cannot race its own synchronous
 * `claimNext` calls (JS never interleaves them), but N separate OS processes
 * hammering the SAME file's `BEGIN IMMEDIATE` transaction genuinely can.
 *
 * Usage: `bun claim-race-worker.ts <dbPath> <attempts>` — opens `dbPath`
 * (already migrated by the parent; this script never migrates), calls
 * `claimNext` up to `attempts` times, and prints a JSON array of the job ids
 * it personally claimed to stdout.
 *
 * `PRAGMA busy_timeout` is set explicitly (openDb() itself does not set one
 * — WAL mode alone does not make `BEGIN IMMEDIATE` block on a lock held by
 * another connection) so a worker that loses a lock race waits and retries
 * instead of throwing `SQLITE_BUSY` — contention under this test is
 * expected and not itself evidence of anything wrong; only an ADMITTED
 * over-claim would be.
 */
import { openDb } from '../db'
import { createJobStore } from './job-store'

const [, , dbPath, attemptsArg] = process.argv
if (!dbPath || !attemptsArg) {
  console.error('usage: bun claim-race-worker.ts <dbPath> <attempts>')
  process.exit(1)
}
const attempts = Number.parseInt(attemptsArg, 10)

const { db, sqlite } = openDb(dbPath)
sqlite.exec('PRAGMA busy_timeout = 5000;')
const store = createJobStore(db)

const claimed: string[] = []
for (let i = 0; i < attempts; i++) {
  const result = store.claimNext(60)
  if (result) claimed.push(result.job.id)
}

process.stdout.write(JSON.stringify(claimed))
