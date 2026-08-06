import { sql } from 'drizzle-orm'
import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Tabel devices (spec §12, subset M0). Tabel lain (jobs, scripts, artifacts,
 * users, tool_installs, audit_log) arrive in the plans that need them —
 * are not created "while we are here" (plan 01 §2).
 */
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    /** Identitas stabil: ro.serialno / ANDROID_ID (spec §7.5). */
    stableId: text('stable_id').notNull().unique(),
    /** The current adb transport address — it can change (USB ↔ ip:port). */
    serial: text('serial').notNull(),
    label: text('label').notNull(),
    ownerId: text('owner_id'),

    androidVersion: text('android_version'),
    apiLevel: integer('api_level'),
    screenW: integer('screen_w'),
    screenH: integer('screen_h'),
    density: integer('density'),

    transport: text('transport').default('adb-usb'),
    display: text('display').default('scrcpy'),
    input: text('input').default('scrcpy-uhid'),
    inspection: text('inspection').default('ui-server'),

    battery: text('battery', { mode: 'json' }),
    settings: text('settings', { mode: 'json' }),
    status: text('status').default('offline'),
    /** Quarantine reason (e.g. 'thermal:47.3C') — null when not quarantined. */
    quarantineReason: text('quarantine_reason'),
    /** The node that owns this device (cloud mode); null = local device. */
    nodeId: text('node_id'),
    tenantId: text('tenant_id'),
    lastSeen: integer('last_seen', { mode: 'timestamp' }),
    /**
     * The owning cluster (plan 22.0 §3.2), or null when unclustered. A device
     * belongs to at most one cluster; this column IS that guarantee — there
     * is no membership table to keep consistent and no code path that can
     * leave a device in two clusters, because assigning one is an UPDATE
     * that necessarily clears any previous value.
     */
    clusterId: text('cluster_id'),
    /**
     * The operator's standing readiness intent (plan 43 §3.3, §4.2) — never
     * changed by a hold (§3.6): a job or viewer can wake a device without
     * ever writing this column. Null means "never set" — treated as
     * 'asleep' everywhere it is read. `actual` readiness is derived from
     * live session state and is NEVER stored (§3.3).
     */
    desiredReadiness: text('desired_readiness'),
    /**
     * The persisted `vpn-helper` route (plan 44 step 5.4, @enkaku/protocol's
     * `PersistedNetworkRouteSchema`) — null when no route has ever been
     * declared. Kept off `settings` deliberately, so it is queryable on its
     * own and does not collide with that column's schema. `config` carries
     * a `credentialRef` naming a row in `network_credentials` below rather
     * than a raw password (plan 52 §4.2, §5.1, superseding plan 44's
     * PLAINTEXT compromise) — this column itself never holds a secret.
     * Still, never read it into an API response without redacting first:
     * an old, pre-migration row can carry inline `username`/`password`
     * until `createGuestAgentRoutes`'s boot-time migration rewrites it.
     */
    networkRoute: text('network_route', { mode: 'json' }),
  },
  (t) => [
    // `/api/devices` sorts by label ASC, id ASC — the browse list, not a
    // feed (plan 30 §4.2).
    index('idx_devices_label').on(t.label, t.id),
    index('idx_devices_cluster').on(t.clusterId),
  ],
)

export type DeviceRow = typeof devices.$inferSelect
export type DeviceInsert = typeof devices.$inferInsert

/**
 * Device tags (plan 19 §4.1): many-to-many, so a device can be in the smoke
 * pool AND on Android 15 without duplicating the device or the column.
 * No foreign key to `devices` — a device delete must remove these rows itself,
 * in the same transaction, matching how the rest of the schema handles cleanup.
 */
export const deviceTags = sqliteTable(
  'device_tags',
  {
    deviceId: text('device_id').notNull(),
    /** Normalised on write (plan 19 §3.4): lowercase, trimmed, [a-z0-9:._-]. */
    tag: text('tag').notNull(),
    at: integer('at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.tag] }),
    // Plan 20 resolves clusters with this one.
    index('idx_device_tags_tag').on(t.tag),
  ],
)

export type DeviceTagRow = typeof deviceTags.$inferSelect

/**
 * A device deliberately excluded from the farm (plan 47 §3.2, §3.3), keyed
 * by `stableId` rather than the adb serial or the `devices.id` row it once
 * had — a block must survive exactly the things that would defeat a serial-
 * or row-keyed one: a different USB port, a switch to `adb-tcp`, or being
 * forgotten and re-enrolled. The registry consults this table before ever
 * probing a newly seen serial (plan 47 §4.2).
 */
export const blockedDevices = sqliteTable('blocked_devices', {
  stableId: text('stable_id').primaryKey(),
  label: text('label'),
  reason: text('reason'),
  blockedAt: integer('blocked_at', { mode: 'timestamp' }).notNull(),
  blockedBy: text('blocked_by'),
})

export type BlockedDeviceRow = typeof blockedDevices.$inferSelect

/**
 * Phones adb has seen that nobody has admitted to the farm yet (plan 56 §3.3).
 *
 * A separate table rather than a sixth `DeviceStatus` on purpose: `devices`
 * rows ARE farm members — the scheduler picks from them, the lease manager
 * leases them, the wall renders them. A status would mean every one of those
 * paths has to remember to exclude it, a filter that must be right in a dozen
 * places and only has to be wrong once to hand someone's personal phone to a
 * job. Keyed on `stableId`, exactly like `blocked_devices` above, because
 * identity is the hardware serial and not the adb address (spec §7.5).
 */
export const discoveredDevices = sqliteTable('discovered_devices', {
  stableId: text('stable_id').primaryKey(),
  /** Transport address at last sight — informational only; identity is `stableId`. */
  serial: text('serial').notNull(),
  /** Best-effort `ro.product.model`, so the tray reads as a phone and not a barcode. */
  label: text('label'),
  androidVersion: text('android_version'),
  firstSeen: integer('first_seen', { mode: 'timestamp' }).notNull(),
  lastSeen: integer('last_seen', { mode: 'timestamp' }).notNull(),
})

export type DiscoveredDeviceRow = typeof discoveredDevices.$inferSelect

/**
 * Just enough to label a dangling reference (plan 47 §3.4): forgetting a
 * device removes its `devices` row but deliberately keeps `jobs`,
 * `artifacts`, and `device_events` pointing at the old `deviceId` — this
 * table is what lets a UI render "deleted device (<stableId>)" instead of a
 * blank or a crash, without resurrecting the row itself.
 */
export const deletedDevices = sqliteTable('deleted_devices', {
  id: text('id').primaryKey(), // the old devices.id
  stableId: text('stable_id').notNull(),
  label: text('label'),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }).notNull(),
})

