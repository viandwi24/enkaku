import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactInfo } from '@enkaku/protocol'
import type { Db } from '../db'
import { artifacts } from '../db/schema'
import { EnkakuError } from '../util/errors'

const MAX_FILE_BYTES = 8 * 1024 * 1024

const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'artifact'

export interface ArtifactStore {
  save(input: {
    kind: 'screenshot' | 'file' | 'log'
    label: string
    data: Uint8Array
    ext?: string
  }): Promise<ArtifactInfo>
  jobDir(): string
}

/**
 * Per-job artifacts (spec §11.2, §7.2): `<app-data>/artifacts/<job-id>/`.
 * `path` is stored RELATIVE to app-data so the folder can be moved.
 */
export function createArtifactStore(deps: {
  db: Db
  dataDir: string
  jobId: string
  onSaved: (info: ArtifactInfo) => void
}): ArtifactStore {
  const dir = join(deps.dataDir, 'artifacts', deps.jobId)
  let seq = 0

  return {
    jobDir: () => dir,

    async save({ kind, label, data, ext }) {
      if (kind === 'file' && data.length > MAX_FILE_BYTES) {
        throw new EnkakuError('ARTIFACT_TOO_LARGE', `artifact "${label}" ${data.length} byte melebihi 8 MB`)
      }
      mkdirSync(dir, { recursive: true })
      seq += 1
      const extension = ext ?? (kind === 'screenshot' ? 'png' : kind === 'log' ? 'log' : 'bin')
      const filename = `${String(seq).padStart(3, '0')}-${slug(label)}.${extension}`
      const abs = join(dir, filename)
      await Bun.write(abs, data)
      const size = statSync(abs).size
      const info: ArtifactInfo = {
        id: crypto.randomUUID(),
        jobId: deps.jobId,
        kind,
        label,
        path: join('artifacts', deps.jobId, filename),
        sizeBytes: size,
        createdAt: Math.floor(Date.now() / 1000),
      }
      deps.db
        .insert(artifacts)
        .values({
          id: info.id,
          jobId: info.jobId,
          kind: info.kind,
          label: info.label,
          path: info.path,
          sizeBytes: size,
          createdAt: new Date(),
        })
        .run()
      deps.onSaved(info)
      return info
    },
  }
}
