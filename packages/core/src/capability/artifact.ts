import { ArtifactGetInputSchema, ArtifactGetOutputSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `artifact.get` (owner request 2026-09-16) — does a stored artifact still
 * exist, and what is it.
 *
 * Exists because the Files page can now delete uploads in bulk, and a plugin
 * that remembered an artifact id (the Social Media Manager's post rows, for
 * one) needs a cheap way to find out the file is gone BEFORE it dispatches a
 * job that would fail pushing it. A missing artifact is an answer, not an
 * error: `{ exists: false, artifact: null }`.
 *
 * `job.view`, not `device.files`: this reads metadata `GET /api/artifacts`
 * already lists without a files permission, and moves no bytes. A plugin
 * declares the capability id (`artifact.get`) in its `service.permissions`.
 */
export const artifactGet = defineCapability({
  id: 'artifact.get',
  input: ArtifactGetInputSchema,
  output: ArtifactGetOutputSchema,
  permission: 'job.view',
  deadline: 5_000,
  effect: 'read',
  description:
    'Whether an artifact (an uploaded file, or a run\'s output) still exists, with its metadata when it does. ' +
    'A missing artifact answers { exists: false, artifact: null } rather than failing, so a caller can check before ' +
    'dispatching work that pushes the file — the Files page can delete uploads.',
  handler: (ctx, { artifactId }) => {
    if (!ctx.artifacts) throw new EnkakuError('E_NOT_SUPPORTED', 'artifact.get is not available on this host')
    const artifact = ctx.artifacts.get(artifactId)
    return Promise.resolve({ exists: artifact !== null, artifact })
  },
})

export const ARTIFACT_CAPABILITIES = [artifactGet]
