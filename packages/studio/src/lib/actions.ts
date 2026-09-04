import {
  ActionResponseSchema,
  OperationResponseSchema,
  type ActionParams,
  type ActionResponse,
  type ActionResult,
  type ActionResultStatus,
  type ActionVerb,
  type Operation,
  type Target,
} from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { toast } from 'sonner'

/**
 * The Studio-side client for the actions API (plan 207 §4.9): one endpoint
 * per verb, taking a target, answering `202` with one result per device
 * (`runAction`), plus the async-verb follow-up (`fetchOperation`/
 * `awaitOperation`). `runOnDevice` and `groupResults` are the two shapes the
 * old single-device and bulk dialogs need to keep working unchanged on top
 * of this — see `docs/plans/207-mvp-actions-api-and-groups.md` §4.9 for the
 * full call-site table this file replaces.
 */

/** Thrown by `runOnDevice` for any terminal, non-`done` outcome — `forbidden`, `skipped`, or `failed` (never `accepted`/`warned`; those are handled inline). */
export class ActionRefusedError extends Error {
  readonly status: ActionResult['status']
  readonly code: string
  readonly deviceId: string

  constructor(result: ActionResult) {
    super(result.message ?? `the device refused (${result.status})`)
    this.name = 'ActionRefusedError'
    this.status = result.status
    this.code = result.code ?? result.status
    this.deviceId = result.deviceId
  }
}

/** `POST /api/actions/:verb` (plan 207 §4.2). Answers per device — a single device is a target of one. */
export function runAction<V extends ActionVerb>(verb: V, target: Target, params: ActionParams<V>, opts?: { force?: boolean }): Promise<ActionResponse> {
  return api(`/api/actions/${verb}`, ActionResponseSchema, { method: 'POST', json: { target, ...params, force: opts?.force ?? false } })
}

/** `GET /api/operations/:id` (plan 207 §4.2) — readable for one hour after every result settles. */
export function fetchOperation(id: string): Promise<Operation> {
  return api(`/api/operations/${encodeURIComponent(id)}`, OperationResponseSchema).then((body) => body.operation)
}

/** Polls every `intervalMs` (default 1000) until `settled`, or throws after `timeoutMs` (default 600000). */
export async function awaitOperation(id: string, opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Operation> {
  const intervalMs = opts?.intervalMs ?? 1000
  const timeoutMs = opts?.timeoutMs ?? 600_000
  const startedAt = Date.now()
  for (;;) {
    opts?.signal?.throwIfAborted()
    const operation = await fetchOperation(id)
    if (operation.settled) return operation
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`operation ${id} did not settle within ${Math.round(timeoutMs / 1000)}s`)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs)
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(opts.signal!.reason)
      })
    })
  }
}

/**
 * The old single-device flows (plan 207 §3.2 item 9): send, await when
 * `accepted`, show the policy sentence once as `toast.warning` and re-send
 * with `force: true` on a `warned` result, throw `ActionRefusedError` on
 * `forbidden`/`skipped`/`failed`. Returns the device's final result (always
 * `done` on a normal return).
 */
export async function runOnDevice<V extends ActionVerb>(
  verb: V,
  deviceId: string,
  params: ActionParams<V>,
  opts?: { force?: boolean },
): Promise<ActionResult> {
  const response = await runAction(verb, { deviceIds: [deviceId] }, params, opts)
  let result = response.results.find((r) => r.deviceId === deviceId)
  if (!result) throw new Error(`no result for device ${deviceId} in the response`)

  if (result.status === 'warned' && !opts?.force) {
    toast.warning(result.message ?? 'this device has a conflicting activity')
    const forced = await runAction(verb, { deviceIds: [deviceId] }, params, { force: true })
    result = forced.results.find((r) => r.deviceId === deviceId)
    if (!result) throw new Error(`no result for device ${deviceId} in the forced response`)
  }

  if (result.status === 'accepted') {
    const operation = await awaitOperation(response.operationId)
    const settled = operation.results.find((r) => r.deviceId === deviceId)
    if (!settled) throw new Error(`no settled result for device ${deviceId} on operation ${response.operationId}`)
    result = settled
  }

  if (result.status !== 'done') throw new ActionRefusedError(result)
  return result
}

/** `results` grouped for the old bulk dialogs' reports. */
export function groupResults(results: ActionResult[]): Record<ActionResultStatus, ActionResult[]> {
  const groups: Record<ActionResultStatus, ActionResult[]> = {
    accepted: [],
    skipped: [],
    forbidden: [],
    warned: [],
    done: [],
    failed: [],
  }
  for (const result of results) groups[result.status].push(result)
  return groups
}
