/**
 * Response envelopes for the core's REST surface (plan 72 §4.1) — declared
 * ONCE here and shared by `packages/core`'s route handlers and
 * `packages/studio`'s `api()` calls, so a shape mismatch between the two is
 * a typecheck failure rather than a runtime `undefined` (plan 72 §3.2).
 *
 * One file per route group, built from the entity schemas that already
 * exist elsewhere in this package — no entity schema is duplicated here.
 */
export * from './json-schema'
export * from './pagination'
export * from './agents'
export * from './connectors'
export * from './threads'
export * from './blobs'
export * from './capabilities'
export * from './devices'
export * from './jobs'
export * from './workflow-jobs'
export * from './artifacts'
export * from './scripts'
export * from './workflows'
export * from './node-types'
export * from './batches'
export * from './schedules'
export * from './groups'
export * from './notifications'
export * from './webhooks'
export * from './settings'
export * from './adb'
export * from './app-restart'
export * from './video'
export * from './auth'
export * from './tools'
export * from './tags'
export * from './monitor'
export * from './workspace'
export * from './plugins'
export * from './kv'
export * from './storage'
