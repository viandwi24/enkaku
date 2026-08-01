import { join, normalize } from 'node:path'
import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { artifacts } from '../db/schema'
import { EnkakuError } from '../util/errors'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
  log: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
}

/** Artifact per job: list + download (spec §11.2, §19 job detail). */
export function createArtifactRoutes(deps: { db: Db; dataDir: string }): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    const jobId = c.req.query('jobId')
    if (!jobId) throw new EnkakuError('E_BAD_REQUEST', 'query ?jobId= wajib')
    const rows = deps.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.jobId, jobId))
      .orderBy(asc(artifacts.createdAt))
      .all()
    return c.json({
      artifacts: rows.map((r) => ({
        id: r.id,
        jobId: r.jobId,
        kind: r.kind,
        label: r.label,
        path: r.path,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
      })),
    })
  })

  app.get('/:id/content', async (c) => {
    const row = deps.db.select().from(artifacts).where(eq(artifacts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('artifact_not_found', 'artifact tidak ada')
    // path di DB relatif terhadap app-data; tolak traversal.
    const rel = normalize(row.path)
    if (rel.startsWith('..')) throw new EnkakuError('E_BAD_REQUEST', 'path artifact tidak valid')
    const abs = join(deps.dataDir, rel)
    const file = Bun.file(abs)
    if (!(await file.exists())) throw new EnkakuError('artifact_not_found', 'file artifact sudah tidak ada di disk')
    const ext = rel.split('.').pop() ?? ''
    return new Response(file, {
      headers: { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' },
    })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (err.code === 'artifact_not_found' ? 404 : 400) as 400)
    }
    throw err
  })

  return app
}
