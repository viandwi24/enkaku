import { PLUGIN_UI_API_VERSION } from '@enkaku/protocol'
import { definePlugin, defineService, ui, type PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'
import { createSupervisor } from './service/supervisor'
import { CHECK_NOT_BUILT, PLUGIN_NOT_BUILT, PROXY_KEY_PREFIX, VIEW_NOT_BUILT } from './shared'

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
 * ## What this is NOT
 *
 * It does not route any device's traffic, and a proxy an app *can be pointed
 * at* is not a route an app *cannot escape*. Routing already has an owner
 * elsewhere in the product: the `network` driver layer (spec §7.9), whose only
 * non-bypassable engine is `vpn-helper`, and nothing a plugin can reach
 * touches it.
 *
 * The screen also cannot yet start, stop or restart a bridge, or show its
 * logs — those need `ctx.onRequest`, which is plan 109 step 109.6 and does not
 * exist. And an upstream **password cannot be stored at all** until plan 112
 * step 112.2 stops the key/value store leaking a fragment of every secret onto
 * its own row.
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

export default definePlugin({
  id: 'proxy-manager',
  version: '0.3.1',
  title: 'Proxy manager',
  description: PLUGIN_NOT_BUILT,
  scripts: [checkScript],

  /**
   * The long-lived half (plan 109 §3.1, §3.3; plan 112 §4.5).
   *
   * **`permissions: []` is deliberate**, and it is what removes plan 109 step
   * 109.3's capability broker from this plan's critical path. The screen reads
   * devices through `GET /api/plugins/:name/data/scan` from the browser with
   * the operator's own session — which is what the Assignments tab already
   * does — so the service never needs `ctx.farm.call('device.list')`. The one
   * place that changes is step 112.11, where resolving a device to expose a
   * bridge to it may need a capability; it is declared then, in the step that
   * needs it, and shown at install.
   *
   * **`events: []` likewise.** There is nothing to reconcile on a device
   * event until the exposure chain exists.
   */
  service: defineService({
    permissions: [],
    events: [],
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

      // Registered BEFORE anything binds, so a setup that throws halfway still
      // has a disposer for whatever did get opened. It destroys immediately
      // and does not drain: the host's whole disposer budget is 5 s for every
      // disposer combined, and a `drainMs` of 10 s could only blow it, earn a
      // warn naming this plugin, and leave the service reading `stopping`
      // (plan 112 §3.7).
      ctx.onStop(() => supervisor.destroyAll())

      await supervisor.startEnabled()

      // [112.9, gated on plan 109 step 109.6]
      //   ctx.onRequest('proxies', …) — list, start, stop, restart, logs.
      // Until that exists the screen has no door to drive this through, and
      // the shortcut — polling this plugin's own KV namespace every couple of
      // seconds for an `enabled` flag the screen flipped — is refused rather
      // than built: it is a weaker parallel path that would have to be deleted
      // the week 109.6 lands, and a `list()` per tick is a real cost in the
      // core's event loop (plan 112 §4.6).
    },
  }),

  surface: {
    nav: [{ id: 'proxies', label: 'Proxy manager', icon: 'network', view: 'proxies' }],
    views: {
      proxies: {
        title: 'Proxy manager',
        description: VIEW_NOT_BUILT,
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
