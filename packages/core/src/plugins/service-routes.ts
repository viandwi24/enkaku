import {
  PLUGIN_REQUEST_HEADER_ALLOWLIST,
  PLUGIN_RESPONSE_HEADER_ALLOWLIST,
  PluginQueryResultSchema,
  type PluginCaller,
  type PluginHandlerKind,
  type PluginHttpMethod,
  type PluginQueryRow,
  type PluginServiceStatus,
} from '@enkaku/protocol'
import type { PluginQueryRequest, PluginRequest, PluginResponse } from '@enkaku/sdk'
import { can } from '../auth/acl'
import { EnkakuError } from '../util/errors'
import type { PluginRuntime } from './runtime'
import type { PluginServiceView, RuntimeHost } from './runtime-host'
import type { PluginHandlerRegistration } from './service-handlers'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.6 — **the three route
 * families**, and the one place the order of their refusals is written.
 *
 * `api/plugins.ts` registers the routes (so the parity guard can see them);
 * this module decides what they answer. Everything a handler does still goes
 * through `host.invoke` — the deadline, the `try`/`catch` and the error budget
 * are the same ones `setup` and an event delivery get. There is no second door.
 *
 * ## The order of the questions IS the feature
 *
 * A handler is registered by `setup`, not declared in the manifest, so a
 * stopped service has none. Asking "is there a handler called `status`?" first
 * would answer 404 for a plugin whose service is merely down — and 404 on a
 * view an operator has open reads as *your plugin no longer has this screen*,
 * which is a claim about the manifest and is false. So:
 *
 * | # | question | refusal |
 * |---|---|---|
 * | 1 | is a plugin of this name LIVE? | `plugin_not_found` (404) — `requireLivePlugin`, the caller's |
 * | 2 | is it live only as a DEV SLOT? | `E_PLUGIN_DEV_SLOT_NO_SERVICE` (409) — named, not a 404 that reads like a typo |
 * | 3 | does it declare a service at all? | `E_PLUGIN_NO_SERVICE` (409) |
 * | 4 | is that service RUNNING? | `E_PLUGIN_RUNTIME_*` (503) — one code per state, `starting` distinct from broken |
 * | 5 | is there a handler by this id? | `E_PLUGIN_HANDLER_NOT_FOUND` (404) |
 * | 6 | may this caller reach it? | `auth.forbidden` (403) |
 *
 * Only after all six does plugin code run.
 *
 * ## What a handler is told about the caller, and what it is not
 *
 * It gets `{ id, role }`. It does not get the session cookie, the
 * `Authorization` header, or a WS ticket — `PLUGIN_REQUEST_HEADER_ALLOWLIST` is
 * the whole of what crosses. The reasoning is NOT that a plugin is untrusted
 * with authority: it runs in the core's process, holds the core's OS authority,
 * and can open the farm database directly (§3.2, §4.3 — *it is not a sandbox*).
 * It is that a credential is the one kind of authority that can LEAVE the
 * process — stored, logged, forwarded to a webhook, replayed tomorrow from
 * another machine as that operator. Identity cannot.
 *
 * And identity is not delegation. A handler invoked by an admin is still, when
 * it calls `ctx.farm`, the `plugin:<name>` principal with its publisher's role
 * (step 109.3, §9 Q14), checked against its own manifest. What ties the two
 * halves together in the log is the `plugin.http`/`plugin.socket` row this
 * module writes under the REAL caller: without it, 109.3's `plugin.capability`
 * and `capability.invoke` rows would name a plugin with no way back to the
 * human who set it going.
 */

export interface PluginServiceRouteDeps {
  plugins: PluginRuntime
  host: RuntimeHost
}

/** What the six questions above resolve to, when they all pass. */
export interface ResolvedPluginHandler {
  registration: PluginHandlerRegistration
  caller: PluginCaller
}

function statusRefusal(plugin: string, status: PluginServiceStatus, lastError: string | null): EnkakuError {
  if (status === 'starting') {
    // Its own code, because "not yet" and "broken" are different answers and
    // the UI keeps them different (§4.2, `docs/design.md`'s degraded-state
    // rule). A caller that sees this should retry; one that sees the next
    // should not.
    return new EnkakuError(
      'E_PLUGIN_RUNTIME_STARTING',
      `plugin "${plugin}"'s service is still starting — it is not running yet, and a call into it is refused rather than queued. Try again in a moment.`,
    )
  }
  const tail = lastError ? ` Last error: ${lastError}` : ''
  return new EnkakuError(
    'E_PLUGIN_RUNTIME_NOT_RUNNING',
    `plugin "${plugin}"'s service is "${status}", so it is serving nothing.${tail}`,
  )
}

