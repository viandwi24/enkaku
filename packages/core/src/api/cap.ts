import { Hono } from 'hono'
import { ListCapabilitiesResponseSchema, toJsonSchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { createCapabilityContext, invoke, type CapabilityContextDeps } from '../capability'
import type { CapabilityRegistry } from '../capability/registry'
import type { AuditLogger } from '../auth/audit'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/**
 * `GET /api/v1/cap` and `POST /api/v1/cap/:id` (plan 63 §3.6, §4.5) — the
 * REST surface generated from the registry. `POST` for every entry,
 * including reads: capability inputs are objects that do not survive
 * query-string encoding cleanly, and device ids/file paths/clipboard text
 * should never ride in a URL (§3.6).
 *
 * Every request runs through the SAME `invoke` (`capability/invoke.ts`) the
 * MCP server and (once 63.7 lands) the script IPC bridge use — this route
 * file does not check permission, the activity policy, or readiness itself;
 * `invoke` is the only door.
 */

const REFUSAL_STATUS: Record<string, number> = {
  E_BAD_INPUT: 400,
  E_FORBIDDEN: 403,
  E_NO_GRANT: 403,
  E_DEVICE_CONFLICT: 409,
  E_DEVICE_OFFLINE: 409,
  E_DEADLINE: 504,
  E_INTERNAL: 500,
}

/** A handful of common domain codes a capability's own service can throw
 * (job-service, resolve.ts, transfer.ts, readiness.ts, ...) — everything
 * else defaults to 400, which is still an honest "this call did not
 * succeed" for a caller that has not special-cased every code. */
const DOMAIN_STATUS: Record<string, number> = {
  device_not_found: 404,
  job_not_found: 404,
  script_not_found: 404,
  script_version_not_found: 404,
  script_ref_unresolved: 409,
  script_disabled: 409,
  script_version_exists: 409,
  device_busy: 409,
  device_unavailable: 409,
  device_in_use: 409,
  device_offline: 409,
  device_quarantined: 409,
  job_running: 409,
  job_not_cancellable: 409,
  'auth.forbidden': 403,
  E_CLIPBOARD_UNAVAILABLE: 409,
  E_TRANSFER_UNAVAILABLE: 503,
  E_NOT_SUPPORTED: 501,
  // The workspace (plan 64 §4.3) and server-side bundling (§4.4).
  E_BAD_PATH: 400,
  E_NOT_FOUND: 404,
  E_EXISTS: 409,
  E_STALE: 409,
  E_QUOTA: 413,
  E_OUT_OF_SCOPE: 403,
  E_BUILD_FAILED: 400,
  E_BUILD_TIMEOUT: 504,
}

function statusFor(code: string): number {
  return REFUSAL_STATUS[code] ?? DOMAIN_STATUS[code] ?? 400
}

export interface CapRoutesDeps {
  registry: CapabilityRegistry
  contextDeps: CapabilityContextDeps
  audit?: AuditLogger
}

export function createCapRoutes(deps: CapRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  // `GET /` — the registry filtered to what the caller may actually invoke
  // (plan 63 §3.6, acceptance #8): a caller lacking `device.files` does not
  // see `device.push` at all, so the discovery document is not a map of
  // the farm for an unauthorised caller.
  app.get('/', (c) => {
    const user = c.get('user')
    const ctx = createCapabilityContext(deps.contextDeps, user ? { id: user.id, role: user.role } : null)
    const items = deps.registry.visibleTo(ctx).map((cap) => ({
      id: cap.id,
      description: cap.description,
      input: toJsonSchema(cap.input),
      output: toJsonSchema(cap.output),
      permission: cap.permission,
      activity: cap.activity ?? null,
      deadline: cap.deadline,
      effect: cap.effect,
    }))
    return typedJson(c, ListCapabilitiesResponseSchema, { capabilities: items })
  })

  app.post('/:id', async (c) => {
    const cap = deps.registry.get(c.req.param('id'))
    if (!cap) return c.json({ error: { code: 'E_NOT_FOUND', message: `no such capability: ${c.req.param('id')}` } }, 404)
    const user = c.get('user')
    const ctx = createCapabilityContext(deps.contextDeps, user ? { id: user.id, role: user.role } : null)
    const raw = await c.req.json().catch(() => ({}))
    const result = await invoke(cap, ctx, raw, { audit: deps.audit })
    if (result.ok) return c.json({ ok: true, output: result.output })
    return c.json({ ok: false, error: result.error }, statusFor(result.error.code) as 400)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (statusFor(err.code) ?? 500) as 400)
    throw err
  })

  return app
}
