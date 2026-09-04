import { z } from 'zod'
import { definePlugin, defineService } from '@enkaku/sdk'

/**
 * Plan 109 (M74), step 109.2 — **the deliberately-misbehaving plugin.**
 *
 * This file is not imported by the test process. It is BUNDLED by
 * `runtime-host.test.ts` (`Bun.build`, the same call `scripts/build.ts` makes
 * for a real publish), staged into the plugins table as a bundle, verified by
 * the real verify child, activated, and then loaded by the real runtime host
 * — so what is under test is a plugin the farm could actually have installed,
 * not a stand-in the test constructed in its own heap.
 *
 * That matters for one policy in particular: the host attributes a floating
 * rejection partly by looking for a plugin's own bundle file in the error's
 * stack (`runtime-host.ts`'s `attributeRejection`, tier 3). A fixture defined
 * inside the test file would live in the test's own module and that tier could
 * never fire, so the mechanism would pass a test it does not implement.
 *
 * The control object lives on `globalThis` rather than being imported,
 * because the bundle is a standalone module with no way to reach the test's
 * exports — and because it must survive a RELOAD, which imports a fresh copy
 * of this module under a fresh cache-busting URL.
 */

export interface RuntimeHostFixtureControl {
  /** How `setup` behaves. `gate` is what makes `starting` observable: it waits on a promise the test resolves. */
  setupMode: 'ok' | 'throw' | 'hang' | 'gate'
  gate?: Promise<void>
  /** How the handler the test invokes through the host behaves. */
  handlerMode: 'ok' | 'throw' | 'reject' | 'hang'
  /** How the `ctx.onStop` disposer behaves. */
  disposerMode: 'ok' | 'throw' | 'hang'
  setupCalls: number
  disposerCalls: number
  handlerCalls: number

  // -- step 109.4, listeners -------------------------------------------------
  /**
   * What `setup` does about a socket of its own.
   *
   * - `none` — nothing, the 109.2 behaviour every earlier test relies on;
   * - `report` — bind, register a disposer that closes it, report it;
   * - `leak` — bind and report it, and **register no disposer for it**. This
   *   is criterion 9's plugin: one that fails to release a port it reported.
   *   The socket is parked on `leakedServer` so the TEST can close it, which
   *   matters — the core deliberately cannot;
   * - `udp-reachable` — report a UDP listener claiming `deviceReachable: true`,
   *   which criterion 17 says must be refused. The refusal lands in
   *   `reportError` rather than being thrown out of `setup`, so the test can
   *   read the message instead of only the failure.
   */
  listenerMode: 'none' | 'report' | 'leak' | 'udp-reachable'
  /** The port `setup` binds. `0` lets the OS choose, and the choice lands in `boundPort`. */
  listenerPort?: number
  /** What the fixture actually bound, read back from the listener. */
  boundPort?: number
  /** The `udp-reachable` refusal, or a message from any other rejected report. */
  reportError?: string
  /** `leak` mode parks its socket here. The test closes it; the core never does. */
  leakedServer?: { stop(closeActiveConnections?: boolean): void }
  /** `ctx.isPortFree`, handed out by `setup` so a test can call the real lent primitive through the real context. */
  isPortFree?: (port: number, proto?: 'tcp' | 'udp') => Promise<boolean>
  /** `ctx.reportListener`, likewise — so a test can drive the reporting boundary after `setup` has returned. */
  reportListener?: (listener: { id: string; port: number; proto?: 'tcp' | 'udp'; deviceReachable?: boolean }) => unknown

  // -- step 109.5, events ----------------------------------------------------
  /**
   * How the `device.status` handler behaves. `block` is the interesting one:
   * it burns `blockMs` of CPU synchronously, which is the shape that WOULD
   * delay a broadcast if dispatch were not detached.
   */
  eventMode: 'ok' | 'throw' | 'hang' | 'block'
  blockMs?: number
  /** Set to subscribe to something the manifest does not declare; the refusal lands in `subscribeError`. */
  subscribeUndeclared?: string
  subscribeError?: string
  /** Every event the handler was entered with, in arrival order. */
  eventsSeen: string[]
  /** When the handler was ENTERED, for the timing assertions. */
  eventEnteredAt: number[]
  /** Installed by `setup`. The test drives it through `host.invoke`, which is the containment funnel. */
  handler?: () => Promise<string>
  /**
   * Installed by `setup`. Floats a rejection FROM INSIDE this module, so the
   * resulting error's stack names this plugin's bundle. `'string'` rejects
   * with a non-Error, which is the known unattributable case.
   */
  float?: (kind: 'error' | 'string') => void
  /** Installed by `setup`. Floats the rejection of a promise the CORE handed the plugin — attribution tier 2. */
  floatPortRejection?: () => void