/**
 * **Questions 2–4, alone** — is there a service, and is it running?
 *
 * Split out of `resolvePluginHandler` by step 109.7 so the webhook family can
 * ask the SAME questions in the SAME order without also asking question 6:
 * an inbound webhook's caller is a third party with no farm session and no
 * role, so there is no ACL question to put to it (its signature is the whole
 * authorisation, checked before this is reached). Re-deriving the order in a
 * second file is exactly how a webhook to a stopped service would come to
 * answer 404 while an HTTP request to the same service answered 503.
 *
 * Returns the service's view once it is running; throws the coded refusal
 * otherwise.
 */
export function requireRunningService(deps: PluginServiceRouteDeps, plugin: string, kind: PluginHandlerKind): PluginServiceView {
  // 2 — a dev slot. Reported rather than worked around: plan 109 §9's "known
  // gap left open by 109.3" is that the host and the broker both answer for the
  // ACTIVE row only, so a dev slot's service is never loaded and its declared
  // permissions were never consented to at install. Closing that needs a ruling
  // about what an unpublished manifest's permissions MEAN, which this step has
  // no mandate to take. What it can do is refuse by name.
  if (!deps.plugins.active(plugin) && deps.plugins.devSlots().some((s) => s.pluginName === plugin)) {
    throw new EnkakuError(
      'E_PLUGIN_DEV_SLOT_NO_SERVICE',
      `"${plugin}" is running from a DEV SLOT, and a dev slot's service is not loaded — so it has no ${kind} handlers. ` +
        `This is a known gap, not a missing route (docs/plans/109-m74-plugin-runtime.md §9, the note after Q15): the runtime host and the ` +
        `capability broker both answer for the ACTIVE plugin row, and a dev slot is an unpublished manifest whose permissions nobody ` +
        `consented to at install. Publish and activate the plugin to run its service; its scripts, screens and \`ui/\` assets keep working from the slot.`,
    )
  }

  // 3 — declares a service at all.
  if (!deps.plugins.service(plugin)) {
    throw new EnkakuError(
      'E_PLUGIN_NO_SERVICE',
      `plugin "${plugin}" declares no service, so it registers no ${kind} handlers — there is nothing here to reach.`,
    )
  }

  // 4 — running. Asked BEFORE the handler lookup: see this file's header.
  const view = deps.host.get(plugin)
  if (!view) {
    throw new EnkakuError(
      'E_PLUGIN_RUNTIME_NOT_LOADED',
      `plugin "${plugin}" declares a service, but this core has not loaded it — it has not been started since the core booted.`,
    )
  }
  if (view.disabledByBudget) {
    throw new EnkakuError(
      'E_PLUGIN_RUNTIME_DISABLED',
      `plugin "${plugin}"'s service was disabled by the error budget and is not being retried. Last error: ${view.lastError?.message ?? 'unknown'}`,
    )
  }
  if (view.status !== 'running') throw statusRefusal(plugin, view.status, view.lastError?.message ?? null)
  return view
}

/**
 * Question 5, alone — the handler lookup, given a service already known to be
 * running. Shared with the webhook family for the same reason
 * `requireRunningService` is.
 */
export function requireHandler(
  deps: PluginServiceRouteDeps,
  view: PluginServiceView,
  input: { plugin: string; kind: PluginHandlerKind; id: string },
): PluginHandlerRegistration {
  const registration = deps.host.lookupHandler(input.plugin, input.kind, input.id)
  if (!registration) {
    const known = view.handlers.filter((h) => h.kind === input.kind).map((h) => h.id)
    throw new EnkakuError(
      'E_PLUGIN_HANDLER_NOT_FOUND',
      `plugin "${input.plugin}"'s service is running but registered no ${input.kind} handler called "${input.id}". ` +
        `It registered: ${known.length > 0 ? known.join(', ') : '(none of this kind)'}.`,
    )
  }
  return registration
}

/**
 * Questions 2–6. Question 1 (`requireLivePlugin`) belongs to the router,
 * because every other `/:name/*` route asks it too and a second definition of
 * "live" is how they come to disagree.
 */
export function resolvePluginHandler(
  deps: PluginServiceRouteDeps,
  input: { plugin: string; kind: PluginHandlerKind; id: string; caller: { id: string; role: 'admin' | 'operator' } | undefined; method?: PluginHttpMethod },
): ResolvedPluginHandler {
  const { plugin, kind, id } = input

  // 2, 3, 4 — the service's own state, then 5 — the handler.
  const view = requireRunningService(deps, plugin, kind)
  const registration = requireHandler(deps, view, { plugin, kind, id })
  if (registration.kind === 'http' && input.method && !registration.methods.includes(input.method)) {
    throw new EnkakuError(
      'E_PLUGIN_HANDLER_METHOD_NOT_ALLOWED',
      `plugin "${plugin}"'s "${id}" handler answers ${registration.methods.join(', ')} — not ${input.method}.`,
    )
  }

  // 6 — the caller. The permission comes from the HANDLER, so it cannot be
  // Hono middleware: it is not known when the route is registered. Exactly the
  // shape `POST /:name/action/:actionId` already has.
  //
  // A `null` permission means a webhook registration (step 109.7), whose gate
  // is its own secret and which is never reached through this function. Refused
  // rather than defaulted, because "no ACL permission" arriving on a route that
  // asks an ACL question can only be a routing bug, and the safe reading of a
  // routing bug is closed.
  if (registration.permission === null) {
    throw new EnkakuError(
      'auth.forbidden',
      `plugin "${plugin}"'s "${id}" handler is gated by its own webhook secret, not by a permission, and cannot be reached this way`,
    )
  }
  const caller = input.caller
  if (!caller || !can(caller.role, registration.permission)) {
    throw new EnkakuError('auth.forbidden', `requires the ${registration.permission} permission`)
  }

  return { registration, caller: { id: caller.id, role: caller.role } }
}