export type DeletedDeviceRow = typeof deletedDevices.$inferSelect

/**
 * Named upstream credentials for a `vpn-helper` route (plan 52 §4.2, §5.1), replacing the
 * plaintext `username`/`password` plan 44 stored inline on `devices.network_route`. `secret` is
 * encrypted with a key kept in a file in the data directory
 * (`packages/core/src/network/credential-store.ts`), created on first use with file mode `0600`.
 *
 * This is NOT a KMS and does not claim to be one — the honest claim, repeated in Studio, is that
 * a secret here is "not readable by grepping the database"; anyone with read access to the whole
 * data directory (the key file sits right beside `enkaku.db`) can still decrypt it. A route
 * references one of these by `name`, so the same upstream credential can back several devices
 * without retyping it (plan 52 acceptance criterion 5).
 */
export const networkCredentials = sqliteTable('network_credentials', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  username: text('username'),
  /** `iv.tag.ciphertext`, AES-256-GCM, each segment base64 — never the plaintext secret. */
  secret: text('secret').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  createdBy: text('created_by'),
})

export type NetworkCredentialRow = typeof networkCredentials.$inferSelect

/**
 * One-shot data migrations that cannot be expressed as plain SQL — currently
 * just the cluster materialisation (plan 22.0 §3.4, §4.1) — guarded so each
 * runs exactly once no matter how many times the core starts (acceptance
 * #8: a restart must not reassign or duplicate).
 */
export const migrationMarkers = sqliteTable('migration_markers', {
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at', { mode: 'timestamp' }).notNull(),
})

export type MigrationMarkerRow = typeof migrationMarkers.$inferSelect

/** The tool install catalogue (spec §12) — physical truth still lives on disk. */
export const toolInstalls = sqliteTable('tool_installs', {
  id: text('id').primaryKey(),
  toolId: text('tool_id').notNull(),
  version: text('version').notNull(),
  active: integer('active', { mode: 'boolean' }).default(false),
  sha256: text('sha256'),
  installedAt: integer('installed_at', { mode: 'timestamp' }),
})

export type ToolInstallRow = typeof toolInstalls.$inferSelect

/** The per-device job queue (spec §12, §10.3). */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    scriptId: text('script_id').notNull(), // M3: 'internal:sleep'
    deviceId: text('device_id').notNull(),
    params: text('params', { mode: 'json' }),
    priority: integer('priority').default(0),
    status: text('status').default('queued'), // queued|running|success|failed|cancelled
    /** Epoch seconds — the job lease, extended by the runner's heartbeat (spec §10.2). */
    leaseExpiresAt: integer('lease_expires_at'),
    result: text('result', { mode: 'json' }),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp' }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    /** Plan 20 §4.1 — null for a standalone job. */
    batchId: text('batch_id'),
    /** Position within the batch; the shuffle for `random` order is baked in here (plan 20 §3.2). */
    batchSeq: integer('batch_seq'),
    /** Unix seconds; the reaper expires the job if it has not started by then (plan 21 §3.3, §4.1). Null = wait forever. */
    expiresAt: integer('expires_at'),
    /**
     * Plan 36 §4.3 — set on the final settle of a `failed` job: 'infra' |
     * 'script' | 'load' (see `jobs/failure-class.ts`). Nullable: a
     * pre-existing row, or a job that never failed, has none.
     */
    failureClass: text('failure_class'),
    /**
     * Plan 60 §3.4 — the phase a failure happened in ('prepare' | 'run' |
     * 'finish', plus the runner's own 'reset' | 'acquire' | 'timeout'). The
     * runner has always known this and threw it away at the executor
     * boundary, so "it failed" was answerable from the job row and "where"
     * was only answerable by reading the log. Null for a job that never
     * failed, and for any row written before this column existed.
     */
    errorPhase: text('error_phase'),
    /**
     * Plan 36 §3.4, §3.6 — how many times this job has been requeued for an
     * infrastructure failure (rebind on another eligible device for a batch
     * member). Nullable/defaulted so existing rows keep reading; 0 for a job
     * that has never rebound.
     */
    infraAttempts: integer('infra_attempts').default(0),
    /**
     * Plan 82 §3.4 — denormalised at enqueue from the resolving registry
     * entry, so a job's script name survives even the script row it
     * pointed at disappearing (a deleted publish, or — the case this plan
     * adds — a dev slot that has since been dropped, criterion 13). Both
     * nullable: a pre-existing row has neither, and keeps resolving its
     * name the old way, through `jobs.scriptId` → the `scripts` table
     * (`queue/job-store.ts`'s `scriptNames()` falls back to that lookup
     * whenever these are null). Also read by plan 80's `jobs/script-jobs.ts`
     * (`JobSummary.scriptName`/`.scriptVersion`) for a running script's own
     * view of its neighbours on the queue.
     */
    scriptName: text('script_name'),
    scriptVersion: text('script_version'),
    /**
     * Plan 81 §3.2, §4.1 — lineage. `triggeredByJobId` is the job whose
     * script called `ctx.jobs.trigger()`; null for a job a human, schedule,
     * or batch created. `rootJobId` is the origin of the chain — null on the
     * origin's OWN row (a job with no trigger IS its own root, but that is
     * never written back onto it; every existing pre-plan-81 row already
     * satisfies "null root, depth 0", which is exactly true of it). `depth`
     * is 0 for a root, parent's depth + 1 otherwise — both `rootJobId` and
     * `depth` are set by the PARENT at enqueue time from the triggering
     * job's own row, never from anything the child sends (`jobs/triggers.ts`
     * §3.2) — a child that could name its own depth could name zero.
     */
    triggeredByJobId: text('triggered_by_job_id'),
    rootJobId: text('root_job_id'),
    depth: integer('depth').default(0),
    /**
     * Plan 81 §3.3 — idempotency key for a trigger call, scoped by
     * `rootJobId` via the unique index below. A second trigger with the same
     * key (root, key) pair returns the existing row instead of inserting —
     * the mechanism that makes a re-run `finish()` (or a retried `run()`
     * that derives the same key) a no-op rather than a duplicate job.
     */
    triggerKey: text('trigger_key'),
  },
  (t) => [
    index('idx_jobs_claim').on(t.status, t.deviceId, t.priority, t.createdAt),
    index('idx_jobs_device').on(t.deviceId, t.createdAt),
    index('idx_jobs_batch').on(t.batchId, t.batchSeq),
    // The unfiltered `/api/jobs` keyset list — `(createdAt DESC, id DESC)`
    // (plan 30 §4.2). idx_jobs_device only helps once a deviceId is given.
    index('idx_jobs_created').on(t.createdAt, t.id),
    // Plan 81 §4.1 — idempotency (a partial unique index: SQLite only
    // enforces uniqueness among rows where `trigger_key IS NOT NULL`, so
    // every job with no trigger key at all — which is most jobs — never
    // collides) and the chain-size/descendant lookups (`triggers.ts`,
    // `script-jobs.ts`, cancel-with-descendants).
    uniqueIndex('idx_jobs_trigger_key').on(t.rootJobId, t.triggerKey).where(sql`${t.triggerKey} is not null`),
    index('idx_jobs_root').on(t.rootJobId),
    index('idx_jobs_triggered_by').on(t.triggeredByJobId),
  ],
)