  // -- step 109.6, the three handler families --------------------------------
  /**
   * How the `echo` HTTP handler behaves. `ok` answers 200 with everything it
   * was told about the request, which is what lets a test assert on exactly
   * what a plugin can and cannot SEE of the caller.
   */
  httpMode: 'ok' | 'throw' | 'hang' | 'void' | 'headers'
  /** What the `echo` handler was handed, verbatim. The assertion surface for "no cookie, no authorization". */
  lastRequest?: unknown
  /** How the `rows` query handler behaves. `bad-shape` returns something `PluginQueryResultSchema` refuses. */
  queryMode: 'ok' | 'throw' | 'hang' | 'bad-shape' | 'paged'
  /** What the `rows` handler was asked. */
  lastQuery?: unknown
  /** Set to register a handler behind a permission that does not exist; the refusal lands in `registerError`. */
  registerBadPermission?: string
  /** Set to register a handler behind an admin-only permission, so an operator is refused and an admin is not. */
  httpPermission?: string
  registerError?: string
  /** How the `feed` socket handler behaves. */
  socketMode: 'ok' | 'throw' | 'push' | 'no-handlers'
  /** Frames the socket handler received, in order. */
  socketFrames: string[]
  /** `[code, reason]` from the socket's close callback. */
  socketClosed?: [number, string]
  /** The socket the handler was opened with, so a test can drive `send`/`close` from outside. */
  lastSocket?: { connectionId: string; caller: { id: string; role: string }; open: boolean; send(data: string): void; close(code?: number, reason?: string): void }

  // -- step 109.7, inbound webhooks ------------------------------------------
  /** How the `hook` webhook handler behaves. */
  webhookMode: 'ok' | 'throw' | 'hang' | 'void'
  /** What the webhook handler was handed, verbatim — the assertion surface for "no caller, and no signature header". */
  lastWebhook?: unknown
  /** Every webhook delivery the handler was ENTERED for. The control that turns "a bad signature never reaches the handler" from an absence into a measured one. */
  webhookCalls: number
  /** Set to register a handler for a webhook the MANIFEST does not declare; the refusal lands in `webhookRegisterError`. */
  registerUndeclaredWebhook?: string
  webhookRegisterError?: string
  /** `ctx.webhooks`, handed out so a test drives the real accessor through the real context rather than the store behind it. */
  webhookApi?: {
    list(): Promise<unknown[]>
    secret(id: string): Promise<string>
    rotate(id: string, opts?: { graceSec?: number }): Promise<{ secret: string; previousValidUntil: number | null }>
  }

  // -- step 109.8, logs ------------------------------------------------------
  /** `ctx.log`, handed out so a test can make the fixture log arbitrary text — which is how "the secret never appears in a log line" is tested against a plugin that really tries. */
  emit?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void
  /** `ctx.logs`, likewise — the read half, which is what a plugin's own screen serves through its own `ctx.onRequest` handler. */
  readLogs?: (opts?: { cursor?: number | null; subject?: string | null; limit?: number }) => Promise<{ plugin: string; lines: Array<{ msg: string; subject: string | null }>; truncated: boolean }>
}

/**
 * The control object, reached through `globalThis` rather than a `declare
 * global` block: this file is compiled as part of `packages/core`, and adding
 * a global to that package's type namespace for the sake of one fixture would
 * make every other module in it able to see a symbol only this one owns.
 */
interface ControlHolder {
  __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl
}

/**
 * A control object in its default state — every mode set to the behaviour the
 * 109.2 tests rely on. Exported so a test's `beforeEach` resets to exactly
 * what the fixture itself would create: two hand-written copies of this object
 * drift the moment a mode is added, and the drift shows up as a `undefined`
 * mode silently taking a branch nobody chose.
 */
export function freshFixtureControl(): RuntimeHostFixtureControl {
  return {
    setupMode: 'ok',
    handlerMode: 'ok',
    disposerMode: 'ok',
    setupCalls: 0,
    disposerCalls: 0,
    handlerCalls: 0,
    listenerMode: 'none',
    eventMode: 'ok',
    eventsSeen: [],
    eventEnteredAt: [],
    httpMode: 'ok',
    queryMode: 'ok',
    socketMode: 'ok',
    socketFrames: [],
    webhookMode: 'ok',
    webhookCalls: 0,
  }
}

export function fixtureControl(): RuntimeHostFixtureControl {
  const holder: ControlHolder = globalThis as ControlHolder
  const existing = holder.__enkakuRuntimeHostFixture
  if (existing) return existing
  const fresh = freshFixtureControl()
  holder.__enkakuRuntimeHostFixture = fresh
  return fresh
}

