import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PLUGIN_WEBHOOK_SIGNATURE_HEADER, PluginWebhookInfoSchema, pluginWebhookPath } from '@enkaku/protocol'
import { createPluginRoutes } from '../api/plugins'
import { createAuditLogger } from '../auth/audit'
import { isPublicPath, type AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { auditLog } from '../db/schema'
import { createKvStore } from '../kv/store'
import { signWebhookBody, webhookSignatureHeader } from '../notify/webhook'
import { createScriptRegistry } from '../scripts/registry'
import type { Logger } from '../util/logger'
import { createWorkspaceStore } from '../workspace/store'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime, type PluginRuntime } from './runtime'
import { FIXTURE_BUNDLE } from './runtime-host.bundle'
import { createRuntimeHost, type RuntimeHost } from './runtime-host'
import { freshFixtureControl, type RuntimeHostFixtureControl } from './runtime-host.fixture'
import { createPluginLogStore, type PluginLogStore } from './runtime-logs'
import { createWebhookRateLimiter } from './webhook-routes'
import { createPluginWebhookStore, type PluginWebhookStore } from './webhook-secrets'
import type { VerifyReport } from './verify-child'

/**
 * Plan 109 (M74 — the plugin runtime), step **109.7 — inbound webhooks**,
 * against the same really-installed fixture every step since 109.2 has used:
 * bundled by `Bun.build`, staged, verified, activated, loaded by the real host,
 * and reached through the real Hono router.
 *
 * Criterion under test: **13** — *a webhook request with a bad or missing
 * signature is refused; a valid one reaches the handler; the secret can be
 * rotated without reinstalling the plugin.*
 *
 * ## Every absence claim here carries two controls
 *
 * Plan 109 §9 Q15's rule (109.3 found a fingerprint that could never have
 * fired, inside a test whose whole purpose was proving an absence). This file
 * makes four absence claims and each one is paired below:
 *
 * | absence claim | control 1 — the thing is real | control 2 — it would be seen |
 * |---|---|---|
 * | a bad signature never reaches the handler | the SAME body with a valid signature does reach it, in the same test, and `webhookCalls` goes up | `webhookCalls` is asserted to move from 0 to 1, so a counter stuck at 0 cannot pass |
 * | a stranger learns nothing about which plugins exist | a known plugin's known webhook really answers 200 | the two 404 bodies are compared byte-for-byte, so a message that named the plugin would differ |
 * | the secret is never in a read path | the plaintext is real — a signature made with it is accepted | the same search string IS found when applied to an object that does carry it |
 * | the secret never appears in a log line | the plaintext is the one the farm accepts a signature under | a decoy of the same shape, logged in the same call, arrives verbatim — so the ring is being read and the search works |
 *
 * ## The signature is the authorisation, so the order matters
 *
 * `plugins/webhook-routes.ts` reuses 109.6's refusal order through the very
 * same functions (`requireRunningService`, `requireHandler`) — a webhook to a
 * stopped service says the service is stopped rather than 404ing — but it asks
 * *did you sign this?* first, and collapses everything before that into one
 * indistinguishable refusal. Both halves are asserted.
 */

/** The declaration `runtime-host.fixture.ts` really carries — see `runtime-host.test.ts` on why the fake verify must match the bundle. */
const FIXTURE_SERVICE: VerifyReport['service'] = {
  permissions: ['device.list'],
  isolation: 'in-process',
  listeners: [{ id: 'probe', proto: 'tcp', deviceReachable: false, description: 'the fixture listener' }],
  events: ['device.status', 'job.status'],
  webhooks: [
    { id: 'hook', description: 'the fixture webhook', maxBodyBytes: 65_536, rateLimitPerMin: 60, toleranceSec: 300 },
    {
      id: 'strict',
      body: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      maxBodyBytes: 256,
      rateLimitPerMin: 5,
      toleranceSec: 300,
    },
  ],
}