export type JobRow = typeof jobs.$inferSelect

/**
 * A cluster is a container, not a selector (plan 22.0 §3.1–§3.3, superseding
 * plan 20 §3.1): devices are put into it and taken out of it, and
 * `devices.cluster_id` is the sole source of membership. This table carries
 * only the cluster's own identity — no tags, no device list, nothing that
 * could disagree with the owning field on `devices`.
 */
export const clusters = sqliteTable(
  'clusters',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_clusters_created').on(t.createdAt, t.id)],
)

export type ClusterRow = typeof clusters.$inferSelect

/**
 * A batch is one script run across a resolved set of devices (plan 20 §3.2,
 * §3.5). `status` is a cached projection of its jobs, recomputed — never
 * incremented — whenever a member job changes state.
 */
export const batches = sqliteTable(
  'batches',
  {
    id: text('id').primaryKey(),
    /** Null when the batch targeted an ad-hoc device list. */
    clusterId: text('cluster_id'),
    scriptId: text('script_id').notNull(),
    params: text('params', { mode: 'json' }),
    /** 0 = unlimited, else the max jobs running at once (plan 20 §3.2). */
    concurrency: integer('concurrency').notNull().default(0),
    order: text('order').notNull().default('as-listed'), // 'as-listed' | 'random'
    status: text('status').notNull().default('queued'),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
  },
  (t) => [index('idx_batches_created').on(t.createdAt)],
)

export type BatchRow = typeof batches.$inferSelect

/** Published scripts (spec §12, §11.4 — finished bundles, not raw source). */
export const scripts = sqliteTable(
  'scripts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    /** The output of `enkaku publish` (a single-file ESM bundle). */
    bundle: text('bundle').notNull(),
    /**
     * The entry file's original source, kept purely so a human can read what a
     * job actually ran. The bundle is ~500 KB of inlined dependencies and is
     * useless to look at. Nullable because scripts published before this
     * column existed have none.
     */
    source: text('source'),
    paramsSchema: text('params_schema', { mode: 'json' }),
    enabled: integer('enabled', { mode: 'boolean' }).default(true),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }),
    /**
     * Plan 82 §4.2 — set together, both null, or both non-null. `pluginId`
     * is `plugins.id` this row's bundle came from (the row's own `bundle`
     * column holds the FULL plugin bundle, identical across every member —
     * see `plugins/runtime.ts`'s `activate`); `exportId` is which member of
     * `mod.default.scripts` the child selects (`child-entry.ts`). Null for
     * every standalone script, including every row published before this
     * plan.
     */
    pluginId: text('plugin_id'),
    exportId: text('export_id'),
  },
  (t) => [
    uniqueIndex('idx_scripts_name_version').on(t.name, t.version),
    index('idx_scripts_created').on(t.createdAt, t.id),
    index('idx_scripts_plugin').on(t.pluginId),
  ],
)

export type ScriptRow = typeof scripts.$inferSelect

/**
 * Per-job (and, since plan 24 §4.6, per-device) artifacts (spec §12). `path`
 * is relative to app-data. Exactly one of `jobId` / `deviceId` is set: a job
 * artifact (screenshot, log, file from a script run) keeps `jobId` as
 * before; a device artifact ("save last N lines" from the Monitor tab) has
 * no job to belong to, hence `deviceId` and a nullable `jobId`.
 */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id'),
    /** Set only for a device-scoped artifact (plan 24 §4.6); null for a job artifact. */
    deviceId: text('device_id'),
    kind: text('kind').notNull(), // screenshot|log|file|video
    label: text('label'),
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes'),
    createdAt: integer('created_at', { mode: 'timestamp' }),
  },
  (t) => [
    index('idx_artifacts_job').on(t.jobId, t.createdAt),
    index('idx_artifacts_device').on(t.deviceId, t.createdAt),
  ],
)

export type ArtifactRow = typeof artifacts.$inferSelect

