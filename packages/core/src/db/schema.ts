import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Tabel devices (spec §12, subset M0). Tabel lain (jobs, scripts, artifacts,
 * users, tool_installs, audit_log) menyusul di plan yang membutuhkannya —
 * jangan dibuat "sekalian" (plan 01 §2).
 */
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  /** Identitas stabil: ro.serialno / ANDROID_ID (spec §7.5). */
  stableId: text('stable_id').notNull().unique(),
  /** Alamat transport adb saat ini — bisa berubah (USB ↔ ip:port). */
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
  lastSeen: integer('last_seen', { mode: 'timestamp' }),
})

export type DeviceRow = typeof devices.$inferSelect
export type DeviceInsert = typeof devices.$inferInsert

/** Katalog install tool (spec §12) — kebenaran fisik tetap di disk. */
export const toolInstalls = sqliteTable('tool_installs', {
  id: text('id').primaryKey(),
  toolId: text('tool_id').notNull(),
  version: text('version').notNull(),
  active: integer('active', { mode: 'boolean' }).default(false),
  sha256: text('sha256'),
  installedAt: integer('installed_at', { mode: 'timestamp' }),
})

export type ToolInstallRow = typeof toolInstalls.$inferSelect

/** Antrian job per-device (spec §12, §10.3). */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    scriptId: text('script_id').notNull(), // M3: 'internal:sleep'
    deviceId: text('device_id').notNull(),
    params: text('params', { mode: 'json' }),
    priority: integer('priority').default(0),
    status: text('status').default('queued'), // queued|running|success|failed|cancelled
    /** Epoch detik — lease job, diperpanjang heartbeat runner (spec §10.2). */
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

