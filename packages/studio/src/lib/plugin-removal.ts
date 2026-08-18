import {
  classifyPluginVersionRemoval,
  planPluginVersionRemoval,
  PluginBulkRemoveResponseSchema,
  type PluginBulkRemoveResponse,
  type PluginVersionCandidate,
  type PluginVersionRemovalScope,
} from '@enkaku/protocol'
import { api } from '@enkaku/ui'

/**
 * The browser half of bulk version removal — `POST
 * /api/plugins/:name/versions/remove`.
 *
 * The farm owner asked for three removals on a plugin row (2026-08-17):
 * *"remove specific versi, atau remove all version, atau remove all except
 * latest version"*. The first is `DELETE /api/plugins/:name/:version` and is
 * `RemovePluginAction`'s own, unchanged. These are the other two.
 *
 * **This module lives outside `components/plugins/` on purpose.** The removal
 * ACTION is a component another worker owns and was rebuilding when this
 * landed; what belongs to the API half is the request, the copy derived from
 * the plan, and the reading of the per-version report. Kept here, that half is
 * a pure module with no JSX — testable on its own, and droppable into whatever
 * shape the row's actions end up in.
 *
 * ## Nothing here decides what gets deleted
 *
 * `planPluginVersionRemoval` is imported from `@enkaku/protocol` and is the
 * SAME function `packages/core/src/plugins/runtime.ts` calls to do the work.
 * That is the point: a confirm dialog that promises "these nine go, these two
 * stay" and a server that then applies a slightly different rule is worse than
 * no dialog at all. Studio calls it to WRITE the sentence; the core calls it to
 * PERFORM it. There is no second copy of the rule to drift.
 */

/** The two bulk scopes, in the vocabulary `RemovePluginAction` already uses. */
export type BulkRemoveScope = 'all' | 'all-except-latest'

/** `RemovePluginAction`'s vocabulary → the protocol's. Two names for one thing is a translation, not a decision. */
export function toProtocolScope(scope: BulkRemoveScope): PluginVersionRemovalScope {
  return scope === 'all' ? 'all' : 'except-latest'
}

/**
 * POST the bulk removal.
 *
 * `deleteKv` is sent only for `all`. `all-except-latest` must never carry it:
 * every version of a plugin shares ONE key/value namespace, so deleting the
 * namespace while keeping the latest version would empty the store out from
 * under the exact row the operator chose to keep.
 */
export function requestBulkRemoval(name: string, scope: BulkRemoveScope, deleteKv: boolean): Promise<PluginBulkRemoveResponse> {
  return api(`/api/plugins/${encodeURIComponent(name)}/versions/remove`, PluginBulkRemoveResponseSchema, {
    method: 'POST',
    json: { scope: toProtocolScope(scope), deleteKv: scope === 'all' ? deleteKv : false },
  })
}

export interface BulkRemovalPreview {
  /** Versions this request will attempt to delete, oldest first — the same order the core works through them in. */
  going: string[]
  /** Versions it will not touch, each with the reason in the operator's own words. */
  staying: { version: string; reason: string }[]
}

/**
 * What the confirm dialog must state: exactly what goes and exactly what stays,
 * **by name and count**, not "are you sure?".
 *
 * The `staying` list is the half that matters and the half a naive
 * implementation would omit. "Remove all except the latest" keeps more than the
 * latest — the ACTIVE version too, and they are not always the same row: a
 * rollback leaves an older version `active` while a newer one sits
 * `superseded`. An operator pruning history must be told that the live row is
 * safe, by name, before they press the button.
 */
export function previewBulkRemoval(versions: readonly PluginVersionCandidate[], scope: BulkRemoveScope): BulkRemovalPreview {
  const plan = planPluginVersionRemoval(versions, toProtocolScope(scope))
  return {
    going: plan.remove.map((v) => v.version),
    staying: plan.keep.map((k) => ({ version: k.candidate.version, reason: k.message })),
  }
}

export interface BulkRemovalSummary {
  removed: string[]
  kept: string[]
  failed: { version: string; code: string; message: string }[]
  kvDeleted: number
  /** The toast headline, and `null` when the request removed nothing at all — the caller raises that as a failure instead. */
  title: string
  /** The toast body: what was refused and why. `null` when everything asked for happened. */
  description: string | null
}

/**
 * Read the per-version report.
 *
 * **Partial success is the normal case, not an error.** Nine of eleven removed
 * with two named refusals is a completed request, and the summary says so
 * plainly rather than colouring the whole thing red — but it never rounds the
 * refusals away either: each one is named with the core's own code and message
 * (chiefly `script_in_use`, a queued or running job still holding that
 * version), because "which two, and why" is the only part an operator can act
 * on.
 */
export function summariseBulkRemoval(name: string, report: PluginBulkRemoveResponse): BulkRemovalSummary {
  const removed: string[] = []
  const kept: string[] = []
  const failed: BulkRemovalSummary['failed'] = []
  for (const r of report.results) {
    const outcome = classifyPluginVersionRemoval(r)
    if (outcome === 'removed') removed.push(r.version)
    else if (outcome === 'kept') kept.push(r.version)
    else failed.push({ version: r.version, code: r.error?.code ?? 'unknown', message: r.error?.message ?? 'no reason given' })
  }
  const kvDeleted = report.results.reduce((n, r) => n + r.kvDeleted, 0)

  const plural = (n: number) => (n === 1 ? 'version' : 'versions')
  const title =
    removed.length === 0
      ? // Two very different nothings, and they must not share a sentence. Every
        // version REFUSED is a problem to act on; every version KEPT is the
        // guard doing its job on a plugin whose whole history is already live or
        // newest, and colouring that red would teach an operator to ignore the
        // colour.
        failed.length > 0
        ? `No version of ${name} could be removed`
        : `Nothing to remove — every version of ${name} was kept`
      : failed.length > 0
        ? `${removed.length} of ${removed.length + failed.length} ${plural(removed.length + failed.length)} of ${name} removed`
        : `${removed.length} ${plural(removed.length)} of ${name} removed`

  const parts: string[] = []
  if (failed.length > 0) parts.push(`Refused: ${failed.map((f) => `${f.version} (${f.code}) — ${f.message}`).join('; ')}`)
  if (kept.length > 0) parts.push(`Kept: ${kept.join(', ')}`)
  if (kvDeleted > 0) parts.push(`${kvDeleted} stored ${kvDeleted === 1 ? 'entry' : 'entries'} deleted`)
  if (report.webhooksDeleted > 0) {
    parts.push(`${report.webhooksDeleted} webhook ${report.webhooksDeleted === 1 ? 'secret' : 'secrets'} dropped — nothing named ${name} is left`)
  }

  return { removed, kept, failed, kvDeleted, title, description: parts.length > 0 ? parts.join('. ') : null }
}