/** Only the headers `PLUGIN_REQUEST_HEADER_ALLOWLIST` names, lower-cased. Everything else — cookie, authorization, a ticket, `x-forwarded-*` — never reaches plugin code. */
export function filterRequestHeaders(read: (name: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PLUGIN_REQUEST_HEADER_ALLOWLIST) {
    const value = read(name)
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return out
}

/** The response half. `set-cookie` is absent from the allowlist deliberately — see `PLUGIN_RESPONSE_HEADER_ALLOWLIST`. */
export function filterResponseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (!PLUGIN_RESPONSE_HEADER_ALLOWLIST.includes(name)) continue
    if (typeof value !== 'string') continue
    out[name] = value
  }
  return out
}

export interface PluginHttpOutcome {
  status: number
  body: unknown
  headers: Record<string, string>
}

/**
 * Run one HTTP handler through the containment funnel.
 *
 * A `void` return is `204` — a handler with nothing to say says nothing, rather
 * than being made to write `{ body: null }`. A status outside 200–599 is
 * clamped rather than refused: a plugin typo must not turn into a `Response`
 * constructor throwing inside the core's own route.
 */
export async function runHttpHandler(
  host: RuntimeHost,
  registration: PluginHandlerRegistration & { kind: 'http' },
  request: PluginRequest,
): Promise<PluginHttpOutcome> {
  const result = await host.invoke<PluginResponse | void>(
    registration.pluginId,
    {
      what: `http:${request.method} ${registration.id}${request.path === '/' ? '' : request.path}`,
      ...(registration.timeoutMs !== undefined ? { timeoutMs: registration.timeoutMs } : {}),
    },
    (signal) => registration.handler(request, signal),
  )
  if (!result || typeof result !== 'object') return { status: 204, body: null, headers: {} }
  const raw = typeof result.status === 'number' && Number.isFinite(result.status) ? Math.trunc(result.status) : 200
  const status = Math.min(599, Math.max(200, raw))
  return { status, body: result.body ?? null, headers: filterResponseHeaders(result.headers) }
}

export interface PluginQueryOutcome {
  items: PluginQueryRow[]
  nextCursor: string | null
}

/**
 * Run one query handler and validate what it answered.
 *
 * **A plugin's OUTPUT is external input to this boundary**, and is parsed like
 * any other: it is about to be serialised onto a wire a browser reads against
 * `PluginQueryResponseSchema`. A handler that returns a string, or a row whose
 * `$device` is a number, is a coded failure naming its own plugin — not a
 * Studio parse error naming nothing, which is what an unvalidated pass-through
 * would produce two packages away from the cause.
 *
 * `id` is filled in from the row's index when the handler supplied none. That
 * is right for a read-only table and wrong for a `selectable` one across a
 * refetch, which is why `PluginQueryRowSchema.id` documents itself as the
 * caller's job when selection matters.
 */
export async function runQueryHandler(
  host: RuntimeHost,
  registration: PluginHandlerRegistration & { kind: 'query' },
  request: PluginQueryRequest,
): Promise<PluginQueryOutcome> {
  const raw = await host.invoke<unknown>(
    registration.pluginId,
    {
      what: `query:${registration.id}`,
      ...(registration.timeoutMs !== undefined ? { timeoutMs: registration.timeoutMs } : {}),
    },
    (signal) => registration.handler(request, signal),
  )
  const parsed = PluginQueryResultSchema.safeParse(raw)
  if (!parsed.success) {
    throw new EnkakuError(
      'E_PLUGIN_QUERY_RESULT_INVALID',
      `plugin "${registration.pluginId}"'s "${registration.id}" query answered a shape this farm cannot render — ` +
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') +
        `. A query handler returns { rows: [{ value, device?, entry?, id? }], nextCursor? }.`,
    )
  }
  return {
    items: parsed.data.rows.map((row, index) => ({ ...row, id: row.id ?? String(index) })),
    nextCursor: parsed.data.nextCursor ?? null,
  }
}