/** Farm-wide settings — always exactly one row (id = 1). */
export const farmSettings = sqliteTable('farm_settings', {
  id: integer('id').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

export type FarmSettingsRow = typeof farmSettings.$inferSelect


/** Users (spec §12) — argon2 passwords, in use from M7. */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  role: text('role').default('operator'), // admin|operator
  passwordHash: text('password_hash'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export type UserRow = typeof users.$inferSelect

/** Login sessions — the raw token is NEVER stored, only its sha256. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  userAgent: text('user_agent'),
  ip: text('ip'),
})

export type SessionRow = typeof sessions.$inferSelect

/** Audit trail (spec §14): who did what. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'),
    action: text('action').notNull(), // job.run|device.enroll|tool.activate|user.login|...
    target: text('target'),
    meta: text('meta', { mode: 'json' }),
    at: integer('at', { mode: 'timestamp' }),
  },
  (t) => [index('idx_audit_at').on(t.at)],
)

export type AuditRow = typeof auditLog.$inferSelect

/**
 * One row per device event, `main` (lifecycle) or `input` (every injected
 * action) — plan 18 §3.1, §4.1. One table because the two streams share a
 * shape; only their retention budget differs (plan 18 §3.3).
 */
export const deviceEvents = sqliteTable(
  'device_events',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id').notNull(),
    /** 'main' | 'input' — the retention budget follows this (plan 18 §3.3). */
    stream: text('stream').notNull(),
    /** Dotted kind, e.g. 'device.online', 'input.tap'. */
    kind: text('kind').notNull(),
    /** userId, 'job:<id>', or null when the core itself is the actor. */
    actor: text('actor'),
    /** Kind-specific detail; always an object, never a bare value. */
    meta: text('meta', { mode: 'json' }),
    at: integer('at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('idx_device_events_tail').on(t.deviceId, t.stream, t.at),
    // The GC deletes by age across all devices; give it its own index.
    index('idx_device_events_at').on(t.at),
  ],
)

export type DeviceEventRow = typeof deviceEvents.$inferSelect
export type DeviceEventInsert = typeof deviceEvents.$inferInsert

/** Cloud nodes (plan 11 §4.3, renamed from "agents" in plan 61) — one node holds many devices. */
export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    /** Multi-tenant (M8c) — null in single-tenant. */
    tenantId: text('tenant_id'),
    name: text('name').notNull(),
    /** A single-use enrollment token (null once exchanged for a credential). */
    tokenHash: text('token_hash'),
    credentialHash: text('credential_hash'),
    status: text('status').default('pending'), // pending|online|offline|disabled
    version: text('version'),
    platform: text('platform'),
    lastSeen: integer('last_seen', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }),
  },
  (t) => [index('idx_nodes_created').on(t.createdAt, t.id)],
)

export type NodeRow = typeof nodes.$inferSelect

/**
 * A schedule triggers a batch on a cron expression, in a stated timezone
 * (plan 21 §1, §4.1) — it never triggers a bare job. Every operator question
 * (overlap, queue timeout, catch-up, jitter, priority) is an explicit column
 * rather than an emergent behaviour.
 */
export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    /** Standard 5-field cron, or 6 fields with seconds (croner syntax). */
    cron: text('cron').notNull(),
    /** IANA zone, e.g. 'Asia/Jakarta'. Never a UTC offset — offsets break on DST. */
    timezone: text('timezone').notNull(),

    /**
     * `name@version` or `name@latest` (plan 62 §3.3, §4.3) — a schedule
     * stores the REFERENCE, never a resolved id. Renamed from `scriptId`
     * (which held a concrete `scripts.id` and pinned forever, invisibly) —
     * the migration backfills every existing row to its pinned
     * `"<name>@<version>"` verbatim, never to `@latest` (acceptance #9).
     */
    /**
     * `''` for an agent-kind schedule (see `scheduleAgentTargets` below) —
     * the dispatcher branches on WHETHER a `scheduleAgentTargets` row exists
     * for this schedule BEFORE `scriptRef` is ever read (plan 68 §4.2), so
     * the script branch's own reading of this column is byte-for-byte
     * unchanged from plan 62.
     */
    scriptRef: text('script_ref').notNull(),
    params: text('params', { mode: 'json' }),
    /** Exactly one of clusterId / deviceIds is populated (plan 21 §9 open question #3 — no "all devices"). */
    clusterId: text('cluster_id'),
    deviceIds: text('device_ids', { mode: 'json' }), // string[]

    // Batch shape, passed straight through to plan 20's dispatcher (script targets only).
    concurrency: integer('concurrency').notNull().default(0),
    order: text('order').notNull().default('as-listed'), // 'as-listed' | 'random'

    // Policy (plan 21 §3.2–§3.6)
    onOverlap: text('on_overlap').notNull().default('skip'), // 'skip' | 'queue' | 'cancel-previous'
    queueTimeoutSec: integer('queue_timeout_sec'), // null = wait forever
    catchUp: text('catch_up').notNull().default('skip'), // 'skip' | 'once'
    jitterSec: integer('jitter_sec').notNull().default(0),
    priority: integer('priority').notNull().default(0),

    lastFiredAt: integer('last_fired_at', { mode: 'timestamp' }),
    lastBatchId: text('last_batch_id'),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('idx_schedules_enabled').on(t.enabled),
    index('idx_schedules_created').on(t.createdAt, t.id),
  ],
)

export type ScheduleRow = typeof schedules.$inferSelect

/**
 * One row per fire decision, including the ones that ran nothing (plan 21
 * §4.1) — a schedule that has been quietly skipping for a week should be
 * obvious from its history, not just its process logs.
 */
export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    id: text('id').primaryKey(),
    scheduleId: text('schedule_id').notNull(),
    /** When it was due, not when it ran — jitter separates the two. */
    dueAt: integer('due_at', { mode: 'timestamp' }).notNull(),
    firedAt: integer('fired_at', { mode: 'timestamp' }),
    outcome: text('outcome').notNull(), // 'dispatched'|'skipped-overlap'|'skipped-missed'|'no-targets'|'error'
    batchId: text('batch_id'),
    detail: text('detail'),
    missedCount: integer('missed_count').notNull().default(0),
  },
  (t) => [index('idx_schedule_runs_sched').on(t.scheduleId, t.dueAt)],
)

export type ScheduleRunRow = typeof scheduleRuns.$inferSelect

