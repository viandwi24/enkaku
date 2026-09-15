import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { ArtifactBulkDeleteResponseSchema, ArtifactReferencesResponseSchema, type ShellMode } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { AuditLogger } from '../auth/audit'
import { getArtifactInfo } from '../artifacts/references'
import { artifactGet } from '../capability/artifact'
import type { CapabilityContext } from '../capability/context'
import { openDb, runMigrations } from '../db'
import { artifacts, jobRuns, jobs, kvEntries } from '../db/schema'
import { createArtifactRoutes } from './artifacts'

/**
 * Bulk removal of uploads (owner request 2026-09-16) and the reference check
 * that keeps it from breaking running work: the body schema, the files gate,
 * preview vs. real, pins, blocking vs. non-blocking references, `force`, and
 * the single DELETE's own in-use refusal.
 */

type Audited = { action: string; target?: string; meta?: unknown }

function setUp(opts: { role?: 'admin' | 'operator' | null; mode?: ShellMode } = {}) {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const db = opened.db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-artifacts-'))
  const audited: Audited[] = []
  const audit: AuditLogger = { record: (e) => void audited.push(e), list: () => [] }
  const inner = createArtifactRoutes({ db, dataDir, upload: { audit, shellSettings: () => ({ mode: opts.mode ?? 'operator' }) } })
  const app = new Hono<AuthEnv>()
  const role = opts.role === undefined ? 'operator' : opts.role
  app.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u1@test', role })
    await next()
  })
  app.route('/', inner)

  const addArtifact = (o: { label: string; sizeBytes?: number; ageSec?: number; pinned?: boolean; mimeType?: string; kind?: 'file' | 'video' | 'screenshot'; runId?: string | null }): string => {
    const id = crypto.randomUUID()
    const rel = join('artifacts', 'uploads', `${id}.bin`)
    mkdirSync(dirname(join(dataDir, rel)), { recursive: true })
    writeFileSync(join(dataDir, rel), 'x'.repeat(o.sizeBytes ?? 10))
    db.insert(artifacts)
      .values({
        id,
        runId: o.runId ?? null,
        deviceId: null,
        kind: o.kind ?? 'video',
        label: o.label,
        path: rel,
        sizeBytes: o.sizeBytes ?? 10,
        createdAt: new Date(Date.now() - (o.ageSec ?? 0) * 1000),
        pinned: o.pinned ?? false,
        mimeType: o.mimeType ?? 'video/mp4',
      })
      .run()
    return id
  }
  const fileOf = (id: string): string => join(dataDir, 'artifacts', 'uploads', `${id}.bin`)

  const addJob = (jobId: string, params: unknown, status: string): void => {
    db.insert(jobs).values({ id: jobId, deviceId: 'd1', params, scriptName: 'post-video', createdAt: new Date() }).run()
    db.insert(jobRuns).values({ id: `${jobId}-run`, jobId, seq: 1, trigger: 'manual', status, deviceId: 'd1', createdAt: new Date() }).run()
  }

  const addKv = (o: { key: string; value: unknown; secret?: boolean; expiresAt?: number | null }): void => {
    db.insert(kvEntries)
      .values({
        id: crypto.randomUUID(),
        scope: 'global',
        scopeId: '',
        namespace: 'social-media-manager',
        key: o.key,
        value: JSON.stringify(o.value),
        secret: o.secret ?? false,
        expiresAt: o.expiresAt ?? null,
        updatedAt: new Date(),
      })
      .run()
  }

  const post = (body: unknown) => app.request('/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const rowExists = (id: string): boolean => getArtifactInfo(db, id) !== null

  return { db, app, audited, addArtifact, fileOf, addJob, addKv, post, rowExists }
}

describe('POST /api/artifacts/delete — body and gate', () => {
  test('refuses a body naming both ids and filter, neither, or an unknown field', async () => {
    const t = setUp()
    expect((await t.post({ ids: ['a'], filter: {} })).status).toBe(400)
    expect((await t.post({})).status).toBe(400)
    expect((await t.post({ filter: {}, everything: true })).status).toBe(400)
    expect((await t.post({ ids: [] })).status).toBe(400)
  })

  test('is gated like single delete: no user, or files switched off, is forbidden', async () => {
    expect((await setUp({ role: null }).post({ filter: {} })).status).toBe(403)
    expect((await setUp({ mode: 'off' }).post({ filter: {} })).status).toBe(403)
  })
})

