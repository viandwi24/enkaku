import { PLUGIN_UI_API_VERSION } from '@enkaku/protocol'
import { definePlugin, defineService, type PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'
import { registerApplyRoutes } from './service/apply-routes'
import { registerRouterRoutes } from './service/handlers'

/**
 * MikroTik routing — assigns a farm device its own internet egress path by
 * writing policy routing rules on a MikroTik router (`docs/plans/122-m87-mikrotik-routing.md`).
 * It never touches the device; the only thing that changes is the router.
 *
 * ## What this is, as of step 122.3
 *
 * Stage 1 of the plan (§5) is read-only, and this step is where it ships as
 * something an operator can actually open. Steps 122.1/122.2 gave this
 * plugin a `RouterDriver` (the `MikrotikRestDriver`) and a marker
 * parser/serialiser; this step wires both into a service (`defineService`,
 * plan 109) with three `ctx.onRequest` routes (`service/handlers.ts`) and a
 * tier-C React screen (`src/ui/**`, plan 111) with three tabs — Paths,
 * Settings, Rules — modelled closely on `plugins/proxy-manager`, this repo's
 * most complete tier-C plugin.
 *
 * **Still no write path exists anywhere in this package.**
 * `createRule`/`updateRule`/`deleteRule` on `RouterDriver` still throw "not
 * implemented" (step 122.6's job), and every route this step registers only
 * ever calls `inventory()`/`listRules()`/`doctor()` — nothing in this build
 * can apply anything to the router.
 *
 * ## The capability list, and what it deliberately does not include (§4.10)
 *
 * `device.list`/`device.get` — the fleet and its LAN-address bridge, needed
 * once the identity bridge (122.4, already built as a pure module) is wired
 * to a real device list (a later step: nothing in THIS step calls either
 * capability yet, but the manifest is what an operator consents to at
 * install, and both belong on the list before anything depends on them).
 * `job.run` — enqueuing `verify-egress` (122.10). `notify.send` — drift and
 * path-down alerts (122.9). **No `device.*` control capability of any kind is
 * declared, and none ever will be**: this plugin never touches a phone: it
 * writes to exactly one thing, the router's `/routing/rule` (§3.1).
 *
 * ## The version bump
 *
 * 0.1.0 → 0.2.0, the same reasoning `plugins/proxy-manager/src/index.ts`'s
 * own version-history comment gives every time it bumps: `service.permissions`
 * went from `[]` to four real capabilities, and a service now runs at all —
 * both are exactly what an operator is shown and consents to at install
 * (plan 109 §4.1). A pack that quietly gained a running service and four
 * capabilities under a version somebody had already approved would make that
 * consent screen a formality. Minor, not patch, for the same reason.
 *
 * **0.2.0 → 0.3.0 — step 122.6, the write path.** `service.permissions` is
 * UNCHANGED (`device.list`/`device.get`/`job.run`/`notify.send` already
 * covered everything this step reads), so this is not a consent bump the way
 * `proxy-manager`'s own 0.5.0/0.6.0/0.8.0 rows are — it is
 * `proxy-manager`'s OTHER reason, the mechanical one 0.9.0/0.10.0's notes
 * spell out: `packages/core/src/plugins/seed-embedded.ts`'s
 * `seedEmbeddedPacks` keys on `${pack.name}@${pack.version}` and skips
 * restaging a version already present in `<dataDir>/seeded-packs.json`. An
 * install that already seeded `mikrotik-routing@0.2.0` (stage 1, read-only)
 * would silently keep running that bundle forever after a binary upgrade —
 * `createRule`/`updateRule`/`deleteRule` went from an unconditional reject to
 * real REST writes, and three new routes (`fleet`/`plan`/`apply`) now exist
 * for a service that used to answer only three read-only ones. Left at
 * `0.2.0`, the fix for "this plugin cannot change a router yet" would itself
 * silently fail to arrive on an already-provisioned farm. Minor, not patch:
 * an operator meets this immediately, on the new Assignments tab.
 *
 * **Still `0.3.0` — a correctness bug in this same write path, found by
 * review immediately after 122.6 landed and fixed before this version ever
 * shipped**, so it is folded into this entry rather than earning its own
 * bump: `resolve.ts`/`planner.ts` matched a router rule's `src-address` to
 * an endpoint by raw string equality, and `createRule` wrote a bare address
 * specifically so that comparison would line up. The owner's real router
 * echoes `src-address` back in CIDR form regardless of what was written
 * (`192.168.10.221/32`, not `192.168.10.221`), so the exact-string match
 * never found the rule it had just created — every apply after the first
 * would silently add a duplicate rule for the same device instead of
 * updating it. Fixed by matching on parsed address RANGE
 * (`cidr.ts`'s `sameAddressSpec`) everywhere a router-supplied `src-address`
 * is compared against an endpoint we produced, and `createRule`/`updateRule`
 * now write an explicit `/32` to match what an operator already sees for
 * hand-made rules in Winbox — see `resolve.ts`, `planner.ts`, and
 * `router-driver.ts`'s own `createRule`/`updateRule` comments for the detail.
 */

const checkParams = z.object({})

const checkResult = z.object({
  ok: z.boolean().describe('Always false — no router was contacted. Reported so a run that did nothing can never be mistaken for a router that was checked.'),
})

export const checkScript: PluginMemberScript<typeof checkParams, typeof checkResult> = {
  id: 'check',
  title: 'Check the router',
  description: 'Not built yet — this plugin has no behaviour reachable from a job. See docs/plans/122-m87-mikrotik-routing.md.',
  params: checkParams,
  result: checkResult,
  timeout: 30_000,

  async run(ctx) {
    ctx.log.warn('mikrotik-routing has no behaviour yet — the router driver exists (service/router-driver.ts) but nothing on the router was read or changed by this run')
    return { ok: false }
  },
}

export default definePlugin({
  id: 'mikrotik-routing',
  version: '0.3.0',
  title: 'MikroTik routing',
  description:
    'Assigns a farm device its own internet egress path by writing policy routing rules on a MikroTik router. Stage 2: single assignments from the Assignments tab, applied through a reviewed plan and refused (§3.2) while every device is not provably still reachable over adb. Named groups (activate/deactivate as a unit) are not built yet.',
  scripts: [checkScript],

  /**
   * The long-lived half (plan 109 §3.1, §3.3). `permissions` is the
   * exhaustive list §4.10 names — shown to the operator at install, checked
   * by the broker BEFORE any capability runs, and, this step, unused by any
   * handler below: `inventory`/`rules`/`doctor` only ever call the
   * `RouterDriver`, never `ctx.farm`. Declared now anyway, deliberately,
   * because it is what the operator consents to and later steps (the
   * identity bridge, `verify-egress`, drift notifications) depend on it
   * already being there rather than arriving as a second, unreviewed bump.
   *
   * `events: []` — there is nothing to reconcile on a device event yet
   * (matches `plugins/proxy-manager`'s own reasoning for the identical
   * empty list): an assignment is a later step's concept, and a device
   * coming online must not silently trigger anything this plugin does.
   */
  service: defineService({
    permissions: ['device.list', 'device.get', 'job.run', 'notify.send'],
    events: [],

    async setup(ctx) {
      // The three read-only routes (`inventory`/`rules`/`doctor`) the
      // Paths/Rules/Settings tabs call — see `service/handlers.ts`'s own
      // header for why each is its own `onRequest` registration rather than
      // one shared handler.
      registerRouterRoutes(ctx)
      // The write half (step 122.6): `fleet`/`plan` (read) and `apply` (the
      // one route in this plugin that reaches the router) — see
      // `service/apply-routes.ts`'s own header for the permission split.
      registerApplyRoutes(ctx)
    },
  }),

  surface: {
    nav: [{ id: 'routing', label: 'MikroTik routing', icon: 'server', view: 'routing' }],
    views: {
      routing: {
        title: 'MikroTik routing',
        description: 'Paths, the router connection, and every rule on the router, split managed vs. foreign. Read-only — nothing here writes to the router yet.',
        /**
         * Tier C (plan 111), the same reason §3.6 gives: every one of these
         * three tabs has to render drift/health state that tier A's
         * expression-free vocabulary cannot express, and splitting the
         * plugin across two tiers to save markup on three tables buys
         * nothing. `entry` names the file `enkaku publish` builds
         * `src/ui/index.tsx` into inside the package's `ui/` directory —
         * rename one and the other has to move with it (mirrors
         * `plugins/proxy-manager/src/index.ts`'s own comment on this exact
         * field).
         */
        react: { entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION },
      },
    },
  },
})
