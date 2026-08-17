import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { plugins, type PluginRow } from '../db/schema'
import { scriptNeedsPluginMessage } from '../scripts/service'
import { EnkakuError } from '../util/errors'

/**
 * Where an owning plugin comes from when a `scripts` row is NOT written by the
 * stage → verify → activate pipeline (plan 110 §3.2, §3.4, §4.3).
 *
 * `publishScript()` refuses a `kind: 'script'` row with no `pluginId`; that is
 * the rule, and it lives in the writer. This file is the other half: the two
 * publish paths that are not `POST /api/plugins` — a recording, and a direct
 * publish through `POST /api/scripts` / the `script.publish` capability — have
 * to name an owner before they can call the writer at all, and both do it
 * here, once, rather than each inventing its own answer.
 *
 * Two owner shapes, deliberately different, each documented on its own
 * function below:
 *
 * - the SYNTHETIC owner (`recordings`) — one fixed row, never installable, its
 *   members versioned independently of it;
 * - a DIRECT-PUBLISH owner — an ordinary plugin row created by the publish
 *   that needed it, versioned in lockstep with its members exactly as a real
 *   plugin's are (plan 82 §3.6).
 *
 * A row from either shape is told apart from a real, verified package by
 * `verifiedAt`/`manifest` being null — a column-free flag, as §4.3 asks for.
 */

/** The same shape `definePlugin` and `PluginRuntime` already enforce on a plugin id. */
const PLUGIN_ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/
/**
 * A member id is looser than a plugin id by exactly one character class:
 * `RECORDING_NAME_RE` (`@enkaku/protocol`) already allows `.` and `_` in a
 * recording's name, and a recording's name IS its member id (§3.4). Nothing
 * else about a member id is constrained here — `definePlugin` is what checks a
 * real plugin's members, and this is only ever the name half of a row.
 */
const MEMBER_ID_SHAPE = /^[a-z0-9][a-z0-9._-]*$/

/** The synthetic plugin that owns every published recording (plan 110 §3.4). */
export const RECORDINGS_PLUGIN_NAME = 'recordings'

/**
 * The fixed version of the synthetic owner row. It is NOT the version of
 * anything it holds: each recording is compiled, bundled and published on its
 * own, so its member row carries the RECORDING's version, not this one (see
 * `scripts/registry.ts`, which is the one reader that has to know).
 */
const SYNTHETIC_OWNER_VERSION = '0.0.0'

/**
 * A synthetic owner's bundle column is a comment and nothing else. It exists
 * because `plugins.bundle` is NOT NULL, and it is never imported: `verify`,
 * `activate` and `restart` all refuse or skip a synthetic row, so nothing in
 * the farm ever hands this text to a child process.
 */
const SYNTHETIC_OWNER_BUNDLE =
  "// plan 110 §3.4 — the farm's own owner for published recordings. It has no bundle: every member row carries the compiled recording it was published from.\n"

/**
 * Reserved plugin names, and the ONE place the list lives. A real
 * `definePlugin({ id })` claiming one is refused at stage and at verify
 * (§4.3): two owners over one name would be two owners over one KV namespace.
 */
const RESERVED_PLUGIN_NAMES: readonly string[] = [RECORDINGS_PLUGIN_NAME]

/**
 * True for a name the farm owns itself. "Reserved" and "synthetic" are the
 * same set said from the two directions that matter: reserved is what an
 * author may not claim, synthetic is what an operator may not install,
 * activate, roll back, disable or remove.
 */
export function isSyntheticPluginName(name: string): boolean {
  return RESERVED_PLUGIN_NAMES.includes(name)
}

/** Refuses a real plugin claiming a reserved name (plan 110 §4.3, criterion 5). */
export function reservedPluginNameError(name: string): EnkakuError {
  return new EnkakuError(
    'E_PLUGIN_RESERVED_NAME',
    `"${name}" is a reserved plugin name — the farm uses it as the owner of every published recording (plan 110 §3.4). Choose another id for definePlugin({ id }): two owners cannot share one KV namespace.`,
  )
}

/**
 * Refuses a lifecycle verb on a synthetic owner (plan 110 §3.4: "an operator
 * cannot activate, roll back, or remove it independently of the recordings it
 * holds. That constraint has to be real in the runtime, not just a UI
 * omission").
 */
export function syntheticPluginError(name: string, verb: string): EnkakuError {
  return new EnkakuError(
    'E_PLUGIN_SYNTHETIC',
    `"${name}" is the farm's own owner for published recordings (plan 110 §3.4), not an installable plugin — it cannot be ${verb}. What it holds is changed by the recordings themselves: publish, re-publish or delete them at /api/recordings.`,
  )
}

export interface ScriptOwner {
  pluginId: string
  pluginName: string
  exportId: string
}

/** `tiktok/login` → `{ plugin: 'tiktok', member: 'login' }`; null when there is no slash. Splits at the FIRST slash, so a member id may not contain one. */
function splitMemberName(name: string): { plugin: string; member: string } | null {
  const i = name.indexOf('/')
  if (i < 0) return null
  return { plugin: name.slice(0, i), member: name.slice(i + 1) }
}

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(text)
  return hasher.digest('hex')
}

function rowsNamed(db: Db, name: string): PluginRow[] {
  return db.select().from(plugins).where(eq(plugins.name, name)).all()
}