describe('POST /api/artifacts/delete — outcomes', () => {
  test('a preview deletes nothing and reports exactly what the real call would do', async () => {
    const t = setUp()
    const plain = t.addArtifact({ label: 'plain.mp4', sizeBytes: 100 })
    const pinned = t.addArtifact({ label: 'pinned.mp4', pinned: true })
    const running = t.addArtifact({ label: 'running.mp4' })
    const smm = t.addArtifact({ label: 'smm.mp4' })
    t.addJob('job-1', { videoArtifactId: running }, 'running')
    t.addKv({ key: `post:${smm}`, value: { status: 'failed' } })

    const res = await t.post({ filter: {}, preview: true })
    expect(res.status).toBe(200)
    const body = ArtifactBulkDeleteResponseSchema.parse(await res.json())
    expect(body).toMatchObject({ preview: true, matched: 4, deleted: 1, bytesFreed: 100, skipped: 3, failed: 0 })
    const byId = new Map(body.items.map((i) => [i.id, i]))
    expect(byId.get(plain)).toMatchObject({ outcome: 'would-delete' })
    expect(byId.get(pinned)).toMatchObject({ outcome: 'skipped', reason: 'pinned' })
    expect(byId.get(running)).toMatchObject({ outcome: 'skipped', reason: 'in-use' })
    expect(byId.get(running)?.references[0]).toMatchObject({ kind: 'job', blocking: true, jobId: 'job-1', status: 'running' })
    expect(byId.get(smm)).toMatchObject({ outcome: 'skipped', reason: 'referenced' })
    expect(byId.get(smm)?.references[0]).toMatchObject({ kind: 'plugin-data', blocking: false, namespace: 'social-media-manager', key: `post:${smm}` })

    for (const id of [plain, pinned, running, smm]) {
      expect(t.rowExists(id)).toBe(true)
      expect(existsSync(t.fileOf(id))).toBe(true)
    }
    expect(t.audited).toEqual([])
  })

  test('the real call removes row and bytes for the deletable files only, and audits each one plus a summary', async () => {
    const t = setUp()
    const plain = t.addArtifact({ label: 'plain.mp4', sizeBytes: 100 })
    const queued = t.addArtifact({ label: 'queued.mp4' })
    const smm = t.addArtifact({ label: 'smm.mp4' })
    t.addJob('job-q', { artifactId: queued }, 'queued')
    t.addKv({ key: 'post:abc', value: { videoArtifactId: smm } })

    const body = ArtifactBulkDeleteResponseSchema.parse(await (await t.post({ filter: {} })).json())
    expect(body).toMatchObject({ preview: false, deleted: 1, bytesFreed: 100, skipped: 2 })
    expect(t.rowExists(plain)).toBe(false)
    expect(existsSync(t.fileOf(plain))).toBe(false)
    expect(t.rowExists(queued)).toBe(true)
    expect(t.rowExists(smm)).toBe(true)
    expect(t.audited.map((a) => a.action)).toEqual(['artifact.delete', 'artifact.delete.bulk'])
    expect(t.audited[0]?.target).toBe(plain)
  })

  test('force deletes a file held only by plugin data, never one a queued or running job uses, never a pinned one', async () => {
    const t = setUp()
    const smm = t.addArtifact({ label: 'smm.mp4' })
    const running = t.addArtifact({ label: 'running.mp4' })
    const pinned = t.addArtifact({ label: 'pinned.mp4', pinned: true })
    t.addKv({ key: `post:${smm}`, value: {} })
    t.addKv({ key: `post:${running}`, value: {} })
    t.addJob('job-r', { artifactIds: [running] }, 'running')

    const body = ArtifactBulkDeleteResponseSchema.parse(await (await t.post({ filter: {}, force: true })).json())
    expect(body.deleted).toBe(1)
    expect(t.rowExists(smm)).toBe(false)
    expect(t.rowExists(running)).toBe(true)
    expect(t.rowExists(pinned)).toBe(true)
    expect(body.items.find((i) => i.id === running)).toMatchObject({ reason: 'in-use' })
  })

  test('a finished job no longer holds its file; secret and expired KV rows are not searched', async () => {
    const t = setUp()
    const done = t.addArtifact({ label: 'done.mp4' })
    const secret = t.addArtifact({ label: 'secret.mp4' })
    const expired = t.addArtifact({ label: 'expired.mp4' })
    t.addJob('job-done', { artifactId: done }, 'success')
    t.addKv({ key: 'enc', value: secret, secret: true })
    t.addKv({ key: 'old', value: expired, expiresAt: Math.floor(Date.now() / 1000) - 60 })

    const body = ArtifactBulkDeleteResponseSchema.parse(await (await t.post({ filter: {}, preview: true })).json())
    expect(body.deleted).toBe(3)
  })

  test('ids mode reports an unknown id and a run artifact instead of deleting them', async () => {
    const t = setUp()
    const upload = t.addArtifact({ label: 'upload.mp4' })
    const runShot = t.addArtifact({ label: 'shot.png', kind: 'screenshot', runId: 'run-9' })

    const body = ArtifactBulkDeleteResponseSchema.parse(await (await t.post({ ids: [upload, runShot, 'nope', upload] })).json())
    expect(body.matched).toBe(3)
    expect(body.items.find((i) => i.id === 'nope')).toMatchObject({ outcome: 'skipped', reason: 'not-found' })
    expect(body.items.find((i) => i.id === runShot)).toMatchObject({ outcome: 'skipped', reason: 'not-upload' })
    expect(t.rowExists(upload)).toBe(false)
    expect(t.rowExists(runShot)).toBe(true)
  })

  test('filter mode selects by family, age and name, and never reaches a run artifact', async () => {
    const t = setUp()
    const oldVideo = t.addArtifact({ label: 'Old clip.mp4', ageSec: 10 * 86_400 })
    t.addArtifact({ label: 'New clip.mp4', ageSec: 60 })
    t.addArtifact({ label: 'Old picture.png', ageSec: 10 * 86_400, kind: 'file', mimeType: 'image/png' })
    t.addArtifact({ label: 'Old run clip.mp4', ageSec: 10 * 86_400, runId: 'run-1' })

    const body = ArtifactBulkDeleteResponseSchema.parse(
      await (await t.post({ filter: { family: 'video', olderThanSec: 7 * 86_400, query: 'CLIP' }, preview: true })).json(),
    )
    expect(body.items.map((i) => i.id)).toEqual([oldVideo])
  })
})

