import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Tabel devices (spec §12, subset M0). Tabel lain (jobs, scripts, artifacts,
 * users, tool_installs, audit_log) arrive in the plans that need them —
 * are not created "while we are here" (plan 01 §2).
 */
export const devices = sqliteTable('devices', {
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
})

export type DeviceRow = typeof devices.$inferSelect
export type DeviceInsert = typeof devices.$inferInsert

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
  },
  (t) => [
    index('idx_jobs_claim').on(t.status, t.deviceId, t.priority, t.createdAt),
    index('idx_jobs_device').on(t.deviceId, t.createdAt),
  ],
)

export type JobRow = typeof jobs.$inferSelect

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
  (t) => [uniqueIndex('idx_scripts_name_version').on(t.name, t.version)],
)

export type ScriptRow = typeof scripts.$inferSelect

/** Per-job artifacts (spec §12). `path` is relative to app-data. */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    kind: text('kind').notNull(), // screenshot|log|file|video
    label: text('label'),
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes'),
    createdAt: integer('created_at', { mode: 'timestamp' }),
  },
  (t) => [index('idx_artifacts_job').on(t.jobId, t.createdAt)],
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

/** Cloud agents (plan 11 §4.3) — one agent holds many devices. */
export const agents = sqliteTable('agents', {
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
})

export type AgentRow = typeof agents.$inferSelect