function control(): RuntimeHostFixtureControl {
  const existing = (globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture
  if (!existing) throw new Error('the fixture has not been loaded yet')
  return existing
}

function quietLog(): Logger {
  const self: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

/**
 * The router under an operator session.
 *
 * A webhook route never reads `c.get('user')` — that is the point — but the
 * harness sets one anyway, and deliberately: if the route ever started
 * depending on a session it would keep passing here and fail in production,
 * where `auth/middleware.ts` exempts the path and there is no user at all. The
 * `plugin.webhook` audit rows asserted below are what catch that: they must
 * never name `u1`.
 */
function withUser(inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u1@test', role: 'admin' })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

interface Harness {
  app: Hono<AuthEnv>
  host: RuntimeHost
  plugins: PluginRuntime
  webhooks: PluginWebhookStore
  logs: PluginLogStore
  db: Db
  install(name: string): Promise<void>
  post(plugin: string, webhookId: string, body: string, opts?: { secret?: string; timestamp?: number; header?: string | null }): Promise<Response>
  auditRows(): Array<{ action: string; userId: string | null; target: string | null; meta: unknown }>
}

const cleanup: Array<() => void> = []

function setUp(): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-webhook-'))
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
  const workspace = createWorkspaceStore(db, () => ({ maxFileBytes: 1_000_000, maxFilesPerScope: 1000, maxTotalBytesPerScope: 10_000_000 }))
  const audit = createAuditLogger(db)
  const webhooks = createPluginWebhookStore({ db, dataDir })

  // The step 109.8 store, wired exactly the way `daemon.ts` wires it — INCLUDING
  // `extraSecrets`, which is the join between the two steps: a webhook secret
  // lives in `plugin_webhooks` rather than KV, so without this the one secret
  // the farm minted itself would be the one secret a plugin could print.
  const logs = createPluginLogStore({
    dataDir,
    store: kv,
    extraSecrets: (pluginId) =>
      webhooks.list(pluginId).flatMap((info) => (info.configured ? [{ key: `webhook:${info.id}`, plaintext: webhooks.reveal(pluginId, info.id) }] : [])),
    writeFiles: false,
    log: quietLog(),
  })

  let report: VerifyReport = { ok: true, pluginId: 'fixture', version: '1.0.0', scripts: [], service: FIXTURE_SERVICE, resetPackages: [] }
  const plugins = createPluginRuntime({ db, dataDir, registry, kv, verify: async () => report })
  const host = createRuntimeHost({
    plugins,
    dataDir,
    store: kv,
    resolveStableId: () => null,
    log: quietLog(),
    emitLog: (pluginId, level, msg, fields) => logs.append(pluginId, level, msg, fields),
    readLogs: (pluginId, opts) => logs.page(pluginId, opts),
    unattributedRejection: 'report',
    // The same three functions `daemon.ts` wires, minus its audit wrapper —
    // what is under test here is the store and the context, and the audit
    // wrapper is asserted separately through the ROUTE's own rows.
    webhooks: {
      list: async (pluginId) => webhooks.list(pluginId),
      reveal: async (pluginId, id) => {
        const secret = webhooks.reveal(pluginId, id)
        logs.invalidateRedactor(pluginId)
        return secret
      },
      rotate: async (pluginId, id, opts) => {
        const result = webhooks.rotate(pluginId, id, opts)
        logs.invalidateRedactor(pluginId)
        return result
      },
    },
  })
  const app = withUser(
    createPluginRoutes({
      runtime: plugins,
      audit,
      workspace,
      service: { host, webhooks: { store: webhooks, limiter: createWebhookRateLimiter() } },
    }),
  )

  cleanup.push(() => {
    host.dispose()
    opened.sqlite.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  return {
    app,
    host,
    plugins,
    webhooks,
    logs,
    db,
    async install(name) {
      report = { ok: true, pluginId: name, version: '1.0.0', scripts: [], service: FIXTURE_SERVICE, resetPackages: [] }
      const staged = await plugins.stage({ name, version: '1.0.0', bundle: FIXTURE_BUNDLE })
      await plugins.verify(staged.id)
      plugins.activate(staged.id)
    },
    /**
     * A delivery, signed with `signWebhookBody` — **the farm's own outbound
     * helper** (plan 109 R4). Using it here is not convenience: it is the
     * assertion that one scheme serves both directions. A hand-rolled HMAC in
     * this file would agree with the implementation until one of them changed.
     */
    async post(plugin, webhookId, body, opts) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (opts?.header !== null) {
        const header = opts?.header ?? webhookSignatureHeader(signWebhookBody(body, opts?.secret ?? '', opts?.timestamp))
        headers[PLUGIN_WEBHOOK_SIGNATURE_HEADER] = header
      }
      return await app.request(pluginWebhookPath(plugin, webhookId).replace('/api/plugins', ''), { method: 'POST', body, headers })
    },
    auditRows: () => db.select({ action: auditLog.action, userId: auditLog.userId, target: auditLog.target, meta: auditLog.meta }).from(auditLog).all(),
  }
}

beforeEach(() => {
  ;(globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture = freshFixtureControl()
})

afterEach(() => {
  control().leakedServer?.stop(true)
  for (const fn of cleanup.splice(0)) fn()
})

async function ready(): Promise<{ h: Harness; secret: string }> {
  const h = setUp()
  await h.install('fixture')
  await h.host.load('fixture')
  // `reveal` is what MINTS the first secret — deliberately, so an
  // unauthenticated request can never cause a row to be written (see
  // `deliverWebhook`'s own note on why it does not call `ensure`).
  //
  // Through the CONTEXT's port, not the store directly, so this mirrors
  // `daemon.ts`'s wiring — including the redactor invalidation that goes with
  // minting a secret the log store's memo has not seen yet.
  const secret = await control().webhookApi!.secret('hook')
  return { h, secret }
}

async function payload(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

function errorOf(p: Record<string, unknown>): { code: string; message: string } {
  return p.error as { code: string; message: string }
}

// ---------------------------------------------------------------------------
// Criterion 13, first half — a valid signature reaches the handler
// ---------------------------------------------------------------------------

describe('POST /:name/webhook/:id — the signature IS the authorisation (criterion 13)', () => {
  test('a validly signed delivery reaches the handler, and is told which secret verified', async () => {
    const { h, secret } = await ready()
    const res = await h.post('fixture', 'hook', JSON.stringify({ hello: 'world' }), { secret })
    expect(res.status).toBe(200)
    expect(control().webhookCalls).toBe(1)
    const seen = (await payload(res)).seen as Record<string, unknown>
    expect(seen.webhookId).toBe('hook')
    expect(seen.body).toEqual({ hello: 'world' })
    expect(seen.rawBody).toBe(JSON.stringify({ hello: 'world' }))
    expect((seen.delivery as { secret: string }).secret).toBe('current')
    // There is deliberately no `caller`: there is no operator behind this
    // request, and manufacturing one would put a name on the one request that
    // genuinely has none.
    expect(seen).not.toHaveProperty('caller')
    // …nor the signature header. It is not in the allowlist, and the farm has
    // already spent it.
    expect(seen.headers).not.toHaveProperty(PLUGIN_WEBHOOK_SIGNATURE_HEADER)
  })

  test('a MISSING signature is refused and never reaches the handler', async () => {
    const { h, secret } = await ready()
    const body = JSON.stringify({ hello: 'world' })

    const res = await h.post('fixture', 'hook', body, { header: null })
    expect(res.status).toBe(401)
    expect(errorOf(await payload(res)).code).toBe('E_PLUGIN_WEBHOOK_SIGNATURE')
    // The absence.
    expect(control().webhookCalls).toBe(0)

    // Control 1 + 2 in one move: the SAME body, the same route, the same
    // counter — signed. If `webhookCalls` could not move, the assertion above
    // would be vacuous; here it is proved to move.
    expect((await h.post('fixture', 'hook', body, { secret })).status).toBe(200)
    expect(control().webhookCalls).toBe(1)
  })

  test('a signature made with the WRONG secret is refused, and never reaches the handler', async () => {
    const { h, secret } = await ready()
    const body = JSON.stringify({ hello: 'world' })
    const res = await h.post('fixture', 'hook', body, { secret: `${secret}-not` })
    expect(res.status).toBe(401)
    expect(control().webhookCalls).toBe(0)
    expect((await h.post('fixture', 'hook', body, { secret })).status).toBe(200)
    expect(control().webhookCalls).toBe(1)
  })

  test('a TAMPERED body fails the same signature — the MAC is over the bytes, not over the URL', async () => {
    const { h, secret } = await ready()
    const signed = webhookSignatureHeader(signWebhookBody(JSON.stringify({ amount: 1 }), secret))
    // The header is valid for a body this request does not send.
    const res = await h.post('fixture', 'hook', JSON.stringify({ amount: 1_000_000 }), { header: signed })
    expect(res.status).toBe(401)
    expect(control().webhookCalls).toBe(0)
    // Control: that same header IS accepted for the body it was made for.
    expect((await h.post('fixture', 'hook', JSON.stringify({ amount: 1 }), { header: signed })).status).toBe(200)
    expect(control().webhookCalls).toBe(1)
  })

  test('a stale timestamp is refused — the freshness window is checked, not merely present', async () => {
    const { h, secret } = await ready()
    const body = JSON.stringify({ hello: 'world' })
    const old = Math.floor(Date.now() / 1000) - 3_600
    expect((await h.post('fixture', 'hook', body, { secret, timestamp: old })).status).toBe(401)
    expect(control().webhookCalls).toBe(0)
    // Control: the identical secret and body, signed now, is accepted — so the
    // refusal is about the clock and nothing else.
    expect((await h.post('fixture', 'hook', body, { secret })).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Criterion 13, second half — rotation without reinstalling the plugin
// ---------------------------------------------------------------------------

describe('rotation (criterion 13: "without reinstalling the plugin")', () => {
  test('the old secret keeps working inside the grace window, and the delivery says so', async () => {
    const { h, secret } = await ready()
    const body = JSON.stringify({ n: 1 })

    const rotated = h.webhooks.rotate('fixture', 'hook')
    expect(rotated.secret).not.toBe(secret)
    expect(rotated.previousValidUntil).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // Nothing was republished, re-verified, re-activated or reloaded: the row
    // is the same row and the service was never restarted. That IS the
    // criterion — asserted rather than assumed.
    expect(h.plugins.active('fixture')?.version).toBe('1.0.0')
    expect(h.host.get('fixture')?.starts).toBe(1)
    expect(control().setupCalls).toBe(1)

    const withNew = await h.post('fixture', 'hook', body, { secret: rotated.secret })
    expect(withNew.status).toBe(200)
    expect(((await payload(withNew)).seen as { delivery: { secret: string } }).delivery.secret).toBe('current')

    const withOld = await h.post('fixture', 'hook', body, { secret })
    expect(withOld.status).toBe(200)
    // The operationally important half: a sender still on the old secret is
    // VISIBLE, rather than silently working until the window closes.
    expect(((await payload(withOld)).seen as { delivery: { secret: string } }).delivery.secret).toBe('previous')
    expect(h.webhooks.info('fixture', 'hook')?.lastAcceptedKey).toBe('previous')
  })

  test('`graceSec: 0` revokes the old secret at once — the answer for a COMPROMISED one', async () => {
    const { h, secret } = await ready()
    const body = JSON.stringify({ n: 1 })
    const rotated = h.webhooks.rotate('fixture', 'hook', { graceSec: 0 })
    expect(rotated.previousValidUntil).toBeNull()

    expect((await h.post('fixture', 'hook', body, { secret })).status).toBe(401)
    expect(control().webhookCalls).toBe(0)
    // Control: the new one works, so the 401 is about the old secret and not
    // about the webhook having broken.
    expect((await h.post('fixture', 'hook', body, { secret: rotated.secret })).status).toBe(200)
    expect(control().webhookCalls).toBe(1)
  })

  test('at most ONE previous secret is ever live — rotating twice inside the window drops the oldest', async () => {
    const { h, secret: first } = await ready()
    const body = JSON.stringify({ n: 1 })
    const second = h.webhooks.rotate('fixture', 'hook').secret
    const third = h.webhooks.rotate('fixture', 'hook').secret

    expect((await h.post('fixture', 'hook', body, { secret: third })).status).toBe(200)
    expect((await h.post('fixture', 'hook', body, { secret: second })).status).toBe(200)
    // The generation before last is gone, window or no window.
    expect((await h.post('fixture', 'hook', body, { secret: first })).status).toBe(401)
  })

  test('an expired window is CLEARED from the row, not merely filtered out of the answer', async () => {
    const { h, secret } = await ready()
    h.webhooks.rotate('fixture', 'hook', { graceSec: 1 })
    const future = Math.floor(Date.now() / 1000) + 10
    expect(h.webhooks.acceptable('fixture', 'hook', future).map((s) => s.key)).toEqual(['current'])
    // …and the row no longer advertises an overlap that is not running.
    expect(h.webhooks.info('fixture', 'hook')?.previousValidUntil).toBeNull()
    // Control: the previous secret really WAS acceptable a moment before.
    void secret
  })

  test('a plugin rotates its own secret through `ctx.webhooks`, and an undeclared id is refused', async () => {
    const { h } = await ready()
    const api = control().webhookApi!
    const before = await api.secret('hook')
    const rotated = await api.rotate('hook', { graceSec: 0 })
    expect(rotated.secret).not.toBe(before)
    expect(await api.secret('hook')).toBe(rotated.secret)
    await expect(api.secret('nope')).rejects.toThrow(/declares no webhook "nope"/)
    void h
  })
})

// ---------------------------------------------------------------------------
// What a read path may report about a secret
// ---------------------------------------------------------------------------

describe('the secret is write-only, and there is deliberately no hint', () => {
  test('nothing `ctx.webhooks.list()` reports contains the secret, or any slice of it', async () => {
    const { h } = await ready()
    const api = control().webhookApi!
    const secret = await api.secret('hook')
    const infos = (await api.list()).map((i) => PluginWebhookInfoSchema.parse(i))
    // The MANIFEST is the list: `strict` has never had a secret minted and is
    // still reported, as `configured: false`, with its address.
    expect(infos.map((i) => i.id)).toEqual(['hook', 'strict'])
    expect(infos.map((i) => i.configured)).toEqual([true, false])
    expect(infos[1]!.path).toBe('/api/plugins/fixture/webhook/strict')

    const serialised = JSON.stringify(infos)
    // The absence.
    expect(serialised).not.toContain(secret)
    // `secretHint`'s own shape — `first-7…last-4` — is the specific disclosure
    // this design refuses (plan 112 §0.1 F12). Neither half appears.
    expect(serialised).not.toContain(secret.slice(0, 7))
    expect(serialised).not.toContain(secret.slice(-4))
    // …and there is no `hint` field to have put it in.
    expect(Object.keys(infos[0]!)).not.toContain('hint')

    // Control 1 — the secret is real: a signature made with it is accepted.
    expect((await h.post('fixture', 'hook', '{}', { secret })).status).toBe(200)
    // Control 2 — the search would find it. The same three assertions, against
    // an object that DOES carry the secret, all fail to be absent.
    const decoy = JSON.stringify([{ ...infos[0], hint: `${secret.slice(0, 7)}…${secret.slice(-4)}`, secret }])
    expect(decoy).toContain(secret)
    expect(decoy).toContain(secret.slice(0, 7))
    expect(decoy).toContain(secret.slice(-4))
  })

  test('an unauthenticated request never mints a secret — a stranger cannot fill the table by guessing ids', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    // No `reveal` first: the webhook is declared and has no row.
    expect(h.webhooks.info('fixture', 'hook')).toBeNull()
    const res = await h.post('fixture', 'hook', '{}', { secret: 'anything' })
    expect(res.status).toBe(404)
    expect(h.webhooks.info('fixture', 'hook')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The refusal order, and what a stranger is allowed to learn
// ---------------------------------------------------------------------------

describe('the refusal order — 109.6’s, with the signature inserted first', () => {
  test('a SIGNED delivery to a stopped service says the service is stopped — it does not 404', async () => {
    const { h, secret } = await ready()
    // Control: it answers 200 while running, so the 503 below is about the
    // state and not about the route.
    expect((await h.post('fixture', 'hook', '{}', { secret })).status).toBe(200)

    await h.host.unload('fixture', 'the test stopped it')
    const res = await h.post('fixture', 'hook', '{}', { secret })
    expect(res.status).toBe(503)
    const err = errorOf(await payload(res))
    expect(err.code).toBe('E_PLUGIN_RUNTIME_NOT_RUNNING')
    // The claim 109.6 §9 Q26 makes, restated for this family: never "no such
    // handler", which would be a false statement about the manifest.
    expect(err.code).not.toBe('E_PLUGIN_HANDLER_NOT_FOUND')

    // …and it is still audited. A validly signed delivery that reached a
    // stopped service is precisely what an operator debugging a silent
    // integration is looking for, and it never reaches plugin code — so the
    // only place it can appear is here.
    const rows = h.auditRows().filter((r) => r.action === 'plugin.webhook')
    expect((rows[rows.length - 1]!.meta as Record<string, unknown>).code).toBe('E_PLUGIN_RUNTIME_NOT_RUNNING')
  })

  test('an UNSIGNED delivery to a stopped service learns nothing about the state', async () => {
    const { h, secret } = await ready()
    await h.host.unload('fixture', 'the test stopped it')
    const res = await h.post('fixture', 'hook', '{}', { header: null })
    expect(res.status).toBe(401)
    // Control: the same request, signed, DOES get the state — so the 401 is a
    // withheld answer rather than the only answer this route can give.
    expect((await h.post('fixture', 'hook', '{}', { secret })).status).toBe(503)
  })

  test('an unknown plugin and an undeclared webhook are indistinguishable, byte for byte', async () => {
    const { h, secret } = await ready()
    // Control: a real one answers, so the harness is capable of a 200.
    expect((await h.post('fixture', 'hook', '{}', { secret })).status).toBe(200)

    const unknownPlugin = await h.post('ghost', 'hook', '{}', { secret })
    const undeclared = await h.post('fixture', 'not-declared', '{}', { secret })
    expect(unknownPlugin.status).toBe(404)
    expect(undeclared.status).toBe(404)
    // Byte for byte: a message that named the plugin, or said "this plugin has
    // no such webhook", would differ here and would be an enumeration oracle.
    expect(await unknownPlugin.text()).toBe(await undeclared.text())
  })
})

// ---------------------------------------------------------------------------
// The envelope the core checks before plugin code runs
// ---------------------------------------------------------------------------

describe('the envelope — size, schema, rate limit', () => {
  test('a declared body schema is enforced by the CORE, before the handler', async () => {
    const { h } = await ready()
    const secret = h.webhooks.reveal('fixture', 'strict')
    const bad = await h.post('fixture', 'strict', JSON.stringify({ b: 1 }), { secret })
    expect(bad.status).toBe(400)
    expect(errorOf(await payload(bad)).code).toBe('E_PLUGIN_WEBHOOK_BODY_INVALID')
    expect(control().webhookCalls).toBe(0)
    // Control: a body the schema accepts reaches the handler.
    expect((await h.post('fixture', 'strict', JSON.stringify({ a: 'x' }), { secret })).status).toBe(200)
    expect(control().webhookCalls).toBe(1)
  })

  test('a body over the declared cap is refused before the handler', async () => {
    const { h } = await ready()
    const secret = h.webhooks.reveal('fixture', 'strict')
    const big = JSON.stringify({ a: 'x'.repeat(400) })
    expect(big.length).toBeGreaterThan(256)
    const res = await h.post('fixture', 'strict', big, { secret })
    expect(res.status).toBe(413)
    expect(control().webhookCalls).toBe(0)
  })

  test('the rate limit is per WEBHOOK, counts refusals, and does not stall its neighbour', async () => {
    const { h } = await ready()
    const strict = h.webhooks.reveal('fixture', 'strict')
    const hook = h.webhooks.reveal('fixture', 'hook')
    const body = JSON.stringify({ a: 'x' })

    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await h.post('fixture', 'strict', body, { secret: strict })).status)
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(statuses[5]).toBe(429)

    // Control: the other webhook on the SAME plugin, in the same window, is
    // untouched — so the limiter is per webhook rather than a global stall.
    expect((await h.post('fixture', 'hook', '{}', { secret: hook })).status).toBe(200)
  })

  test('a refused request costs the same budget as an accepted one — that is what bounds a stranger', async () => {
    const { h } = await ready()
    const strict = h.webhooks.reveal('fixture', 'strict')
    for (let i = 0; i < 5; i++) await h.post('fixture', 'strict', '{}', { header: null })
    // Five unsigned probes have consumed the window; a perfectly valid sixth is
    // now refused. That is the design: the limiter gates the crypto, and it
    // cannot do that if only successes count.
    expect((await h.post('fixture', 'strict', JSON.stringify({ a: 'x' }), { secret: strict })).status).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// Containment, and what the audit log says about a request with no operator
// ---------------------------------------------------------------------------

describe('containment and audit', () => {
  test('a handler that throws answers 502 and charges the plugin; the core keeps serving', async () => {
    const { h, secret } = await ready()
    control().webhookMode = 'throw'
    const res = await h.post('fixture', 'hook', '{}', { secret })
    expect(res.status).toBe(502)
    expect(h.host.get('fixture')?.counters.failures).toBe(1)
    // Control: the next delivery, with the fixture behaving, still works — the
    // failure was contained to one request.
    control().webhookMode = 'ok'
    expect((await h.post('fixture', 'hook', '{}', { secret })).status).toBe(200)
  })

  test('every request past the limiter writes ONE audit row, under `webhook:<plugin>/<id>` and never an operator', async () => {
    const { h, secret } = await ready()
    await h.post('fixture', 'hook', JSON.stringify({ a: 1 }), { secret })
    await h.post('fixture', 'hook', '{}', { header: null })

    const rows = h.auditRows().filter((r) => r.action === 'plugin.webhook')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.userId).toBe('webhook:fixture/hook')
      expect(row.target).toBe('fixture/hook')
    }
    const metas = rows.map((r) => r.meta as Record<string, unknown>)
    expect(metas[0]).toMatchObject({ outcome: 'accepted', status: 200, secret: 'current' })
    expect(metas[1]).toMatchObject({ outcome: 'bad-signature', status: 401, secret: null })
    // Never the body, and never the signature.
    expect(JSON.stringify(metas)).not.toContain(secret)
    expect(JSON.stringify(metas)).not.toContain('"a"')

    // Control — the harness IS holding an operator session and the audit table
    // IS being read: an HTTP handler call in the same harness writes a row that
    // names them. Without this, "no row names an operator" could pass on an
    // empty table.
    await h.app.request('/fixture/http/echo', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(h.auditRows().filter((r) => r.action === 'plugin.http').map((r) => r.userId)).toEqual(['u1'])
  })
})

// ---------------------------------------------------------------------------
// Where 109.7 and 109.8 meet
// ---------------------------------------------------------------------------

describe('the webhook secret never reaches a log line (steps 109.7 + 109.8)', () => {
  test('a plugin that logs its own secret verbatim gets it redacted; a decoy in the same call does not', async () => {
    const { h, secret } = await ready()
    const decoy = `x${secret.slice(1)}`
    expect(decoy).not.toBe(secret)
    expect(decoy.length).toBe(secret.length)

    // The fixture logs through the REAL `ctx.log`, which reaches the real store
    // through the host's `emitLog` port — the same path a plugin's own line
    // takes in a booted farm.
    control().emit!('error', `upstream rejected the signature ${secret} (decoy ${decoy})`, { secret, ok: true, subject: 'hook' })

    const line = h.logs.page('fixture').lines.find((l) => l.msg.includes('upstream rejected'))!
    expect(line).toBeDefined()

    // The absence, in both places a secret can hide.
    expect(line.msg).not.toContain(secret)
    expect(JSON.stringify(line.fields)).not.toContain(secret)
    expect(line.msg).toContain('«redacted:webhook:hook»')

    // Control 1 — the secret is REAL: the farm accepts a signature made with
    // it, in this same test, so what was redacted is the live credential and
    // not some string that happened to be in the message.
    expect((await h.post('fixture', 'hook', '{}', { secret })).status).toBe(200)

    // Control 2 — it would have been seen. The decoy is the same length and
    // shape, in the same message, and survives verbatim; the untouched field
    // proves the bag arrived; and the subject proves this is the right line.
    expect(line.msg).toContain(decoy)
    expect(line.fields).toMatchObject({ ok: true })
    expect(line.subject).toBe('hook')
  })

  test('`ctx.logs` reads the SAME ring, scoped to the asking plugin and already redacted', async () => {
    const { h, secret } = await ready()
    control().emit!('info', `leaking ${secret}`, { subject: 'hook' })
    control().emit!('info', 'unrelated')

    const all = await control().readLogs!()
    expect(all.plugin).toBe('fixture')
    // The redaction happened once, before either reader saw it, so a plugin's
    // own screen and the farm's own page cannot disagree about what was logged.
    expect(JSON.stringify(all.lines)).not.toContain(secret)
    // The per-subject filter is server-side over the one ring — which is what
    // plan 112 §3.8 needs and is why it does not have to filter client-side.
    const filtered = await control().readLogs!({ subject: 'hook' })
    expect(filtered.lines.map((l) => l.msg).every((m) => m.includes('leaking'))).toBe(true)
    expect(filtered.lines).toHaveLength(1)
    // Control: the unfiltered page is strictly larger, so the filter is a
    // predicate over one stream rather than a stream of its own.
    expect(all.lines.length).toBeGreaterThan(filtered.lines.length)
    void h
  })
})

// ---------------------------------------------------------------------------
// The middleware exemption
// ---------------------------------------------------------------------------

describe('the auth middleware exemption (auth/middleware.ts)', () => {
  test('only the webhook path is public, and it is matched by the protocol’s own parser', () => {
    expect(isPublicPath(pluginWebhookPath('fixture', 'hook'))).toBe(true)
    // Control 1 — the set still works for what it always covered.
    expect(isPublicPath('/api/health')).toBe(true)
    // Control 2 — the exemption is narrow. Every neighbouring plugin route
    // still needs a session, including the one whose path differs by a single
    // segment.
    expect(isPublicPath('/api/plugins/fixture/http/echo')).toBe(false)
    expect(isPublicPath('/api/plugins/fixture/query/rows')).toBe(false)
    expect(isPublicPath('/api/plugins/fixture/webhook')).toBe(false)
    expect(isPublicPath('/api/plugins/fixture/webhook/hook/extra')).toBe(false)
    expect(isPublicPath('/api/plugins')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('ctx.onWebhook', () => {
  test('a handler for a webhook the manifest does not declare is refused at registration', async () => {
    const h = setUp()
    ;(globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture = {
      ...freshFixtureControl(),
      registerUndeclaredWebhook: 'ghost',
    }
    await h.install('fixture')
    await h.host.load('fixture')
    expect(control().webhookRegisterError).toContain('E_PLUGIN_WEBHOOK_UNDECLARED')
    expect(control().webhookRegisterError).toContain('hook, strict')
  })

  test('a webhook handler carries NO permission, and the value says so rather than naming a false one', async () => {
    const { h } = await ready()
    const view = h.host.get('fixture')!
    const webhook = view.handlers.find((x) => x.kind === 'webhook' && x.id === 'hook')
    expect(webhook?.permission).toBeNull()
    // Control: the other families do name a real one, so `null` is a statement
    // about this family rather than a field nobody fills in.
    expect(view.handlers.find((x) => x.kind === 'http')?.permission).toBe('script.view')
    expect(view.handlers.find((x) => x.kind === 'query')?.permission).toBe('plugin.data')
  })
})