/**
 * `code: message`, so a test can assert on the CODE a refusal carries and not
 * only on its prose. An `EnkakuError`'s `code` is a property, never part of
 * `message` — and a test that asserted on wording alone would keep passing
 * after the code changed, which is the half a caller actually branches on.
 */
function describeRefusal(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = Reflect.get(err, 'code')
  return typeof code === 'string' ? `${code}: ${err.message}` : err.message
}

export default definePlugin({
  id: 'fixture',
  version: '1.0.0',
  scripts: [{ id: 'noop', params: z.object({}), run: async () => ({ ok: true }) }],
  service: defineService({
    permissions: ['device.list'],
    // Step 109.4 — declared so the install consent step can show it. Declaring
    // reserves nothing: the plugin still binds its own socket, on a port of its
    // own choosing, and owns its own collisions (plan 109 §3.3).
    listeners: [{ id: 'probe', proto: 'tcp', description: 'the fixture listener' }],
    // Step 109.5 — exhaustive: `ctx.onEvent` refuses anything absent from this.
    // `device.status` is the real name for what plan 109 §3.5 called
    // `device.connected`/`device.disconnected` (§9 Q16).
    events: ['device.status', 'job.status'],
    // Step 109.7 — DECLARED, unlike the three handler families above, because a
    // webhook owns a farm-held secret that has to exist and be rotatable while
    // this service is stopped. `strict` carries a body schema the core
    // evaluates before the handler is entered, and deliberately tiny caps so a
    // test can reach them without sending a megabyte or waiting a minute.
    webhooks: [
      { id: 'hook', description: 'the fixture webhook' },
      {
        id: 'strict',
        body: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        maxBodyBytes: 256,
        rateLimitPerMin: 5,
      },
    ],
    setup: async (ctx) => {
      const control = fixtureControl()
      control.setupCalls++

      if (control.setupMode === 'throw') throw new Error('fixture: setup exploded')
      // Never resolves. The host's start deadline is what ends this, and the
      // status must land on `failed`, never on `running`.
      if (control.setupMode === 'hang') await new Promise(() => {})
      if (control.setupMode === 'gate') await control.gate

      control.isPortFree = (port, proto) => ctx.isPortFree(port, proto)
      control.reportListener = (listener) => ctx.reportListener(listener)

      if (control.listenerMode === 'udp-reachable') {
        // Criterion 17, at the runtime boundary: a UDP listener is fine, and
        // claiming a device can dial it is not. The report is refused; the
        // socket, if there were one, would be entirely unaffected.
        try {
          ctx.reportListener({ id: 'udp', port: control.listenerPort ?? 45999, proto: 'udp', deviceReachable: true })
        } catch (err) {
          control.reportError = describeRefusal(err)
        }
      } else if (control.listenerMode !== 'none') {
        const server = Bun.listen({ hostname: '127.0.0.1', port: control.listenerPort ?? 0, socket: { data() {} } })
        control.boundPort = server.port
        if (control.listenerMode === 'leak') {
          // No disposer. Parked here so the TEST can close it afterwards —
          // the core cannot, was never given the handle, and must not.
          control.leakedServer = server
        } else {
          ctx.onStop(() => server.stop(true))
        }
        ctx.reportListener({ id: 'probe', port: server.port, proto: 'tcp' })
      }

      if (control.subscribeUndeclared) {
        try {
          // Typed as a real message type by the SDK; the point is that the
          // MANIFEST does not declare it, which is what must be refused.
          ctx.onEvent('device.activity', () => {})
        } catch (err) {
          control.subscribeError = describeRefusal(err)
        }
      }

      ctx.onEvent('device.status', async (event) => {
        control.eventsSeen.push(event.type)
        control.eventEnteredAt.push(Date.now())
        if (control.eventMode === 'throw') throw new Error('fixture: event handler exploded')
        if (control.eventMode === 'hang') await new Promise(() => {})
        if (control.eventMode === 'block') {
          // A synchronous burn. This is the shape that would delay a broadcast
          // if the tap ran handlers inside the broadcast's own frame — which is
          // exactly what the timing test measures.
          const until = Date.now() + (control.blockMs ?? 150)
          while (Date.now() < until) {
            // spin
          }
        }
      })

      ctx.onStop(async () => {
        control.disposerCalls++
        if (control.disposerMode === 'throw') throw new Error('fixture: disposer exploded')
        if (control.disposerMode === 'hang') await new Promise(() => {})
      })

      control.handler = async () => {
        control.handlerCalls++
        if (control.handlerMode === 'throw') throw new Error('fixture: handler exploded')
        if (control.handlerMode === 'reject') return Promise.reject(new Error('fixture: handler rejected'))
        if (control.handlerMode === 'hang') return new Promise<string>(() => {})
        return 'ok'
      }

      control.float = (kind) => {
        if (kind === 'string') {
          void Promise.reject('fixture: a non-Error rejection')
          return
        }
        void (async () => {
          throw new Error('fixture: a floating rejection')
        })()
      }

      control.floatPortRejection = () => {
        // `ctx.farm` refuses with `E_FARM_UNAVAILABLE` while no broker is
        // wired (step 109.3 builds it). The refusal is an error the CORE
        // constructed, so its stack names core code and tier 3 cannot see it —
        // it is attributable only because the host stamped it. The `.then` hop
        // is deliberate: it proves the stamp survives a derived promise, which
        // a `WeakMap` keyed on the promise itself would not.
        void ctx.farm
          .callRaw('device.list', {})
          .then((v) => v)
          .then((v) => v)
      }

      // -- step 109.6: the three handler families ---------------------------

      if (control.registerBadPermission) {
        try {
          ctx.onRequest('nope', () => ({ body: {} }), { permission: control.registerBadPermission })
        } catch (err) {
          control.registerError = describeRefusal(err)
        }
      }

      ctx.onRequest(
        'echo',
        async (request) => {
          // Recorded before any branch, so even the failing modes prove what
          // the handler was handed.
          control.lastRequest = request
          if (control.httpMode === 'throw') throw new Error('fixture: http handler exploded')
          if (control.httpMode === 'hang') await new Promise(() => {})
          if (control.httpMode === 'void') return
          if (control.httpMode === 'headers') {
            return {
              body: { ok: true },
              headers: {
                'content-type': 'application/json',
                // Refused by the allowlist. A plugin that could set a cookie on
                // the farm's own origin could overwrite the session cookie.
                'set-cookie': 'enkaku_session=stolen',
                'access-control-allow-origin': '*',
              },
            }
          }
          return { status: 200, body: { seen: request } }
        },
        control.httpPermission ? { permission: control.httpPermission } : {},
      )

      ctx.onQuery('rows', async (request) => {
        control.lastQuery = request
        if (control.queryMode === 'throw') throw new Error('fixture: query handler exploded')
        if (control.queryMode === 'hang') await new Promise(() => {})
        if (control.queryMode === 'bad-shape') {
          // Not a `PluginQueryResult` at all. The core must refuse this at ITS
          // boundary, naming the plugin — not hand it to a browser that then
          // fails to parse it two packages away from the cause.
          return 'these are not rows' as unknown as { rows: [] }
        }
        if (control.queryMode === 'paged') {
          return { rows: [{ value: { n: request.cursor ?? 'first' } }], nextCursor: request.cursor ? null : 'page-2' }
        }
        return {
          rows: [
            { id: 'a', value: { label: 'alpha' }, device: { id: 'd1', stableId: 's1', label: 'Pixel', status: 'online', groupId: null, number: 7 } },
            { value: { label: 'beta' } },
          ],
        }
      })

      ctx.onSocket('feed', (socket) => {
        control.lastSocket = socket as unknown as RuntimeHostFixtureControl['lastSocket']
        if (control.socketMode === 'throw') throw new Error('fixture: socket handler exploded')
        if (control.socketMode === 'no-handlers') return
        if (control.socketMode === 'push') {
          socket.send('hello')
          return {}
        }
        return {
          message: (data) => {
            control.socketFrames.push(typeof data === 'string' ? data : `bytes:${data.byteLength}`)
          },
          close: (code, reason) => {
            control.socketClosed = [code, reason]
          },
        }
      })

      // -- step 109.7: inbound webhooks -------------------------------------

      if (control.registerUndeclaredWebhook) {
        try {
          ctx.onWebhook(control.registerUndeclaredWebhook, () => ({ body: {} }))
        } catch (err) {
          control.webhookRegisterError = describeRefusal(err)
        }
      }

      const webhook = async (request: unknown) => {
        control.webhookCalls++
        control.lastWebhook = request
        if (control.webhookMode === 'throw') throw new Error('fixture: webhook handler exploded')
        if (control.webhookMode === 'hang') await new Promise(() => {})
        if (control.webhookMode === 'void') return
        return { status: 200, body: { seen: request } }
      }
      ctx.onWebhook('hook', webhook)
      ctx.onWebhook('strict', webhook)

      control.webhookApi = {
        list: () => ctx.webhooks.list(),
        secret: (id) => ctx.webhooks.secret(id),
        rotate: (id, opts) => ctx.webhooks.rotate(id, opts),
      }

      // -- step 109.8: logs --------------------------------------------------

      control.emit = (level, msg, fields) => ctx.log[level](msg, fields)
      control.readLogs = (opts) => ctx.logs.page(opts)

      ctx.log.info('fixture service up')
    },
  }),
})