/**
 * The synthetic `recordings` owner, created on first publish and reused
 * forever after (plan 110 §3.4, §4.3).
 *
 * One row, one fixed version, `status: 'active'` — active because a member is
 * only resolvable while its owner is (`scripts/registry.ts`), and there is no
 * pipeline that could ever activate this row later: `activate` refuses it by
 * design.
 *
 * Synchronous end to end, so two concurrent recording publishes cannot
 * interleave between the lookup and the insert (bun:sqlite is one synchronous
 * connection; nothing here awaits).
 */
export function resolveRecordingsOwner(db: Db): PluginRow {
  const existing = rowsNamed(db, RECORDINGS_PLUGIN_NAME)[0]
  if (existing) return existing
  const row: PluginRow = {
    id: crypto.randomUUID(),
    name: RECORDINGS_PLUGIN_NAME,
    version: SYNTHETIC_OWNER_VERSION,
    title: 'Recordings',
    description: 'Every recording published from the recorder. Created by the farm; not an installable plugin.',
    bundle: SYNTHETIC_OWNER_BUNDLE,
    source: null,
    bundleHash: sha256(SYNTHETIC_OWNER_BUNDLE),
    status: 'active',
    verifiedAt: null,
    verifyError: null,
    verifyErrorCode: null,
    manifest: null,
    resetPackages: null,
    createdBy: null,
    createdAt: new Date(),
  }
  db.insert(plugins).values(row).run()
  return row
}

export interface DirectPublishOwnerInput {
  /** The full published name — `<plugin>/<script>`. A name with no slash has no owner and is refused. */
  name: string
  version: string
  bundle: string
  source?: string | null
  createdBy?: string | null
}

/**
 * The owner of a script published directly — `POST /api/scripts` and the
 * `script.publish` capability (plan 110 §3.2's table, §5 steps 110.1/110.3).
 *
 * Both of those paths write ONE member from ONE bundle, so the plugin they
 * publish is a one-member plugin whose version is that member's version —
 * lockstep, exactly as plan 82 §3.6 defines a plugin member's version, which
 * is also what keeps `<plugin>/<script>@latest` honest (`scripts/registry.ts`
 * translates a plugin-scoped `@latest` to the ACTIVE plugin's version).
 *
 * What it refuses, and why each refusal is not an inconvenience:
 *
 * - a name with no slash — there is nothing to own it (the rule itself);
 * - a reserved name — the farm owns it (§4.3);
 * - a name whose plugin was published as a VERIFIED package — adding a member
 *   to it one row at a time would put a script in the plugin that its own
 *   manifest does not list, and superseding its active version from here would
 *   let an unverified bundle displace a verified one. Add the member to the
 *   bundle and republish the plugin instead.
 */
export function resolveDirectPublishOwner(db: Db, input: DirectPublishOwnerInput): ScriptOwner {
  const split = splitMemberName(input.name)
  if (!split) {
    throw new EnkakuError('E_SCRIPT_NEEDS_PLUGIN', scriptNeedsPluginMessage(`"${input.name}"`))
  }
  const { plugin, member } = split
  if (!PLUGIN_ID_SHAPE.test(plugin)) {
    throw new EnkakuError('E_BAD_REQUEST', `the owning plugin "${plugin}" in "${input.name}" must match ${PLUGIN_ID_SHAPE} — the same shape definePlugin({ id }) requires`)
  }
  if (!MEMBER_ID_SHAPE.test(member)) {
    throw new EnkakuError('E_BAD_REQUEST', `the script "${member}" in "${input.name}" must match ${MEMBER_ID_SHAPE}`)
  }
  if (isSyntheticPluginName(plugin)) throw reservedPluginNameError(plugin)

  const rows = rowsNamed(db, plugin)
  if (rows.some((r) => r.verifiedAt !== null)) {
    const active = rows.find((r) => r.status === 'active') ?? rows[0]
    throw new EnkakuError(
      'E_PLUGIN_VERIFIED_OWNER',
      `"${plugin}" was published as a verified plugin package (${plugin}@${active?.version ?? '?'}) — a member cannot be added to it one row at a time, and an unverified bundle must not displace a verified one. Add "${member}" to the plugin's own bundle and publish the plugin (POST /api/plugins).`,
    )
  }

  const atVersion = rows.find((r) => r.version === input.version)
  if (atVersion) {
    if (atVersion.status !== 'active') {
      db.transaction((tx) => {
        for (const other of rows) {
          if (other.id !== atVersion.id && other.status === 'active') tx.update(plugins).set({ status: 'superseded' }).where(eq(plugins.id, other.id)).run()
        }
        tx.update(plugins).set({ status: 'active' }).where(eq(plugins.id, atVersion.id)).run()
      })
    }
    return { pluginId: atVersion.id, pluginName: plugin, exportId: member }
  }

  const row: PluginRow = {
    id: crypto.randomUUID(),
    name: plugin,
    version: input.version,
    title: null,
    description: null,
    bundle: input.bundle,
    source: input.source ?? null,
    bundleHash: sha256(input.bundle),
    // Active immediately, and never verified: this path has no verify child to
    // run (it is the direct `POST /api/scripts` publish, now owned) — which is
    // exactly what `restart` reads to decide it must not re-verify this row.
    status: 'active',
    verifiedAt: null,
    verifyError: null,
    verifyErrorCode: null,
    manifest: null,
    resetPackages: null,
    createdBy: input.createdBy ?? null,
    createdAt: new Date(),
  }
  db.transaction((tx) => {
    for (const other of rows) {
      if (other.status === 'active') tx.update(plugins).set({ status: 'superseded' }).where(eq(plugins.id, other.id)).run()
    }
    tx.insert(plugins).values(row).run()
  })
  return { pluginId: row.id, pluginName: plugin, exportId: member }
}
