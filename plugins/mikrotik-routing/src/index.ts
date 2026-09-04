import { PLUGIN_UI_API_VERSION } from '@enkaku/protocol'
import { definePlugin, defineService, type PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'
import activateGroupScript from './activate-group'
import discoverLanIpScript from './discover-lan-ip'
import { registerApplyRoutes } from './service/apply-routes'
import { registerGroupRoutes } from './service/groups-routes'
import { registerRouterRoutes } from './service/handlers'
import { registerReconcileRoutes } from './service/reconcile-routes'
import { createReconcileLoop } from './service/reconcile'
import verifyEgressScript from './verify-egress'

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
 *
 * **0.3.0 → 0.3.1 — three defects found testing against the owner's real
 * router the day after 0.3.0 shipped (2026-08-21, `v0.1.21`).**
 * `service.permissions` is UNCHANGED — this is `proxy-manager`'s "mechanical"
 * reason again, not a consent bump: `seedEmbeddedPacks` keys on
 * `${pack.name}@${pack.version}` and would otherwise keep an
 * already-provisioned farm running the buggy `0.3.0` bundle forever.
 * (1) `local-exception.ts`'s suggested `src-address` was `smallestCoveringCidr`
 * of the devices known AT THE MOMENT OF THE CHECK — on the owner's farm, 3
 * online devices out of 40 produced a `/29` that stopped protecting the
 * other 37 the instant they came back online, after the suggestion had
 * already been pasted into the router. Now `naturalCoveringCidr`
 * (`cidr.ts`), which widens to the /24 that actually contains the known
 * addresses — still derived from them, never a hardcoded literal — unless
 * the known addresses already span more than one /24, in which case the
 * true minimal covering block is kept and shown honestly. (2)
 * `describeUncovered` printed `label` alone, which repeats uselessly once a
 * farm has more than one device of the same model (the owner's farm printed
 * "SM-F721U1, SM-F721U1, SM-F721U1"); it now prints `label (address)`, and
 * the Settings tab's own separate "Uncovered:" line does the same — and as
 * of plan 124 step 124.7 that `label` also carries the device NUMBER, which
 * is the answer the owner's complaint was actually asking for (`#7 SM-F721U1
 * (192.168.10.15)`). (3) Two
 * UI strings still claimed this plugin could not write to the router — the
 * view description below, and the Preferences card's description in
 * `ui/parts/settings.tsx` — stale since 122.6 shipped the write path;
 * both now describe the build truthfully: apply exists (Assignments tab),
 * the reconcile loop does not (122.9).
 *
 * **0.3.1 → 0.4.0 — step 122.8, named groups end to end.** `service.permissions`
 * is UNCHANGED (group CRUD/activation/deactivation reads/writes only this
 * plugin's own `ctx.storage`, plus the same `device.list` the identity
 * bridge already used) — not a consent bump, but the same mechanical reason
 * 0.2.0→0.3.0 and 0.3.0→0.3.1 already give: `seedEmbeddedPacks` keys on
 * `${pack.name}@${pack.version}`, and five new routes (`groups`/`group-save`/
 * `group-delete`/`group-activate`/`group-deactivate`, `service/groups-routes.ts`)
 * plus a fifth tab would otherwise never reach an already-provisioned farm.
 * Minor, not patch: an operator meets this immediately, on the new Groups
 * tab — the owner's own "otomatis" (122.13's correction: *"bikin grup itu,
 * assign beberapa dan bisa gampang diaktifkan atau didisable otomatis routing
 * rulenya juga mengikuti"*) is this step.
 *
 * **0.4.0 → 0.5.0 — step 122.10, the three member scripts (§4.8).**
 * `verify-egress`, `discover-lan-ip`, `activate-group` — `checkScript` below
 * is replaced by real behaviour reachable from a job for the first time.
 * `service.permissions` is UNCHANGED: `job.run` was already declared (0.1.0's
 * manifest names exactly this — "enqueuing verify-egress"), and none of the
 * three needs a NEW capability (`ctx.device.*` inside a script is the job
 * system's own device access, granted by the job's control marker, not the plugin
 * capability broker `ctx.farm` gates; `activate-group` calls
 * `groups-service.ts`'s `activateGroup` directly with `ctx` as the host,
 * reusing `storage`/`farm`/`log` a script already carries). So this is not a
 * consent bump the way `service.permissions` widening would be — it is the
 * SAME mechanical reason 0.2.0→0.3.0, 0.3.0→0.3.1 and 0.3.1→0.4.0 already
 * give: `packages/core/src/plugins/runtime.ts:344-376` turns each member
 * script into an ordinary `scripts` row ON ACTIVATION, keyed by
 * `<plugin>/<exportId>`, and `seedEmbeddedPacks` skips restaging a version
 * already present in `<dataDir>/seeded-packs.json` — left at `0.4.0`, an
 * already-provisioned farm would never receive these three rows at all, and
 * "rotation is schedulable with existing cron machinery" (this step's own
 * stated result) would silently fail to arrive. Minor, not patch: an
 * operator meets this immediately, in the Scripts list and in the schedule
 * picker — three new jobs exist to run or schedule that did not exist a
 * version ago.
 *
 * **0.5.0 → 0.6.0 — step 122.9, the reconcile loop (§4.7).** `service.
 * permissions` is UNCHANGED — `device.list`/`notify.send` were already
 * declared (0.1.0's manifest names exactly these two reasons: the fleet/
 * address bridge, and "drift and path-down alerts"), and the loop needs
 * nothing new: it reads `ctx.storage`/calls `ctx.farm` exactly like every
 * other handler in this plugin. So this is the SAME mechanical reason every
 * bump since 0.2.0→0.3.0 gives, not a consent bump: `seedEmbeddedPacks` keys
 * on `${pack.name}@${pack.version}`, and a new route (`reconcile`,
 * `service/reconcile-routes.ts`) plus a service that now starts a background
 * timer on setup would otherwise never reach an already-provisioned farm —
 * it would keep running the pre-122.9 bundle, where nothing ever notices
 * drift, forever. Minor, not patch: an operator meets this the moment the
 * loop's first `notify.send` lands, or presses the new "Reconcile now"
 * button.
 *
 * **0.6.0 → 0.7.0 — plan 124 (M89), device identity and search in this
 * plugin's own UI.** `service.permissions` is UNCHANGED; nothing here asks
 * for a new capability. The same mechanical reason as every bump above, and
 * this one was very nearly missed: plan 124 §0.2 named this pack's "Add a
 * device…" dropdown the worst device selector in the product — a bare
 * `Select` over `{d.label}`, no number, no search, on a farm of twenty
 * identically-named phones — and step 124.7 replaced it with a searchable
 * `Combobox` reading `#7 SM-F721U1`, put `number` on `FleetDeviceRow` (both
 * halves of the pack), and added a filter to the assignments table.
 *
 * All of that is UI, and UI is exactly what `seedEmbeddedPacks` gates: it
 * keys on `${pack.name}@${pack.version}` and skips a key it has already
 * seeded, so left at 0.6.0 every farm running `v0.1.22` — which is the
 * owner's — would keep serving the OLD `index.js` bundle for ever. The fix
 * would sit in the repository, fully tested, and never once reach a browser.
 * That is not hypothetical: the owner reported the dropdown unchanged after
 * the work landed, and this bump is the answer.
 *
 * Minor, not patch: an operator meets it the moment they open the group
 * editor and can type `7` to find a phone.
 *
 * **0.12.0 → 0.13.0 — what "Up" actually means (plan 134, M99).**
 *
 * Plan 133 explained two of the three offline devices from the farm session.
 * The third was worse than unexplained — it was reported **healthy**. Device
 * #20's modem answered every ping and had **no data plan at all**, because
 * `check-gateway=ping` answers "does the modem reply to ICMP", and every
 * operator reads it as "traffic down this path reaches the internet".
 *
 * One boolean becomes three independent facts, each named after the question
 * it actually answers:
 *
 *   `link`    — can the router reach this path's gateway at all?
 *   `gateway` — does the modem answer?  (today's signal, correctly labelled)
 *   `egress`  — does traffic through this table REACH the internet?
 *
 * `up` is byte-identical to before, so the planner, plan 132's `overDownPath`
 * and every other consumer read exactly what they read yesterday.
 *
 * `egress` is `unknown` until an operator presses **Probe** on the Paths tab —
 * `POST /rest/ping` with `interface=` (chosen because this farm's RouterOS
 * 7.24 rejects `routing-table=` on `/ping`), three packets, out of one uplink.
 * It is never scheduled: every packet is metered LTE data on somebody's SIM.
 * A router that cannot run the probe reports **`unknown`, never `fail`** —
 * failing to measure and measuring a failure are different facts, and only one
 * of them is about the modem.
 *
 * Two new faults that were silent before, both free:
 *
 *   - **Two uplinks holding the same address** — the plan 133 fault itself,
 *     now read straight off `/ip/dhcp-client` and named on the row, pointing
 *     at the modem left on its factory-default LAN range. That GET is
 *     best-effort: a router that will not serve it loses the warning, never
 *     the screen.
 *   - **Two paths egressing from one public IP** — plan 132 §0's ban risk,
 *     grouped from each device's own `verify-egress` reading. Only verified
 *     devices count; unverified ones are never grouped with each other.
 *
 * Minor, not patch: a new column, a new button, and two new warnings.
 *
 * **0.13.1 → 0.13.2 — groups rename, MVP 15 §0.1 (plan 207).** One
 * doc-comment rework (`src/index.ts` here, two lines) that cited "cluster"
 * — the core-side rename that plan 207 carried all the way to the DB
 * table and the `/api/groups` route — as "group" instead. No behavior
 * change. Patch: invisible to an operator.
 *
 * **0.13.0 → 0.13.1 — plan 205 vocabulary sweep.** Three doc-comment
 * reworks (`src/index.ts` here, `src/verify-egress.ts`,
 * `src/ui/parts/settings.tsx`) that cited terms plan 205 retired core-side —
 * a device job's control marker (the deleted per-device manual-hold
 * concept), and a deleted device-list schema from the deleted screen-share
 * feature — no behavior change. Patch: invisible to an operator.
 *
 * **0.11.0 → 0.12.0 — a down path says why (plan 133, M98).**
 *
 * From a live session on the owner's farm: three devices had no internet for
 * three unrelated reasons, and Studio reported the same red chip for all of
 * them. Telling them apart took a router CLI session.
 *
 *   #20 — modem alive, no data plan. Reported **Up**, because
 *         `check-gateway=ping` only proves the modem answers.
 *   #5, #7 — two Orbits left on the factory-default `192.168.8.0/24`, so both
 *         DHCP clients pulled `192.168.8.100` and the router held NO address
 *         in `192.168.125.0/24` / `192.168.127.0/24`. The route printed
 *         `immediate-gw=""` and sat inactive.
 *
 * The router had known the difference all along: `immediate-gw` already
 * arrived on every inventory call through `IpRouteSchema`'s `.passthrough()`
 * and nothing read it. `PathHealth` now carries a `reason` —
 * `no-route-to-gateway` (the router cannot reach the modem AT ALL: a VLAN or
 * DHCP fault on the port, not a modem fault), `gateway-unreachable` (the modem
 * is off or silent), `no-default-route` (the table is empty) — and the Paths
 * tab renders a sentence naming the thing to go and look at.
 *
 * `up` is unchanged, so the planner, plan 132's `overDownPath` and every other
 * consumer read exactly what they read before. An unrecognised reason from a
 * newer core falls back to the plain "Down" wording rather than blanking the
 * cell.
 *
 * **What this does NOT fix**, and it is the bigger half: `check-gateway=ping`
 * still cannot tell "the modem has internet" from "the modem answers ping" —
 * #20 was green with no upstream at all. The plugin already ships
 * `verify-egress`, which tests the real thing; making it the health signal is
 * its own plan (§9 Q1 there).
 *
 * Minor, not patch: an operator meets a new sentence on the Paths tab.
 *
 * **0.10.0 → 0.11.0 — an assignment is a constraint, not a preference
 * (plan 132, M97). This REVERSES plan 122 §4.5.**
 *
 * A device assigned to a path now gets that path written even when the path
 * is DOWN. The old rule skipped it, and the owner's instruction was blunt:
 * *"sekalinya device ditentukan keluar lewat mana internetnya itu wajib
 * dipatuhi … makanya ga boleh diskip wajib dipaksa"*.
 *
 * §4.5 optimised for the wrong failure. It treated a device with no internet
 * as the worst outcome. On this farm the worst outcome is a device with the
 * WRONG internet: one that keeps its previous path is sharing an IP it must
 * not be on, and that is what gets accounts banned. Of the three possible
 * outcomes — skip, apply, delete the old rule — `skip` was the only one that
 * leaked, because it left the old rule standing.
 *
 * Safe to do only because of a property that was already right:
 * `MANAGED_RULE_ACTION = 'lookup-only-in-table'` (`service/router-driver.ts`).
 * A rule pointing at a dead table DROPS the traffic. Had it been plain
 * `lookup`, forcing would have produced exactly the leak this change
 * prevents, and the reversal would have been wrong.
 *
 * `SkipReason` loses `'path-down'` entirely rather than keeping it as dead
 * vocabulary. `path-missing` and `duplicate` are untouched and still refuse:
 * a routing table that does not exist cannot be written to, and §4.3 refuses
 * a duplicate rather than guessing which of two rules to keep. Neither is
 * availability caution.
 *
 * The warning survives the refusal's removal and moves ABOVE the plan list,
 * in both the Assignments apply dialog and the group activation preview —
 * previously it sat below a scrolling list, so an operator could apply a
 * 22-row plan and leave believing the fleet had moved. Plan 131's
 * "apply anyway" button is gone: there is nothing left to force, and leaving
 * the affordance would imply some safer default still existed.
 *
 * Minor, not patch: the outcome of an apply changes.
 *
 * **0.9.0 → 0.10.0 — field report, 2026-08-26: five complaints from one
 * afternoon of real use.** Four additive, one a correction.
 *
 * **Bulk, by number.** `buildPairings` pairs an inclusive device-NUMBER range
 * positionally against the path list from a start index, and both the
 * Assignments tab and the group editor build on it. Every anomaly is a row in
 * the preview, never a dropped one: a number nobody has, a device already
 * assigned, running out of paths. The preview is mandatory and it IS the
 * feature — §4.4's "plan, then apply — never write blind" aimed at the
 * database rather than the router. `overflow` defaults to `stop`, because
 * `wrap` silently puts a later device on a path an earlier one already holds.
 *
 * **Selection.** Per-row checkboxes, select-all scoped to the FILTERED rows,
 * and a bulk bar whose count matches that scope — `docs/design.md`'s "a
 * filter must not lie about its scope". Selection clears when the filter
 * changes, because a selection whose scope you can no longer see is a trap.
 *
 * **The table stops throwing away your scroll position.** `if (loading)
 * return <LoadingRows />` unmounted every row on every write, so the browser
 * had no anchor to restore and the viewport snapped to the top. The skeleton
 * is now for the FIRST load only. Reported as "saya udah di item ke 30 …
 * pas assign device itu tabel ke refresh dan page saya balik ke scroll paling
 * atas", and the owner's own guess at the cause — a forced re-render — was
 * exactly right.
 *
 * **Applying over a down path is now a decision instead of a dead end.**
 * Plan 122 §4.5 says such a rule is "never applied **silently**" — the word
 * is silently. `skip` stays the default and the warning stays, and beside it
 * is one explicit, never-primary action naming how many rows it will write
 * and which paths are down. The forcing happens in the PLANNER, so a forced
 * row is previewed as the real `create`/`update` it will be, flagged
 * `forcedOverDownPath`; forcing in the executor would have left the plan
 * saying `skip` while the write happened anyway, which is the same silent
 * surprise from the other side. `path-missing` and `duplicate` remain
 * unforceable: a table that does not exist cannot be written to, and §4.3 is
 * explicit that two matching rules means refuse, never guess.
 *
 * Minor, not patch: an operator meets every one of these the moment they open
 * the tab.
 *
 * **0.7.0 → 0.8.0 — field report, 2026-08-26: "kok masih dropdown?"** The
 * owner opened this group editor on a live 20-device farm and asked why it
 * was still a dropdown when the product has a device selector. Fair: 0.7.0
 * fixed the SEARCHING and left the SHAPE alone. It was still one device per
 * trip — open, search, pick, Add — so putting twelve phones in a group meant
 * twelve of those cycles.
 *
 * The reason it stayed that shape is worth recording, because it was never a
 * choice anyone made here: `DevicePicker`'s own rule is "every place that
 * chooses a device uses this component, not a bare `Select`", and a plugin
 * UI may only import `@enkaku/ui`, while `DevicePicker` lived in
 * `packages/studio`. The rule was literally unfollowable from inside a
 * plugin. So the component moved into `@enkaku/ui` (with Studio's status
 * badge, holder badges and unavailable-reason text injected through render
 * props, so Studio loses nothing), and this editor now uses the same picker
 * every other surface does: search, tag chips, group grouping, and
 * multi-select — tick several phones, add them in one motion.
 *
 * `FleetDeviceRow` carries no status, tags or group. The picker's input is
 * structural with those optional, so the parts it was not given simply do
 * not render — rather than this pack inventing `status: 'idle'` to satisfy a
 * type, which would have put a badge on screen that nobody had checked.
 *
 * `service.permissions` is UNCHANGED. Minor, not patch, for the same reason
 * the row above gives: an operator meets this the moment they open the group
 * editor. And the same seeding gate applies — `seedEmbeddedPacks` keys on
 * `${pack.name}@${pack.version}`, so without this bump the owner's farm
 * would go on serving the 0.7.0 bundle and the dropdown would still be
 * there, which is exactly the complaint that opened this row.
 *
 * `config.autoRepair` was SAVED but UNREAD before this step (a gap the
 * Settings tab's own Preferences copy used to admit honestly rather than
 * imply otherwise). This step is what wires it: `reconcile.ts`'s
 * `computeReconcileTick` reads it fresh every tick and, when true, repairs
 * `missing-rule`/`wrong-path` drift ONLY — never `duplicate`/
 * `unexpected-managed-rule`/`stale-owner`/`path-missing`, all of which stay
 * human decisions (§4.2, §4.3) — and only while §3.2's local-exception check
 * is `ok`, the same precondition every other write in this plugin already
 * refuses without. `ui/parts/settings.tsx`'s Preferences card copy is
 * updated in the same change to say so, rather than left claiming nothing
 * reads it.
 *
 * **0.8.0 → 0.9.0 — plan 129 §5 step 129.7, the wall picker.** The owner's
 * own words opening plan 129 §0.4: *"saya minta device selector nya pas add
 * device ada popup untuk device list kaya walls gitu, jadi user bisa pilih
 * mau add device sambil lihat screen castnya"* — 0.8.0's list-style
 * `DevicePicker` was strictly better than the dropdown it replaced and still
 * not the ask: a wall of LIVE tiles, chosen by looking at the screen. That
 * needed a component no plugin could previously reach — one that owns a
 * WebSocket video stream — so plan 129 §3.4/§4.4 added `@enkaku/host`, a
 * second host-module table alongside `@enkaku/ui`'s, through which Studio
 * hands a plugin its OWN live components rather than a published package.
 * `ui/parts/groups.tsx`'s group editor now opens `DeviceWallWithPicker`
 * (Studio's `Wall`/`WallTile`, plan 129 §3.5) instead of the list picker;
 * `addEntry` is unchanged in shape — it still takes several ids in one call
 * and builds one entry per device with its resolved LAN address and the
 * fleet's first path — only the source of those ids changed.
 *
 * `service.permissions` is UNCHANGED. Minor, not patch, for the same
 * mechanical reason every UI-only bump above gives: `seedEmbeddedPacks`
 * (`packages/core/src/plugins/seed-embedded.ts`) keys on
 * `${pack.name}@${pack.version}` and skips a key it has already seeded, so
 * left at 0.8.0 the owner's farm would go on serving the list-picker bundle
 * and this row would never reach a browser — exactly what plan 124 §0.2 and
 * the 0.7.0/0.8.0 rows above already record happening twice.
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
  version: '0.13.2',
  title: 'MikroTik routing',
  description:
    'Assigns a farm device its own internet egress path by writing policy routing rules on a MikroTik router. Assign devices individually from the Assignments tab, or as a named group from the Groups tab — activate or deactivate a whole group at once, with the router\'s rules following automatically, and every write refused (§3.2) while every device is not provably still reachable over adb.',
  scripts: [checkScript, verifyEgressScript, discoverLanIpScript, activateGroupScript],

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
      // Named groups end to end (step 122.8): CRUD, the §4.6 activation
      // transaction, and deactivation — see `service/groups-routes.ts`'s own
      // header for the five routes and their permission split.
      registerGroupRoutes(ctx)

      // The reconcile loop (step 122.9, §4.7) — a self-rescheduling
      // `setTimeout` per §0.2's precedent (`service/reconcile.ts`'s own
      // header has the full reasoning for the shape, the overlap guard, and
      // what "newly-detected" means for `notify.send`). `ctx` satisfies
      // `ReconcileHost` structurally (its `storage`/`farm`/`log` are exactly
      // what the loop needs), so it is handed straight through — no
      // adapter. `ctx.onStop` is the ONLY place `loop.stop()` is called: the
      // loop itself never decides to stop.
      const reconcileLoop = createReconcileLoop(ctx)
      registerReconcileRoutes(ctx, reconcileLoop)
      reconcileLoop.start()
      ctx.onStop(() => reconcileLoop.stop())
    },
  }),

  surface: {
    nav: [{ id: 'routing', label: 'MikroTik routing', icon: 'server', view: 'routing' }],
    views: {
      routing: {
        title: 'MikroTik routing',
        description:
          'Paths, the router connection, every rule on the router (managed vs. foreign), the Assignments tab where a reviewed plan can be applied (§4.4), and a reconcile loop that reports drift — missing/wrong-path rules, orphans, duplicates, stale owners — without silently healing it unless auto-repair is on.',
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