/**
 * A schedule's AGENT target (plan 68 §3.1, §4.1) — a companion row, one per
 * agent-kind schedule, rather than new columns on `schedules` itself. This
 * is a deliberate deviation from the plan's own §4.1 illustration (which
 * shows `target`/`threadMode`/`onApprovalRequired` as columns added
 * directly to `schedules`): `schedules/runner.test.ts`'s `seedSchedule` and
 * `api/schedules.test.ts`'s `seedSchedule` both build a fully-typed literal
 * `const row: ScheduleRow = {...}` — TypeScript requires EVERY column of a
 * `$inferSelect` type to be present in such a literal regardless of
 * nullability or a SQL-level default, so any new column added directly to
 * `schedules` fails to compile in both files, and neither may be edited
 * (acceptance #2: "existing script schedules behave identically... with
 * their tests UNEDITED"). A companion table keyed on `scheduleId` adds the
 * agent-target fields with ZERO change to `ScheduleRow`'s shape, which is
 * what actually keeps both files compiling and passing untouched — a
 * stronger form of "extending rather than replacing" than the plan's own
 * illustration achieves. Presence of a row here IS the discriminator: the
 * dispatcher (`schedules/runner.ts`) checks for one before ever touching
 * `schedules.scriptRef`.
 */
export const scheduleAgentTargets = sqliteTable(
  'schedule_agent_targets',
  {
    scheduleId: text('schedule_id').primaryKey(),
    agentId: text('agent_id').notNull(),
    prompt: text('prompt').notNull(),
    /** Plan 68 §3.2 — 'new' (default): a fresh thread per firing. 'continue': one long-lived thread, reused via `threadId` below. */
    threadMode: text('thread_mode').notNull().default('new'),
    /** Set once, on the first firing, when threadMode = 'continue'. */
    threadId: text('thread_id'),
    /** Plan 68 §3.5 — 'deny' (default) or 'pause'. */
    onApprovalRequired: text('on_approval_required').notNull().default('deny'),
    /** The most recent agent run this schedule started, for overlap tracking (parallels `schedules.lastBatchId` for the script branch). */
    lastAgentRunId: text('last_agent_run_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_schedule_agent_targets_schedule').on(t.scheduleId)],
)
export type ScheduleAgentTargetRow = typeof scheduleAgentTargets.$inferSelect
export type ScheduleAgentTargetInsert = typeof scheduleAgentTargets.$inferInsert

/**
 * The virtual, database-backed workspace (plan 64 §3.1, §4.1) — deliberately
 * NEVER the real filesystem: scripts run as the core's OS user with full
 * filesystem access (spec §11.3, crash containment not a sandbox) and an
 * agent reads attacker-controllable device screens, so a real directory here
 * would convert a prompt injection into arbitrary host file writes. `path`
 * unique is what makes a write a single upsert and a listing a prefix scan;
 * directories are implied by paths and are never rows of their own (§3.2).
 */
