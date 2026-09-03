import { PLUGIN_UI_API_VERSION } from '@enkaku/protocol'
import { definePlugin, defineService, ui, type PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'
import { applyAssignment, type ApplyHost } from './service/apply'
import { registerProxyRoutes } from './service/handlers'
import { resetProxyManager } from './service/reset'
import { createSupervisor } from './service/supervisor'
import { CHECK_NOT_BUILT, PLUGIN_NOT_BUILT, PROXIES_VIEW_DESCRIPTION, PROXY_KEY_PREFIX, type ProxyApplyMode } from './shared'

/**
 * Proxy manager — a plugin that owns a screen and, deliberately, nothing else.
 *
 * ## What this is
 *
 * A catalogue, an assignment note per device, and a list of this pack's own
 * runs, on three tabs. The screen is a **React module this pack ships** (tier
 * C, plan 111): `src/ui/index.tsx` is built to `ui/index.js` inside the
 * `.enkaku` package, Studio loads it into its own component tree with its own
 * React instance, and it draws itself with `@enkaku/ui` — the same components
 * every built-in screen is drawn with.
 *
 * ## Why this pack, and not the other one
 *
 * Plan 111 §4.3 chose it on purpose. TikTok Accounts is a table over scanned
 * KV, which is exactly what tier A is for, and rebuilding it in React would
 * prove only that React can draw a table. This pack wants **tabs** — the
 * owner's own named example — a form that is more than one flat schema, and
 * eventually live output. Rebuilding it is the real comparison, and it leaves
 * one pack on each tier so the two can be judged side by side.
 *
 * ## What it deliberately no longer declares
 *
 * No `data`, no `table`, no `actions`. A tier-C view calls `fetch` directly
 * with the operator's session (plan 111 §3.4) — there is no sandbox and no
 * bridge, so a declared vocabulary would only be a second, weaker way to do
 * what the component can already do. Writes go to `PUT/DELETE
 * /api/plugins/proxy-manager/data/entry`, which is the operator-facing
 * (`plugin.data`) door onto this plugin's own namespace and audits every write
 * as `plugin.data.set`/`plugin.data.delete`. The namespace is taken
 * server-side from the URL path and is never spelled here (plan 108 §3.7).
 *
 * ## What it DOES do, as of plan 112 steps 112.1–112.7
 *
 * It runs a **service** (plan 109's `defineService`): a long-lived entry point
 * loaded into the core's own process, which starts a local proxy bridge for
 * every catalogue record marked `enabled` and stops it again when the plugin
 * does. A bridge is an HTTP or SOCKS5 listener bound to loopback that tunnels
 * through the upstream proxy the record names — the owner's own
 * `gost -L "http://:9902" -F "socks5://…"`, folded into the farm, with no
 * binary downloaded and no second process supervised.
 *
 * ## What it does as of plan 114 step 114.9 — and what it still does not
 *
 * It can **ask the farm to point a device at one of these bridges**, from the
 * Assignments tab, one device at a time, when somebody presses Apply. It does
 * that through `ctx.farm.call('device.network.set', …)` — the same
 * `PUT /api/devices/:id/network` an operator's own click goes through — under a
 * `plugin:proxy-manager` principal, checked against the manifest below before
 * the capability runs and audited afterwards. The device's own Network panel
 * then reports *set by proxy-manager*.
 *
 * There is deliberately no second path. This pack has no adb, no shell, and
 * writes no device setting; `service/apply.ts` is the only file that reaches a
 * phone at all, and it does so by asking.
 *
 * ## Two modes on that Apply, as of 0.6.0
 *
 * The owner's ask: *"apply di setting proxy manager juga harusnya ada 2 pilihan
 * dong, apply sebagai vpn mode atau sebagai http proxy mode."* Both come from
 * ONE catalogue entry, and they are not two names for the same thing:
 *
 * - **HTTP proxy** points the phone at the record's own BRIDGE
 *   (`adb-reverse-proxy`). The phone dials its own loopback over the adb
 *   connection, the upstream account never leaves this machine, and an app with
 *   its own networking can ignore the whole arrangement.
 * - **VPN** hands the phone the record's own UPSTREAM (`vpn-helper`). The guest
 *   agent dials that SOCKS5 proxy itself, so the bridge is not involved and does
 *   not even need to be running — and an app cannot opt out. The price, said at
 *   the point of choice rather than buried here: the upstream password is sent
 *   to the phone, which is exactly what the reverse rung exists to avoid.
 *
 * This is what corrected `shared.ts`'s standing claim that the enforcing rung
 * was structurally out of reach. It was right that a loopback BRIDGE cannot be a
 * SOCKS5 upstream for the guest agent, and wrong that the RECORD has nothing
 * else to offer — a record holds both addresses.
 *
 * A VPN that cannot be applied — no guest agent, a non-SOCKS5 upstream, no saved
 * password — is refused by name. It is never quietly replaced with an HTTP
 * proxy, which would leave the operator believing traffic is captured when it is
 * not (plan 114 §3.1, §3.4 rule 4). See `APPLY_RUNG_SENTENCE` and
 * `APPLY_VPN_SENTENCE`.
 *
 * ## What it does as of plan 112 steps 112.8 and 112.9
 *
 * A bridge can be **started, stopped and restarted one at a time**, and every
 * bridge's lines go to **one log the farm filters per proxy**. Both arrive as
 * `ctx.onRequest` handlers (plan 109 step 109.6) rather than as anything this
 * pack opens itself, so they inherit the core's auth, TLS, CORS, rate limiting
 * and audit unchanged — plan 109 §3.7 names the alternative, a raw port serving
 * a UI, as the trap, and it would bypass all five.
 *
 * `service/handlers.ts` owns none of that behaviour: it is a door onto the
 * supervisor, which is the one owner of a bridge's state.
 *
 * An upstream **password still cannot be stored at all** until plan 112 step
 * 112.2 stops the key/value store leaking a fragment of every secret onto its
 * own row.
 *
 * Every word an operator can read says so — see `shared.ts`, where those
 * sentences are declared once and used by both halves so that the plugin list
 * and the screen cannot drift into disagreeing.
 */

const checkParams = z.object({
  proxy: z
    .string()
    .max(200)
    .default(PROXY_KEY_PREFIX)
    .describe('The storage key of a saved proxy, e.g. "proxy:office-uk". It is written to the log and read by nothing — no connection is attempted.')
    .meta(ui({ title: 'Proxy key' })),
})

const checkResult = z.object({
  proxy: z.string().describe('The proxy key this run was given, echoed back.').meta(ui({ title: 'Proxy key', summary: true })),
  reachable: z
    .boolean()
    .describe('Always false — nothing was contacted. Reported so a run that did nothing can never be mistaken for a proxy that passed a check.')
    .meta(ui({ title: 'Proxy reachable' })),
})

/**
 * The pack's one member, and it is honest about being empty.
 *
 * It is a real script, not a stub that throws: it publishes, verifies,
 * enqueues, runs to `success`, and returns a declared result. That matters for
 * two reasons. A plugin must have at least one member to exist at all
 * (`definePlugin` refuses an empty `scripts`), and a member that threw would
 * make every install of this pack look broken on the jobs list — a red row is
 * a claim that something went wrong, and nothing did.
 *
 * `reachable: false` is the load-bearing part of the result. A run that
 * reports nothing at all reads like a pass; a run that reports "not reachable,
 * because nothing was contacted" cannot.
 *
 * Untouched by plan 111 step 111.7, which changes the UI and not the scripts.
 *
 * Declared as a named `const` with both generics (the pattern the TikTok pack
 * uses) so `run`'s return is checked against `checkResult` at author time —
 * `definePlugin`'s array-position inference cannot carry a member's `result`
 * type, so the check has to happen here, at the declaration.
 */
export const checkScript: PluginMemberScript<typeof checkParams, typeof checkResult> = {
  id: 'check',
  title: 'Check a proxy',
  description: CHECK_NOT_BUILT,
  params: checkParams,
  result: checkResult,
  timeout: 30_000,

  async run(ctx) {
    // `warn`, not `info`: an operator who ran this expecting a check should
    // see the line that tells them it was not one, without unfolding a log.
    ctx.log.warn('proxy-manager has no behaviour yet — no connection was attempted and nothing on the device was changed', {
      proxy: ctx.params.proxy,
    })
    return { proxy: ctx.params.proxy, reachable: false }
  },
}

/**
 * The supervisor belonging to the CURRENTLY LOADED instance of this module, or
 * `null` when `setup` has not run (or has been torn down).
 *
 * Module scope, and deliberately: `setup` and `onResetData` are siblings on the
 * `defineService` input rather than nested, so a closure cannot join them, and
 * the host imports this bundle afresh per start — so one module instance is one
 * running service, and this variable can never point at a previous load's
 * sockets. See `setup` for the full argument.
 */
let liveSupervisor: ReturnType<typeof createSupervisor> | null = null

export default definePlugin({
  id: 'proxy-manager',
  /**
   * Bumped by step 114.9, and the reason is the manifest rather than the code:
   * `service.permissions` went from `[]` to two capabilities, and that list is
   * what an operator is SHOWN and consents to at install (plan 109 §4.1). A
   * pack that quietly gained the ability to change a phone's networking under
   * the version somebody already approved would make the consent screen a
   * formality. A minor bump, not a patch, for the same reason.
   *
   * **Bumped again to 0.5.0 for the same class of reason.** The pack now STORES
   * an upstream password — the first credential this repo puts in KV — on a
   * second key per record, and the description an operator reads in the plugin
   * list says so (`PLUGIN_NOT_BUILT`, narrowed from *"an upstream password
   * still cannot be saved"*). A pack that started holding credentials under a
   * version somebody had already approved is the same consent problem as one
   * that quietly gained a capability, even though `service.permissions` is
   * unchanged: what the operator is agreeing to is not only the capability
   * list.
   *
   * 0.5.1 is a patch on top of it and nothing more: the derived key rendered
   * `proxy:untitled` over an empty Name field, which advertised the
   * slugs-to-nothing fallback as the plan. Caught by rendering the dialog, not
   * by a test.
   *
   * **0.6.0 — Apply grew a second mode, and it is a consent change for the
   * third time and the same reason.** `service.permissions` is UNCHANGED
   * (`device.network.set` already covered both engines), but a pack that can now
   * send a stored upstream password TO A PHONE is not doing what the operator
   * approved at 0.5.x, where the whole point of the reverse rung was that the
   * account never left the farm. The description they read says so
   * (`PLUGIN_NOT_BUILT`), and a minor bump is what puts it in front of them.
   *
   * **0.8.0 — Reset data, and it is a consent change for the fourth time.** The
   * pack now declares a `resetData` block, and that block names
   * `device.network.clear` — the capability this pack's own comment refused to
   * take. It is scoped to one operator-initiated pass and the running service
   * still cannot reach it (see `service.permissions` below), but a scoped grant
   * is still a grant, it appears in its own list on the install screen, and a
   * pack that quietly gained the ability to un-route phones under a version
   * somebody had already approved is exactly the consent problem 0.6.0's note
   * describes. A minor bump, for the same reason all three before it were.
   *
   * **0.9.0 — plan 121 (M86), backup upstreams and failover.** Not a consent
   * change like the four bumps above it — `service.permissions` is
   * unchanged, and a record's upstream (including a fallback) is still
   * exactly what it always was: an address the OPERATOR types in, the same
   * class of thing a `socks5`/`http` primary upstream already let them point
   * anywhere. This bump exists for a different, purely mechanical reason:
   * `packages/core/src/plugins/seed-embedded.ts`'s `seedEmbeddedPacks` keys
   * on `${pack.name}@${pack.version}` and SKIPS restaging a version already
   * present in `<dataDir>/seeded-packs.json` — an install that had already
   * seeded `proxy-manager@0.8.0` would silently keep running the PRE-121
   * bundle forever after a binary upgrade, because the version string
   * (which is what identity is keyed on, not the code) never changed. Ship
   * a real, sizeable feature under an unchanged version number and no
   * existing install ever sees it. A bare patch bump would technically also
   * force a reseed, but this is a feature an operator will notice using
   * (a Studio editor, a chip, a new route), not "nothing more" — the
   * distinction 0.5.1's own note above draws.
   *
   * **0.10.0 — plan 123 (M88), the bind capability probe.** Same mechanical
   * reason as 0.9.0, and this time the cost of forgetting it would have been
   * severe. `proxy-manager@0.9.0` SHIPPED (tag `v0.1.19`) and is running on
   * the owner's farm; plan 123 then changed twelve files in this pack —
   * `net.connect({ localAddress })` is silently ignored by Bun on every
   * platform tested, so the Windows-only gate around the `gost` workaround
   * was replaced by a per-boot capability probe, and a record whose bind
   * provably does not work now refuses to start (`E_PROXY_BIND_INEFFECTIVE`)
   * instead of egressing from the wrong address while reporting `running`.
   * Left at `0.9.0`, `seedEmbeddedPacks` would have skipped restaging every
   * install that already seeded that version — which is every install of
   * `v0.1.19` — so the fix for a silent wrong-egress bug would itself have
   * silently failed to arrive. Minor, not patch: a record that used to serve
   * traffic now refuses to start on Linux and macOS, which is a behaviour
   * change an operator meets immediately.
   *
   * **0.11.0 — plan 124 (M89), device identity and search in this pack's own
   * UI.** `service.permissions` UNCHANGED. Step 124.8 taught the Assignments
   * tab to render `#7 SM-F721U1` instead of a bare label (the `number` was
   * already on the wire — `GET /api/plugins/:name/data/scan` has LEFT JOINed
   * `device_numbers` since plan 89 — this pack simply never parsed it), added
   * a filter above the device table, and turned the per-row proxy `Select`
   * into a searchable `Combobox`, which on a 45-record catalogue rendered
   * once per device row was a scroll hunt.
   *
   * The bump is the whole point, for the reason 0.10.0's note above spells
   * out at length: `seedEmbeddedPacks` keys on `${pack.name}@${pack.version}`
   * and skips what it has already seeded, so a UI-only change left at 0.10.0
   * never reaches an install that already ran. The other UI pack plan 124
   * touched was bumped in the same pass and for the same reason — the owner
   * reported ITS device dropdown still unchanged after the work had landed
   * and been committed, and that report is what found this.
   *
   * Minor, not patch: an operator meets it immediately, in a table they use
   * every day.
   *
   * **0.11.1, plan 201 (MVP wave 0): housekeeping.** `service.permissions`
   * UNCHANGED. Deleted `record.ts`, a Zod re-declaration of the record that
   * only tests imported (the service parses through `shared.ts`'s
   * `readProxyRecord`); renamed the view's stale "not built" description
   * constant to `PROXIES_VIEW_DESCRIPTION` because the view has been built
   * since plan 112; reworded two comments that named the deleted
   * `plugin.log` broadcast. Patch, not minor: nothing an operator meets
   * changes.
   */
  version: '0.11.1',
  title: 'Proxy manager',
  description: PLUGIN_NOT_BUILT,
  scripts: [checkScript],

  /**
   * The long-lived half (plan 109 §3.1, §3.3; plan 112 §4.5; plan 114 step
   * 114.9).
   *
   * **`permissions` is no longer empty, and the list is exhaustive on
   * purpose** — it is what an operator is shown and consents to at install, and
   * plan 109 §4.3 refuses anything absent from it *before* the capability runs.
   * Two entries, each earning its place:
   *
   * - `device.list` — the only way this pack learns a device exists. The
   *   Assignments tab is keyed by `stableId` (that is what
   *   `GET /api/plugins/:name/data/scan` answers with) and every device API is
   *   keyed by the row id; this is the map between them. It is a read.
   * - `device.network.set` — the one door onto a device's route. This is the
   *   capability that makes the pack able to change a phone at all, and it is
   *   the reason the other two halves of `shared.ts`'s honesty copy had to be
   *   narrowed.
   *
   * **`device.network.clear` is still deliberately NOT declared HERE, and the
   * argument that withheld it still holds.** Turning a device's proxy off is
   * the operator's own act on the device's own screen, where the §3.6 restore
   * is explained; a plugin that could silently un-route forty phones is a
   * bigger authority than anything on this screen asks for.
   *
   * The day a case for it would be named has come, and the case is narrower
   * than the grant would have been — so what was added is narrower too. It sits
   * in `resetData.permissions` below, which is a *different list with a
   * different lifetime*: those capabilities are live only during an
   * operator-initiated Reset data pass, only through the context object handed
   * to `onResetData`, and only until that one pass ends. `setup`, the Apply
   * handler, the five bridge routes and every member script are refused
   * `device.network.clear` exactly as they were before — `farm-broker.ts` checks
   * the standing list for them, and this list only when the host says a pass is
   * open. Nothing on this screen gained the ability to un-route a phone.
   *
   * **`events: []` still.** There is nothing to reconcile on a device event:
   * an assignment is intent, and applying it is a deliberate press (plan 114 §9
   * Q6). A device coming online must not silently re-apply a proxy nobody asked
   * for on that occasion — the farm's own reconcile already restores a route it
   * was actually asked to apply.
   */
  service: defineService({
    permissions: ['device.list', 'device.network.set'],
    events: [],

    /**
     * **Reset data** — the operator action that deletes everything this pack
     * stored, and the one run this pack gets to undo what it did first.
     *
     * The owner's own example is this pack, and it is the right one: the
     * `assigned` rows below are the ONLY record of which phones this pack
     * pointed at a proxy. Deleting them without turning those routes off leaves
     * live routes on real devices that nothing left in the farm can explain.
     * `service/reset.ts` is the handler and carries the full account.
     *
     * ## The two capabilities, and why they are here rather than above
     *
     * - `device.network.get` — read `setBy` before touching anything, so a
     *   route this pack did NOT set is left alone rather than un-routed on the
     *   operator's behalf without being asked.
     * - `device.network.clear` — the one this pack has always withheld. See the
     *   `permissions` comment above for what has and has not changed: it is
     *   live during a reset pass and at no other moment, and the running
     *   service cannot reach it.
     *
     * Both are shown to the operator at install, in their own list, described
     * as what they are. That is the trade: the pack gains the authority to
     * finish its own cleanup, and gains it for one operator-initiated pass
     * rather than for its whole lifetime.
     */
    resetData: {
      permissions: ['device.network.get', 'device.network.clear'],
      description:
        'Turns off the network route on every device this plugin routed — checking first that the route on each phone was set by this plugin and not by you — and stops every bridge it has listening. A phone that cannot be reached is not reported as done: the farm records the teardown against that device and carries it out the next time the device is admitted.',
    },
    /**
     * Declared so the operator learns at install that this plugin opens ports
     * on their machine — a declaration is the SHAPE consented to, never a
     * reservation (plan 109 §9 Q20). The real ports come from the records and
     * are reported at run time by `ctx.reportListener`; there is no advisory
     * `port` here because there is no single one to name.
     *
     * `deviceReachable` is absent (i.e. `false`) on purpose: the chain that
     * would make it true is plan 109 steps 109.9–109.11, and advertising it
     * first would be a manifest whose central claim is not yet keepable.
     */
    listeners: [
      {
        id: 'proxy-bridge',
        proto: 'tcp',
        description: 'One loopback TCP port per enabled proxy record — the local bridge an app is pointed at.',
      },
    ],

    async setup(ctx) {
      const supervisor = createSupervisor(ctx)
      /**
       * `onResetData` is a sibling of `setup`, not a closure inside it, so this
       * is how the reset pass reaches the supervisor `setup` built.
       *
       * Module scope is the right scope for it and not a shortcut. The host
       * cache-busts its `import()` per start (`runtime-host.ts`), so a fresh
       * load gets a fresh module instance with its own `liveSupervisor` — and
       * the `onResetData` the host captured off that same instance's `service`
       * object reads that same variable. A reset can therefore only ever stop
       * bridges belonging to the instance that is actually running, never a
       * previous load's.
       */
      liveSupervisor = supervisor

      // Registered BEFORE anything binds, so a setup that throws halfway still
      // has a disposer for whatever did get opened. It destroys immediately
      // and does not drain: the host's whole disposer budget is 5 s for every
      // disposer combined, and a `drainMs` of 10 s could only blow it, earn a
      // warn naming this plugin, and leave the service reading `stopping`
      // (plan 112 §3.7).
      ctx.onStop(() => {
        liveSupervisor = null
        return supervisor.destroyAll()
      })

      await supervisor.startEnabled()

      /**
       * `POST /api/plugins/proxy-manager/http/apply` (plan 114 step 114.9) —
       * the Assignments tab's Apply button, and the ONLY thing in this pack
       * that reaches a phone.
       *
       * It is a handler rather than a `fetch` straight to
       * `PUT /api/devices/:id/network` from the screen, and the difference is
       * the attribution: a browser call would run as the OPERATOR, and the
       * device would report that a person set the route when a plugin did.
       * Going through the service means the call runs as
       * `plugin:proxy-manager`, is checked against the manifest above before it
       * runs at all, is audited under that principal, and lands on the device's
       * own panel as *set by proxy-manager*.
       *
       * `permission: 'device.network'` — the same permission the built-in
       * endpoint requires of a person. Both gates apply and neither is
       * redundant: this one is about the operator who pressed the button, and
       * the broker's is about the plugin. An operator who may not change a
       * device's networking must not be able to do it by pressing a plugin's
       * button, and a plugin that did not declare the capability must not be
       * able to do it on behalf of an operator who may.
       *
       * A refusal answers `200` with `{ ok: false, … }` rather than a 4xx: the
       * cases are ordinary product outcomes (no note yet, the record is not
       * enabled, its listener speaks SOCKS5, this phone has no guest agent) and
       * the screen renders each one differently.
       *
       * **As of 0.6.0 the farm's OWN refusals join them** rather than escaping
       * as a `502` naming this plugin as faulty — see `service/apply.ts`'s
       * `catch`. Somebody else driving the phone is `admitMember` working
       * exactly as designed, and an operator has to be able to read that
       * sentence; a real fault (a bug in this file, a host that is not there at
       * all) still throws and still becomes the `502` where it belongs.
       */
      ctx.onRequest(
        'apply',
        async (request) => {
          const body = request.body
          const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { stableId?: unknown; mode?: unknown }) : {}
          if (typeof fields.stableId !== 'string' || fields.stableId.length === 0) {
            return { status: 400, body: { ok: false, code: 'E_BAD_REQUEST', kind: 'refusal', message: 'Apply needs a stableId naming which device to point at its noted proxy.' } }
          }
          /**
           * `mode` is passed through as it arrived, INCLUDING a value this
           * build does not know — `applyAssignment` refuses that by name
           * (`E_PROXY_BAD_MODE`) rather than this handler quietly dropping it
           * and applying the default. A dropped mode is a silent downgrade, and
           * a silent downgrade from the enforcing route to the advisory one is
           * the exact failure plan 114 §3.4 rule 4 exists to prevent.
           */
          const mode = fields.mode === undefined ? undefined : (fields.mode as ProxyApplyMode)
          /**
           * `bridgePort` (plan 118 step 118.2) is the one field `ctx` itself
           * cannot supply — the supervisor is this file's own, not part of
           * `PluginServiceContext` — so the host is built explicitly rather
           * than passing `ctx` straight through as every call before this one
           * did. `runtimeOf` is a plain, synchronous map read; nothing here
           * touches storage a second time.
           */
          const applyHost: ApplyHost = { storage: ctx.storage, farm: ctx.farm, log: ctx.log, bridgePort: (proxyId) => supervisor.runtimeOf(proxyId)?.port ?? null }
          return { body: await applyAssignment(applyHost, { stableId: fields.stableId, ...(mode === undefined ? {} : { mode }) }) }
        },
        {
          methods: ['POST'],
          permission: 'device.network',
          // The advisory mode waits on `adb reverse`, a settings write and a
          // read-back; the VPN mode waits on the guest agent's whole
          // install/grant/bootstrap/forward/handshake chain, on a phone that may
          // be on the far side of a slow wireless link. The farm's own
          // capability deadline (120 s for `device.network.set`) is the real
          // bound; this one only has to be wider than it is not.
          timeoutMs: 180_000,
          description:
            'Ask the farm to point one device at the proxy noted against it, either as an HTTP proxy the phone is asked to use or as a VPN the guest agent dials the record’s upstream through. Explicit, one device at a time — saving a note applies nothing, and a VPN that cannot be applied is never replaced with an HTTP proxy.',
        },
      )

      /**
       * The five routes the screen drives a bridge through (plan 112 §4.6,
       * step 112.9) — `proxies`, `start`, `stop`, `restart`, `logs`.
       *
       * They are a door onto the supervisor above, never a second lifecycle:
       * `service/handlers.ts` holds no state, binds nothing and keeps no timer.
       * The shortcut this replaced was refused rather than built — the screen
       * writing `enabled: true` into KV and the service polling its own
       * namespace every couple of seconds — because it is a weaker parallel
       * path (00-overview §4.3) and a `list()` per tick is a real cost in the
       * core's own event loop (plan 112 §4.6).
       */
      registerProxyRoutes(ctx, supervisor)
    },

    /**
     * The cleanup half of Reset data — see `resetData` above and
     * `service/reset.ts` for the whole account.
     *
     * It runs while this pack's data is still entirely intact, which is the
     * point: the `assigned` rows are the only record of which phones were
     * routed, and they are what the handler reads to know where to go.
     *
     * A supervisor that is not there is a refusal, not an empty pass. It means
     * `setup` has not finished (or has been torn down) under a service the host
     * reported as running, and answering "nothing to undo" for that would let
     * the farm delete every assignment this pack holds on the strength of a
     * question that was never actually asked.
     */
    async onResetData(ctx) {
      if (!liveSupervisor) {
        throw new Error(
          'this plugin’s service has no live supervisor, so its bridges cannot be accounted for — nothing was cleaned up and nothing should be deleted. Reload the plugin and reset again.',
        )
      }
      return resetProxyManager(ctx, liveSupervisor)
    },
  }),

  surface: {
    nav: [{ id: 'proxies', label: 'Proxy manager', icon: 'network', view: 'proxies' }],
    views: {
      proxies: {
        title: 'Proxy manager',
        description: PROXIES_VIEW_DESCRIPTION,
        /**
         * Tier C. `entry` names a file inside the package's `ui/` directory,
         * and `enkaku publish` builds `src/ui/index.tsx` into exactly that —
         * rename one and the other has to move with it. `src/ui/index.css` is
         * compiled beside it into `ui/index.css` by the same convention, and
         * Studio links it before the script (plan 111 step 111.9).
         *
         * `apiVersion` is the `@enkaku/ui` major this screen was written
         * against. Verify refuses a mismatch, naming both numbers, rather than
         * letting a component built against an older component library break
         * in front of an operator (plan 111 §3.5). It is read from
         * `@enkaku/protocol` rather than typed as a literal because this pack
         * lives in the repo and is rebuilt with the farm — a third-party pack
         * pins the number its scaffold emitted.
         */
        react: { entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION },
      },
    },
  },
})
