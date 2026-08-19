# Plan 88 — M53 : Getting Devices Connected, and Keeping Them Connected

> Status: partial, close to done — re-verified 2026-08-12 against the code (file existence, targeted `bun test`, `grep`), not assumed from stale checkboxes within each step section below (several were left unticked despite the work landing; this line is the accurate one). **Implemented and test-green:** 88.1 (connection as a first-class concept), 88.2 (the address book and the reconnect ladder, now including the sweep branch 88.3 added), 88.3 (the bounded sweep — H5 confirmed), 88.4 (per-device disconnect/reconnect — H2 confirmed), 88.5 (the guided OTG cutover wizard — `registry/cutover.ts`, the two `POST`/`DELETE /:id/connection/cutover` routes, `CutoverDialog.tsx`; also closes 88.4's own "declared medium never read back" gap and a deeper sibling defect it exposed — `discovery.networks` was never threaded into ANY production device-list call site at all, confirmed and fixed in the same pass, see 88.5's own checklist entry), 88.6 (badge component, client-side connection filter, `FarmNetworksEditor` — **its own "Scan network button" bullet was NOT actually built here, despite this line previously claiming it was; see 88.12**), 88.7 (the adb-health rolling window and its five symptoms, a read-only doctor check), 88.8 (`adb-server-control.ts`'s `cycle()`, the Restart adb server button, the farm-wide banner), 88.9 (the rule change and its workspace-wide guard test), 88.10 (documentation, `bun run spec:check` at GAP 0), and 88.11 (cutover discoverability and bulk cutover — see this line's own paragraph below). **Pending real hardware, owner to run (both write to the phone's TCP-listener state, which the operating agent's hardware rule forbade — see 88.5's own checklist entry for exact commands):** H1 (does `tcpip:<port>` work as a device service with no CLI spawn) and H3 (does `persist.adb.tcp.port` need root) — the code lands correctly either way (H1 has an automatic fallback, H3 is measured and reported, never promised), so this gates only the two hypotheses' labels, not shipping.
>
> **Three hypotheses are still pending the owner's real hardware — H1, H3, H6 — and this line says so plainly rather than reading "implemented" over an untested claim** (the exact drift plans 84, 85 and 87 each shipped with once). H6 (88.1): the reproduction is written up with exact commands but not run — needs a phone put into `adb-tcp` mode, which the operating agent's hardware rule forbade; the shipped fix (`AdbTcpTransport.disconnect()` as a no-op) is covered by fakes only. H1 and H3 (88.5's own first checklist item, unchecked): whether `tcpip:<port>` works as a device service over `openRaw`, and whether `persist.adb.tcp.port` survives a reboot without root — both still need a real phone, and 88.5's worker owns running that spike.
>
> **Two additional gaps, discovered while writing 88.10 and not this step's job to fix, are worth carrying forward precisely because they touch acceptance criteria 2 and 14:** (1) `deriveConnection`'s farm-network-inferred `medium` and the endpoint store's declared `medium` are both real, unit-tested code that **no production call site threads real data into** — `daemon.ts`, `capability/context.ts`, `api/topology.ts`, and `device-registry.ts`'s own default export all call `listDevicesWithTags`/`rowToDeviceInfo` with no network list, so every device Studio renders reads `mediumSource: 'unknown'` and the badge is USB-or-TCP only; OTG/WI-FI is unreachable outside a test today. This was already flagged in writing under 88.4's own "Known gap" note; this line confirms it is still open. (2) `GET /api/devices?connection=` (named in 88.6's own checklist and acceptance criterion 15) does not exist — `devices.ts` reads no `connection` query param anywhere; only Studio's client-side filter works. Both are documented honestly in `docs/guide/enrollment.md`, `docs/guide/install.md`, `docs/spec.md` §7.5, and `packages/core/README.md` rather than papered over — see 88.10's own checklist entries for exactly where.
> **Residual wiring gap, found and fixed 2026-08-13 (`docs/plans/96-m61-hotfixes.md` §96.5).** 88.5's own claim above ("confirmed and fixed in the same pass") was accurate for the four call sites its own checklist entry named (`daemon.ts:1455`, `capability/context.ts:340,353`, `api/topology.ts:54`, `api/devices.ts:577`) but incomplete: three more call sites computing the exact `DeviceInfo`/`device.added` payload an operator watches were still passing an empty network list or nothing — `POST /discovered/:stableId/admit` (`api/devices.ts:388,393`, both the broadcast and the response body), `DeviceRegistry`'s own "new device registered" broadcast plus its `listDevices()` (`registry/device-registry.ts` — `DeviceRegistryDeps` had no `networks` accessor at all), and the cluster detail device list (`api/clusters.ts:181` — `createClusterRoutes` had neither `networks` nor `declaredMedia`). The user-visible symptom this produced: a device admitted from the Discovered tray badged `TCP` on the very screen an operator was watching, then silently flipped to `OTG`/`WI-FI` on the next refetch. All three are fixed and proven through their real HTTP routes / broadcast payloads (`api/devices.test.ts`, `api/clusters.test.ts`, `registry/device-registry.test.ts`) — see §96.5 for the full account, including one finding that narrows this plan's own original claim further: `device-registry.ts`'s "new device registered" broadcast branch is unreachable under the current admission gate (`classify()` only returns `'admitted'` when a `devices` row already exists, and the code's own second lookup is the identical query with no `await` between them), so that specific site was dead code even before this fix, not a live source of the symptom above.
> **88.11 added and fixed, 2026-08-19** — the cutover wizard's own Studio surface had no honest entry point (a USB device's "Reconnect" row silently opened it instead of reconnecting) and no bulk capability, both flagged by the owner comparing this farm to Panda/some3c's own Devices-page menu. `ActionsList.tsx`'s Reconnect row now only ever reconnects; a new, USB-only "Move to the network (Wi-Fi/OTG)…" row opens the wizard (the fixed 12-row list grows to 13 on a USB device only — deliberate, stated, and mirrors the same file's own Wake/Sleep precedent for a conditional row). `BulkCutoverDialog.tsx` (new) is the multi-target sibling — `TargetPicker`-driven, a `Promise.all` fan-out over the existing per-device route (there is no batch cutover endpoint), client-side USB/offline eligibility skipping via `SkippedGroups`, one shared port (confirmed device-local, not farm-wide), and an "armed, not the whole journey" report. Reached from a new "Move to network…" entry in the Devices page's own fleet `⋮` menu, pre-filled from the current selection or every eligible USB device. "Farm networks" discoverability under Settings is fixed with a cross-link from the "Network" tab to "Discovery & monitoring" rather than a structural schema move. See 88.11 for the full account and its own file list; the two live UX defects (the mislabeled Reconnect row, the misplaced Farm networks section) are also logged in `docs/plans/96-m61-hotfixes.md`.
> **88.12 added and fixed, 2026-08-19** — `POST /api/devices/scan` (the bounded subnet sweep of §3.5/§4.5) had **no Studio call site at all**, confirmed by an exhaustive grep across `packages/studio/src` before this step, despite this route's own doc comment in `packages/core/src/api/devices.ts` (~line 508) and 88.6's own checklist bullet both stating or implying a "Scan network" button already existed. Both were false — corrected here, and in `docs/plans/96-m61-hotfixes.md`. Built in both places 88.6's checklist and the owner's own Panda comparison pointed to, sharing one hook rather than two: `packages/studio/src/lib/network-scan.ts` (`useNetworkScan`, `summariseSweepReport`, `scanDisabledReason`). `FarmNetworksEditor.tsx` (Settings → Discovery & monitoring) gained a "Scan network" button beside the address-budget readout, disabled with the exact empty-state reason ("No networks configured — the sweep cannot run") when nothing is configured, or its own distinct reason when networks exist but none have "Include in a sweep" on; a successful scan renders the real `SweepReport` counts inline (`Swept <cidrs> · N scanned · N answered · ...`), never a generic "done". The Devices page's fleet `⋮` menu gained a matching "Scan network" item beside "Move to network…", disabled the same way, refetching the fleet and the Discovered tray on success (the same belt-and-suspenders refetch `renumberFleet`/`DiscoveredTray`'s own Rescan already do alongside the WS-driven `device.added`/`device.discovered` update the sweep's admission path already emits — no new WS plumbing needed). `E_SCAN_BUSY`/`E_SCAN_UNAVAILABLE`/`E_NOT_SUPPORTED` are surfaced by letting the server's own message through `useAction`'s existing failure toast — the same "no policy re-implemented, no invented wording" pattern `DiscoveredTray.tsx`'s "Rescan" button already established for `POST /rescan`'s identical optionality. See `packages/studio/src/lib/network-scan.test.ts`, `packages/studio/src/components/settings/FarmNetworksEditor.test.tsx`, and `packages/studio/src/app/page.test.tsx` for coverage of the disabled-with-reason precondition, the real-counts render, and the two distinct refusal codes.

> Depends on: Plan 56 (admission — anything a network scan finds goes through the Discovered tray, never around it), Plan 85 (the `DeviceReconciler`, the bounded `host-adb` helper, the autoscaled stream lane). Neither needs to change first; this plan extends both. Plan 29 is a **draft** and is superseded in part by §5 88.4 — see §3.8.
> Spec references: §7.1 (transport engines), §7.5 (stable identity, admission, discovery reconciliation), §7.7 (tool management API and UI), §10.4 (adb serialisation and the `kill-server` prohibition — **this plan amends it**), §12 (data model), §13 (core⇄Studio protocol), §15.1 (the enrollment flow), §16 (NFR targets)
> Ships: packages/core/src/registry/endpoints.ts

---

## 0. Evidence

Written from the code, not from the feature request. Every claim below is
either **CONFIRMED** (a file and a line says so) or **HYPOTHESIS** (a
mechanism that fits, has not been observed directly, and which §5 therefore
tests before acting on). Two of the hypotheses gate implementation steps
outright: 88.5 opens with a throwaway spike and stops there if it fails.

The external research this was written against is `compete-3-gapmap.md`
(a per-item audit of Enkaku against Panda/Some3C, verified against the shipped
code) and `compete-4-topology.md` (phone-farm physical topology, traced to
Some3C's own manual and Google's adb-over-Ethernet documentation). The single
load-bearing conclusion from the latter, re-verified against this repo in
F3/F4 below: **"OTG mode" is not a transport. It is `adb tcpip` + `adb
connect` carried over a wired LAN, plus a hardware role-switch on the chassis
that no software can press.**

### 0.1 Confirmed findings

#### The data model has no notion of how a device is connected

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | `DeviceInfoSchema` — the shape every list row, wall tile and device card renders — carries **no transport, no connection type and no address**. It has id, stableId, serial, label, android/api/screen/density, status, lastSeen, battery, quarantineReason, tags, cluster, lastCrashAt, readiness, heldBy. Nothing else. | `packages/protocol/src/device.ts:34-86` |
| **F2** | A `transport` field exists on exactly one payload — the single-device detail fetch — and reaches Studio as one row of plain text in an engine table (`{ key: 'transport', label: 'transport', reg: 'transports' }`), resolved to an engine display name by `engineName`. It is never a badge, never on the wall, never on a card. | `packages/protocol/src/api/devices.ts:18-25`; `packages/studio/src/components/device/DeviceHeader.tsx:79-84`, `:89-92` |
| **F3** | The `adb-tcp` engine's `displayName` is `'ADB (Wireless / TCP)'` — served verbatim to Studio through `GET /api/registry` and rendered as-is by F2's table. It asserts that every TCP-connected device is wireless, which is **false** for a wired OTG chassis. That file's own header comment already establishes the rule this breaks: a `displayName` "must never assert a number nobody has measured as fact", and the same reasoning applies to a medium nobody has observed. | `packages/drivers/src/descriptors.ts:35-42`, header comment `:9-26` |
| **F4** | Nothing anywhere in `packages/*/src` reads a device's IP address. No `ip addr`, no `ip route`, no `ifconfig`, no `wlan0`/`eth0`. The identity probe issues seven commands — `ro.serialno`, `android_id`, `ro.product.model`, `ro.build.version.release`, `ro.build.version.sdk`, `wm size`, `wm density` — and no network state at all. | repo-wide search; `packages/session/src/probe.ts:57-85` |
| **F5** | The devices page filters by status, free text, tag (AND semantics), cluster and readiness. There is no connection dimension. | `packages/studio/src/app/page.tsx:28-35` (the filter types), `:208-227` (the `filtered` memo) |
| **F6** | `parseDevicesLongBlock` splits each `host:devices-l` line on whitespace and keeps **serial and state only**, discarding `usb:`, `product:`, `model:`, `device:` and `transport_id:` — including the `usb:` field that is adb's own signal that a transport is USB rather than TCP. `TrackedDevice` has exactly two fields. | `packages/adb/src/client.ts:127-137`; `packages/adb/src/tracker.ts:6-9` |
| **F7** | Studio reloads the whole device list on `device.status` (and on `device.added`/`device.removed`), so any field added to `DeviceInfo` propagates live on any connect/disconnect with **no new WS message needed**. | `packages/studio/src/app/page.tsx:133-139` |

#### adb has no memory of a TCP device's address, and neither do we

| # | Finding | Evidence |
|---|---------|----------|
| **F8** | The device row's only address is `serial`, documented in the schema as "the current adb transport address — it can change (USB ↔ ip:port)". There is **no column and no table anywhere** holding an expected, last-known or declared network address. | `packages/core/src/db/schema.ts:14-17`; repo-wide search for an endpoints/address table |
| **F9** | The `DeviceReconciler` re-derives adb's own truth (`host:devices-l`) and diffs it against the registry. It adopts what adb has, drops what adb lost, nudges `offline` transports, and retries failed probes. It **never dials an address adb has forgotten** — every path in `runOnce` starts from `adbList`. | `packages/core/src/registry/reconcile.ts:69-171`; `packages/adb/src/client.ts:654-660` |
| **F10** | Consequence: a USB device self-announces to adb via hotplug, so F9 is sufficient for USB. A TCP device does not — plain `adb tcpip`/`adb connect` has no mDNS and no adb-side auto-reconnect (compete-4 §3, §4). A wired phone that reboots onto a new DHCP lease is therefore **unreachable by any code path in this repository**. | F8 + F9 + compete-4 §3 |
| **F11** | `connectDevice`/`disconnectDevice` exist as one-line host-service calls. `disconnectDevice` has exactly one caller in the workspace: `AdbTcpTransport.disconnect()`. `connectDevice` has two: `AdbTcpTransport.connect()` and the wireless pairing flow. **Neither is an operator action.** | `packages/adb/src/client.ts:680-696`; `packages/drivers/src/transport/adb-transport.ts:66-73`; `packages/core/src/enroll/pairing.ts:70` |
| **F12** | **`DeviceSession.close()` calls `transport.disconnect()`.** For a device whose transport engine is `adb-tcp`, closing a session therefore issues `host:disconnect:<host:port>` and drops the entire adb transport — not just the session. Nobody chose this as a product behaviour; it falls out of `Transport` having one `disconnect` that means two different things at two different layers. | `packages/session/src/session.ts:379`; `packages/drivers/src/transport/adb-transport.ts:71-73` |
| **F13** | Reconnect is farm-wide only: `POST /api/devices/rescan` runs one reconcile pass, and inside it a single **un-targeted** `host:reconnect-offline` (one call re-opens every offline transport, as the code's own comment states). There is no per-device connect, disconnect or reconnect route in the device API at all. | `packages/core/src/api/devices.ts:311`; `packages/core/src/registry/reconcile.ts:136-155` |
| **F14** | A device the registry has never successfully probed is **not** auto-enrolled: `classify()` routes an unknown `stableId` to the Discovered tray and a blocked one to nothing at all. Any address a network scan finds must go through this same gate. | `packages/core/src/registry/device-registry.ts:309-347` |
| **F15** | `blocked_devices` and `discovered_devices` are keyed on `stableId`, deliberately, so they survive a port change, a switch to `adb-tcp`, and a forget/re-enroll cycle. That is the precedent for keying an address table on `stableId` rather than `devices.id`. | `packages/core/src/db/schema.ts:105-118`; spec §7.5 |
| **F16** | `AdbClient.openRaw(serial, service)` opens `host:transport:<serial>` then any device service and hands back the socket, bypassing the per-device queue and the stream lane. This is the mechanism a `tcpip:<port>` call would use — no adb CLI spawn required. | `packages/adb/src/client.ts:632-645` |

#### Restart adb: the rule, the machinery, and a drain that was never wired

| # | Finding | Evidence |
|---|---------|----------|
| **F17** | `adb kill-server` has exactly **one implementation call site**, commented as such, reachable only from the Toolchain Manager's version swap. Every other occurrence in `packages/*/src` is a comment restating the rule or a test name. | `packages/core/src/tools/adb-swap.ts:19-21`, `:45-48`; workspace grep |
| **F18** | The swap flow already drains correctly for what it drains: pause the queue → `waitQueueIdle(30s)` → refuse with `E_TOOL_IN_USE` if it does not settle → stop the tracker → kill → commit → start → restart tracker → resume, with a rollback to the old binary if the new `start-server` fails. This is the machinery to reuse. | `packages/core/src/tools/adb-swap.ts:31-77` |
| **F19** | **But `drainSessions` is never supplied.** `daemon.ts` constructs the coordinator with `getClient`, `stopTracker`, `startTracker` and `log`, and a comment reading "drainSessions: a no-op in M1 — filled in by Plan 04 (draining live leases and sessions)". Plan 04 shipped long ago; the hook was never wired. Today's adb version swap kills the server with live sessions, leases and jobs still attached. | `packages/core/src/daemon.ts:278-288`; the optional dep at `packages/core/src/tools/adb-swap.ts:11-12` |
| **F20** | The only **mechanical** guard for the `kill-server` rule is scoped to the doctor package: a test reads 19 named files and asserts the literal string is absent from each. There is no workspace-wide guard. Plan 01 §398 declared one ("Grep-guard: pastikan string `kill-server` tidak ada di `packages/`") and its checkbox is still unticked; §494 even specified the right implementation ("assert tidak mengandung `kill-server` (di luar komentar)"). | `packages/core/src/doctor/render.test.ts:123-156`; `docs/plans/01-m0-foundation.md:398`, `:494` |
| **F21** | The doctor's adb check reports reachability and version only, and its header states the rule as an absolute: "a diagnostic that resets someone else's adb server is not a diagnostic". It cannot distinguish "no server" from "a server that accepts the socket and never replies". | `packages/core/src/doctor/checks/adb-server.ts:3-10`, `:14-25` |
| **F22** | `AdbClient.ensureServer()` already spawns `start-server` (3 attempts, 500ms×n backoff) whenever the socket is refused. So a farm that has **no** adb server self-heals on the next command. Restarting is only ever needed for a server that *is* running and *is* wrong — which is precisely the case nothing today can detect. | `packages/adb/src/client.ts:314-335` |
| **F23** | adb metrics are cumulative-since-boot per serial, never windowed: `record()` increments `counts[outcome]` forever and samples latency only for `ok`. There is no rate anywhere, so "adb has *started* timing out" is not a question the core can answer. | `packages/core/src/device/adb-metrics.ts:20-25`, `:58-67` |
| **F24** | `DeviceHealth` already consumes the same `onMetric` feed and counts consecutive failures **per device**, auto-quarantining at a threshold, with `busy` deliberately excluded ("that is load, not the device"). It is a per-device signal by design and has no farm-wide counterpart. | `packages/core/src/device/health.ts:23-35` |
| **F25** | The Tools page already hosts exactly the surfaces this feature belongs beside: per-tool health with a Check action, version activation, downloads with live `tool.install.progress`, a repair action, and a Diagnostics panel rendering `enkaku doctor`'s JSON verbatim — with `tool.manage` gating every action and a shared `ADMIN_ONLY` tooltip for non-admins. | `packages/studio/src/app/tools/page.tsx:19`, `:21-33`, `:80-82`, `:104-120`; `packages/core/src/tools/routes.ts:50-108` |

#### Studio surfaces

| # | Finding | Evidence |
|---|---------|----------|
| **F26** | `TileChips` is the shared chip row for the Wall and topology, with a fixed canonical order and an explicit rule that a missing value renders a dash **in place** rather than collapsing the row. A connection chip must join that order, not be bolted on beside it. | `packages/studio/src/components/TileChips.tsx:6-13`, `:19-27` |
| **F27** | The device card shows the raw adb `serial` as unlabelled small text under the label — which for a TCP device happens to look like `10.20.0.37:5555` and for a USB device like `ZY223KLMNO`. It is not a badge and carries no meaning to anyone who does not already know adb. | `packages/studio/src/components/DeviceCard.tsx:102` |
| **F28** | The generic settings `SchemaForm` renders an array as a list of **plain text inputs** (`String(item ?? '')`), with a JSON `Textarea` as the last-resort fallback for anything else. An array of objects would render as `[object Object]` in a text box. Any list-of-records setting this plan adds needs a bespoke editor — which the Settings page already mixes with `SchemaForm` (`KvPanel`, the connector table). | `packages/studio/src/components/schema-form/SchemaForm.tsx:233-258`, `:273-290`; `packages/studio/src/app/settings/page.tsx:7-11` |
| **F29** | The Discovered tray's **Rescan** button is the established precedent for an operator-triggered discovery pass, rendering a one-line report ("Scanned 5 devices · adopted 1 · nothing else changed"). New discovery actions should read the same way. | `packages/studio/src/components/DiscoveredTray.tsx:16-31`, `:82-92` |
| **F30** | `scripts/check-plan-status.sh`'s `FAIL_ON_UNDECLARED_SHIPS` is `true` since 2026-08-12. A plan with no `Ships:` line fails CI outright. | `scripts/check-plan-status.sh:80` and its header comment |

### 0.2 Hypotheses (test before acting)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | **PENDING — owner to run (2026-08-12); code lands either way.** `tcpip:<port>` works as a **device service** over `openRaw` (F16) — `host:transport:<serial>` then `tcpip:5555` — returning a plain-text acknowledgement, so enabling TCP mode needs no adb CLI spawn. | This is how adb's own client implements `adb tcpip`; the repo already speaks every other device service this way. | `AdbClient.tcpip()` (§5 step 88.5) implements exactly this framing and is proven against a fake adb-protocol server (`client.test.ts`); `cutover.ts`'s `enableTcp()` falls back to `hostAdb.run(['-s', serial, 'tcpip', String(port)])` — already bounded, drained and deadline-enforced by plan 85's helper — on any throw, so the real answer only decides which branch runs silently in production. The hardware rule forbade running this against `ZP2222RMBS` (it writes to the phone's TCP-listener state); the exact commands are in step 88.5's own checklist entry, unrun. |
| **H2** | **CONFIRMED, split (2026-08-12).** A **per-serial** reconnect exists as an adb host service (`adb -s <serial> reconnect`, wire form `host-serial:<serial>:reconnect`), distinct from the un-targeted `host:reconnect-offline` this repo already uses (F13) — but it only KICKS a transport adb already has an entry for; it cannot dial an address adb has fully forgotten, so it does not replace the ladder. | Plan 29 §106 assumed it (`POST /api/devices/:id/reconnect` → `adb reconnect <serial>`), but plan 29 is a draft and was never executed, so the assumption was never checked. | **Tested read-only, no device touched (§5 step 88.4):** `strings -a` against the bundled adb binary (`.dev-data/tools/adb/36.0.0/platform-tools/adb`) — a local-file read, not a live command — shows the usage string `adb reconnect [device\|offline]`, the three distinct behaviours' own help text ("kick connection from host side to force reconnect" for the bare form), and the `host-serial:%s:%s` prefix format the wire form uses. Per-device Reconnect (§4.6, §5 step 88.4) uses `DeviceReconnector` (disconnect+connect for TCP, `host:reconnect-offline` for USB) exactly as this hypothesis' own fallback said it would — the per-serial `reconnect` service is left as a candidate for `adb-health.ts`'s `reconnect-ineffective` remedy (§3.9), not adopted here, so as not to add a second reconnect path for a case the ladder already covers. Neither is `kill-server`. |
| **H3** | **PENDING — owner to run (2026-08-12); code lands either way.** `service.adb.tcp.port` does not survive a reboot; `persist.adb.tcp.port` does, but setting it needs root on a stock device. | compete-4 §3, traced to adbd's documented property-read order; Some3C's own flow re-issues "Enable port 5555" per session rather than relying on persistence. Also consistent with this repo's own `persist.*` ACL evidence (`packages/session/src/farm-tag.ts`'s doc comment on Android's `property_contexts` allowlist — `persist.sys.timezone`/`persist.sys.locale` are individually whitelisted exceptions, not a prefix wildcard `persist.adb.tcp.port` would fall under) and `docs/guide/enrollment.md`'s existing prose. | `cutover.ts` (§5 step 88.5) **attempts** the `setprop`, tolerates any failure (never refuses to arm over it), and reads `persist.adb.tcp.port` back regardless. The wizard reports which of the two outcomes actually happened (`persistSurvivesReboot: true`/`false`, "this phone will need re-arming after a reboot" vs nothing) rather than promising either. The hardware rule forbade the actual write+reboot cycle against `ZP2222RMBS`; the exact commands are in step 88.5's own checklist entry, unrun. |
| **H4** | The competitor's "scan all networks" button exists to paper over F10 — adb forgetting an address — not to discover phones nobody enrolled. | compete-4 §3, §5: a "scan the whole range" UI step would not exist if the address were reliably stable, and the flow's own preceding step is `adb tcpip` on a device that was already authorised over USB. | 88.2 lands the **remembered-address ladder first** and §7.3 measures how often it alone is enough. If it recovers ≥90% of TCP reconnects at the 10- and 20-device rungs, the sweep (88.3) stays on-demand permanently instead of ever becoming a background loop. If it recovers materially less, §9 Q2 takes over. |
| **H5** | **CONFIRMED, split (2026-08-12).** `adb connect` against a dead address leaves no residue in `host:devices-l` either way — but it is only CHEAP when the address actively refuses the connection (~11 ms); against a silent/unroutable one, the LOCAL adb server's own outbound attempt can block for tens of seconds to well over a minute before it gives up. | Widely believed; never verified here. If residue accumulated, a 254-address sweep would leave 253 junk `offline` transports, which would then trip the reconciler's own offline-recovery path (F9) — a self-inflicted storm. | 88.3 opened with a 10-line spike against TEST-NET-1 (`192.0.2.0/24`) and a closed `127.0.0.1` port, never the owner's LAN — see step 88.3's own checklist entry for the exact readings. No residue in either case, so **no `host:disconnect` cleanup pass was added**; the design's mandatory cheap TCP pre-probe (§3.5) already keeps a real `host:connect` from ever reaching a dead address, which is what the timing half of this result says is the load-bearing part. |
| **H6** | Because of F12, a device on the `adb-tcp` transport engine **cannot be re-opened from Studio after its session closes**: `close()` drops the transport, the tracker reports `remove`, the registry marks it offline, and every session-opening path refuses an offline device. | F12 is confirmed; the refusal half is not — `stream.start`'s exact readiness gate was not traced end to end. | 88.1's first task is the reproduction: set a device's transport to `adb-tcp`, open a session from Studio, close it, read `adb devices`, then try to re-open. If H6 holds, 88.1's `Transport.disconnect` change is a **defect repair**, not a refactor, and is called that in the commit. If it does not hold, the change still lands — a session must not own the farm's transport either way — but as an architecture fix rather than a bug fix. |

### 0.3 What the feature request maps to

```
"OTG networks / enable OTG ports / scan all networks"      → F8, F9, F10 (no address memory) + H4
"the badge says USB / WIFI / OTG, and the IP"              → F1, F2, F3, F27
"filter by connection type"                                → F5
"disconnect / reconnect one device"                        → F11, F12, F13, H2, H6
"restart adb"                                              → F17, F18, F19, F20, F21, F22, F23, F25
"is adb stuck?"                                            → F21, F22, F23, F24  ← the more valuable half
```

---

## 1. Goals

- **A device's connection is a fact the product carries**, not something an
  operator infers from the shape of a serial string. Kind (USB / TCP) is
  observed; medium (wired / wireless) is declared or inferred from a
  configured subnet, and is never asserted as observed. Both reach every
  surface that renders a device.
- **Enkaku remembers how to reach a network device**, per `stableId`, across
  a disconnect, a reboot, a DHCP lease change, a core restart and an adb
  server restart. A TCP phone that comes back at a new address is found and
  recognised as the same phone.
- **Finding it does not hammer the network.** The default path is one TCP
  connect to one remembered address. A subnet sweep is bounded, concurrent,
  singleton farm-wide, and runs only when an operator presses the button or a
  cutover window is armed — never on a background timer, unconditionally
  (§9 Q1, decided 2026-08-12).
- **A network scan can never enlarge the farm behind an operator's back.**
  Everything a sweep finds goes through the Plan 56 admission gate.
- **The USB→OTG cutover is a guided sequence with a human in it**, because a
  human has to press the chassis button. Arm → "flip it now" → watch → report,
  with the failure case naming exactly what was tried.
- **A session never owns the farm's transport.** Closing a wall tile stops
  streaming; it does not disconnect a phone from adb.
- **Disconnect and Remove are impossible to confuse**, because each names its
  own consequence in the menu item, not just in a verb.
- **"adb is stuck" becomes a measurement**, with a named symptom and evidence,
  reported by the Doctor — which stays a pure diagnostic and never acts.
- **Restart adb server ships**, on the Tools page, as one implementation with
  two audited entry points, with the cost stated before the click, a real
  drain (including the sessions the swap flow never drained), and every
  remembered network address dialled again afterwards.
- **The repo rule becomes enforceable rather than aspirational**: one file may
  run the command, and a workspace-wide test says so.

## 2. Non-goals

- **Not a third transport engine.** `adb-tcp` already serves a wired OTG
  device correctly (compete-4 §2, F3): same `adb connect host:port`, different
  cable. Adding `adb-otg` would fork the driver layer over a physical medium
  the software cannot see.
- **Not chassis port control.** compete-4 §1 establishes that the USB↔OTG
  role flip is a per-port hardware switch on vendor chassis (a physical
  double-click, or a vendor serial-port controller board). Driving one
  vendor's board means a hardware integration with no spec, no test rig in
  this repo, and a support surface Enkaku cannot honour. The wizard treats
  the flip as a human action and **says so in the UI**.
- **Not mDNS / Android 11+ Wireless Debugging discovery.** compete-4 §4:
  that is a different adb feature (TLS pairing, `_adb-tls-pairing._tcp`,
  a per-session random connect port) from the `adb tcpip` path an OTG chassis
  uses. The repo already has a manual pairing flow
  (`packages/core/src/enroll/pairing.ts:27-78`). Folding both into one
  discovery surface would produce two incompatible halves under one button.
  Its own plan, later.
- **Not automatic adb restart.** Detection is automatic; the action is always
  a human's. A watchdog that restarts the adb server is exactly what the
  prohibition existed to prevent, and weakening the rule further than the
  owner asked for would be the wrong trade.
- **Not a per-device USB disconnect.** adb has no host service that drops one
  USB transport. A button that silently does nothing — or quietly does
  `reconnect`, which is a different thing — is worse than an honest refusal.
  §4.6 refuses it by name.
- **Not `Accessible` mode** (compete-4 §6). It is an on-device
  AccessibilityService agent, i.e. a new `input`/`inspector` engine of the
  guest-agent kind, not a transport — and it needs a per-device manual
  permission tap (two on Android 13+). Unrelated to this plan.
- **Not a change to the admission flow itself** (Plan 56). Discovery gets new
  inputs; whether a discovered device joins the farm stays a human decision.
- **Not multi-device input mirroring** (compete-3 item 11). It runs into the
  per-device exclusive lease model and needs its own design.

## 3. Context and design decisions

### 3.1 Connection type is two facts, not one

The request asks for a badge reading USB / WIFI / OTG and a filter to match.
The obvious implementation — one three-value enum on the device — is wrong,
and the reason is worth writing down because the repo has already made this
exact mistake once.

`otg` is **not observable**. adb sees `10.20.0.37:5555` and cannot tell a
switch port from a radio; Google's own documentation says Ethernet and Wi-Fi
"are not distinct from TCP/IP generally but rather implementations of it using
different physical transmission methods" (compete-4 §2). Storing `otg` as
though it were observed would be storing a claim as a fact — which is exactly
what `'ADB (Wireless / TCP)'` already does (F3), asserting *wireless* about
every TCP device, and exactly what the ui-server descriptor's `<200 ms` claim
did before plan 87 softened it (the header comment at
`packages/drivers/src/descriptors.ts:9-26` is the standing repo rule on this).

The two facts also change at different times for different reasons. Kind flips
the instant a cable is pulled. Medium changes when somebody re-cables a
chassis — perhaps never. Fusing them means re-deriving, on every single
reconnect, a fact that cannot be derived — which in practice means silently
downgrading `otg` to `wifi` every time a phone comes back.

**Decision.** Two fields, one badge:

```
kind    : 'usb' | 'tcp'                observed, from adb
medium  : 'wired' | 'wireless' | null  declared by an operator, or inferred
                                       from a configured farm network
```

The badge is a pure function of the pair:

| kind | medium | badge | tooltip |
|------|--------|-------|---------|
| `usb` | — | **USB** | Connected by cable to this computer |
| `tcp` | `wired` | **OTG** | On the network over a wired connection · 10.20.0.37 |
| `tcp` | `wireless` | **WI-FI** | On the network over Wi-Fi · 192.168.1.51 |
| `tcp` | `null` | **TCP** | On the network · 192.168.1.51 — Enkaku does not know whether this is wired or Wi-Fi |

The last row matters. "TCP" with an explanation is honest; guessing "WI-FI"
is the bug F3 already shipped.

This split is not novel here — it is the third instance of a pattern the
codebase already uses twice. Readiness is `desired` vs `actual`
(`packages/protocol/src/readiness.ts`). A network route is declared vs
observed, and `deriveHealth` reports `unverified` rather than `ok` when
nothing has probed it (spec §7.9). Same shape, same reason.

`medium` is set from exactly two sources, in this order:

1. **Declared** — the operator says so, in the cutover wizard (§3.4) or the
   device settings. `mediumSource: 'declared'`.
2. **Inferred** — the connect address falls inside a configured farm network
   (§3.6). `mediumSource: 'network'`. This is what makes a 20-port chassis on
   `10.20.0.0/24` label itself without twenty declarations.

Neither is ever overwritten by the other silently: a declaration wins, and the
badge's tooltip says which source it came from when asked.

### 3.2 An address book, keyed on identity

F10 is the architectural gap and everything in §3.3–§3.6 hangs off it. USB is
self-announcing to adb; TCP is not; the reconciler only re-reads adb's own
list (F9). So a wired phone that reboots onto a new lease is gone.

**Decision.** A `device_endpoints` table keyed on `stableId` — matching
`blocked_devices` and `discovered_devices` (F15), so an address survives a
serial change, a forget/re-admit cycle, and a move between transports, exactly
as spec §7.5 requires of everything device-scoped.

```
device_endpoints(stable_id, address)          -- address is `host:port`, the exact string adb uses as a serial
  medium                 'wired' | 'wireless' | null
  source                 'observed' | 'declared' | 'scanned'
  first_seen             unix seconds
  last_connected_at      unix seconds | null
  last_attempt_at        unix seconds | null
  consecutive_failures   integer
  conflict_stable_id     text | null    -- this address answered as a DIFFERENT phone
  PRIMARY KEY (stable_id, address)
```

Recording is free and automatic: whenever `onOnline(serial)` succeeds and the
serial is `host:port`-shaped, upsert `(stableId, serial)` with
`source: 'observed'`, `last_connected_at = now`, `consecutive_failures = 0`.
No new probe, no new adb call — it happens on a code path that already ran.

Bounded by construction: at most `discovery.endpointsPerDevice` (default 4)
rows per `stableId`, evicting the oldest `last_connected_at`. A phone that has
walked through four DHCP leases does not need the fifth-oldest, and an
unbounded table is a slow leak on a farm that runs for months.

### 3.3 The reconnect ladder — cheapest first, and it usually stops at step one

**Decision.** `reconnectDevice(stableId, opts)` runs a fixed ladder:

1. **Already connected?** adb lists it as `device` → report `already-connected`
   and stop. Zero work is the common case after a Rescan.
2. **Remembered addresses**, ordered `last_connected_at DESC`,
   `consecutive_failures ASC`, skipping any at or past
   `discovery.endpointRetireAfter` (default 10) unless `force`. For each:
   a **cheap TCP pre-probe** (`Bun.connect`, `discovery.scan.probeTimeoutMs`,
   default 300 ms) and only if that accepts, `host:connect:<address>`.
3. **Settle and verify.** Wait up to `discovery.connectSettleMs` (default
   3000) for the serial to appear as `device`, then run the ordinary
   `registry.onOnline(serial)` — the same probe every other path uses.
   - stableId matches → done. Endpoint updated, failure count zeroed.
   - stableId **differs** → `host:disconnect` immediately, write
     `conflict_stable_id`, continue down the ladder. The other phone is *not*
     adopted here; it will reach the Discovered tray through the reconciler's
     ordinary pass (F14), which is the only place admission is decided.
   - probe fails → `consecutive_failures++`, continue.
4. **Sweep** (§3.5), only if permitted: an explicit operator request, or an
   armed cutover window. There is no third trigger — §9 Q1 (decided
   2026-08-12) cut the automatic path before it shipped.
5. Exhausted → report `not-found` with the full trace: addresses tried,
   which answered the pre-probe, which answered as a different phone, whether
   a sweep ran and over what.

This is the whole answer to "what happens when DHCP moves a device": step 2
fails, step 4 finds it, step 3 verifies the identity, a new endpoint row is
inserted, and because it is now the newest `last_connected_at` the next
reconnect starts there. Self-tuning, no operator action, no configuration.

The pre-probe in step 2 is not decoration. `host:connect` performs a full adb
handshake with its own timeout; against a dead address that is seconds, not
milliseconds. A 300 ms TCP dial answers the same question for one packet.

### 3.4 The cutover needs a human, so the flow admits it

compete-4 §2 traces Panda's LAN-mode flow end to end: enable port 5555 while
the phone is still on USB, **physically flip the chassis port from USB to
OTG** (a double-click on the chassis button; the status light goes blue →
green), then scan the LAN and connect. Step 2 has no API. There is no honest
way to present this as a toggle.

There is also a hard ordering constraint that shapes the whole flow: **the
phone's Ethernet interface does not exist until the port is flipped.** In USB
mode the OTG dongle is not attached, so no amount of `ip addr` while on USB
(which F4 says we do not do anyway) yields the address the phone will have
afterwards. The cutover genuinely cannot know the destination address in
advance. That is why a scan — or a declared address — is structurally
required here and not merely convenient.

**Decision.** A four-screen wizard with an explicit **armed** state on the
server, broadcast over `/ws` so a second browser tab sees the same thing:

```
idle → enabling-tcp → armed → connecting → done
                 ↘ failed        ↘ failed
```

1. **Check.** Preconditions rendered as a checklist, each pass/fail:
   device is on USB and in state `device`; admitted (not in the tray); no job
   running; a farm network configured *or* an address typed by hand. Plus the
   port (default 5555) and the medium choice (Wired / Wi-Fi), which is what
   sets `mediumSource: 'declared'`.
2. **Enable.** Issue `tcpip:<port>` (H1), then **verify by read-back**:
   `getprop service.adb.tcp.port` must equal the port. Attempt
   `persist.adb.tcp.port` and read that back too (H3), reporting which
   persistence the phone actually gave. **If the read-back fails, the wizard
   refuses to arm** — after the flip there is no adb path back to the phone
   until the port is flipped again, so arming on an unverified `tcpip` is how
   an operator ends up at the chassis with a phone that was never listening.
3. **Arm and flip.** The screen collapses to one instruction and one live
   indicator: *"Flip port N on the chassis from USB to OTG now. Enkaku is
   watching for the phone to come back."* The USB serial vanishing is
   **expected**, not an error — while armed, that device's offline transition
   is annotated `reason: 'cutover'` and Studio renders "waiting for it on the
   network", never "Offline". Every `discovery.cutover.armPollSec` (default 5)
   the ladder runs, for up to `armWindowSec` (default 180), showing its own
   work: *"swept 10.20.0.0/24 · 21 answered · none matched yet"*.
4. **Done** — "Connected at 10.20.0.37:5555 over OTG", endpoint recorded,
   badge changed — or **Failed**, naming what was tried and the three likely
   causes in order: the port did not flip, the chassis port has no DHCP lease
   yet, the configured network is wrong.

Cancel is available at every step and reverts nothing: TCP mode stays on, and
a phone in TCP mode still works perfectly over USB. Which is also why
**"return to USB" is not a flow** — flip the chassis port back and USB hotplug
re-announces the phone by itself. The wizard says that in one sentence rather
than inventing a step for software that has nothing to do.

### 3.5 The sweep, and why it is not a background loop

Twenty to a hundred devices is the stated scale. A naive design — every device
that goes missing triggers a subnet scan — is O(devices × subnet) and turns
one flaky phone into a packet storm. An unsolicited full-subnet TCP sweep on a
timer is also, on a shared office LAN, hostile: it trips IDS, it lands in
somebody's firewall log, and it buys nothing for a farm whose phones are all
at remembered addresses.

**Decision.** The sweep is bounded on five axes, and off by default:

- **Singleton.** One sweep at a time, farm-wide, behind a mutex. Twenty
  missing devices produce **one** sweep, not twenty; the sweep's result is
  matched against every missing device at once.
- **Explicit address space.** `discovery.networks[].cidr`, empty by default.
  The host's own subnets are deliberately **not** auto-derived — a laptop on a
  corporate `/16` would otherwise sweep 65,536 addresses because someone
  pressed a button. Empty means the sweep is unavailable and says so, with a
  link to the setting.
- **Hard ceiling.** Total addresses across all scanned networks ≤
  `discovery.scan.maxAddresses` (default 1024, i.e. four `/24`s). Enforced at
  the Zod boundary, so an over-large config fails at save time with a named
  message, not at 2 a.m. during a scan.
- **Bounded concurrency, cheap probe.** `discovery.scan.concurrency` (default
  32) TCP dials of `probeTimeoutMs` (default 300) each. Only hosts that accept
  get an `adb connect`. Addresses adb already lists in any state are skipped
  outright.
- **Cadence.** `scan.mode` is `'on-demand'` by default — a sweep runs only
  when an operator asks (the Rescan / scan-all-networks button, F29) or a
  cutover window is armed. `'off'` disables it entirely. **There is no
  `'auto'` mode** (§9 Q1, decided 2026-08-12): the owner's answer was that
  this feature is manually triggered, full stop, so no background cadence —
  and therefore no cooldown to gate one — exists to configure.

The cost model, written down so it can be checked at §7.3:

| Situation | Work |
|---|---|
| 20 devices, all at remembered addresses | 20 pre-probes + 20 connects, ≈1 s, **no sweep** |
| 1 device missing, operator presses Reconnect | 1 pre-probe (300 ms), then on failure 1 sweep of a `/24`: 254 pre-probes at 32-way ≈ 2.4 s, plus one connect+probe for the single new answerer |
| 20 devices missing (the farm switch rebooted) | 20 pre-probes, then **one** sweep, matched against all 20 |

Ordering is a free optimisation: probe the last-known final octet first (a
device usually comes back near where it was), then ascending.

### 3.6 Farm networks: one list, one concept

§3.1 needs a source for `medium`; §3.5 needs an address space. Two separate
settings lists (`wiredSubnets` and `scanSubnets`) would be two things to keep
in sync for one underlying fact.

**Decision.** One list of records:

```ts
discovery.networks: Array<{
  cidr: string          // '10.20.0.0/24'
  label: string         // 'Chassis A' — shown in the sweep report and the badge tooltip
  medium: 'wired' | 'wireless'
  scan: boolean         // include in a sweep
}>
```

An address inside a network takes that network's `medium` (as
`mediumSource: 'network'`) and its label. `scan: false` lets an operator label
a Wi-Fi range without ever sweeping it.

F28 says the generic `SchemaForm` cannot render this — arrays are rendered as
lists of text inputs, and an array of objects would print `[object Object]`.
So a bespoke `FarmNetworksEditor` is a **required deliverable** of 88.6, not a
polish item. The Settings page already mixes bespoke panels with `SchemaForm`
(`KvPanel`, the connector table), so this is the established pattern, not an
exception to it. Each row validates its CIDR live and shows the address count
it contributes against the `maxAddresses` ceiling — a number an operator
otherwise has to compute in their head.

### 3.7 A session must not own the farm's transport

F12: `DeviceSession.close()` calls `transport.disconnect()`, which for
`adb-tcp` issues `host:disconnect`. Closing a wall tile therefore disconnects
a wireless phone from adb entirely. H6 says it may not even be recoverable
from Studio afterwards.

This is one interface meaning two things at two layers. `Transport.connect`/
`disconnect` describe a *session's* use of a transport; `host:connect`/
`host:disconnect` change the *farm's* topology. They are not the same
operation and must not share a method.

**Decision.**
- `AdbTcpTransport.connect()` becomes **ensure-connected**: a no-op when adb
  already lists the serial as `device`; otherwise it delegates to the ladder
  (§3.3) so a session start on a momentarily-dropped device still works, and
  works *better* than today (it can find a moved address).
- `AdbTcpTransport.disconnect()` becomes a **no-op**, with a comment naming
  this plan and the reason. Transport lifetime belongs to the registry and to
  the operator's explicit action (§4.6), which after this change is the only
  thing in the product that can drop a transport.

This mirrors what plan 52 already did for network routes — a route belongs to
the device and survives lease release — and what plan 42 did for sessions.
Same principle, one layer down.

### 3.8 Disconnect, Reconnect, Forget, Block — four verbs that must not blur

Forget and Block are settled (spec §7.5, plans 47/56) and this plan does not
touch them. What it adds sits next to them and sounds dangerously similar, so
the disambiguation is a design deliverable, not copy-editing.

**Decision.** The consequence goes *in the menu item*, not only in the dialog,
and the items are grouped with a separator so the destructive one is visually
apart:

```
Connection
  Disconnect from the network        Drops the adb link. The phone stays in the farm.
  Reconnect                          Dials its last known address.
  Move to the network (Wi-Fi/OTG)…   Switch this phone from USB to the network.
──────────────────────────────────
  Remove from farm…                  (destructive styling, unchanged)
```

`Disconnect from the network` is enabled only for a `tcp` device. On a `usb`
device it is present but disabled with a tooltip explaining that adb has no
way to release a USB transport and the equivalent is unplugging the cable —
because a control that vanishes teaches nothing, and a control that lies is
worse (F26's chip rule, applied to menus).

The confirm dialog names both halves — what changes and what does not:

> **Disconnect Pixel 7 Pro from the network?**
> Enkaku drops its adb connection. The phone keeps running.
> **Unchanged:** its record, tags, cluster, settings, job history and
> artifacts. This is not Remove.
> **Until you reconnect it:** it shows as Offline, and it cannot be
> controlled or scheduled.
> It reconnects from `10.20.0.37:5555`, its last known address.

Plan 29 §106 proposed `POST /api/devices/:id/reconnect` and never shipped
(it is a draft marked DO NOT EXECUTE). This supersedes that line item; the
rest of plan 29 is untouched.

### 3.9 "adb is stuck" — the half worth more than the button

F21, F22 and F23 together say the product currently cannot tell the operator
anything about adb's condition beyond "something answered on 5037". F22 is the
sharp edge: a farm with *no* adb server already self-heals, because
`ensureServer()` starts one. So "restart adb" is only ever the right answer
for a server that **is** running and **is** wrong — the exact state nothing
can currently detect. Shipping the button without the detection would be
shipping a guess.

**Decision.** `AdbServerHealth`, computed continuously in the core, exposed on
`/api/adb/stats`, rendered on the Tools page, and read by a new **read-only**
doctor check. Five named symptoms, each with a distinct remedy, because
"adb is stuck" is not one condition:

| Symptom | Detected by | Restart helps? |
|---|---|---|
| `server-unreachable` | the socket is refused | **No** — `ensureServer()` already starts one (F22). The remedy says so. |
| `server-unresponsive` | the socket connects, `host:version` does not answer within 2 s, twice in a row | **Yes.** This is the case the button exists for. |
| `transports-wedged` | ≥2 serials adb lists as `device` whose last 3 execs all timed out | **Probably** — one wedged device is a phone; several at once is the server. |
| `reconnect-ineffective` | a serial has had ≥3 `host:reconnect-offline` nudges across ≥3 cooldown windows and is still `offline` | **Maybe** — try the per-device Reconnect (§4.6) first; the remedy says which to try in which order. |
| `timeout-storm` | rolling-window timeout rate ≥ `stuckTimeoutRate` (default 0.5) over ≥20 execs | **Sometimes** — also caused by a saturated USB controller, so the remedy names both. |

The rolling window is the only new plumbing: F23 says today's counters are
cumulative-since-boot, so `adb-metrics.ts` gains a ten-bucket, 60-second-per-
bucket ring fed from the **same** `record()` call. No new hook, no new feed.

**The Doctor stays a pure diagnostic.** `checks/adb-health.ts` reports the
verdict and names the Tools action in its remedy; it never performs it. That
is F21's own rule, kept — and it has a mechanical consequence worth stating:
the guardrail test at `render.test.ts:123-156` needs **one line added to its
file list and no change whatsoever to the assertion it makes**. The detection
half lives where diagnostics live; the action half lives where actions live.

### 3.10 Restart adb: one implementation, two audited entry points

The owner's decision is that this ships. The rule change should be the
smallest one that permits it, and it should come out *stronger* than the rule
it replaces — today's rule is enforced only inside the doctor package (F20),
and plan 01 declared a workspace-wide guard that was never built.

**Decision.** `packages/core/src/tools/adb-server-control.ts` becomes the one
file in the workspace that runs the server-stop command. It exports a single
`cycle()` covering both flows, because they are the same seven steps with one
optional extra:

```
drain → stop server → [swap the binary pointer] → start server → restart tracker
      → resume queue → reattach remembered network addresses → reconcile once
```

`createAdbSwapCoordinator` becomes a thin wrapper calling
`cycle({ reason: 'swap', … , commit })`; the restart route calls
`cycle({ reason: 'restart', oldBinaryPath: p, newBinaryPath: p })`. One
mutex covers both, so a version swap and a restart can never interleave.
F18's rollback (bring the old binary back up if the new `start-server` fails)
is preserved verbatim.

Two steps in that list are new and are the reason this is one plan and not
two:

- **The drain finally includes sessions.** F19: `drainSessions` has been an
  unwired optional dep since M1. It gets wired to
  `sessions.closeAll()` + lease release with a named reason + a bounded wait.
  Without this, both flows kill the adb server underneath live video.
- **Reattach.** After a server stop, adb's transport table is empty — every
  TCP device is gone, and adb will not go looking (F10). Without the address
  book from §3.2, this button would silently destroy exactly the farms that
  most need it: a 20-device OTG chassis would come back as 20 offline rows.
  Step 7 dials every remembered endpoint. **This is why the OTG half and the
  restart half belong in the same plan.**

The cost is stated before the click, with live numbers, and it names the thing
the old rule was protecting:

> **Restart the adb server?**
> This stops and restarts the adb server that this computer shares with every
> other program using adb.
> **Here:** all 20 devices disconnect and reconnect. Live screens stop and
> resume. Control is released on 2 devices. 1 running job fails.
> **Elsewhere:** any other program using adb on this machine loses its
> connection at the same moment — Android Studio's device list and Logcat, a
> terminal running `adb logcat`, Flutter or React Native tooling. Most
> reconnect on their own; a command already running will exit.
> **Network devices** (12 here) are dialled again from their last known
> addresses afterwards. Any whose address has changed need a rescan.
> Usually takes 5–15 seconds.

Counts come from live state, fetched before the dialog renders, so they are
this farm's numbers rather than a generic warning nobody reads.

Guardrails: `tool.manage` (admin-only, F25); refuse with `E_ADB_BUSY_FARM`
listing running jobs and held leases unless `force`; rate-limited to one per
`adbControl.restartCooldownSec` (default 60); audited as a new `adb.restart`
action; progress broadcast per phase so twenty devices dropping at once reads
as one banner rather than twenty offline toasts.

---

## 4. Technical design

### 4.1 Protocol — connection (`packages/protocol/src/device.ts`)

```ts
export const ConnectionKindSchema = z.enum(['usb', 'tcp'])
export const ConnectionMediumSchema = z.enum(['wired', 'wireless'])

/**
 * How a device is reached (plan 88 §3.1). TWO fields, deliberately:
 * `kind` is OBSERVED (adb's serial shape, plus the `usb:` field
 * `host:devices-l` carries), `medium` is DECLARED by an operator or
 * INFERRED from a configured farm network — adb cannot see the difference
 * between a switch port and a radio, and a schema that stores 'otg' as an
 * observed value stores a claim as a fact. Same observed-vs-declared split
 * as readiness (desired/actual) and network routes (declared/observed).
 */
export const DeviceConnectionSchema = z.object({
  kind: ConnectionKindSchema,
  medium: ConnectionMediumSchema.nullable(),
  mediumSource: z.enum(['declared', 'network', 'unknown']),
  /** Host part of a `host:port` serial; null for USB. */
  address: z.string().nullable(),
  port: z.number().int().nullable(),
  /** `discovery.networks[].label` when the address matched one — for the tooltip and the sweep report. */
  networkLabel: z.string().nullable(),
})
export type DeviceConnection = z.infer<typeof DeviceConnectionSchema>

/** USB | WI-FI | OTG | TCP — the ONE place the badge string is computed, so no surface can disagree with another. */
export function connectionBadge(c: DeviceConnection): 'USB' | 'WI-FI' | 'OTG' | 'TCP'
```

`DeviceInfoSchema` gains one field, defaulted so every existing constructor
(tests, orchestrator mode, fallbacks) keeps parsing — the same treatment
`readiness` and `heldBy` already have:

```ts
connection: DeviceConnectionSchema.default(() => ({
  kind: 'usb' as const, medium: null, mediumSource: 'unknown' as const,
  address: null, port: null, networkLabel: null,
})),
```

Derivation lives in one function, `deriveConnection(serial, row, networks)`,
called from `rowToDeviceInfo` — so the list, the wall, the card, the device
page and every WS broadcast get it from one place. No caller computes it.

### 4.2 Settings (`packages/protocol/src/settings.ts`)

`discovery` (existing block, `:753-781`) gains:

```ts
tcpPort: z.number().int().min(1024).max(65535).default(5555)
  .describe('The port a device listens on for adb over the network. 5555 is the default everywhere.')
  .meta({ title: 'adb TCP port' }),
endpointsPerDevice: z.number().int().min(1).max(16).default(4)
  .describe('How many past network addresses to remember per device.')
  .meta({ title: 'Remembered addresses per device' }),
endpointRetireAfter: z.number().int().min(1).max(100).default(10)
  .describe('Stop trying a remembered address after this many failures in a row.')
  .meta({ title: 'Retire an address after' }),
connectSettleMs: z.number().int().min(500).max(30_000).default(3_000)
  .describe('How long to wait for a device to appear after connecting to it.')
  .meta({ title: 'Connect settle time (ms)' }),

networks: z.array(z.object({
  cidr: CidrSchema,                                   // validated, see below
  label: z.string().max(40).default(''),
  medium: ConnectionMediumSchema.default('wired'),
  scan: z.boolean().default(true),
})).max(16).default([])
  .describe('The networks your devices live on. Enkaku labels a device found here, and scans the ones you tick.')
  .meta({ title: 'Farm networks' }),

scan: z.object({
  // CHANGED (§9 Q1, decided 2026-08-12): 'auto' is cut before shipping — the
  // owner's decision is manual trigger only, not "manual trigger, plus an
  // automatic option nobody enabled yet". No cooldown field exists either:
  // it existed solely to gate the automatic cadence this mode no longer has.
  mode: z.enum(['off', 'on-demand']).default('on-demand')
    .describe('When Enkaku may scan a network for devices. On demand = only when you ask, or during a guided move to the network. There is no automatic background scan.')
    .meta({ title: 'Network scanning' }),
  maxAddresses: z.number().int().min(64).max(4096).default(1024)
    .describe('The most addresses one scan may probe, across every scanned network.')
    .meta({ title: 'Max addresses per scan' }),
  concurrency: z.number().int().min(1).max(256).default(32)
    .meta({ title: 'Simultaneous probes' }),
  probeTimeoutMs: z.number().int().min(50).max(5_000).default(300)
    .meta({ title: 'Probe timeout (ms)' }),
}).default({ … }),

cutover: z.object({
  armWindowSec: z.number().int().min(30).max(900).default(180)
    .describe('How long Enkaku watches for a device after you flip its port.')
    .meta({ title: 'Cutover window (s)' }),
  armPollSec: z.number().int().min(1).max(60).default(5).meta({ title: 'Cutover poll interval (s)' }),
}).default({ armWindowSec: 180, armPollSec: 5 }),
```

The `maxAddresses` ceiling is enforced as a **cross-field** refinement on the
whole `discovery` object, not on `networks` alone, because it is the sum over
`networks.filter(n => n.scan)` that matters:

```ts
.superRefine((d, ctx) => {
  const total = d.networks.filter(n => n.scan).reduce((n, x) => n + addressCount(x.cidr), 0)
  if (total > d.scan.maxAddresses) ctx.addIssue({ code: 'custom', path: ['networks'],
    message: `these networks add up to ${total} addresses, over the ${d.scan.maxAddresses} limit — untick one, narrow a range, or raise the limit` })
})
```

New top-level block:

```ts
adbControl: z.object({
  healthIntervalSec: z.number().int().min(5).max(300).default(30)
    .describe('How often Enkaku checks whether the adb server is answering.')
    .meta({ title: 'adb health check interval (s)' }),
  stuckTimeoutRate: z.number().min(0.1).max(1).default(0.5)
    .describe('The share of adb commands that must time out before adb is reported as stuck.')
    .meta({ title: 'Stuck threshold (timeout rate)' }),
  restartCooldownSec: z.number().int().min(10).max(3600).default(60)
    .meta({ title: 'Minimum gap between adb restarts (s)' }),
  drainTimeoutMs: z.number().int().min(5_000).max(300_000).default(30_000)
    .describe('How long a restart waits for in-flight adb work and live sessions to finish before giving up.')
    .meta({ title: 'Drain timeout (ms)' }),
}).default({ … }),
```

No migration is needed anywhere: every field is new and defaulted.

### 4.3 The endpoint store (`packages/core/src/registry/endpoints.ts`, new — **the artefact this plan ships**)

```ts
export interface Endpoint {
  stableId: string
  address: string                 // 'host:port' — exactly the string adb uses as a serial
  medium: ConnectionMedium | null
  source: 'observed' | 'declared' | 'scanned'
  firstSeen: number
  lastConnectedAt: number | null
  lastAttemptAt: number | null
  consecutiveFailures: number
  conflictStableId: string | null
}

export interface EndpointStore {
  /** Called from the registry's success path — free, no extra adb work. */
  observe(stableId: string, serial: string): void
  declare(stableId: string, address: string, medium: ConnectionMedium | null): void
  /** Ordered for the ladder: lastConnectedAt DESC, consecutiveFailures ASC; retired ones last (and only with `includeRetired`). */
  candidates(stableId: string, opts?: { includeRetired?: boolean }): Endpoint[]
  noteAttempt(stableId: string, address: string, outcome: 'connected' | 'failed' | 'conflict', conflictStableId?: string): void
  forget(stableId: string, address?: string): void
  /** Every stableId with at least one remembered address — the restart flow's reattach list. */
  allWithEndpoints(): Array<{ stableId: string; candidates: Endpoint[] }>
}
```

Eviction happens inside `observe`/`declare`: after an upsert, delete all but
the newest `endpointsPerDevice` rows for that `stableId`.

### 4.4 The reconnect ladder (`packages/core/src/registry/reconnect.ts`, new)

```ts
export type ReconnectOutcome =
  | { result: 'already-connected'; serial: string }
  | { result: 'connected'; address: string; viaSweep: boolean }
  | { result: 'not-found'; tried: AttemptTrace[]; sweep: SweepReport | null }
  | { result: 'refused'; reason: 'usb-device' | 'no-endpoints' | 'scan-unavailable'; detail: string }

export interface AttemptTrace {
  address: string
  preProbe: 'accepted' | 'refused' | 'timeout'
  connect?: 'ok' | 'failed'
  probe?: 'match' | 'conflict' | 'failed'
  conflictStableId?: string
  ms: number
}

export interface DeviceReconnector {
  reconnect(stableId: string, opts?: { allowSweep?: boolean; force?: boolean }): Promise<ReconnectOutcome>
  disconnect(stableId: string): Promise<{ result: 'disconnected' | 'not-connected' | 'refused'; detail?: string }>
}
```

`reconnect` takes a per-`stableId` mutex, so an operator clicking twice, an
armed cutover window and the restart flow's reattach cannot triple-dial one
phone.

### 4.5 The sweep (`packages/core/src/registry/sweep.ts`, new)

```ts
export interface SweepReport {
  networks: Array<{ cidr: string; label: string; addresses: number }>
  scanned: number       // addresses actually probed (skips are excluded)
  skipped: number       // already known to adb
  answered: number      // accepted a TCP connection on the port
  connected: number     // host:connect succeeded
  identified: number    // probed to a stableId
  adopted: string[]     // stableIds matched to an existing device
  discovered: string[]  // stableIds new to us → the Discovered tray (plan 56)
  conflicts: Array<{ address: string; expected: string; found: string }>
  durationMs: number
}

export interface Sweeper {
  /** Rejects with E_SCAN_BUSY if one is already running; E_SCAN_UNAVAILABLE when no scannable network is configured. */
  sweep(opts?: { expect?: string[] }): Promise<SweepReport>
  running(): boolean
}
```

`expect` is the set of `stableId`s the caller is hoping to find; it does not
change what is probed, only what the report calls out first.

### 4.6 Endpoints and messages

| Method | Path | Permission | Body / response |
|---|---|---|---|
| `POST` | `/api/devices/:id/connection/disconnect` | `device.settings` | `{ force?: boolean }` → `{ result, detail? }`. Refuses a USB device with `E_TRANSPORT_NOT_DETACHABLE` and a message naming the cable. Refuses a device with a running job unless `force`. |
| `POST` | `/api/devices/:id/connection/reconnect` | `device.settings` | `{ allowSweep?: boolean; force?: boolean }` → `ReconnectOutcome` |
| `POST` | `/api/devices/:id/connection/cutover` | `device.enroll` | `{ port?, medium, address? }` → `CutoverState`. Starts the wizard's steps 2–3 server-side. |
| `DELETE` | `/api/devices/:id/connection/cutover` | `device.enroll` | cancel an armed window |
| `PATCH` | `/api/devices/:id/connection` | `device.settings` | `{ medium: 'wired' \| 'wireless' \| null }` → declared medium, for a device whose cutover happened outside Enkaku |
| `POST` | `/api/devices/scan` | `device.settings` | `{}` → `SweepReport` |
| `POST` | `/api/tools/adb/restart` | `tool.manage` | `{ force?: boolean }` → `AdbRestartReport` |
| `GET` | `/api/adb/stats` | `device.view` | **extended** with an `adbHealth` block |

New server messages (`packages/protocol`):

```ts
| { type: 'device.cutover'; payload: { deviceId: string; stableId: string; state: CutoverState;
      step: 'enabling-tcp' | 'armed' | 'connecting' | 'done' | 'failed';
      detail: string; triedAddresses: number; answered: number; expiresAt: number | null } }
| { type: 'scan.progress'; payload: { scanned: number; total: number; answered: number } }
| { type: 'adb.server.phase'; payload: { phase: AdbServerPhase; reason: 'swap' | 'restart'; detail: string } }
| { type: 'adb.health'; payload: AdbServerHealth }   // on transition only, never on a timer
```

`adb.health` is broadcast only when the verdict *changes*, following the same
"log/emit only when the effective value changes" discipline
`recomputeAdbConcurrency` already uses (`daemon.ts:349-358`).

### 4.7 adb health (`packages/core/src/device/adb-health.ts`, new)

```ts
export type AdbStuckSymptom =
  | 'server-unreachable' | 'server-unresponsive' | 'transports-wedged'
  | 'reconnect-ineffective' | 'timeout-storm'

export interface AdbServerHealth {
  status: 'ok' | 'degraded' | 'stuck'
  versionRttMs: number | null
  lastCheckedAt: number
  window: { seconds: number; execs: number; timeouts: number; timeoutRate: number }
  wedged: Array<{ serial: string; consecutiveTimeouts: number; adbState: string }>
  stuckOffline: Array<{ serial: string; state: string; sinceSec: number; nudges: number }>
  symptoms: Array<{ symptom: AdbStuckSymptom; detail: string; since: number }>
  /** Whether a restart is the recommended action for the current symptom set — the Tools button reads this, and says why when it is false. */
  restartAdvised: boolean
}
```

The probe is a `host:version` with a 2 s deadline every
`adbControl.healthIntervalSec`, on `withSocket` — a host service, so it never
touches the per-device queue or the stream lane.

`adb-metrics.ts` gains a windowed counter fed from the existing `record()`:

```ts
/** Ten 60-second buckets — a 10-minute rolling view. Cumulative counts (plan 23 §4.6) are unchanged and still reported. */
window(seconds: number): { execs: number; timeouts: number; timeoutRate: number }
```

`reconcile.ts` gains a read-only `nudgeCounts(): Map<string, number>` so
`reconnect-ineffective` can be computed from the reconciler's own existing
`lastReconnectAttempt` bookkeeping (`reconcile.ts:65`) rather than a second
counter that could drift.

### 4.8 adb server control (`packages/core/src/tools/adb-server-control.ts`, new)

```ts
export type AdbServerPhase =
  | 'draining' | 'stopping' | 'swapping' | 'starting' | 'reattaching' | 'reconciling' | 'done' | 'failed'

export interface AdbCycleReport {
  reason: 'swap' | 'restart'
  durationMs: number
  sessionsClosed: number
  leasesReleased: number
  jobsFailed: string[]
  devicesBefore: number
  devicesAfter: number
  reattachAttempted: number
  reattachSucceeded: number
  reattachFailed: Array<{ stableId: string; label: string }>
  serverVersion: string | null
}

export interface AdbServerControl {
  /**
   * The ONLY function in this workspace that stops the adb server (plan 88 §3.10,
   * spec §10.4). Two entry points, one implementation, one mutex:
   *   - the Toolchain Manager's adb version swap (`commit` supplied);
   *   - the operator's Restart adb server on the Tools page (`commit` absent).
   */
  cycle(opts: {
    reason: 'swap' | 'restart'
    oldBinaryPath: string | null
    newBinaryPath: string
    commit?: () => Promise<void>
    force?: boolean
  }): Promise<AdbCycleReport>
  busy(): boolean
}
```

`createAdbSwapCoordinator` keeps its name and its `AdbSwapHook` shape and
becomes a five-line wrapper — the Toolchain Manager's contract is untouched.

`daemon.ts` supplies the deps the old coordinator never got (F19):

```ts
drainSessions: async () => {
  const closed = await sessions.closeAll()
  const released = leases.releaseAll({ reason: 'adb-server-restart' })
  return { sessionsClosed: closed, leasesReleased: released }
},
reattachEndpoints: () => reconnector.reattachAll(),
onPhase: (phase, detail) => hub.broadcast({ type: 'adb.server.phase', payload: { phase, reason, detail } }),
```

### 4.9 Studio

- **`ConnectionBadge.tsx`** (new) — renders `connectionBadge(connection)` with
  the tooltip from §3.1's table. Used by `TileChips` (joining the canonical
  order as the first chip, F26), `DeviceCard`, and the device header. The
  header's engine table keeps its `transport` row: the badge says how the
  phone is reached, the engine row says which driver serves it, and those are
  different questions.
- **`DeviceCard`** — the raw serial line (F27) becomes badge + address:
  `[OTG] 10.20.0.37` for a TCP device, `[USB] ZY223KLMNO` for a USB one. Same
  line, same height, now legible without knowing adb.
- **The connection filter** — a `Select` beside the readiness filter:
  Any connection / USB / Wi-Fi / OTG / TCP (unknown). It filters on the
  **badge** value, because that is what the operator sees, and
  `GET /api/devices?connection=` accepts the same values so client-side and
  server-side filtering cannot disagree — the rule `page.tsx:216`'s comment
  already states for tags.
- **`CutoverDialog.tsx`** (new) — the four screens of §3.4, driven by
  `device.cutover` broadcasts.
- **`FarmNetworksEditor.tsx`** (new) — §3.6's list editor, with live CIDR
  validation and a running address count against `maxAddresses`.
- **`AdbServerCard.tsx`** (new) — on the Tools page above Diagnostics: server
  version, reachability, the health verdict with its symptom and evidence,
  adb's device count next to the registry's, and the **Restart adb server**
  button (admin-only via the page's existing `ADMIN_ONLY` tooltip pattern,
  F25). The button's label and tone follow `restartAdvised`: prominent when
  adb is stuck, ordinary-outline when it is not, with a one-line note saying
  restarting looks unnecessary right now.
- **`AdbRestartDialog.tsx`** (new) — §3.10's copy, with counts fetched live
  before render.
- **A farm-wide banner** while `adb.server.phase` is active, so twenty devices
  dropping reads as one event.

---

## 5. Implementation steps

### 88.1 — Connection as a first-class concept (tests H6)

- [ ] **Reproduce H6 first.** Set one device's transport to `adb-tcp`, open a
      session from Studio, close it, read `adb devices`, try to re-open.
      Record the result in this plan. It decides whether the next bullet is a
      defect repair or an architecture fix; it lands either way.

      **Status: pending — owner to run.** This step's hardware rule forbade
      putting the attached phone (`ZP2222RMBS`, moto_g06_power, USB) into TCP
      mode — no `adb tcpip`, no `adb connect`/`disconnect`, no settings
      writes; read-only adb only (`adb devices -l`, `getprop`, `dumpsys`).
      What follows is therefore read from the code, not observed on hardware:

      - **CONFIRMED (F12), by reading the code — no phone needed for this
        half:** before this step's fix, `packages/session/src/session.ts:379`
        called `transport.disconnect()` unconditionally from `close()`, and
        `AdbTcpTransport.disconnect()`
        (`packages/drivers/src/transport/adb-transport.ts`, pre-fix) forwarded
        that straight to `AdbClient.disconnectDevice()` — i.e.
        `host:disconnect:<host:port>`, a farm-wide adb command, not a
        session-scoped one. So closing a wall tile on an `adb-tcp` device
        provably issued `host:disconnect` against that device's own
        transport. This half is a direct read of the call graph, confirmed
        the same way F12 itself was (no execution needed).
      - **NOT CONFIRMED — the half that genuinely needs the phone:** whether,
        after that disconnect, the device was actually unrecoverable from
        Studio without an operator dropping to a shell. `stream.start`'s
        exact readiness gate for an offline device was never traced end to
        end (§0.2 H6's own wording), and no code path in this repository ran
        a background reconnect for a `tcp` device adb had fully dropped
        (F10) — so the mechanism for the SILENCE (no automatic recovery)
        exists on paper, but nobody watched it not happen.

      **Exact commands for the owner to run**, against this plan's tip commit
      *reverted to just before this step's fix* (`git stash` the diff to
      `packages/drivers/src/transport/adb-transport.ts` and
      `packages/session/src/session.ts`, or check out the parent commit) —
      the pre-fix `AdbTcpTransport.disconnect()` is what H6 is about:

      ```bash
      # 0. Core running locally with the phone already enrolled over USB
      #    (bun run dev), so its stableId/tags/history exist beforehand.

      # 1. Put the phone into TCP mode and note its address — this is the
      #    one step that genuinely needs the hardware rule waived, by the
      #    owner, at the owner's own phone (also H1's spike, reused here):
      .dev-data/tools/adb/36.0.0/platform-tools/adb tcpip 5555
      .dev-data/tools/adb/36.0.0/platform-tools/adb connect <phone-ip>:5555

      # 2. In Studio, set this device's transport engine to adb-tcp (Device
      #    → Settings → Drivers → Transport), if the reconciler has not
      #    already flipped `devices.serial` to `<phone-ip>:5555` on its own
      #    (it should, per F9: the tcp serial arrives as a new `add` event,
      #    probes to the same stableId, and the registry adopts it under the
      #    existing enrolment rather than creating a second device row).

      # 3. Open a session on the tile (click it), confirm video/control
      #    works, then close it (navigate away, or close the tile).

      # 4. Read adb's own truth:
      .dev-data/tools/adb/36.0.0/platform-tools/adb devices -l

      # 5. Try to re-open the same tile from Studio.
      ```

      **What each outcome means:**

      | Step 4 (`adb devices -l`) | Step 5 (re-open) | Verdict |
      |---|---|---|
      | `<phone-ip>:5555` is **gone** | fails, or the device sits Offline with no operator action recovering it | **H6 confirmed in full** — the disconnect (already known from the code) and the unrecoverability. Label this step's fix a **defect repair** in the commit/changelog that closes out this plan. |
      | `<phone-ip>:5555` is **gone** | **succeeds anyway** (something already reconnects it) | The disconnect half holds; the unrecoverability half does not. Per §0.2 H6's own text the `Transport.disconnect()` change still ships as written — a session must not own the farm's transport either way — but label it an **architecture fix**, not a bug fix. |
      | `<phone-ip>:5555` is **still there** | — | H6 does not hold as stated. Before concluding the mechanism itself is wrong, check that the device's transport setting genuinely read `adb-tcp` and that the build under test still has the pre-fix `disconnect()` — F12 is a direct code read, not a guess, so a clean repro failure here means the setup, not the finding. |

      **Then, as the acceptance check for this step's actual fix** (un-stash /
      return to the tip commit, where `AdbTcpTransport.disconnect()` is the
      no-op), re-run steps 0–5 once more: step 4 should now show
      `<phone-ip>:5555` **still connected** after close, and step 5 should
      succeed immediately with no reconnect delay. That is exactly the
      behaviour `packages/drivers/src/transport/adb-transport.test.ts` and
      `packages/session/src/session.test.ts` already prove against a fake
      `AdbClient` — this physical run is the one confirmation neither test
      can give on its own.
- [x] `packages/protocol/src/device.ts`: `ConnectionKindSchema`,
      `ConnectionMediumSchema`, `DeviceConnectionSchema`, `connectionBadge()`,
      and `DeviceInfoSchema.connection` (defaulted).
- [x] `packages/adb/src/client.ts:127-137`: `parseDevicesLongBlock` keeps the
      `usb:` / `transport_id:` fields it currently discards (F6);
      `TrackedDevice` gains `usb?: string` and `transportId?: number`.
      `parseSnapshot` (tracker) is untouched — `host:track-devices` does not
      carry them.
- [x] `packages/core/src/registry/device-registry.ts`: `deriveConnection()`,
      called from `rowToDeviceInfo`; `listDevicesWithTags` passes the farm
      networks in once for the whole list (never per row — the N+1 rule at
      `:171-175`).
- [x] `packages/drivers/src/transport/adb-transport.ts:66-73`: `connect()`
      becomes ensure-connected; `disconnect()` becomes a documented no-op
      (§3.7). `packages/session/src/session.ts:379` keeps its call — the
      change is in what it means, and the comment there says so.
- [x] `packages/drivers/src/descriptors.ts:37`: `'ADB (Wireless / TCP)'` →
      `'ADB over the network (TCP)'`. It is served to users verbatim (F3) and
      currently states a falsehood about every wired device.
- **Verifiable result:** `GET /api/devices` returns a `connection` object for
  every device; a USB device reads `kind: 'usb'`, a TCP device reads
  `kind: 'tcp'` with the address split out. Closing a session on an
  `adb-tcp` device leaves it connected in `adb devices`. ✅ implemented and
  covered by fakes (`adb-transport.test.ts`, `session.test.ts`); the physical
  confirmation is the pending H6 reproduction above.

### 88.2 — The address book and the reconnect ladder (fixes F8, F10, F13)

- [ ] `packages/core/src/db/schema.ts`: `device_endpoints` per §3.2, plus a
      Drizzle migration (`bun run --cwd packages/core db:generate`).
- [ ] `packages/core/src/registry/endpoints.ts`: `EndpointStore` per §4.3,
      with eviction inside `observe`/`declare`.
- [ ] `packages/core/src/registry/device-registry.ts:382`: on a successful
      probe, call `endpoints.observe(stableId, serial)` — one line, on a path
      that already ran.
- [ ] `packages/core/src/registry/reconnect.ts`: the ladder per §3.3 and §4.4,
      **without** the sweep branch (88.3 adds it); per-`stableId` mutex.
- [ ] `packages/protocol/src/settings.ts`: the `discovery` additions of §4.2
      except `networks`/`scan` (88.3 adds those).
- **Verifiable result:** disconnect a wireless device with `adb disconnect`,
  then call the ladder — it reconnects from the remembered address with no
  operator input and no scan. A device whose address is stale reports
  `not-found` with an `AttemptTrace` naming what it tried.

### 88.3 — The bounded sweep (tests H4, H5)

- [x] **Spike H5 first** (~10 lines, thrown away): `host:connect` to 20
      non-listening addresses, then `host:devices-l`. If junk transports
      accumulate, add a `host:disconnect` cleanup pass to the sweep and record
      that here.
      **H5 CONFIRMED, no cleanup pass added (2026-08-12).** Run against the
      bundled adb, port 5037, targeting only TEST-NET-1 (`192.0.2.0/24`, RFC
      5737 — reserved so nothing on the owner's LAN was touched) and a closed
      `127.0.0.1` port: (1) a black-hole address (no routing, no RST) made
      `adb connect` block for tens of seconds to well over a minute before
      the LOCAL adb server itself gave up and replied `Operation timed out`;
      (2) a refused (closed-port, actively rejected) address returned in
      ~11 ms. In **both** cases `adb devices -l` showed nothing afterwards,
      and `adb disconnect` on the same address replied `no such device` —
      no junk `offline` transport was left behind either way. So the literal
      question ("does adb accumulate junk transports") is **no**, and no
      `host:disconnect` cleanup pass was added. The *timing* half is the one
      that matters operationally: a raw `host:connect` against a dead
      address is cheap only when something actively refuses it — against a
      silent/unroutable one it is NOT cheap at the adb-server level, which is
      exactly why §3.5's mandatory pre-probe (`Bun.connect`, its own hard
      ~300 ms timeout) sits in front of every `host:connect` this step issues
      and is never bypassed.
- [x] `packages/protocol/src/settings.ts`: `discovery.networks`,
      `discovery.scan`, `CidrSchema`, `addressCount()`, and the cross-field
      `maxAddresses` refinement of §4.2. Unit-test the refinement with one
      `/24` (ok), five `/24`s (rejected with the exact message), and a
      malformed CIDR.
- [x] `packages/core/src/registry/sweep.ts`: §4.5. Singleton mutex, bounded
      concurrency, skip-known, last-octet-first ordering, `scan.progress`
      broadcasts.
- [x] `packages/core/src/registry/reconnect.ts`: the sweep branch (ladder step
      4), gated on `allowSweep` / `scan.mode` only — no cooldown gate, since
      there is no automatic cadence to protect against (§9 Q1).
- [x] Every identified `stableId` unknown to the registry goes through
      `registry.onOnline(serial)` → the Plan 56 admission gate (F14). A test
      asserts a sweep **cannot** enrol a device.
- [x] `packages/core/src/api/devices.ts`: `POST /api/devices/scan`.
- **Verifiable result:** with one `/24` configured, a sweep of a subnet holding
  20 devices completes in under 5 s, probes ≤254 addresses, issues
  `host:connect` only to hosts that answered, and reports counts that add up.
  A `stableId` nobody admitted lands in the Discovered tray, never in
  `devices`.

### 88.4 — Per-device disconnect and reconnect (fixes F11, F13; tests H2)

- [x] **Spike H2**: does a per-serial reconnect host service exist? Record the
      answer here. The fallback (disconnect+connect for TCP,
      `host:reconnect-offline` for USB) is already implemented either way.

      **H2 CONFIRMED, read-only, 2026-08-12.** No device was touched — this
      was `strings -a` against the bundled adb binary
      (`.dev-data/tools/adb/36.0.0/platform-tools/adb`), a local-file read,
      per the hardware rule. The binary embeds `adb reconnect [device|offline]`
      as a usage string, alongside three distinct behaviours: bare
      `reconnect` ("kick connection from host side to force reconnect"),
      `reconnect device` ("kick connection from device side to force
      reconnect"), and `reconnect offline` ("reset offline/unauthorized
      devices to force reconnect" — the literal string `host:reconnect-offline`
      sits right next to it, confirming that is the wire form F13 already
      uses). The binary separately embeds the `host-serial:%s:%s` prefix
      format, the same per-serial wrapper adb uses for `get-state`/`forward`/
      etc. — strong evidence the bare `reconnect` command reaches the wire as
      `host-serial:<serial>:reconnect`, a genuinely different, PER-SERIAL host
      service from the farm-wide `host:reconnect-offline`.

      **Why this doesn't change the implementation.** `host-serial:<serial>:reconnect`
      only operates on a transport adb ALREADY has an entry for (any state,
      including `offline`/`unauthorized`) — it kicks the existing connection
      to re-handshake. It cannot dial an address adb has fully forgotten
      (F10's own problem: a `host:disconnect`ed or timed-out TCP transport
      has no entry left to select). So it is not a substitute for the
      ladder's job (§3.3: dial a remembered address from scratch) — only a
      theoretically cheaper alternative to `host:reconnect-offline` for
      nudging ONE stuck-but-present device without touching the other
      nineteen. Not adopted here: `DeviceReconnector` (88.2/88.8) already
      does the real job for both transports, and adding a second, narrower
      code path for a case the existing one already covers (a device that is
      offline gets picked up by `reconnect()`'s ladder same as any other) is
      exactly the "second reconnect path" this step was told not to write.
      Left as a note for whoever eventually builds `adb-health.ts`'s
      `reconnect-ineffective` remedy (§3.9) — that IS the symptom this
      command was built for.
- [x] `packages/core/src/api/devices.ts`: `POST /:id/connection/disconnect`,
      `POST /:id/connection/reconnect`, `PATCH /:id/connection`, per §4.6,
      each `requirePermission('device.settings')` and audited. Reuses the
      `DeviceReconnector` from 88.2/88.8 verbatim — no second ladder.
- [x] Guards: a USB device's disconnect refuses with
      `E_TRANSPORT_NOT_DETACHABLE`; a device with a running job refuses unless
      `force`, and the error **lists** the jobs; a successful disconnect
      closes the session and releases the manual lease first. Covered by
      `packages/core/src/api/devices.test.ts`'s `POST /:id/connection/disconnect`
      block (USB refusal, job-running refusal + list, force override, the
      session→lease→transport ordering, and the audit/event trail).
- [x] `packages/core/src/events/`: `device.disconnected` / `device.reconnected`
      recorded on the `main` stream via the existing `record()` mechanism
      (`kind` is a free string there — no schema change needed), so the Logs
      tab shows an operator action beside adb's own `device.offline` events.
- [x] `packages/studio/src/components/device/DeviceHeader.tsx`: the Connection
      group of §3.8 (Disconnect, Reconnect), with its own separator above the
      destructive Remove item, and the disabled-with-reason USB case (a
      `Tooltip`-wrapped, `onSelect`-intercepted item — never the native
      `disabled` prop, which would also suppress the hover that explains it).
      "Move to the network (Wi-Fi/OTG)…" is NOT here — that is 88.5's cutover
      wizard, not yet built.
- [x] `packages/studio/src/components/DeviceCard.tsx`: the same items in the
      card's overflow menu, same words (the repo's "a verb keeps its name
      through the whole flow" rule, `DeviceHeader.tsx`'s own comment on its
      Remove item).
- [x] `packages/studio/src/components/DisconnectDeviceDialog.tsx`: §3.8's
      confirm copy near-verbatim (what changes, what doesn't, "This is not
      Remove", the last-known address), plus the running-job refusal's
      message and a `force` checkbox, mirroring `AdbRestartDialog`'s own
      refuse-then-offer-the-override shape.
- **Verifiable result:** an operator disconnects one wireless phone; the other
  nineteen are untouched; the phone shows Offline with its record intact;
  Reconnect brings it back. Disconnect on a USB device is visibly disabled and
  explains why. ✅ implemented and covered by fakes (`devices.test.ts`,
  `lease-manager.test.ts`, `DeviceHeader.test.tsx`, `DeviceCard.test.tsx`,
  `DisconnectDeviceDialog.test.tsx`) — no physical device exercised, per the
  hardware rule.

  **Known gap, not closed by this step — CLOSED by 88.5 (2026-08-12).**
  `PATCH /:id/connection` persists a declared medium into the endpoint store
  (`EndpointStore.declare`, exactly as §3.2/§4.3 specify), but
  `deriveConnection` (`packages/core/src/registry/device-registry.ts`) did
  not yet read a declared medium back — it only derived `kind` from the
  serial shape and `medium` from a network match. The route's own response
  reflected the just-declared value directly so the caller got immediate
  confirmation, but a subsequent `GET /api/devices`/`GET /:id` did not show
  it until 88.5's own acceptance criterion (§6 item 14: "a completed cutover
  produces... `mediumSource: 'declared'`") made it load-bearing. `deriveConnection`
  now takes a third, optional `declaredMedium` argument — `undefined` (no
  declaration for this exact address) falls through to the network match
  exactly as before; a value, including explicit `null` ("declared
  unknown"), always wins, per §3.1's own rule. `loadDeclaredMedia` resolves
  it for a whole list in one query (the endpoint store's own
  `allWithEndpoints()`, already built for the restart flow's reattach list),
  matching the N+1 discipline `loadClusterNames`/`loadRecentCrashes` already
  set. Every `GET` route in `api/devices.ts` (`GET /`, `GET /:id`,
  `infoWithTags`) now threads it through, and `PATCH /:id/connection`'s own
  response is re-derived through the SAME function/branch rather than
  hand-assembled, so it is provably not a special echo.

  **A second, deeper layer of the same defect, found and closed in the same
  pass:** `discovery.networks` itself was never threaded into any
  production `rowToDeviceInfo`/`listDevicesWithTags` call site AT ALL —
  `daemon.ts`, `capability/context.ts` (an agent script's own
  `ctx.listDevices()`/`ctx.getDevice()`) and `api/topology.ts` (the fleet
  map) all called it with no networks argument, so a device on a configured
  wired network could never badge `OTG` anywhere in the product, only ever
  the honest-but-incomplete `TCP`. This predates 88.4 and was outside that
  step's own scope, but left unfixed it would have made 88.6's connection
  filter and networks editor configure a setting nothing read and 88.1's own
  `deriveConnection`/badge machinery untested by anything that mattered. All
  three call sites now pass `discovery.networks` (read fresh from the
  settings store) and the declared-media map through, resolved ONCE per
  request/list, never per row — the existing N+1 rule at
  `device-registry.ts:171-175` extended, not bent. See 88.5's own checklist
  entry for the full file list and the end-to-end tests that prove it
  through the real routes.

### 88.5 — The OTG cutover: arm, flip, watch (tests H1, H3)

- [ ] **Spike H1 and H3 first, together, on a real phone**
      (`ENKAKU_TEST_DEVICE=1`): `openRaw(serial, 'tcpip:5555')`, read the
      reply, read back `service.adb.tcp.port`, attempt and read back
      `persist.adb.tcp.port`. **If H1 fails, the wizard uses
      `hostAdb.run(['-s', serial, 'tcpip', port])` instead** and the rest of
      this step is unchanged. Record both answers in this plan.

      **Status: pending — owner to run.** Both H1 and H3 require WRITING to
      the attached phone's TCP-listener state — `tcpip:<port>` restarts
      adbd's own listener, and `setprop persist.adb.tcp.port` writes a
      property — which the hardware rule forbids on `ZP2222RMBS` (read-only
      adb only, same constraint 88.1's H6 hit). Unlike H2/H5, neither is
      fully answerable from static evidence; what follows is read from the
      code and the repo's own prior evidence, not observed on hardware:

      - **H1 — read-only investigation.** `AdbClient.tcpip(serial, port)`
        (`packages/adb/src/client.ts`, next to `connectDevice`/
        `disconnectDevice`) sends `host:transport:<serial>` then
        `tcpip:<port>` over one raw socket — exactly `openRaw`'s own
        connect → transport → service sequence (F16), the mechanism this
        hypothesis is about. A fake-adb-server test
        (`packages/adb/src/client.test.ts`, the `AdbClient.tcpip` describe
        block) proves the WIRE FRAMING the client sends is correct against a
        scripted adb-protocol server. What that test cannot prove — because
        it is not a real adbd — is whether a real device's adbd actually
        accepts `tcpip:<port>` presented this way, as opposed to needing the
        CLI's own internal path. The implementation does not gate
        correctness on the answer either way: `cutover.ts`'s `enableTcp()`
        tries `client.tcpip()` first and, on ANY throw — the exact shape a
        real adbd's refusal would take — falls back to the already bounded,
        drained, deadline-enforced
        `hostAdb.run(['-s', serial, 'tcpip', String(port)])`, per this
        hypothesis' own documented fallback. Either path is then
        independently verified by reading `getprop service.adb.tcp.port`
        back (§3.4 step 2's own rule) before the wizard ever calls itself
        armed — so H1's real answer only decides WHICH path silently runs
        in production, never whether the feature works.
      - **H3 — read-only investigation.** `docs/guide/enrollment.md`
        already carries a prose answer from prior research: setting the
        persistent property "normally needs root, which most farm phones do
        not have." The repo's own strongest supporting evidence is
        `packages/session/src/farm-tag.ts`'s doc comment on Android's
        `property_contexts`/SELinux ACL model: `persist.*` is not a
        shell-writable prefix — only a short, AOSP-maintained allowlist of
        individual names is (`persist.sys.timezone`/`persist.sys.locale`,
        both already used by this repo at
        `packages/core/src/api/device-identity.ts` and confirmed working
        from `adb shell` with no root on Android 15, per
        `docs/plans/58-m28-device-identity-spoofing.md`).
        `persist.adb.tcp.port` is not on that allowlist, so the SAME
        mechanism that lets `persist.sys.timezone` through predicts
        `persist.adb.tcp.port` will not, on a stock (non-rooted) phone —
        consistent with H3, not a hardware confirmation of it. This is why
        `cutover.ts` treats the `setprop` attempt as **tolerated, never
        fatal**: it wraps the call in try/catch, reads
        `persist.adb.tcp.port` back regardless of whether `setprop` itself
        reported success, and arms with `persistSurvivesReboot: false` on
        any mismatch rather than refusing to arm — the wizard MEASURES and
        REPORTS, exactly as §3.4 step 2 and the "`persist.adb.tcp.port`
        cannot be set" risk row (§8) require, without ever promising a
        persistence nobody has verified on this repo's own target hardware.

      **Exact commands for the owner to run**, against a phone already
      enrolled over USB — note steps 1 and 3 below WRITE to whichever phone
      runs them; do not run this against a phone in active manual use:

      ```bash
      # 0. Core running locally with the phone enrolled over USB (bun run dev).

      # 1. H1 — the device-service path (no CLI spawn):
      ENKAKU_TEST_DEVICE=1 bun -e '
        import { AdbClient } from "@enkaku/adb"
        const client = new AdbClient({ adbPath: ".dev-data/tools/adb/36.0.0/platform-tools/adb" })
        await client.tcpip("<serial>", 5555)
        console.log("tcpip: accepted, no throw")
      '
      # A throw here answers H1 "no" — enableTcp()'s existing fallback is
      # what production silently uses instead; no code change needed either way.

      # 2. Read back what actually happened (read-only — getprop never writes):
      .dev-data/tools/adb/36.0.0/platform-tools/adb -s <serial> shell getprop service.adb.tcp.port
      # Expect 5555 if step 1 (or its hostAdb.run fallback) took effect.

      # 3. H3 — the actual write this repo cannot perform:
      .dev-data/tools/adb/36.0.0/platform-tools/adb -s <serial> shell setprop persist.adb.tcp.port 5555
      .dev-data/tools/adb/36.0.0/platform-tools/adb -s <serial> shell getprop persist.adb.tcp.port
      # Expect on a stock, non-rooted phone: empty or unchanged — setprop
      # itself does not necessarily report the permission failure as an
      # error (H3, per enrollment.md's existing prose).

      # 4. Confirm end to end: reboot the phone, wait for USB to
      #    re-enumerate, then:
      .dev-data/tools/adb/36.0.0/platform-tools/adb -s <serial> shell getprop service.adb.tcp.port
      # Non-empty here (with no re-arm in between) is the real proof H3 was
      # wrong on this phone; empty confirms it.
      ```

      **What each outcome means:**

      | Reading | Verdict / effect |
      |---|---|
      | Step 1's `tcpip()` does not throw | H1 confirmed — the device-service path works with no CLI spawn; `enableTcp()`'s primary branch is what runs in production and `hostAdb.run` stays a dormant fallback. |
      | Step 1's `tcpip()` throws | H1 does not hold as stated — every real cutover silently takes the `hostAdb.run` fallback branch. No code change needed (already the documented fallback); worth a one-line update to `enableTcp()`'s own comment for the next reader. |
      | Step 3–4's `persist.adb.tcp.port` reads back `5555` and survives the reboot | H3 does **not** hold on this hardware — `persistSurvivesReboot` reads `true` on every cutover and the "will need re-arming after a reboot" line never shows for this phone. |
      | Step 3–4's `persist.adb.tcp.port` reads back empty/unchanged, or the reboot loses it | H3 confirmed — matches `enrollment.md`'s existing prose and the `farm-tag.ts` ACL evidence; `persistSurvivesReboot` reads `false`, and the wizard's own detail line already names the caveat. |
- [x] `packages/core/src/registry/cutover.ts`: the state machine of §3.4,
      in-memory, keyed by `stableId`, with `armWindowSec` expiry and
      cancellation. Deliberately **not** persisted — an armed cutover that
      survives a core restart is a surprise, and the operator is standing at
      the chassis. `stopAll()` (called from `daemon.ts`'s own `stop()`)
      clears every live poll timer — the one piece of state here that
      genuinely outlives a single call, unlike the reconnect ladder's bare
      mutex map.
- [x] Verified enable: `tcpip:<port>` → read back `service.adb.tcp.port` →
      **refuse to arm** if it does not match. Attempt `persist.adb.tcp.port`,
      read it back, and report which persistence was achieved (H3).
- [x] While armed: **judgement call, deviating from the letter of this
      bullet.** No DB/state-machine annotation was added — an armed cutover
      never writes `reason: 'cutover'` anywhere, because the state machine
      (`packages/core/src/device/state-machine.ts`) has no `reason` column
      to write it to, and adding one would be a schema change this step's
      own scope did not ask for. Instead, `CutoverDialog.tsx` renders
      "waiting for it on the network" ENTIRELY from the `device.cutover`
      broadcasts it is already subscribed to while open — the one screen an
      operator is actually watching during an armed window already knows
      the true reason without touching the wall/list's own offline
      rendering. A phone armed but not yet flipped, viewed from the plain
      device list rather than this dialog, still reads "Offline" — a
      narrower fix than the bullet's own wording promised; broadening it to
      every surface is future work, not blocked on anything landed here.
      Poll the ladder + sweep every `armPollSec`: done, reusing
      `DeviceReconnector.reconnect(stableId, { allowSweep: true })` verbatim
      — no second ladder.
- [x] `packages/protocol`: the `device.cutover` message of §4.6
      (`packages/protocol/src/messages/cutover.ts`), plus
      `CutoverStateSchema`/`CutoverStartBodySchema`/`CutoverResponseSchema`
      (`packages/protocol/src/api/devices.ts`) and the `discovery.cutover`
      settings block (`armWindowSec`, `armPollSec`).
- [x] `packages/core/src/api/devices.ts`: `POST`/`DELETE
      /:id/connection/cutover`, `requirePermission('device.enroll')`. Guards
      mirror `/:id/connection/disconnect`'s own shape: `E_ALREADY_ON_NETWORK`
      for a `tcp` device (this wizard is for the USB→network move itself),
      `device_offline`, and a `job_running` refusal with **no** `force`
      override (a physical port flip is not something a running script can
      be safely recovered from mid-run, unlike a disconnect).
- [x] `packages/studio/src/components/device/CutoverDialog.tsx`: the four
      screens, with the "flip the port now" screen showing live progress
      (a countdown `Progress` bar against `armWindowSec`, and the live
      tried/answered counts) and the failure screen naming what was tried
      and the three likely causes. Wired into `DeviceHeader.tsx`'s
      Connection menu group as "Move to the network (Wi-Fi/OTG)…", USB-only,
      the third item §3.8 always described but 88.4 left unbuilt.
- [x] The "return to USB" note (§3.4) — one sentence, no flow. Present in
      the dialog on every screen.
- **Carried-over gap closed (was flagged under 88.4's own checklist entry,
  see below):** `deriveConnection` now reads a declared medium back from
  the endpoint store on every render, not only in `PATCH /:id/connection`'s
  own response — this is what makes a completed cutover show
  `mediumSource: 'declared'` on the very next `GET /api/devices`/`GET /:id`,
  satisfying criterion 14. Proven end to end (through the real HTTP routes,
  never `deriveConnection` in isolation) in
  `packages/core/src/api/devices.test.ts`'s "connection.medium read-back on
  GET" describe block, and at the unit level in
  `packages/core/src/registry/cutover.test.ts`'s "once the phone answers on
  the network... declares the medium" test.
- **Scope extension (found during this step, closed in the same pass):** an
  even earlier layer of the same "saved but never read" defect —
  `discovery.networks` itself was never threaded into any production
  `rowToDeviceInfo`/`listDevicesWithTags` call site (`daemon.ts`,
  `capability/context.ts`, `api/topology.ts` all called it with no networks
  argument), so a device on a configured wired network could never badge
  OTG anywhere, only ever `TCP`. All three call sites now pass
  `discovery.networks` (and the endpoint store's declared media) through,
  resolved once per request/list — never per row, keeping the existing N+1
  rule at `device-registry.ts` intact. Proven end to end in
  `packages/core/src/api/topology.test.ts` and
  `packages/core/src/capability/context.test.ts`, alongside the
  `api/devices.test.ts` coverage above.

  **This bullet's own "all three call sites" undercounted by three (found and
  fixed 2026-08-13, `docs/plans/96-m61-hotfixes.md` §96.5).** The admit route
  (`api/devices.ts:388,393`), `DeviceRegistry`'s own broadcast/`listDevices()`
  (`registry/device-registry.ts`), and the cluster detail device list
  (`api/clusters.ts:181`) were still passing an empty network list or none at
  all — see this plan's own status line at the top of the document for the
  full account.
- **Verifiable result:** on a real chassis, an operator moves a phone from USB
  to OTG in under a minute without leaving Studio and without typing an IP.
  The same phone is one `devices` row throughout (same `stableId`, same tags,
  same cluster, same history), and its badge changes from USB to OTG.
  ✅ implemented and covered by fakes (`cutover.test.ts`'s ladder-mocked
  "once the phone answers on the network..." test proves the whole
  arm→declare→badge chain end to end against a fake reconnector, including
  the "still on USB, not done yet" filter and the window-expiry failure
  path) — the physical confirmation (a real chassis, a real port flip, a
  real wall-clock) is §7.3's own hardware ladder, gated the same way as
  every other physical-farm row in that table, plus the pending H1/H3
  spikes above.

### 88.6 — Studio: badge, filter, networks editor (fixes F1, F5, F27, F28)

- [ ] `packages/studio/src/components/ConnectionBadge.tsx`, wired into
      `TileChips` (first in the canonical order, dash-in-place when unknown),
      `DeviceCard`, and the device header.
- [ ] `packages/studio/src/app/page.tsx`: `ConnectionFilter` type, the
      `filtered` memo clause, and the `Select` beside the readiness filter.
- [ ] `packages/core/src/api/devices.ts:356`: `GET /api/devices?connection=`
      accepting the same five values.
- [ ] `packages/studio/src/components/settings/FarmNetworksEditor.tsx`: §3.6,
      with live CIDR validation and the running address count against
      `maxAddresses` — because `SchemaForm` cannot render an array of objects
      (F28) and a JSON textarea for a farm's network topology is not a
      feature.
- [x] A **Scan network** button — NOT built here despite this bullet's
      original wording; left unchecked for years while the plan's own top
      Status line and `devices.ts`'s own doc comment both incorrectly
      claimed it existed. Actually built by step 88.12 (2026-08-19), in two
      places rather than only beside the Discovered tray's Rescan:
      `FarmNetworksEditor.tsx` (beside the ranges it scans) and the Devices
      page's fleet `⋮` menu (beside "Move to network…") — see 88.12 for the
      full account, and `docs/plans/96-m61-hotfixes.md` for the false-claim
      entry.
- [ ] Studio tests render every new component through the DOM renderer (plan
      72's rule: a UI change is not verified until its screens have rendered).
- **Verifiable result:** a 20-device farm shows USB/OTG/WI-FI at a glance on
  both the list and the wall; filtering to OTG shows exactly the wired ones;
  the networks editor rejects a `/16` with the exact reason and the number.

### 88.7 — What "adb is stuck" looks like, measured (fixes F21, F23; tests H5's cousin)

- [ ] `packages/core/src/device/adb-metrics.ts`: the ten-bucket rolling window
      of §4.7, fed from the existing `record()`. Cumulative counts unchanged.
- [ ] `packages/core/src/device/adb-health.ts`: the monitor and the five
      symptoms of §3.9, with `restartAdvised` computed from the symptom set.
- [ ] `packages/core/src/registry/reconcile.ts`: expose `nudgeCounts()` from
      the existing `lastReconnectAttempt` map (`:65`) — no second counter.
- [ ] `packages/core/src/api/adb-stats.ts`: the `adbHealth` block, zero-filled
      before the monitor exists (the same optional/zero-default contract
      `transport` and `hostAdb` already use, `:21-30`).
- [ ] `packages/core/src/doctor/checks/adb-health.ts` + a
      `DoctorContext.adbHealth.probe()` namespace: `skip` with no live core,
      `ok`/`warn`/`fail` from the verdict, `observed` carrying the symptom and
      its evidence, `remedy` naming the Tools action **without ever containing
      the forbidden literal**.
- [ ] `packages/core/src/doctor/render.test.ts:128-148`: add
      `'checks/adb-health.ts'` to the file list. **The assertion itself does
      not change** — the doctor stays a pure diagnostic (§3.9).
- [ ] `packages/protocol`: the `adb.health` transition-only broadcast.
- **Verifiable result:** with adb healthy the check reads `ok` and
  `restartAdvised` is false. Blocking the adb server's socket (SIGSTOP on the
  server process) produces `server-unresponsive` within two intervals, with
  the RTT and the two failed probes as evidence; `enkaku doctor` prints it and
  exits 1.

### 88.8 — Restart adb: one implementation, two entry points (fixes F19; ships the owner's decision)

- [ ] `packages/core/src/tools/adb-server-control.ts`: `cycle()` per §4.8,
      lifting F18's drain/kill/start/rollback verbatim and adding the drain of
      sessions, the reattach, and the phase broadcasts. One mutex.
- [ ] `packages/core/src/tools/adb-swap.ts`: reduced to a wrapper around
      `cycle({ reason: 'swap', … , commit })`. Its `AdbSwapHook` shape is
      unchanged, so the Toolchain Manager needs no edit.
- [ ] `packages/core/src/daemon.ts:278-288`: **wire `drainSessions`** (F19 —
      an unwired hook since M1) and `reattachEndpoints`, and pass the phase
      broadcaster.
- [ ] `packages/core/src/tools/routes.ts`: `POST /adb/restart`,
      `requirePermission('tool.manage')`, `E_ADB_BUSY_FARM` listing running
      jobs and lease holders unless `force`, rate-limited by
      `adbControl.restartCooldownSec`.
- [ ] `packages/core/src/auth/audit.ts`: an `adb.restart` action; recorded
      with the report.
- [ ] `packages/studio/src/app/tools/page.tsx`: `AdbServerCard` +
      `AdbRestartDialog` (§4.9), with §3.10's copy and live counts, above the
      Diagnostics panel.
- [ ] `packages/studio/src/components/layout/`: the farm-wide banner driven by
      `adb.server.phase`, so twenty devices dropping is one event.
- **Verifiable result:** on a 5-device farm with two live wall tiles and one
  wireless device, Restart completes in under 20 s; the dialog stated the
  counts correctly beforehand; the wireless device is reconnected
  automatically; the report names anything that did not come back. Running it
  with a job in flight refuses and lists the job.

### 88.9 — The rule change, and the guard that enforces it (fixes F17's scope, F20)

- [x] `CLAUDE.md`: replace the `adb kill-server` bullet with §3.10's wording —
      one implementation file, two audited entry points, both draining first
      and reattaching afterwards, forbidden everywhere else including the
      doctor package.
- [x] `docs/plans/00-overview.md` §3, the adb-serialisation row: same wording.
- [x] `docs/spec.md` §10.4 (`:520`): same wording, plus the operator-facing
      sentence that a restart is offered on the Tools page and what it costs.
- [x] `docs/guide/install.md:259`: today it tells the user not to run
      `adb kill-server` by hand while the farm is working. It gains the
      other half — that Tools → Restart adb server does it safely, draining
      first and reconnecting network devices afterwards, and that it still
      disconnects Android Studio.
- [x] `packages/core/src/tools/adb-server-control.test.ts`: the guard plan 01
      §398/§494 specified and never built — enumerate every non-test `.ts`
      under `packages/*/src`, **strip comments** (§494's own qualifier: "di
      luar komentar"), and assert the literal appears in exactly one file.
      Failing prints the offending path, so the next person to write it
      learns the rule from the failure rather than from a document.

      **Done (2026-08-12).** The doctor package's own narrower guard
      (`doctor/render.test.ts:137-171`) was checked, not assumed: its file
      list is scoped to `doctor/`-relative paths only and needed no edit,
      because `tools/adb-server-control.ts` was never in scope for it — that
      guard was always package-local and could never have caught a call site
      added anywhere else in the workspace (F20's actual gap). The new
      workspace-wide test walks every package's `src/` itself rather than
      naming files, so it does not need updating when a file moves or a new
      one appears; verified against a real second call site by temporarily
      adding `spawnAdb(x, ['kill-server'])` to an unrelated file during
      development, confirming the test fails and names the offending path,
      then reverting it.
- **Verifiable result:** `bun test` fails if the command is added to a second
  file; passes with exactly one. Every document states the same rule in the
  same words. ✅ confirmed — `bun test packages/core/src/tools/adb-server-control.test.ts` is green with the new guard included, and the doctor package's guard (`bun test packages/core/src/doctor`) is unchanged and still green.

### 88.10 — Documentation

- [x] `docs/guide/enrollment.md`: a "Moving a device to the network" section —
      Wi-Fi and OTG, the chassis flip, what Enkaku can and cannot do, and the
      reboot caveat H3 actually measured.

      **Done (2026-08-12), with one correction to this bullet's own wording:**
      H3 has **not** actually been measured — its spike is still pending real
      hardware (88.5's first checklist item is unchecked). The section says
      that plainly rather than presenting a hypothesis as a finding: it names
      both properties (`service.adb.tcp.port` vs `persist.adb.tcp.port`),
      explains why the latter usually needs root, and tells the operator to
      verify on their own hardware rather than promising either outcome. The
      section also documents the guided cutover wizard's flip/arm/watch
      sequence as **not yet shipped** (`cutover.ts`/`CutoverDialog.tsx` do not
      exist as of this pass — confirmed by file search, not assumed) and gives
      the manual `adb tcpip` + physical port-flip equivalent an operator can
      use today, since the address book and reconnect ladder (88.2) pick up
      from there automatically either way.
- [x] `docs/guide/install.md`: farm networks, what a scan does and does not
      do, and why it is on-demand by default.

      **Done (2026-08-12).** New "Farm networks and scanning for devices"
      section: what the `discovery.networks[]` list is for (badge medium +
      scan address space, one list feeding both), what a scan probes and at
      what ceiling, what it deliberately never does (auto-enrol, touch an
      unlisted subnet, run on a timer), and the shared-LAN courtesy note
      (§8's first risk row) about clearing a sweep with the network's owner
      first.
- [x] `packages/core/README.md`: the endpoint store, the ladder, the sweep,
      the cutover state machine, `adb-server-control`.

      **Done (2026-08-12), with the cutover state machine left out
      deliberately** — `registry/cutover.ts` does not exist yet (88.5 is
      still in flight, owned by another worker as of this pass). The new
      "Connection, the address book, the sweep, and adb server control"
      section says so explicitly in its opening paragraph, then documents
      the four pieces that **are** shipped and test-green (`endpoints.ts`,
      `reconnect.ts`, `sweep.ts`, `tools/adb-server-control.ts`) —
      re-verified in this pass with a targeted `bun test` run (see the step's
      own verifiable-result line below), not merely read from source.
- [x] `packages/adb/README.md`: the host services this plan adds or newly
      relies on, and the `devices -l` fields now parsed.

      **Done (2026-08-12).** Documents `TrackedDevice.usb`/`.transportId`
      (the `host:devices-l` fields F6 used to discard) and the first
      operator-facing callers of `connectDevice`/`disconnectDevice` — the
      reconnect ladder and per-device Disconnect/Reconnect — plus what
      `AdbTcpTransport.disconnect()` becoming a no-op actually means for a
      session (§3.7).
- [x] `docs/spec.md`: §7.5 gains the address book and the cutover; §12 gains
      `device_endpoints`; §13 gains the four new messages; §7.7 gains the
      restart action. (00-overview §7 item 8 — same commit or a `DIV-` row.)

      **Done (2026-08-12), one item short of this bullet's own list on
      purpose.** `bun run spec:check` reported exactly one gap going into
      this step — `device_endpoints` named in neither `docs/spec.md` nor a
      `DIV-` row — and closing it is §12.4's new bullet, written in the
      section's existing "smaller tables" style with the same provenance-note
      convention the file already uses (`script_param_sets`'s own entry,
      immediately above it, is the direct template). §7.5 gained the
      connection-as-two-facts model, the address book, the ladder, the
      bounded sweep, and per-device disconnect/reconnect — but **not** the
      cutover wizard, since it has not shipped; the same paragraph says so
      and points at the plan's status line instead of describing unshipped
      UI as real. §7.7 gained `POST /api/tools/adb/restart`. §13 gained
      **three** of the plan's four designed messages — `scan.progress`,
      `adb.server.phase`, `adb.health` — all three confirmed present in
      `packages/protocol/src/messages/`; the fourth, `device.cutover`, is not
      in the protocol package yet (grepped for, not found) and is left out
      for the same reason the cutover wizard is left out of the README and
      the spec's own §7.5 paragraph. `bun run spec:check` now reports **GAP
      0** (tables 0, screens 0, routes 0) — verified after these edits, not
      only before them.
- **Verifiable result:** `bun run spec:check` ends at GAP 0. Every doc above
  describes what is actually running today — verified by a targeted `bun
  test` pass across `endpoints.test.ts`, `reconnect.test.ts`, `sweep.test.ts`,
  `adb-health.test.ts`, `adb-metrics.test.ts`, `adb-server-control.test.ts`,
  `devices.test.ts`, and `doctor/render.test.ts` (183 pass, 0 fail) plus the
  full Studio suite (615 pass, 0 fail, `bun run --cwd packages/studio test`)
  — not by re-describing this plan's own §4 design as though writing it down
  were the same thing as it having shipped. Nothing here documents
  `registry/cutover.ts` or `CutoverDialog.tsx`, because neither exists yet.

  **One more gap surfaced while writing this step, worth recording precisely
  because acceptance criterion 2 depends on it:** `deriveConnection`'s
  `medium` (both sources — network-inferred AND the endpoint store's
  declared value) is real, unit-tested code that **nothing in production
  calls with real data**. `daemon.ts`'s `listDevices`, `capability/context.ts`,
  `device-registry.ts:615`, and `api/topology.ts` every one call
  `listDevicesWithTags`/`rowToDeviceInfo` with no farm-network list (grepped
  for all call sites, none pass one), so `mediumSource` is `'unknown'` for
  every device Studio actually renders and the OTG/WI-FI badges are
  currently unreachable outside a test that constructs the row directly.
  This was already flagged in writing under 88.4's own checklist entry
  above (the "Known gap" paragraph) — this note only confirms, as of
  2026-08-12, that it is still open — and `docs/guide/enrollment.md` and
  `docs/guide/install.md` say so explicitly rather than describing the
  badge as working. Not this step's job to fix; flagged here so it is not
  lost between 88.4's note and whichever step closes it.

### 88.11 — Cutover discoverability and bulk cutover (extends 88.5, 88.6)

Two live UX defects an operator hit this session, plus the bulk capability
the owner asked for directly (comparing this farm to Panda/some3c, whose
Devices page carries its own menu for the USB→network move): *"kalau di
panda kan dipermudah kaya ke halaman devices sudah ada menunya."* Recorded
in `docs/plans/96-m61-hotfixes.md` (the two defects) since both were live
UX defects, not new design.

- [x] **`ActionsList.tsx`'s "Reconnect" row no longer doubles as the cutover
      trigger.** Before this step, a USB device's "Reconnect" row silently
      opened `CutoverDialog` instead of reconnecting (`onSelect={isUsb ?
      () => setCutoverOpen(true) : () => void reconnect()}`) — actively
      misleading, since "Reconnect" reads as re-establishing a connection
      that already existed, never "move this phone to the network."
      Reconnect now always fires `POST .../connection/reconnect` (a USB
      device that adb still lists answers `already-connected`, a legitimate
      no-op, not a dead click). The cutover wizard gets its own row, "Move
      to the network (Wi-Fi/OTG)…" (matching `DeviceHeader.tsx`'s identical
      Connection-group item, word for word, and `CutoverDialog.tsx:152`'s
      own dialog title in substance), USB-only.

      **The 12-row budget (§4.2/plan 103 §4.2) does not have room for a 13th
      row unconditionally, and the fix is a deliberate, stated exception,
      not a silent overflow.** The new row renders only for a USB device
      (never for one already on the network, which has nowhere left to move
      TO) — so the list is thirteen rows on a USB device and twelve on a
      TCP one. This mirrors a precedent the same file already established
      for Wake/Sleep (plan 103 §5 step 103.10): a single dynamic label
      cannot describe every state, so the row count grows by exactly one
      only when the extra row is genuinely meaningful, never appended
      unconditionally. No existing row was a good candidate to fold this
      into instead — collapsing Disconnect/Reconnect back into one row to
      make space would reintroduce a different version of the exact
      ambiguity this whole fix removes, and `DeviceHeader.tsx`'s own
      Connection group already proves three independent rows (Disconnect,
      Reconnect, Move to network) read correctly together. `ActionsList.tsx`
      is also what the Wall's right-click `DeviceContextMenu.tsx` renders
      (that file's own doc comment: one vocabulary, not two) — verified by
      reading it, and fixed at the one shared component rather than twice.
      Stays single-device, matching plan 104 §10's own recorded reasoning
      for `CutoverDialog.tsx` ("there is no multi-device reading of 'cut
      this device over' that means anything" for a row bound to one focused
      device) — targeting several phones at once is 88.11's own next
      bullet, reached from the Devices page instead.
- [x] **`BulkCutoverDialog.tsx`** (new,
      `packages/studio/src/components/device/`) — the multi-target sibling
      of the singular wizard, composed exactly like every other bulk dialog
      in this repo: `TargetPicker`/`useTargetSelection` (plan 104, no
      `cluster` mode — matching §3.4's own table row for Reconnect/
      Disconnect, "single · devices"), a `Promise.all` fan-out over
      `POST /:id/connection/cutover` (the core has no batch cutover
      endpoint, and `CutoverManager.start` is independently keyed by
      `stableId` — confirmed by reading `cutover.ts`'s own `sessions` map —
      so N concurrent single-device calls is correct, not a shortcut), and
      `OutcomeSummary`/`SkippedGroups` for the report. Design decisions,
      each stated in the file's own header comment:
      - **One port for every targeted device.** Confirmed by reading
        `AdbClient.tcpip`/`enableTcp` in `cutover.ts`: `tcpip:<port>` is a
        DEVICE service over that one phone's own adb transport
        (`host:transport:<serial>` then `tcpip:<port>`), restarting only
        that phone's adbd listener — not a farm-wide allocation, so many
        devices sharing 5555 is not a conflict.
      - **Eligibility is checked client-side before any request goes out.**
        Only a USB-connected, non-offline device is targeted; a device
        already on the network, or offline, is skipped with a stated reason
        via `SkippedGroups` — never silently dropped, never sent a doomed
        request. A server-side refusal (a running job, anything else) still
        lands in the Failed section.
      - **The dialog reports arming, not the whole journey.** Each `POST`
        already waits, server-side, for TCP mode to be enabled and verified
        by read-back before returning — "armed" here is a real, confirmed
        state. The dialog does not poll `device.cutover` per targeted
        device inline; each device's own tile/badge/popup already watches
        that broadcast the moment this dialog closes, and plan 107's
        operation tray was considered and rejected (an in-memory,
        non-persisted `CutoverManager` session is not the durable-record
        shape that tray is built for). No bulk "cancel all pending"
        affordance either — each device's own popup already carries a
        working, idempotent per-device Cancel once armed.
- [x] **A page-level entry point on the Devices page** — `app/page.tsx`'s
      fleet `⋮` dropdown (beside "Add device") gains "Move to network…",
      opening `BulkCutoverDialog` pre-filled from the CURRENT farm-wide
      selection (`selectedIds`) when non-empty, or every USB-connected
      device in the fleet otherwise (never every device unconditionally —
      a TCP device has nowhere left to move to). The direct, literal answer
      to the owner's Panda comparison: a menu reachable from the Devices
      page itself, not buried in a per-device popup.
- [x] **"Farm networks" discoverability (§3.6, 88.6).** The CIDR/sweep-
      policy editor lives under Settings → "Discovery & monitoring"
      (`discovery` schema key), while a separate tab literally named
      "Network" exists holding only the geo-verification lookup (`network`
      schema key, plan 55 §3.2) — confirmed in-browser this session: an
      operator opening "Network" looking for IP-range scanning finds
      nothing related. Fixed with a cross-link banner at the top of the
      Network tab pointing at Discovery & monitoring, the smaller of the
      two options this step's own brief offered. A structural move was
      considered and rejected: `discovery`'s sweep-policy fields (port,
      scan mode, max addresses) sit in the same schema block as the CIDR
      list and share one `FarmForm`; relocating only the CIDR table would
      split one coherent settings group across two tabs for no schema
      reason, and relocating the whole `discovery` block would touch a
      widely-read settings path (`sweep.ts`, `reconnect.ts`, `endpoints.ts`,
      `cutover.ts`) for a UI-only fix.
- **Verifiable result:** `ActionsList.test.tsx`'s row-count test is split by
  connection kind (thirteen on USB, twelve on TCP) and a new describe block
  proves the cutover row is reachable independently of Reconnect, on both
  kinds; `DeviceContextMenu.test.tsx`'s row count is updated identically
  (same shared component); `BulkCutoverDialog.test.tsx` proves eligibility
  skipping (non-USB, offline), the shared port on every request body, and a
  server-side `failed` step landing in the report; `page.test.tsx` proves
  the fleet menu entry opens the dialog pre-filled from an active selection,
  and defaults to every eligible USB device with none selected;
  `settings/page.test.tsx` proves the Network tab's cross-link text and its
  working `href="/settings?tab=discovery"`. `bash scripts/typecheck.sh` and
  `bun run --cwd packages/studio test` both green — see this plan's own
  status line for the exact counts this pass ran.

### 88.12 — Scan network: closing the gap `devices.ts`'s own doc comment and 88.6's own checklist bullet falsely claimed was already closed

- [x] **Confirmed the gap first, not assumed:** an exhaustive grep across
      `packages/studio/src` for `/scan` and `/api/devices/scan` found zero
      call sites. `POST /rescan` (a different route — it re-reads adb's own
      list, no IP range needed) has always had a caller
      (`DiscoveredTray.tsx`'s "Rescan" button); `POST /scan` (the bounded
      subnet sweep of §3.5/§4.5, which dials addresses adb has never heard
      of) never did, despite `devices.ts`'s own doc comment above the route
      (~line 508, corrected by this step) and this plan's own top Status
      line and 88.6 checklist bullet (also corrected by this step) both
      stating or implying otherwise.
- [x] `packages/studio/src/lib/network-scan.ts` (new): `useNetworkScan()` —
      one `POST /api/devices/scan` call behind `useAction`'s existing
      pending/toast machinery, shared by both call sites below rather than
      each hand-rolling its own fetch. `summariseSweepReport()` — one line
      naming every `SweepReport` category that actually changed (`adopted`,
      `discovered`, `conflicts`) and closing with an explicit "nothing new"
      when nothing did, the same wording discipline
      `DiscoveredTray.tsx`'s own `summariseReconcileReport` and
      `registry/cutover.ts`'s own `detail` field already established.
      `scanDisabledReason()` / `hasScannableNetwork()` — the one
      client-side-knowable precondition (`discovery.networks[].scan`, none
      of it needs a round trip): `null` (loading), zero networks configured
      (reuses `FarmNetworksEditor`'s own empty-state wording verbatim, per
      this step's own brief — "reuse that reasoning… rather than inventing
      new wording"), networks configured but none swept, or ready. Every
      OTHER refusal (`E_SCAN_BUSY`, `E_SCAN_UNAVAILABLE` for `scan.mode:
      'off'`, `E_NOT_SUPPORTED` for orchestrator mode/adb not ready) has no
      Studio-visible signal and is deliberately left to surface after the
      click, as the server's own message through `useAction`'s built-in
      failure toast — mirroring `DiscoveredTray.tsx`'s "Rescan" button,
      which does the identical thing for `POST /rescan`'s own
      `E_NOT_SUPPORTED` case rather than inventing a second error-mapping
      convention.
- [x] `packages/studio/src/components/settings/FarmNetworksEditor.tsx`: a
      "Scan network" button beside the "Farm networks" heading (adjacent to
      the address-budget readout the empty-state copy already promised this
      button beside), disabled with the exact reason above, and the last
      `SweepReport` rendered inline once one has run.
- [x] `packages/studio/src/app/page.tsx`: a "Scan network" item in the fleet
      `⋮` menu beside "Move to network…" (88.11's own precedent for a
      Devices-page entry point, per the owner's Panda comparison) — styling-
      only disabled (no Radix `disabled` prop, so `title`'s hover reason
      still fires; same reasoning `ActionsList.tsx`'s own disabled-row
      comment gives for its identical Tooltip-based pattern), refetching the
      fleet (`load()`) and the Discovered tray (`loadDiscovered()`) on
      success — belt-and-suspenders alongside the `device.added`/
      `device.discovered` WS broadcasts the sweep's own admission path
      (Plan 56, reused verbatim — a sweep-found device goes through
      `registry.onOnline`) already emits, the same two-path pattern
      `renumberFleet`/`DiscoveredTray`'s Rescan already use.
- [x] `packages/core/src/api/devices.ts`: corrected the `POST /scan` doc
      comment's false "the Studio 'Rescan / scan all networks' button"
      claim to name the two real call sites above instead.
- [x] `docs/plans/96-m61-hotfixes.md`: logged the false-claim defect.
- **Verifiable result:** `bash scripts/typecheck.sh` clean;
  `bun run --cwd packages/studio test` scoped to
  `src/lib/network-scan.test.ts`, `src/components/settings/FarmNetworksEditor.test.tsx`,
  and `src/app/page.test.tsx` — 83 pass, 0 fail. Both buttons render
  disabled with the correct reason on a farm with no scannable network;
  a successful scan on either renders the real `scanned`/`answered`/
  `adopted`/`discovered` counts, never a generic "done"; `E_SCAN_BUSY` and
  `E_SCAN_UNAVAILABLE` each surface their own distinct server wording
  through the failure toast, proven by capturing it in
  `FarmNetworksEditor.test.tsx` (a local `mock.module('sonner', …)`, the
  same capture technique `AdmitDeviceDialog.test.tsx` already established).

---

## 6. Acceptance criteria

1. Every device carries a `connection` in `DeviceInfo`; a USB device reads
   `kind: 'usb'`, a networked one `kind: 'tcp'` with its address, and the
   badge is computed in exactly one function.
2. A device on a configured wired network reads `OTG`; one on a wireless
   network reads `WI-FI`; one on no configured network reads `TCP` with a
   tooltip saying Enkaku does not know which — never a guess.
3. Closing a session on an `adb-tcp` device leaves it connected in
   `adb devices`.
4. A wireless device disconnected out of band reconnects from its remembered
   address with no operator input and no network scan.
5. A device that moves to a new DHCP address is found by one sweep, verified
   by `stableId`, and reattached to the same `devices` row with its tags,
   cluster and history intact.
6. A sweep of one `/24` completes in under 5 s at the default concurrency,
   probes no address twice, skips addresses adb already knows, and issues
   `host:connect` only to hosts that answered the pre-probe.
7. A sweep can **never** enrol a device: an unknown `stableId` lands in the
   Discovered tray.
8. Configuring networks totalling more than `scan.maxAddresses` is rejected at
   save time with a message naming both numbers.
9. `scan.mode: 'off'` disables scanning entirely, including from the cutover
   wizard, which then requires a typed address.
10. Per-device Disconnect drops exactly one device; the other devices, the
    device's record, and every other tool are untouched. On a USB device it is
    visibly disabled and explains why.
11. The Connection menu group and the Remove item are visually separated, and
    each item states its own consequence.
12. The cutover wizard refuses to arm unless `service.adb.tcp.port` reads back
    as the port it set.
13. While armed, the device's USB disappearance is presented as expected
    progress, never as an offline error.
14. A completed cutover produces one device row, unchanged identity, with
    `medium: 'wired'` and `mediumSource: 'declared'`.
15. The device list can be filtered to USB / Wi-Fi / OTG / TCP, and the same
    values work as `GET /api/devices?connection=`.
16. `/api/adb/stats` reports `adbHealth` with a rolling window; `enkaku
    doctor` reports the same verdict; the doctor never performs an action.
17. A deliberately unresponsive adb server is reported as
    `server-unresponsive` within two health intervals, with evidence, and
    `restartAdvised` is true. A merely-absent server reports
    `server-unreachable` with `restartAdvised` false and a remedy saying it
    starts itself.
18. `POST /api/tools/adb/restart` drains the queue **and live sessions**,
    releases leases, restarts the server, reattaches every remembered network
    address, runs one reconcile, and returns a report whose counts match what
    happened.
19. The restart dialog states the live device, lease and job counts, and names
    the other-tool consequence, before the click.
20. A restart with a job in flight is refused and lists the jobs; `force`
    overrides and the report says which jobs were failed.
21. `adb kill-server` appears in exactly one non-test implementation file, and
    a workspace-wide test enforces it.
22. `CLAUDE.md`, `00-overview.md` §3, `spec.md` §10.4 and
    `docs/guide/install.md` state the same rule in the same words.
23. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test`
    are green. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| connection derivation | `packages/protocol/src/device.test.ts` | `usb`/`tcp` from serial shape; `medium` from a matching network; `mediumSource` precedence (declared beats network); the four badge values |
| `devices -l` parsing | `packages/adb/src/client.test.ts` | `usb:`/`transport_id:` retained; a TCP line has no `usb:`; malformed lines still skipped |
| endpoint store | `packages/core/src/registry/endpoints.test.ts` | observe upserts and zeroes failures; eviction at `endpointsPerDevice`; `candidates` ordering; retirement at `endpointRetireAfter`; conflict recorded |
| ladder | `packages/core/src/registry/reconnect.test.ts` | already-connected short-circuit; pre-probe refusal skips the connect; identity mismatch disconnects and continues; per-stableId mutex serialises two callers; `not-found` trace is complete |
| sweep | `packages/core/src/registry/sweep.test.ts` | skips adb-known addresses; honours concurrency and the ceiling; singleton mutex rejects a second call; a new stableId reaches the tray, never `devices`; last-octet-first ordering |
| settings | `packages/protocol/src/settings.test.ts` | CIDR validation; the cross-field `maxAddresses` refinement with its exact message; `scan.mode` defaults; every new block defaults without a stored row |
| cutover | `packages/core/src/registry/cutover.test.ts` | refuses to arm on a failed read-back; expires at `armWindowSec`; cancel is idempotent; a matching stableId completes it, a different one does not |
| health window | `packages/core/src/device/adb-metrics.test.ts` | buckets roll; a burst then silence decays the rate; cumulative counts unchanged |
| health verdict | `packages/core/src/device/adb-health.test.ts` | each of the five symptoms from an injected fake; `restartAdvised` false for `server-unreachable`; transition-only broadcast |
| doctor check | `packages/core/src/doctor/checks.test.ts` | `skip` with no core; the three statuses; remedy present on warn/fail |
| server control | `packages/core/src/tools/adb-server-control.test.ts` | phase order; drain refusal on timeout; rollback when `start-server` fails; reattach called with every remembered stableId; the mutex blocks a concurrent swap; **the workspace-wide `kill-server` guard** |
| disconnect guards | `packages/core/src/api/devices.test.ts` | USB refusal is coded and explains; running-job refusal lists jobs; `force` overrides; lease released before the disconnect |
| Studio | `packages/studio/src/components/ConnectionBadge.test.tsx`, `TileChips.test.tsx`, `app/page.test.tsx`, `FarmNetworksEditor.test.tsx`, `AdbRestartDialog.test.tsx` | rendered through the DOM renderer (plan 72): badge text and tooltip; chip order with a missing value; the filter narrows correctly; CIDR errors; the dialog's counts appear in its text |

### 7.2 Local smoke (dev box, 1–2 devices)

```bash
bun run typecheck
bun test
bun run --cwd packages/studio test
bun run dev

curl -s localhost:7700/api/devices | jq '.items[] | {label, connection}'
curl -s localhost:7700/api/adb/stats | jq '.adbHealth'
curl -s -XPOST localhost:7700/api/devices/scan | jq
curl -s -XPOST localhost:7700/api/devices/<id>/connection/disconnect | jq
curl -s -XPOST localhost:7700/api/devices/<id>/connection/reconnect | jq
bun run doctor
```

Then, with one phone on Wi-Fi: `adb tcpip 5555`, `adb connect`, admit it, open
a session, close it (**it must stay connected** — criterion 3), `adb
disconnect` by hand, press Reconnect (it must come back with no scan),
change the phone's IP by releasing its DHCP lease, press Reconnect again
(a scan must find it and reattach the same row).

### 7.3 The hardware ladder — the parts only real hardware can answer

Run on a real farm host. **Do not advance a rung until the previous one is
green.** Record the table; an empty cell is a failed rung, not a skipped one.

| Measurement | How | 5 dev | 20 dev, mixed | 20 dev, all OTG |
|---|---|---|---|---|
| ladder-only reconnect success rate (**tests H4**) | count `viaSweep: false` over 20 induced disconnects | | | |
| time to reconnect from a remembered address | stopwatch | <2 s | <2 s | <2 s |
| sweep duration, one `/24` | `SweepReport.durationMs` | | | |
| addresses probed per sweep | same | ≤254 | ≤254 | ≤254 |
| sweeps triggered when N devices drop at once | log count | **1** | **1** | **1** |
| cutover, USB → OTG, wall-clock | stopwatch | | | |
| cutovers needing a typed address | count | **0** | **0** | **0** |
| identity preserved across cutover | `stableId`, tags, cluster | **yes** | **yes** | **yes** |
| `persist.adb.tcp.port` survives a reboot (**tests H3**) | reboot one phone | | | |
| restart adb: wall-clock | report `durationMs` | | | |
| restart adb: devices back after | report | **all** | **all** | **all** |
| restart adb: network devices reattached | report | n/a | | **all** |
| Android Studio's behaviour during a restart | observe | | | |
| false `stuck` verdicts over 2 h idle | log grep | **0** | **0** | **0** |

Rung-specific:

- **5 devices, mixed** — the correctness rung. Every criterion 1–15 checked by
  hand.
- **20 devices, mixed USB + Wi-Fi** — the rung that tests the sweep's
  singleton property: pull the switch's power for 30 s and confirm the
  recovery is **one** sweep, not twenty.
- **20 devices, all OTG on one chassis** — the rung the whole plan is for.
  Restart adb here: all twenty must come back, because after a server stop
  adb knows none of their addresses (§3.10). If any does not, the reattach
  step is wrong and this is a release blocker, not a tuning note.

### 7.4 Regression watch

- `discovery.scan.mode: 'off'` disables every scan path; the ladder still
  works from remembered addresses; the cutover wizard requires a typed
  address and says so.
- `discovery.networks: []` — no `medium` is ever inferred, every TCP device
  reads `TCP`, and the scan button is disabled with a reason.
- A USB-only farm sees no behaviour change anywhere: no endpoints recorded, no
  sweeps possible, badges all `USB`.
- The adb **version swap** still works end to end after 88.8's refactor, now
  additionally draining sessions.
- `adbControl.healthIntervalSec` raised to 300 stops the health probe from
  showing up in `/api/adb/stats`'s exec counts at all.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A subnet sweep looks like a port scan to network security. | Off by default (`on-demand`), explicit address space only, never auto-derived from the host's own subnets, hard ceiling, singleton, and a documented ceiling on packet rate. The guide says plainly what it does so an operator can clear it with their network owner first. |
| A sweep connects to somebody else's phone on the same LAN. | It cannot enrol one (F14 — the tray). An address that answers as an unexpected `stableId` is disconnected immediately and recorded as a conflict. |
| Remembered addresses go stale and every reconnect pays a full sweep. | Failures are counted per address and retired at `endpointRetireAfter`; a successful scan writes the new address as the newest, so the next attempt starts there. §7.3 measures the ladder-only success rate (H4) — if it is low, §9 Q2 revisits the design rather than raising the scan rate. |
| Changing `AdbTcpTransport.disconnect()` to a no-op leaks transports. | Transports were never the session's to own (§3.7). They are now released by exactly three things: the operator's Disconnect, the device vanishing from adb, and an adb server restart. A test asserts the no-op and a `/api/adb/stats` count of TCP transports is checked at every §7.3 rung. |
| The cutover strands a phone: TCP never came up, and the port is already flipped. | The wizard refuses to arm without a verified `service.adb.tcp.port` read-back (§3.4 step 2), which is the only ordering that makes stranding impossible. The failure screen's first suggested cause is "flip the port back to USB" — always available, and it needs no software. |
| `persist.adb.tcp.port` cannot be set, so every reboot needs a re-arm. | H3 says this is likely. The wizard **measures and reports** which persistence the phone gave rather than promising either; the guide says what to expect. A phone that loses TCP mode reappears over USB when the port is flipped back, so nothing is lost — it is a chore, not a failure. |
| Restart adb becomes the reflex fix for every problem. | `restartAdvised` is computed, the button is de-emphasised when it is false, and the card says restarting looks unnecessary right now. `server-unreachable`'s remedy explicitly says a restart will not help (F22). |
| Restart adb loses network devices. | The reattach step (§3.10, 88.8) exists solely for this, and the 20-device all-OTG rung in §7.3 is its release gate. This is why the plan is not split in two. |
| Relaxing the `kill-server` rule leads to a second call site later. | The rule gets *stronger*, not weaker: one implementation file, two entry points, and the workspace-wide guard plan 01 declared and never built (88.9). The doctor package's own narrower guard is kept and unchanged. |
| Wiring `drainSessions` makes the adb version swap slower or newly able to fail. | It becomes correct, which is the point (F19): today it kills the server under live video. The drain is bounded by `adbControl.drainTimeoutMs` and refuses with the existing `E_TOOL_IN_USE` rather than hanging — the same behaviour the queue drain already has. |
| `SchemaForm` cannot render `discovery.networks`, so it silently degrades to a JSON textarea. | F28 is why `FarmNetworksEditor` is a required deliverable of 88.6 rather than a follow-up, and why the settings section for it is bespoke from the start. |
| Adding a chip to `TileChips` overflows a 200px tile. | The component already wraps by whole chips and keeps a fixed order with dash-in-place (F26). The new chip joins that order; the Studio test renders a tile at 200px and asserts no horizontal overflow. |
| The health probe's own `host:version` pollutes the metrics it reads. | It runs on `withSocket`, not through `exec`, so it never reaches `onMetric` (F23's feed) at all. A test asserts the window's exec count is unchanged by a health probe. |

## 9. Open questions

1. **DECIDED (2026-08-12): no automatic sweep. Manual trigger only.** This plan
   originally built `scan.mode: 'auto'` and defaulted it off, and asked here
   whether it should ship at all — even disabled. The owner's answer, in his
   words: *"setau saya fiturnya ada tapi yah di trigger user sendiri manual
   dong"* — the feature exists, but the user triggers it manually. So the
   scope is: ship the address book (§3.2) and the operator-triggered sweep
   (§3.5's Rescan / scan-all-networks button); **do not ship an automatic
   periodic sweep at all** — not as a setting, not defaulted off. `scan.mode`
   is cut to `'off' | 'on-demand'`, full stop.

   The reasoning, for whoever next wants to add it back: the competitor's
   equivalent (H4's premise) is a button a human presses, not a timer; H4's own
   target is that the remembered-address ladder alone recovers ≥90% of TCP
   reconnects at the 10- and 20-device rungs, i.e. this plan's own §7.3 expects
   a sweep to be rarely needed at all; and a permanent background scan of a
   farm subnet is unrequested network traffic that has to be maintained
   forever and can look like hostile activity on a shared or corporate LAN
   (§8's first risk row, unchanged by this decision). `auto` may be revisited
   **only if** §7.3's measurements show the remembered-address ladder failing
   often enough that H4's ≥90% bar is missed — and reopening it then is a new
   question argued from that evidence, not a reversal of this one.

   §3.3 step 4, §3.5's Cadence bullet, §4.2's `scan.mode` enum, and 88.3's
   implementation step are amended to match — see the diffs at each; nothing
   in the acceptance criteria or the regression watch assumed `auto` existed,
   so neither needed a change.

2. **If H4 is wrong — if the remembered-address ladder recovers materially
   fewer than ~90% of TCP reconnects** — the balance shifts and the sweep
   stops being an exception path. The answer is probably not "scan more
   often"; it is more likely a documented recommendation to use DHCP
   reservations keyed to each phone's MAC (which compete-4 §3 says is how
   farms actually solve this, out of band), plus reading and storing the
   device's MAC during the cutover so the guide can tell an operator exactly
   what to reserve. That is a design change, not a tuning change, and it needs
   the numbers first.

3. **Should a declared `medium` be per-device or per-network only?** This plan
   allows both (declared beats inferred, §3.1). A simpler model — medium comes
   *only* from the network an address falls in — has fewer states and no
   possible disagreement, at the cost of a device on an unlisted network never
   being labelled. **Owner's call** on whether the per-device override is worth
   the second source of truth.

4. **What should a restart do about `force`?** Today's design refuses when a
   job is running, and `force` fails those jobs. The alternative is to refuse
   outright and make the operator cancel jobs explicitly, so no automated work
   is ever destroyed by a button on a diagnostics page. **Owner's call.**

5. **Should the operator be able to restart adb from `enkaku doctor` (the
   CLI)?** This plan says no — the doctor stays read-only (§3.9), which is what
   keeps its guardrail test unchanged and its purpose intact. But an operator
   on a headless host has no Studio to click. The honest options are: a
   separate `enkaku adb restart` subcommand (a different binary surface, not
   the doctor), or nothing. **Owner's call**; a separate subcommand is the
   recommendation, and it would call the same `cycle()` so the "one
   implementation" property holds.

6. **What is a reasonable `armWindowSec` on real hardware?** 180 s is a guess.
   A chassis port that takes a DHCP lease may need longer; an operator
   standing at the rack will get bored sooner. §7.3 records the real cutover
   wall-clock at three rungs and the default should be set from that number,
   not from this document.