describe('references and single delete', () => {
  test('GET /references names every upload something still uses', async () => {
    const t = setUp()
    const a = t.addArtifact({ label: 'a.mp4' })
    const b = t.addArtifact({ label: 'b.mp4' })
    t.addArtifact({ label: 'free.mp4' })
    t.addJob('job-1', { workflow: { steps: [{ params: { v: a } }] } }, 'queued')
    t.addKv({ key: 'post:x', value: { videoArtifactId: b.toUpperCase() } })

    const res = await t.app.request('/references')
    expect(res.status).toBe(200)
    const { references } = ArtifactReferencesResponseSchema.parse(await res.json())
    expect(Object.keys(references).sort()).toEqual([a, b].sort())
    expect(references[a]?.[0]).toMatchObject({ kind: 'job', status: 'queued' })
    expect(references[b]?.[0]).toMatchObject({ kind: 'plugin-data', key: 'post:x' })
  })

  test('DELETE /:id refuses a file a running job uses, and still deletes one plugin data names', async () => {
    const t = setUp()
    const running = t.addArtifact({ label: 'running.mp4' })
    const smm = t.addArtifact({ label: 'smm.mp4' })
    t.addJob('job-1', { artifactId: running }, 'running')
    t.addKv({ key: `post:${smm}`, value: {} })

    const refused = await t.app.request(`/${running}`, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(await refused.json())).toContain('E_ARTIFACT_IN_USE')
    expect(t.rowExists(running)).toBe(true)

    expect((await t.app.request(`/${smm}`, { method: 'DELETE' })).status).toBe(200)
    expect(t.rowExists(smm)).toBe(false)
  })

  test('artifact.get answers exists:false for a missing artifact instead of failing', async () => {
    const t = setUp()
    const id = t.addArtifact({ label: 'a.mp4' })
    const ctx = { artifacts: { get: (artifactId: string) => getArtifactInfo(t.db, artifactId) } } as unknown as CapabilityContext
    expect(await artifactGet.handler(ctx, { artifactId: id })).toMatchObject({ exists: true, artifact: { id, label: 'a.mp4' } })
    expect(await artifactGet.handler(ctx, { artifactId: 'gone' })).toEqual({ exists: false, artifact: null })
  })
})