export const workspaceFiles = sqliteTable(
  'workspace_files',
  {
    id: text('id').primaryKey(),
    /** Absolute, NFC-normalised, unique — validated by `workspace/path.ts` before this table is ever touched. */
    path: text('path').notNull().unique(),
    content: blob('content', { mode: 'buffer' }).notNull(),
    contentType: text('content_type').notNull().default('text/plain'),
    size: integer('size').notNull(),
    /** sha256 of `content` — the compare-and-swap token (§3.4). */
    hash: text('hash').notNull(),
    /** 'user:<id>' or 'agent:<id>' — an agent's writes are attributable (§4.5, acceptance #12). */
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_workspace_path').on(t.path)],
)

export type WorkspaceFileRow = typeof workspaceFiles.$inferSelect
export type WorkspaceFileInsert = typeof workspaceFiles.$inferInsert

/**
 * Content-addressed image blobs (plan 70 §3.4, §4.1) — a screenshot or an
 * attached image is stored ONCE, keyed by its own sha256, and referenced
 * from `agent_messages.content` (an `AgentImageRefSchema` block carrying
 * `blobId`) rather than inlined as base64 into every message row and pushed
 * over `/ws`. The id IS the hash, so a row is immutable by construction and
 * two identical screenshots dedupe for free (criterion 2).
 */
export const agentBlobs = sqliteTable('agent_blobs', {
  /** `sha256:<hex>`. */
  id: text('id').primaryKey(),
  mediaType: text('media_type').notNull(),
  bytes: integer('bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  data: blob('data', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export type AgentBlobRow = typeof agentBlobs.$inferSelect
export type AgentBlobInsert = typeof agentBlobs.$inferInsert

/**
 * The durable key/value store scripts use across jobs (plan 79 §3.2, §3.3,
 * §4.2) — global (the whole farm) or device-scoped. The identity is THREE
 * parts, not two (§3.2): `(scope, scopeId, namespace, key)`. `namespace` is
 * the owning plugin's id, or a standalone script's own name — the runtime
 * injects it; a script never types it, which is what makes two plugins both
 * picking the key `token` impossible to collide rather than merely
 * discouraged from colliding. The unique index below IS that rule, enforced
 * by the database.
 *
 * `scopeId` is the device's `stableId` for a device-scoped row, NEVER
 * `devices.id` (§3.3, CLAUDE.md: device identity is stableId; the adb serial
 * is a transport address) — keying on the row id would orphan a device's
 * values the moment it is forgotten and re-admitted with a fresh row.
 * `''` for a global-scoped row (there is no device to name).
 *
 * `value` is a plain TEXT column, not `{mode:'json'}` (a deviation from the
 * plan's own §4.2 illustration, recorded here rather than silently): a
 * secret row does not hold JSON at all, it holds the
 * `secrets/store.ts` AEAD envelope (`iv.tag.ciphertext`) under the `'kv'`
 * namespace, so the column has to accept either shape uniformly as a string.
 * A non-secret row holds `JSON.stringify(value)`.
 */
export const kvEntries = sqliteTable(
  'kv_entries',
  {
    id: text('id').primaryKey(),
    /** 'global' | 'device'. */
    scope: text('scope').notNull(),
    /** The device's stableId for a device-scoped row; '' for global. NOT devices.id — see the table comment. */
    scopeId: text('scope_id').notNull().default(''),
    /** The owning plugin id, or a standalone script's own name (§3.2). Injected by the runtime, never typed by a script. */
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    /** JSON text for a plain value; the `secrets/store.ts` `'kv'`-namespace envelope for a secret. */
    value: text('value').notNull(),
    secret: integer('secret', { mode: 'boolean' }).notNull().default(false),
    /** A masked tail computed once at write time (`secretHint`) — null unless `secret`. */
    hint: text('hint'),
    /** Bumped on every write — the compare-and-swap token (§3.5). */
    version: integer('version').notNull().default(1),
    /** Unix seconds; null never expires. Filtered out on every read the moment it is past, regardless of whether `sweepExpired` has run yet (§4.5). */
    expiresAt: integer('expires_at'),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    /** The job that made the most recent write, if any — informational only. */
    updatedByJobId: text('updated_by_job_id'),
  },
  (t) => [
    // The identity rule from §3.2, enforced by the database rather than convention.
    uniqueIndex('idx_kv_identity').on(t.scope, t.scopeId, t.namespace, t.key),
    index('idx_kv_scan').on(t.scope, t.scopeId, t.namespace),
    index('idx_kv_expiry').on(t.expiresAt),
  ],
)

export type KvEntryRow = typeof kvEntries.$inferSelect
export type KvEntryInsert = typeof kvEntries.$inferInsert

/**
 * A configured provider endpoint plus credential (plan 65 §3.2, §3.6, §4.1)
 * — farm-level, shared across agents (an agent names one by `connectorId`,
 * never holds its own copy). `credential` is `iv.tag.ciphertext`,
 * AES-256-GCM under the `'connector'` namespace of
 * `../secrets/store.ts` — write-only through every API this table backs
 * (`GET` returns `{configured, hint}`, never this column); the exact same
 * honest claim `network_credentials` already states applies here unchanged
 * ("not readable by grepping the database", not real key management).
 */
export const connectors = sqliteTable('connectors', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(), // 'anthropic' | 'openrouter' — free text, validated by ConnectorKindSchema; no migration needed to add a kind (plan 75 §4.4)
  baseUrl: text('base_url'),
  credential: text('credential'),
  /** A masked tail computed ONCE at write time, e.g. "sk-ant-…7Xq2" — never enough to reconstruct the secret, and cheaper than decrypting on every GET just to redact it again. */
  credentialHint: text('credential_hint'),
  status: text('status').default('unknown'), // unknown|ok|unauthenticated|unreachable
  statusMessage: text('status_message'),
  checkedAt: integer('checked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export type ConnectorRow = typeof connectors.$inferSelect

/**
 * A stored, editable AI agent record (plan 65 §3, §4.1) — its own model,
 * provider connector, system prompt, context budgets, tool allowlist,
 * device grants, and workspace scope; farm defaults live in
 * `FarmSettings.agentDefaults` (`@enkaku/protocol`), overridden per agent
 * via `settings` below (`resolveAgentConfig` is the ONE place the two are
 * merged — nothing else reads `settings` directly).
 *
 * Named `ai_agents`, NOT `agents`: `agents` carried a different meaning
 * (the cloud tunnel process) for the whole life of this project before plan
 * 61 renamed it to `nodes` — reusing the exact name for a different thing
 * would make every old migration, backup, and support thread ambiguous.
 *
 * `deviceGrants` EMPTY OR NULL MEANS ALL DEVICES, never none (plan 65 §3.5)
 * — the one place this project deliberately inverts the usual "empty list
 * means nothing" reading, because an agent's authority defaults to
 * everything an operator can already reach and narrows only when a grant is
 * explicitly given. Stated here, in the API, and in the UI copy ("All
 * devices (no restriction)"), so an agent never touches a phone it should
 * not through an implicit reading of an empty list.
 */
export const aiAgents = sqliteTable(
  'ai_agents',
  {
    id: text('id').primaryKey(),
    /** Workspace home (`/agents/<slug>/`) and @mentions — unique across the farm. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    colour: text('colour'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    /** Null ⇒ farm default (`agentDefaults.connectorId`). */
    connectorId: text('connector_id'),
    /** Null ⇒ farm default (`agentDefaults.model`). Model ids carry no date suffix. */
    model: text('model'),
    /** Null ⇒ farm default (`agentDefaults.systemPrompt`). */
    systemPrompt: text('system_prompt'),

    /** `AgentSettings` (`@enkaku/protocol`) — every field optional; unset means inherit the farm default. */
    settings: text('settings', { mode: 'json' }),
    /** Registry capability ids. Validated against the live registry at write time. */
    tools: text('tools', { mode: 'json' }),
    /**
     * Registry capability ids that pause for approval EVEN when their own
     * `effect` is not `destructive` (plan 66 §3.6) — an operator's own
     * added caution on top of the registry's default gate. Validated
     * against the live registry at write time, same as `tools`.
     */
    requiresApproval: text('requires_approval', { mode: 'json' }),
    /** Device ids. EMPTY OR NULL MEANS ALL DEVICES — see the table comment. */
    deviceGrants: text('device_grants', { mode: 'json' }),
    /** `{ read: string[], write: string[] }` — workspace path prefixes (plan 64 §3.2). */
    workspaceScope: text('workspace_scope', { mode: 'json' }),
    /** ACL permission names; capped at the owner's own set at write time AND at execution (plan 65 §3.5). */
    permissions: text('permissions', { mode: 'json' }),
    /** 'on-child-result'|'always'|'never' — null means the default (plan 67 §3.3). */
    wakeOnMessage: text('wake_on_message'),

    ownerId: text('owner_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_ai_agents_created').on(t.createdAt, t.id)],
)

export type AiAgentRow = typeof aiAgents.$inferSelect
export type AiAgentInsert = typeof aiAgents.$inferInsert

/**
 * A conversation with one agent (plan 66 §3.1, §4.1) — lives until deleted.
 * `origin` records how it began: a person typing in Studio ('chat'), a
 * schedule firing (plan 68, 'schedule'), or a parent agent spawning a child
 * (plan 67, 'spawn').
 */
export const agentThreads = sqliteTable(
  'agent_threads',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    title: text('title'),
    origin: text('origin').notNull().default('chat'),
    /** Plan 68 §3.5 — 'pause' (default, every non-schedule origin) or 'deny' (set from the firing schedule's own setting). */
    onApprovalRequired: text('on_approval_required').notNull().default('pause'),
    /**
     * Plan 73 §4.6 — set when a thread is opened FROM a device page ("Ask an
     * agent"): every run created in this thread (the opening message and
     * every one after it) is narrowed to exactly these device ids via
     * `deviceGrantsOverride` (plan 67 §4.2's existing per-run mechanism —
     * this is what feeds it for a whole conversation instead of one spawn
     * call). Null for an ordinary thread, matching the run-level field's own
     * "null means no extra narrowing" rule.
     */
    deviceScope: text('device_scope', { mode: 'json' }).$type<string[] | null>(),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_agent_threads_agent').on(t.agentId, t.createdAt)],
)
export type AgentThreadRow = typeof agentThreads.$inferSelect
export type AgentThreadInsert = typeof agentThreads.$inferInsert

/**
 * One execution within a thread (plan 66 §3.1, §3.2, §4.1): a message in,
 * work, a result out. `stopReason`/`errorClass` make a run that failed at
 * 3 a.m. diagnosable from the row alone (§3.8), never only from a log file.
 */
export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    /** queued|running|paused|succeeded|failed|cancelled */
    status: text('status').notNull().default('queued'),
    /** 'done'|'max-steps'|'max-seconds'|'max-tokens'|'loop-detected'|'cancelled'|'error' */
    stopReason: text('stop_reason'),
    errorClass: text('error_class'),
    error: text('error'),
    steps: integer('steps').notNull().default(0),
    /** { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } */
    usage: text('usage', { mode: 'json' }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    /** Plan 67 §4.1 — the run this one was spawned by (`agent.spawn`), null for a root. */
    parentRunId: text('parent_run_id'),
    /** Plan 67 §4.1 — the root's own id; equals `id` for a root. Makes the whole tree one indexed query. */
    rootRunId: text('root_run_id').notNull(),
    /** Plan 67 §3.6, §4.1 — root = 1, its children = 2, grandchildren = 3 (default depth cap). */
    depth: integer('depth').notNull().default(1),
    /** Plan 67 §3.2, §4.1 — true while the parent is parked on this child's result (`waitFor: true`). */
    awaited: integer('awaited', { mode: 'boolean' }).notNull().default(false),
    /** Plan 67 §4.2 — `agent.spawn`'s `deviceIds`, when given: narrows this ONE run's device grants
     * below the authority intersection (never widens it). Null/absent means no extra narrowing. */
    deviceGrantsOverride: text('device_grants_override', { mode: 'json' }),
  },
  (t) => [index('idx_agent_runs_thread').on(t.threadId, t.startedAt), index('idx_agent_runs_root').on(t.rootRunId), index('idx_agent_runs_parent').on(t.parentRunId)],
)
export type AgentRunRow = typeof agentRuns.$inferSelect
export type AgentRunInsert = typeof agentRuns.$inferInsert

/**
 * One turn — user, assistant, tool, or system (plan 66 §3.1, §4.1).
 * Append-only: nothing is ever rewritten in place, including by compaction
 * (§3.5), which is a VIEW built for the provider at request time, never an
 * edit of this table. The unique index on (threadId, seq) is what makes a
 * double submit produce an error instead of two messages at one seq (§4.1) —
 * `seq` is the client's gap detector across the fetch-then-subscribe
 * boundary (§3.4).
 */
export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    runId: text('run_id'),
    /** Monotonic within the thread. */
    seq: integer('seq').notNull(),
    role: text('role').notNull(), // user|assistant|tool|system
    /** Content blocks — text, thinking, tool_use, tool_result. Zod on read. */
    content: text('content', { mode: 'json' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_agent_messages_seq').on(t.threadId, t.seq),
    index('idx_agent_messages_run').on(t.runId),
  ],
)
export type AgentMessageRow = typeof agentMessages.$inferSelect
export type AgentMessageInsert = typeof agentMessages.$inferInsert

/**
 * A paused destructive capability call awaiting a human decision (plan 66
 * §3.6, §4.1). A row, not memory, so it survives a core restart — the run
 * resumes where it paused once decided (acceptance #9), rather than being
 * lost or silently re-running the steps before it. `expiresAt` is plain
 * unix seconds (not `{mode:'timestamp'}`), matching `jobs.expiresAt`'s own
 * convention for a reaper-compared deadline column.
 */
export const agentApprovals = sqliteTable(
  'agent_approvals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    capabilityId: text('capability_id').notNull(),
    input: text('input', { mode: 'json' }).notNull(),
    /**
     * The `tool_use.id` this approval gates (plan 66 §3.2, §3.6) — added
     * beyond §4.1's illustrative column list because it is what makes
     * resuming a run after a decision UNAMBIGUOUS: a step can carry more
     * than one gated call, and without this, deciding call #1 while call
     * #2 is still pending has no way to say which one a stored decision
     * belongs to. Not null: `run.ts` always knows the call id when it
     * creates the row.
     */
    toolCallId: text('tool_call_id').notNull(),
    status: text('status').notNull().default('pending'), // pending|approved|denied|expired
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_agent_approvals_run').on(t.runId), index('idx_agent_approvals_status').on(t.status)],
)
export type AgentApprovalRow = typeof agentApprovals.$inferSelect
export type AgentApprovalInsert = typeof agentApprovals.$inferInsert

/**
 * The run tree's message channel (plan 67 §3.3, §4.1) — a TABLE, not an
 * in-memory queue, so a message survives a restart and an undelivered one is
 * inspectable when an agent appears stuck. Three edges write here:
 * `agent.send` (parent → a running descendant), `agent.reply` (child →
 * parent), and a detached child's completion (`waitFor: false`). The
 * target's loop drains it ONLY at a turn boundary (`agent/loop/run.ts`'s top
 * of iteration) — never mid tool-call (§3.3's central rule).
 */
export const agentInbox = sqliteTable(
  'agent_inbox',
  {
    id: text('id').primaryKey(),
    targetRunId: text('target_run_id').notNull(),
    fromRunId: text('from_run_id'),
    /** 'message' (agent.send / agent.reply) | 'child-result' (a detached child's completion). */
    kind: text('kind').notNull(),
    body: text('body', { mode: 'json' }).notNull(),
    /** Null until drained at a turn boundary (§3.3) — a client renders "queued" while this is null. */
    deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_agent_inbox_target').on(t.targetRunId, t.deliveredAt)],
)
export type AgentInboxRow = typeof agentInbox.$inferSelect
export type AgentInboxInsert = typeof agentInbox.$inferInsert

/**
 * Which agents may spawn which (plan 67 §3.4, §4.1) — opt-in per pair,
 * defaulting to none, so a newly-created agent cannot spawn anything until
 * an operator says which. A table rather than a JSON column because "which
 * agents may spawn this one" is a question worth asking from both directions.
 */
export const agentSpawnGrants = sqliteTable(
  'agent_spawn_grants',
  {
    parentAgentId: text('parent_agent_id').notNull(),
    childAgentId: text('child_agent_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.parentAgentId, t.childAgentId] }), index('idx_agent_spawn_grants_child').on(t.childAgentId)],
)
export type AgentSpawnGrantRow = typeof agentSpawnGrants.$inferSelect
export type AgentSpawnGrantInsert = typeof agentSpawnGrants.$inferInsert

/**
 * In-app notifications (plan 68 §3.4, §4.1) — the record even when a
 * webhook fails: written FIRST, before any webhook delivery is even
 * attempted (§3.4's central rule). `context` is what makes a row clickable
 * — a link to the run/thread/device/job that produced it (criterion 14).
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    level: text('level').notNull(), // 'info' | 'warn' | 'error'
    title: text('title').notNull(),
    body: text('body'),
    /** `{ runId?, threadId?, agentId?, deviceId?, jobId?, scheduleId? }` — makes it clickable. */
    context: text('context', { mode: 'json' }),
    source: text('source').notNull(), // 'agent:<id>' | 'system'
    readAt: integer('read_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_notifications_created').on(t.createdAt, t.id)],
)
export type NotificationRow = typeof notifications.$inferSelect
export type NotificationInsert = typeof notifications.$inferInsert

/**
 * A configured webhook endpoint (plan 68 §3.4, §4.1) — farm-level and
 * admin-managed; an agent chooses only among these NAMES via `notify.send`,
 * never a raw URL, so a webhook cannot leak farm information to an
 * arbitrary address (§8's risk table). `secretRef` is `iv.tag.ciphertext`
 * under the `'webhook'` namespace of `../secrets/store.ts` — the SAME
 * mechanism `connectors.credential` already uses, not a third one — never
 * returned by any API (write-only, exactly like a connector credential).
 */
export const webhookEndpoints = sqliteTable('webhook_endpoints', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  url: text('url').notNull(),
  /** `iv.tag.ciphertext`, AES-256-GCM under the `'webhook'` secrets namespace — never the plaintext secret. Null when the endpoint is unsigned (no secret configured yet). */
  secretRef: text('secret_ref'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Rolling delivery health (plan 68 §4.1) — so a dead endpoint is visible before someone needs it. */
  lastStatus: text('last_status'), // 'ok' | 'failed' | null (never attempted)
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp' }),
  failureCount: integer('failure_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect
export type WebhookEndpointInsert = typeof webhookEndpoints.$inferInsert

/**
 * One published VERSION of a plugin (plan 82 §4.2) — a plugin is a grouping
 * and build concept, not a runtime one (§3.1): activating a version writes
 * N ordinary `scripts` rows (named `<name>/<scriptId>`) alongside this row;
 * a job never references this table, only the `scripts` row it produced,
 * which is why rolling back or removing a plugin never touches a queued or
 * running job (§3.9, §4.4).
 *
 * `(name, version)` is unique, exactly like `scripts` (plan 62 §3.1) — the
 * property that makes a pinned reference mean something. `bundle` is
 * duplicated per version (not de-duplicated across the plugin's history) so
 * `rollback` (§4.3) works without a re-publish: the old bundle is still
 * sitting in its own row.
 */
export const plugins = sqliteTable(
  'plugins',
  {
    id: text('id').primaryKey(),
    /** `tiktok` — stable across versions; NOT unique alone, `(name, version)` is. */
    name: text('name').notNull(),
    version: text('version').notNull(),
    title: text('title'),
    description: text('description'),
    /** The single bundle every one of this version's scripts rows points at (§3.2). */
    bundle: text('bundle').notNull(),
    source: text('source'),
    /** sha256 of `bundle` — what the materialised-file cache keys on (§4.5). */
    bundleHash: text('bundle_hash').notNull(),
    /** staged | verifying | active | superseded | failed | disabled (§3.7, §3.8, §4.4). */
    status: text('status').notNull().default('staged'),
    verifiedAt: integer('verified_at', { mode: 'timestamp' }),
    /** Human-readable, verbatim from the verification child (§3.7 step 2). Shown in the UI (§4.6). */
    verifyError: text('verify_error'),
    verifyErrorCode: text('verify_error_code'),
    /** What the bundle declared once verified: script ids and their JSON-Schema params. Null until verified. */
    manifest: text('manifest', { mode: 'json' }),
    /** `{ packages: string[] }` — merged with each script's own at the runner (§3.10). Null if the plugin declares none. */
    resetPackages: text('reset_packages', { mode: 'json' }),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_plugins_name_version').on(t.name, t.version),
    index('idx_plugins_status').on(t.name, t.status),
  ],
)

export type PluginRow = typeof plugins.$inferSelect
export type PluginInsert = typeof plugins.$inferInsert
