import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
    /** Agent pemilik device (mode cloud); null = device lokal. */
    agentId: text('agent_id'),
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
     * own and does not collide with that column's schema. This stores the
     * upstream password in PLAINTEXT at rest in SQLite: there is no secret
     * store yet (plan 33 §9 Q2 remains open), and this comment exists so
     * that fact is never quietly assumed away. Never read this column into
     * an API response without redacting it first.
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
     * Plan 36 §3.4, §3.6 — how many times this job has been requeued for an
     * infrastructure failure (rebind on another eligible device for a batch
     * member). Nullable/defaulted so existing rows keep reading; 0 for a job
     * that has never rebound.
     */
    infraAttempts: integer('infra_attempts').default(0),
  },
  (t) => [
    index('idx_jobs_claim').on(t.status, t.deviceId, t.priority, t.createdAt),
    index('idx_jobs_device').on(t.deviceId, t.createdAt),
    index('idx_jobs_batch').on(t.batchId, t.batchSeq),
    // The unfiltered `/api/jobs` keyset list — `(createdAt DESC, id DESC)`
    // (plan 30 §4.2). idx_jobs_device only helps once a deviceId is given.
    index('idx_jobs_created').on(t.createdAt, t.id),
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
  },
  (t) => [
    uniqueIndex('idx_scripts_name_version').on(t.name, t.version),
    index('idx_scripts_created').on(t.createdAt, t.id),
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

/** Cloud agents (plan 11 §4.3) — one agent holds many devices. */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    /** Multi-tenant (M8c) — null di single-tenant. */
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
  (t) => [index('idx_agents_created').on(t.createdAt, t.id)],
)

export type AgentRow = typeof agents.$inferSelect

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

    scriptId: text('script_id').notNull(),
    params: text('params', { mode: 'json' }),
    /** Exactly one of clusterId / deviceIds is populated (plan 21 §9 open question #3 — no "all devices"). */
    clusterId: text('cluster_id'),
    deviceIds: text('device_ids', { mode: 'json' }), // string[]

    // Batch shape, passed straight through to plan 20's dispatcher.
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
