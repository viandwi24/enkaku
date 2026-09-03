# Plan 221 — MVP wave 4 : The guest agent — `ui-tree` and `activity` facets, keyboard preferences, the full status screen, and the APK in the release

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 205 (device activities: `DeviceActivitySchema` and `ActivityKindSchema` are the exact shape this plan mirrors onto the phone; the registry's `onChange` is what drives the push), plan 208 (inspector phase 1: the session-scoped lifecycle, the instrumentation lock, and its §9 Q4 on `uiAutomationFlags`), plan 200 (rules, format, references R1..R8).
> Spec references: `docs/mvp/10-guest-agent.md` (entire, the scope), `docs/mvp/02-inspector-readiness.md` §4 phase 2 (why a first-party inspector and the enablement question), `docs/mvp/08-device-control.md` §1.2 (why UHID handles ordinary keys and the IME handles the rest), `docs/mvp/09-additional-scope.md` §4 (the APK is not built by the release today, plan 43 §5.11), `docs/mvp/16-consolidated-plan.md` §2 "Guest agent" row and §3 wave 4, `docs/mvp/13-removal-register.md` Part B.2 `apps/guest-agent` row, `docs/research/android-guest-agent.md` §1.1, §1.2, §1.3, §8, §10 item 5. External facts: R4 (restricted settings), R5 (openatx releases, `uiAutomationFlags`).
> Ships: apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/ui/UiTreeService.kt

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_221` is the one gate grep, defined once in §10 and copied verbatim wherever it is cited. Rows marked `owner` need the lab device (Android 16 / API 36) or the owner's farm.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | `hello()` advertises the two new capabilities | `capabilities` contains `ui-tree` and `activity`; `GuestAgentCapabilitySchema` has 9 members | `bun test packages/protocol/src/guest-agent.test.ts` → test `GuestAgentCapabilitySchema carries ui-tree and activity` passes; `rg -n "\"ui-tree\", \"activity\"" apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/control/Protocol.kt` → one line | [ ] |
| G2 | `PROTOCOL_VERSION` is unchanged | `Protocol.PROTOCOL_VERSION == 1` and `GUEST_AGENT_PROTOCOL === 1` | `rg -n "PROTOCOL_VERSION = 1" apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/control/Protocol.kt` → one line; `rg -n "GUEST_AGENT_PROTOCOL = 1" packages/protocol/src/guest-agent.ts` → one line | [ ] |
| G3 | `ui.dump` returns the same node shape ui-server returns for the same screen | zero differing nodes after normalisation; the diff tool prints `identical: N nodes` | owner: `ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts --serial <serial>` on the lab device | owner |
| G4 | The `ui.dump` result parses against `UiDumpResultSchema`, whose `root` is `UiNodeSchema` | `UiDumpResultSchema.shape.root === UiNodeSchema` by identity | `bun test packages/protocol/src/guest-agent.test.ts` → test `UiDumpResultSchema reuses UiNodeSchema unchanged` passes | [ ] |
| G5 | `ui.find` implements exactly `matchSelector`'s comparison and refuses `{ point }` | id: equality or `:id/<short>` suffix; desc/text: trimmed equality; `{ point }` → `E_BAD_REQUEST` | `bun test packages/drivers/src/network/guest-agent/client.test.ts` → tests `uiFind sends the selector verbatim` and `uiFind rejects a point selector before the wire` pass; owner confirms the device-side refusal in §7.4 step 6 | [ ] |
| G6 | `ui.watch` delivers a change event within 200 ms of a screen change | measured p95 over 20 screen changes `< 200 ms` | owner: `ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts --serial <serial> --watch 20` prints `watch p95: <N> ms`, N < 200 | owner |
| G7 | Accessibility enablement succeeds from adb alone, or the fallback is exercised and recorded | `settings get secure enabled_accessibility_services` contains `dev.enkaku.guestagent/dev.enkaku.guestagent.ui.UiTreeService` and `accessibility_enabled` is `1`, both read back by `ensureAccessibilityEnabled()` | owner, §7.4 step 4. If the write is refused (R4's OEM caveat), the owner uses the status screen's "Open accessibility settings" button and records the OEM and the refusal text in §11 | owner |
| G8 | The status screen renders the twelve sections of MVP 10 §2 in order, omitting rows it has no fact for | section titles in `buildReport()`: Now, Device, Farm link, Video, Inspector, Route, Checks, Keyboard, Label, Location, This build, under one Banner | `bun run build:guest-agent` exits 0; owner reads the screen in §7.4 step 7 | owner |
| G9 | The Now section shows a running job and goes stale when the core is stopped | activity row within 2 s of the push; `stale` marker after `DeadMansSwitch.DEFAULT_TIMEOUT_MS` (90 000 ms) of silence | owner, §7.4 step 8 | owner |
| G10 | The soft-keyboard-with-hardware preference is per device, applied by the IME, and survives a reboot | `text.status().showSoftKeyboardWithHardware` is `true` after `text.prefs` + `adb reboot` + agent restart | owner, §7.4 step 9 | owner |
| G11 | The release workflow writes the APK pin into the toolchain manifest in the same commit as the core release | `packages/toolchain/manifest/enkaku-tools.json`'s `guest-agent` entry has `version`, `url`, `sha256`, `sizeBytes` and `deviceArtifact.versionCode` matching the built APK | `bun test scripts/pin-guest-agent.test.ts` → test `pin-guest-agent rewrites exactly the five fields` passes; CI: the tagged run's `pin-guest-agent` step exits 0 and `sha256sum` of the published `guest-agent.apk` equals the manifest's `sha256` | [ ] |
| G12 | The manifest carries no `TODO-M55` and no zeroed guest-agent pin | 0 matches | `rg -n "TODO-M55" packages/toolchain/manifest/enkaku-tools.json` → empty | [ ] |
| G13 | The two stale `apps/guest-agent/README.md` claims read false nowhere | 0 matches each | `rg -n "has not been built" apps/guest-agent/README.md` → empty; `rg -n "scripts/guest-agent\.ts" apps/guest-agent/README.md` → empty | [ ] |
| G14 | The four stale lease comments in the Kotlin are gone | 0 matches | `rg -n -i "lease" apps/guest-agent/app/src` → empty | [ ] |
| G15 | `bun run typecheck` is clean | 0 errors | `bun run typecheck` → exit 0 | [ ] |
| G16 | The forbidden words of §10 are gone from this plan's area | 0 matches | `GREP_221` (§10) → empty | [ ] |

## 1. Goals

1. A first-party `ui-tree` facet: an `AccessibilityService` in the guest agent exposing the window tree over the existing control channel with `ui.dump`, `ui.find` and `ui.watch`, producing the **same** `UiNode` shape `packages/protocol/src/ui-node.ts` already defines, so selectors, the Zod schema and every consumer carry over unchanged (MVP 02 §4 phase 2, MVP 10 §1.1).
2. `ui.watch` is a real subscription: the agent pushes a change event on `TYPE_WINDOW_CONTENT_CHANGED` so a later `waitFor` can subscribe instead of polling every 80 ms. This plan ships the wire and the host client; plan 222 makes `waitFor` use it.
3. A read-only `activity` facet: the host pushes the device's activity list (plan 205's `DeviceActivity`) plus the farm's own facts about the device and the video state, and the agent keeps the last copy and reports it as **stale** once the host has been silent longer than the control-channel timeout (MVP 10 §1.3).
4. The IME gains what UHID cannot do (MVP 08 §1.2): `text.status` reports whether a field is focused **and** whether the soft keyboard is showing, and a per-device "show the soft keyboard while a hardware keyboard is connected" preference is applied by the IME and persisted on the device so it survives sessions and reboots.
5. The status screen becomes the complete screen of MVP 10 §2: a banner plus Now, Device, Farm link, Video, Inspector, Route, Checks, Keyboard, Label, Location and This build, with the "host expects build N" row, and a fourth button "Open accessibility settings". Same three rules: never overstate, no secrets, omit a row the app has no fact for. Still no Compose, still 2 s refresh, still Copy report.
6. Enablement of the accessibility service is unattended over adb, per R4: `cmd appops set <pkg> ACCESS_RESTRICTED_SETTINGS allow` first, then the two `settings put secure` writes, then a read-back that decides, with the on-screen button as the last resort.
7. The release workflow builds, signs, sha256s **and pins** the APK in the toolchain manifest in the same commit as the core release, closing plan 43 §5.11 and MVP 09 §4's first bullet.
8. `docs/research/android-guest-agent.md` §10 item 5 ("does the agent replace the ui-server inspector eventually, or coexist with it?") is answered in the file itself: replace, with ui-server kept as the fallback engine, decided by MVP 02 §4 phase 2 and executed by plan 222.

## 2. Non-goals

| Not done here | Plan that does it |
|---|---|
| Making `ui-tree` the default inspector engine, adding a `UiTreeInspector` implementing `Inspector`, changing `createInspectorForSession`'s ladder, or demoting `uiautomator-dump` | plan 222 |
| Removing ui-server, its manifest entries, its launcher or its watchdog. It stays as the fallback engine (MVP 10 §5) | nothing in the MVP removes it |
| The session-scoped inspector lifecycle, fail-fast start, the configurator, the pinned instrumentation stream, `E_INSPECTOR_STARTING` | plan 208 |
| The `instrumentation` lock conflict row of MVP 13 A.9 | plan 222 |
| Studio surfaces: the Inspector tab inside Device Control, the keyboard hint and the soft-keyboard toggle, the per-device settings row that writes the keyboard preference | plans 215 and 212 |
| UHID keyboard passthrough, hotkeys, wheel, pinch, clipboard both ways | plan 209 (driver) and plan 215 (Studio) |
| Producing the activity list itself, the policy table, `device.activity` over `/ws` | plan 205 |
| Deleting `scripts/guest-agent.ts` and the two stale README claims about it and about `labelling.ts` (plan 201 §5 owns the exact replacement text and §10 owns the greps) | plan 201, with the fallback in step 221.12 if 201 has not merged |
| Adding a `guest-agent` component to `packages/core/src/device/preparation/registry.ts`. The agent still provisions through `agent-provisioner.ts` (`registry.ts:16-22`: "See `types.ts`'s own doc comment for why `guest-agent` and `scrcpy-server` are NOT here yet/ever") | nothing; the decision stands |
| Bumping the pinned ui-server version or answering plan 208 §9 Q1 | plan 208 |
| Any Studio or `@enkaku/ui` file, and any test under `packages/studio` or `packages/ui` (plan 200 §8.3: zero tests there) | not applicable |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03, quoted so the executor can match on content)

**The APK.** One app, four facets, four manifest components plus a receiver.

- `apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/control/Protocol.kt:52-53`:
  `val CAPABILITIES: List<String> =` / `listOf("socks5-route", "vpn-status", "egress-probe", "route-hold", "mock-location", "screen-label", "text-input")`
- `Protocol.kt:20`: `const val PROTOCOL_VERSION = 1`. `:18`: `const val SOCKET_NAME = "enkaku-guest-agent"`.
- `Protocol.kt:56-78` are the fourteen `METHOD_*` constants: `hello`, `ping`, `route.start`, `route.stop`, `route.status`, `egress.probe`, `route.hold`, `location.set`, `location.clear`, `label.apply`, `label.status`, `label.clear`, `text.commit`, `text.status`.
- `Protocol.kt:81-85`: five error codes, `E_UNAUTHORISED`, `E_BAD_REQUEST`, `E_UNKNOWN_METHOD`, `E_NOT_PAIRED`, `E_NOT_PREPARED`.
- `control/ControlService.kt:110-142` binds `LocalServerSocket(Protocol.SOCKET_NAME)` on a daemon thread and hands each accepted socket to a cached thread pool. `:145-162` `serve()` is the loop: `val line = reader.readLine() ?: return`, one `handle(line)` per line, `writer.write(response.toString())`, `writer.write("\n")`, `writer.flush()`.
- `ControlService.kt:164-189` is authorisation and bookkeeping: `if (!Pairing.hasToken())` → `E_NOT_PAIRED`, `if (!Pairing.matches(token))` → `E_UNAUTHORISED`, then `deadMan.touch()` and `ControlChannelState.recordRequest(method)`.
- `ControlService.kt:190-417` is the `when (method)` dispatch; `:416` is `else -> error(id, Protocol.ERR_UNKNOWN_METHOD, "unknown method: $method")`.
- `ControlService.kt:434-467` are the four helpers a new branch reuses: `ok(id) { ... }`, `error(id, code, message)`, and the two `putOrNull` overloads, whose doc comment at `:451-460` records that `org.json.JSONObject.put(key, null)` **removes** the key rather than emitting a JSON null.
- `control/ControlChannelState.kt:27-93` is the pattern every new in-process state object copies: atomics only, `SystemClock.elapsedRealtime()` stamps, `const val NEVER = 0L`, and "Deliberately holds nothing secret" (`:24-26`).
- `control/Pairing.kt` holds the token; nothing on the status screen reads it.
- `StatusActivity.kt:130-149` `buildReport()` builds the five sections in order: `linkSection`, `routeSection`, `checksSection`, `keyboardSection`, `buildSection`. `:412-431` `render()` clears `R.id.sections` and adds a header plus one row view per row, skipping an empty section (`:425` `if (section.rows.isEmpty()) continue`). `:604-613` holds `REFRESH_INTERVAL_MS = 2_000L`, `LABEL_WIDTH_DP = 118`, `ENKAKU_IME_ID`.
- `StatusActivity.kt:66-71`'s doc comment is the rule this plan must keep: "Rows are built in code rather than declared in XML for the honesty rule above: a row that has nothing to say is never added."
- `res/layout/activity_status.xml:82-87` is the empty `LinearLayout android:id="@+id/sections"` the Kotlin fills; `:117-143` are the three buttons (`refresh_button`, `copy_button`, `switch_keyboard_button`).
- `res/values/strings.xml` holds every string; `res/values/colors.xml` holds the five tones plus four banner backgrounds.
- `input/EnkakuIme.kt:32-118`: `connected` is set in `onStartInputView` and cleared in `onFinishInputView`; `COMPONENT_ID = "dev.enkaku.guestagent/.input.EnkakuIme"`; `isCurrent()` reads `Settings.Secure.DEFAULT_INPUT_METHOD`; `isEnabled()` reads `enabledInputMethodList`.
- `input/TextFacet.kt:56-67` `status()` returns `StatusOutcome(ime, id, connected)` and nothing else.
- `identity/MockLocation.kt` is stateless by design (`:19-24`: "A stateless singleton") and therefore remembers no fix.
- `route/DeadMansSwitch.kt:73-77`: `HEARTBEAT_HINT_MS = 20_000L`, `DEFAULT_TIMEOUT_MS = 90_000L` ("Four missed heartbeats").
- `app/build.gradle.kts:8,14,15`: `compileSdk = 36`, `minSdk = 29`, `targetSdk = 36`. `:21-22`: `versionCode`/`versionName` from `ENKAKU_GUEST_AGENT_VERSION_CODE`/`_NAME`, defaulting to `1`/`"dev"`. `:56-66` and `:75-77`: the release `signingConfig` activates only when `ENKAKU_GUEST_AGENT_KEYSTORE_PATH` is set. `:73` `isMinifyEnabled = true`.
- `AndroidManifest.xml:12-29` are the seven `<uses-permission>` entries; `:59-125` are `BootstrapActivity`, `StatusActivity`, `ControlService`, `RouteVpnService` and `EnkakuIme`. Note `:88-91` and `:106-113`: `BIND_VPN_SERVICE` and `BIND_INPUT_METHOD` are **`android:permission` attributes the system holds**, not `<uses-permission>` entries. `BIND_ACCESSIBILITY_SERVICE` is the third member of that family and is declared the same way.
- There is **no** `apps/guest-agent/app/src/test` and no `androidTest`. `app/src/main` is the only source set: the APK has zero JVM and zero instrumented tests today. `app/build.gradle.kts:107-114` declares the dependencies for both, and nothing uses them.

**The host side.**

- `packages/protocol/src/guest-agent.ts:57-65` `GuestAgentCapabilitySchema` mirrors `Protocol.CAPABILITIES`; `:30` `export const GUEST_AGENT_PROTOCOL = 1`; `:92-242` are the fourteen request schemas and their discriminated union; `:247-355` the results; `:434-476` the response envelope.
- `packages/protocol/src/ui-node.ts:35-63` is `UiNode` and `UiNodeSchema`, the exact eleven fields this plan's Kotlin must emit. `:12-17` `SelectorSchema` is the four-arm union.
- `packages/protocol/src/selector-match.ts:22-29` `matches()` is the comparison the agent must reproduce: `node.resourceId === sel.id || node.resourceId.endsWith(':id/' + sel.id)`, `node.desc.trim() === sel.desc.trim()`, `node.text.trim() === sel.text.trim()`. `:69-…` `matchSelector` is depth-first, first match, and fabricates a synthetic node for `{ point }`.
- `packages/drivers/src/inspector/xml-parser.ts:38-52` `toUiNode` and `:55-74` `parseUiDump` are what both existing engines return. The synthetic root is `className: 'hierarchy'`, everything else empty, `enabled: true`, `bounds` all zero, `index: 0`.
- `packages/drivers/src/inspector/ui-server/index.ts:103-122` `dump()` is `parseUiDump(await this.client.dumpWindowHierarchy(false))`, so **ui-server and `uiautomator dump` already return byte-identical shapes**; matching them is a matter of matching `toUiNode`'s eleven fields, not of matching a second format.
- `packages/drivers/src/network/guest-agent/client.ts:144-195` is the `GuestAgentClient` interface (fourteen methods, `textStatus` at `:194` still with no host caller today). `:198-266` `sendOnce` is one connect, one write, one line read, close. `:269-306` `call()` validates the envelope then the result schema.
- `packages/drivers/src/network/guest-agent/launcher.ts:372-408` `ensurePreGranted()` is the exact pattern the accessibility enablement copies: probe, `appops set`, capture the failure text without throwing, **read back**, and classify. `:257-271` `classify()` returns a `{ state, reason }` result object rather than throwing, "because 'this phone will not pre-grant VPN consent from adb' is not the same event as 'the agent could not be installed or reached'" (`:64-67`).
- `launcher.ts:448-468` `forward()` holds the host-port ownership check: `const owner = list.find((f) => f.local === \`tcp:${localPort}\`)` then `if (!owner || owner.serial !== deps.serial) throw`. Every device's agent listens on the same abstract socket name, so a rebound host port would silently drive another phone. **A `ui.watch` subscription opens a second connection to the same forwarded port and inherits this guarantee; it must never allocate a forward of its own.**
- `packages/drivers/src/network/guest-agent/vpn-helper.ts:64-87` `GuestAgentSession.withClient` is the one place allowed to mint a token for a device. `packages/core/src/api/guest-agent.ts:307,755` expose it as `withGuestAgentClient`.
- `packages/core/src/device/agent-provisioner.ts:118-138` is the `AgentProvisioner` interface: `ensure`, `status`, `ensureAll`, `remove`, `runningSince`. `:56` `MIN_SUPPORTED_SDK = 29`.
- `packages/core/src/device/preparation/registry.ts:23-34` returns exactly one component, `createUiServerComponent`; `:16-22` says `guest-agent` is deliberately not one.
- `packages/toolchain/manifest/enkaku-tools.json:130-154` is the `guest-agent` entry: `"version": "0.1.8"`, `"compatibleCoreRange": "TODO-M55"`, `deviceArtifact.versionCode: 1008`, `signatureSha256: "420222E0C1BD95A6EA11C0F735B0F7CEEF48C05877F487308F80FCF5895048B6"`, and a real `url`/`sha256`/`sizeBytes` for `v0.1.8`.
- `.github/workflows/release.yml:80-154` `build-guest-agent` already builds, signs, size-budgets and uploads the APK, and `:265-288` `publish` attaches it and its `SHA256SUMS.txt` row. **What it does not do is write the pin**, which is why `apps/guest-agent/README.md:70-74` documents a two-tag manual dance.
- `.github/workflows/ci.yml:170-201`: the `changes` job's `dorny/paths-filter` watches `apps/guest-agent/**` and `scripts/build-guest-agent.sh`; the `android` job builds `--debug` only.
- `scripts/build-guest-agent.sh:51-66` resolves the artifact (`app-release.apk`, falling back to `app-release-unsigned.apk`) and prints its sha256.

**Stale text this plan is accountable for.**

- `apps/guest-agent/README.md:68` claims "**Tier 3 cannot fire yet on a real release**: the manifest's `version`, the download `sha256`/`url`, and `deviceArtifact.versionCode` are all `TODO-*`/`0` sentinels". The manifest at `:136-152` carries a real `0.1.8` pin. False today, and this plan's release change makes `:70-74`'s two-tag dance obsolete as well.
- `apps/guest-agent/README.md:221` states the committed `signatureSha256` is `BAA2B36DD52BE50EAE2036404E130065EBF3836D904A6137D740FBE378EDB32F`; `enkaku-tools.json:143` says `420222E0C1BD95A6EA11C0F735B0F7CEEF48C05877F487308F80FCF5895048B6`. The two disagree. See §9 Q1.
- Four lease mentions in the Kotlin, assigned to this plan by plan 205 §2: `route/DeadMansSwitch.kt:24` ("Host-side lease teardown is still the normal path"), `route/RouteVpnService.kt:114` ("a route belongs to a lease") and `:115` ("a route whose lease has ended"), `control/ControlService.kt:48` ("Host-side lease teardown is the normal path").
- `label/LabelRenderer.kt:44` says "Grapheme-cluster cap". That is the Unicode term, not the removed product noun, and `GREP_221` excludes it explicitly.

### 3.2 Decisions

1. **`PROTOCOL_VERSION` stays 1.** Every new method is additive and every one is gated on a capability string, so an older agent answers `E_UNKNOWN_METHOD` and the host reads that as "this build cannot do it" (`guest-agent.ts:52-55`, the same treatment `text-input` already gets). Bumping the version would make `client.ts:326-335` throw `E_PROTOCOL_MISMATCH` against **every deployed agent on the owner's farm** and force a fleet-wide reinstall for no wire-shape change. MVP 10 §3 says the same in product terms: "The host treats an agent without them as an older build, not as an error."
2. **The node shape is not re-derived; it is reused.** `UiNodeSchema` (`ui-node.ts:49-63`) is the contract. The Kotlin emits those eleven keys and nothing else, and the synthetic root copies `parseUiDump`'s root byte for byte (`className: "hierarchy"`, empty strings, zero bounds, `enabled: true`, `index: 0`). This is what makes plan 222 a swap of the engine rather than a rewrite of every selector, and it is what G3's tree diff measures.
3. **`ui.find` runs on the device and reproduces `matches()` exactly.** The whole reason to move the find on-device is to stop shipping a full tree per poll. Any divergence between the Kotlin comparison and `selector-match.ts:22-29` would make the Inspect panel's match count a lie, which `selector-match.ts:5-14` exists to prevent. `{ point }` is refused with `E_BAD_REQUEST`: it is a host-side synthetic node (`matchSelector`'s `{ point }` arm) and there is nothing on the device to look up.
4. **`ui.watch` is a subscription on its own connection, and the event carries no tree.** The agent answers the `ui.watch` request with a normal one-line ack, then writes newline-delimited event frames on that same connection until the peer sends `ui.unwatch` or closes it. The event is `{ event, seq, at, packageName, reason }`: the host calls `ui.dump` or `ui.find` on a **different** connection when it wants content. Two reasons: serialising a tree on every `TYPE_WINDOW_CONTENT_CHANGED` would flood a busy screen, and a tiny event keeps the 200 ms budget (G6) a function of the debounce alone. Exactly one watcher connection per agent; a second `ui.watch` closes the first, because there is exactly one core per device.
5. **The host client's one-shot `sendOnce` is not changed.** `client.ts:198-266` reads one line and closes, which is right for every other method. The subscription gets its own function in a new file, `ui-watch.ts`, so nothing that works today changes shape. It reuses the same forwarded port and therefore the same host-port ownership guarantee (`launcher.ts:448-468`).
6. **Accessibility enablement is provisioning-scoped, not prep-scoped.** The IME is applied at session start and reverted on close (`README.md:110`), because a farm must hand a phone back with its own keyboard. The accessibility service is the opposite: MVP 02 §4 phase 2 wants it alive as long as the agent, with no per-session process, so it is enabled once during provisioning and left enabled. `AgentProvisioner.ensure()` is idempotent and already runs on every hook, so it is the right owner.
7. **`pm grant` is not part of the enablement sequence.** `BIND_ACCESSIBILITY_SERVICE` is a system-held `android:permission` attribute on the service, exactly like `BIND_VPN_SERVICE` and `BIND_INPUT_METHOD` (`AndroidManifest.xml:88-91`, `:106-113`). There is no dangerous runtime permission to grant and no new `<uses-permission>` entry, so `GUEST_AGENT_RUNTIME_PERMISSIONS` (`launcher.ts:43`) is unchanged and `launcher.manifest.test.ts` keeps passing. The executor must not add one.
8. **The appops call is mandatory before the settings write, and the result decides.** R4: Android 13+ restricted settings block enabling an accessibility service for an app installed by a non-session installer, `settings put secure enabled_accessibility_services` can be refused outright, and the documented workaround is `cmd appops set <pkg> ACCESS_RESTRICTED_SETTINGS allow` before the write. R4's caveat is explicit that **no source settles whether `adb install` is exempt on every OEM**, so this plan does not assume it: the appops call always runs, the settings write always runs, and a read-back always decides. A refusal is a `{ state: 'pending', reason }` result, never a thrown error, mirroring `launcher.ts:257-271`.
9. **The Video row is pushed by the host, not read from `/proc`.** MVP 10 §2 says "read from the process list". An ordinary app on API 29 and above cannot see another process's `cmdline`, so a `/proc` scan would produce an empty row on every real device, and the screen's omit-unknown rule would then hide the section permanently. The honest version is the host telling the phone what it started, carried in `activity.set`'s `video` block and marked stale with everything else in Now. The `/proc` visibility question is recorded in §9 Q3 as "to verify"; nothing in §5 depends on the answer.
10. **The Device section's farm facts are pushed too, by `device.describe`.** Stable id, farm label, number, group and tags are things only the host knows. Model, Android version, battery, charging state and screen state are read on the device by `StatusActivity` itself. The word is **group**, never "cluster" (plan 200 §2.4).
11. **Staleness uses the control-channel timeout, as MVP 10 §1.3 says.** That is `DeadMansSwitch.DEFAULT_TIMEOUT_MS` = 90 000 ms, four missed 20 s heartbeats (`DeadMansSwitch.kt:73-77`). It is named once, in `ActivityMirror.STALE_AFTER_MS`, so a future change is one constant. A stale list is rendered with `Tone.WARN` under a "no contact from the farm for N" row and never as current.
12. **No Compose, no new dependency, no new source set.** `app/build.gradle.kts`'s `dependencies` block is untouched. The status screen keeps building rows in Kotlin against the same XML shell. The APK stays under the 4 MiB budget `release.yml:144` enforces.
13. **The Kotlin gets no unit tests.** There are none today (§3.1) and the classes this plan adds are `AccessibilityService`, `InputMethodService` and `Activity` subclasses whose interesting behaviour needs a device or Robolectric. Plan 200 §8.3's critical list does not include Android UI. What **is** tested is everything that crosses the wire: the Zod schemas in `packages/protocol` (the wire contract) and the client methods in `packages/drivers` (the framing). The tree-shape claim of G3 is a hardware measurement by construction and is verified by a diff tool, not by a unit test.
14. **The release pins the APK by rewriting the manifest, not by asking a human to.** `release.yml` already knows the sha256 (`:142`) and the versionCode (`:105`). A new `scripts/pin-guest-agent.ts` writes those five fields into `enkaku-tools.json`, and the workflow commits the result on the release commit. This closes plan 43 §5.11 and deletes `README.md:70-74`'s two-tag dance.

## 4. Technical design

### 4.1 Wire contract, Kotlin side (`control/Protocol.kt`)

```kotlin
  /**
   * `ui-tree` (plan 221 §4.2, MVP 02 §4 phase 2, MVP 10 §1.1): gates [METHOD_UI_DUMP] /
   * [METHOD_UI_FIND] / [METHOD_UI_WATCH] / [METHOD_UI_UNWATCH] / [METHOD_UI_STATUS], backed by
   * `ui/UiTreeService.kt`. Advertised by every build that CONTAINS the service, whether or not the
   * service is currently enabled in Settings: the capability says what the build can do, and
   * `ui.status` says whether it can do it right now. Conflating the two would make an unenabled
   * service look like an old APK, which is a different repair.
   *
   * `activity` (plan 221 §4.5, MVP 10 §1.3): gates [METHOD_ACTIVITY_SET] and
   * [METHOD_DEVICE_DESCRIBE]. Read-only on the device: nothing here acts on the list, it only
   * lets the phone's own screen say what the farm is doing to it.
   */
  val CAPABILITIES: List<String> =
    listOf(
      "socks5-route", "vpn-status", "egress-probe", "route-hold", "mock-location",
      "screen-label", "text-input", "ui-tree", "activity",
    )

  /** Plan 221 §4.2. */
  const val METHOD_UI_DUMP = "ui.dump"
  const val METHOD_UI_FIND = "ui.find"
  const val METHOD_UI_WATCH = "ui.watch"
  const val METHOD_UI_UNWATCH = "ui.unwatch"
  const val METHOD_UI_STATUS = "ui.status"

  /** Plan 221 §4.5. */
  const val METHOD_ACTIVITY_SET = "activity.set"
  const val METHOD_DEVICE_DESCRIBE = "device.describe"

  /** Plan 221 §4.6. */
  const val METHOD_TEXT_PREFS = "text.prefs"

  /** The event frame's own `event` value — never a `method`, so a reader can tell a push from a reply. */
  const val EVENT_UI_CHANGED = "ui.changed"

  /** Plan 221 §4.2: the service is in the build but is not enabled in Settings, or is enabled and not yet connected. */
  const val ERR_UI_TREE_UNAVAILABLE = "E_UI_TREE_UNAVAILABLE"
```

`PROTOCOL_VERSION` is **not** touched (§3.2 decision 1).

### 4.2 `ui/UiTreeService.kt` (new; the file this plan ships)

```kotlin
package dev.enkaku.guestagent.ui

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.lang.ref.WeakReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * The first-party inspector (MVP 02 §4 phase 2, MVP 10 §1.1). An [AccessibilityService] reading
 * the same data source UiAutomator reads ([AccessibilityNodeInfo]) and emitting the SAME node
 * shape `packages/protocol/src/ui-node.ts` defines, so selectors, the Zod schema and every
 * consumer carry over unchanged.
 *
 * It passes the APK rule (`apps/guest-agent/README.md`, "the rule that decides what goes in it"):
 * there is no shell equivalent that survives without `am instrument`, which is exactly the
 * instrumentation this replaces.
 *
 * What it must never do is overstate. A tree that hit [MAX_NODES] is reported with
 * `truncated: true` rather than as a complete tree, and a service that is in the build but not
 * enabled in Settings answers `E_UI_TREE_UNAVAILABLE` rather than an empty tree.
 */
class UiTreeService : AccessibilityService() {

  override fun onServiceConnected() {
    serviceInfo =
      AccessibilityServiceInfo().apply {
        eventTypes =
          AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
            AccessibilityEvent.TYPE_WINDOWS_CHANGED
        feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        // FLAG_INCLUDE_NOT_IMPORTANT_VIEWS: `uiautomator dump` includes them, so omitting them
        // would make the two trees differ for a reason nothing in the product asked for.
        // FLAG_REPORT_VIEW_IDS: without it `viewIdResourceName` is null and every `{ id }`
        // selector silently stops matching.
        // FLAG_RETRIEVE_INTERACTIVE_WINDOWS: `windows` is empty without it, and the dump would
        // carry only the active window where the dump engine carries all of them.
        flags =
          AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
            AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        // 0, not the platform default: the platform's own coalescing window would add latency on
        // top of UiTreeWatch's own debounce, and one coalescer is enough (§4.4).
        notificationTimeout = 0
      }
    active = WeakReference(this)
    UiTreeState.markConnected()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val pkg = event?.packageName?.toString().orEmpty()
    val reason =
      when (event?.eventType) {
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> "window"
        AccessibilityEvent.TYPE_WINDOWS_CHANGED -> "windows"
        else -> "content"
      }
    UiTreeState.recordEvent()
    UiTreeWatch.onChanged(pkg, reason)
  }

  override fun onInterrupt() {
    // Nothing to interrupt: this service speaks to no one but the control channel.
  }

  override fun onUnbind(intent: Intent?): Boolean {
    if (active?.get() === this) active = null
    UiTreeState.markDisconnected()
    return super.onUnbind(intent)
  }

  /** `[width, height]` of the default display, for the dump's own `frameSize` (never the video's). */
  private fun frameSize(): Pair<Int, Int> {
    val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    return if (Build.VERSION.SDK_INT >= 30) {
      val b = wm.currentWindowMetrics.bounds
      b.width() to b.height()
    } else {
      @Suppress("DEPRECATION")
      val size = android.graphics.Point().also { wm.defaultDisplay.getRealSize(it) }
      size.x to size.y
    }
  }

  /**
   * The whole tree, as [UiNodeSchema]-shaped JSON. The synthetic root copies
   * `packages/drivers/src/inspector/xml-parser.ts`'s `parseUiDump` root byte for byte — a
   * `className` of `"hierarchy"`, empty strings, zero bounds, `enabled: true`, `index: 0` — so a
   * consumer cannot tell which engine produced it.
   */
  fun dump(maxDepth: Int, maxNodes: Int): Dump {
    val started = System.nanoTime()
    val counter = Counter(maxNodes)
    val children = JSONArray()
    val roots = windowRoots()
    for ((ordinal, root) in roots.withIndex()) {
      children.put(toJson(root, ordinal, 1, maxDepth, counter))
    }
    val (width, height) = frameSize()
    val root =
      JSONObject().apply {
        put("resourceId", "")
        put("text", "")
        put("desc", "")
        put("className", "hierarchy")
        put("packageName", "")
        put("bounds", boundsJson(0, 0, 0, 0))
        put("clickable", false)
        put("enabled", true)
        put("focused", false)
        put("index", 0)
        put("children", children)
      }
    val tookMs = ((System.nanoTime() - started) / 1_000_000L).toInt()
    UiTreeState.recordDump(counter.used, tookMs)
    return Dump(root, width, height, counter.used, counter.truncated, tookMs)
  }

  /**
   * Depth-first, first match, reproducing `packages/protocol/src/selector-match.ts`'s `matches()`
   * EXACTLY: `{ id }` is equality or a `:id/<short>` suffix, `{ desc }` and `{ text }` are
   * trimmed equality. `{ point }` never reaches here — `ControlService` refuses it with
   * `E_BAD_REQUEST`, because it is a host-side synthetic node with nothing on the device to look
   * up.
   */
  fun find(kind: String, value: String, maxDepth: Int, maxNodes: Int): Found {
    val started = System.nanoTime()
    val counter = Counter(maxNodes)
    var first: JSONObject? = null
    var count = 0
    for ((ordinal, root) in windowRoots().withIndex()) {
      walk(root, ordinal, 1, maxDepth, counter) { node, json ->
        if (matches(node, kind, value)) {
          count++
          if (first == null) first = json()
        }
      }
    }
    return Found(first, count, ((System.nanoTime() - started) / 1_000_000L).toInt())
  }

  private fun matches(node: AccessibilityNodeInfo, kind: String, value: String): Boolean =
    when (kind) {
      "id" -> {
        val id = node.viewIdResourceName.orEmpty()
        id == value || id.endsWith(":id/$value")
      }
      "desc" -> node.contentDescription?.toString().orEmpty().trim() == value.trim()
      "text" -> node.text?.toString().orEmpty().trim() == value.trim()
      else -> false
    }

  /** Windows bottom to top by layer, each contributing its root; the active window alone when `windows` is empty. */
  private fun windowRoots(): List<AccessibilityNodeInfo> {
    val fromWindows = runCatching { windows.sortedBy { it.layer }.mapNotNull { it.root } }.getOrDefault(emptyList())
    if (fromWindows.isNotEmpty()) return fromWindows
    return listOfNotNull(rootInActiveWindow)
  }

  private fun toJson(node: AccessibilityNodeInfo, index: Int, depth: Int, maxDepth: Int, counter: Counter): JSONObject {
    counter.take()
    val rect = Rect().also { node.getBoundsInScreen(it) }
    val children = JSONArray()
    if (depth < maxDepth) {
      for (i in 0 until node.childCount) {
        if (counter.exhausted()) break
        val child = node.getChild(i) ?: continue
        children.put(toJson(child, i, depth + 1, maxDepth, counter))
        recycleIfNeeded(child)
      }
    } else {
      counter.truncated = true
    }
    return JSONObject().apply {
      put("resourceId", node.viewIdResourceName.orEmpty())
      put("text", node.text?.toString().orEmpty())
      put("desc", node.contentDescription?.toString().orEmpty())
      put("className", node.className?.toString().orEmpty())
      put("packageName", node.packageName?.toString().orEmpty())
      put("bounds", boundsJson(rect.left, rect.top, rect.right, rect.bottom))
      put("clickable", node.isClickable)
      put("enabled", node.isEnabled)
      put("focused", node.isFocused)
      put("index", index)
      put("children", children)
    }
  }

  private fun boundsJson(left: Int, top: Int, right: Int, bottom: Int): JSONObject =
    JSONObject().apply {
      put("left", left)
      put("top", top)
      put("right", right)
      put("bottom", bottom)
    }

  /**
   * `AccessibilityNodeInfo.recycle()` is deprecated from API 33 and is a no-op there, but below 33
   * a node obtained from `getChild` that is never recycled leaks the platform's node pool. minSdk
   * is 29, so both paths are live.
   */
  private fun recycleIfNeeded(node: AccessibilityNodeInfo) {
    if (Build.VERSION.SDK_INT < 33) {
      @Suppress("DEPRECATION")
      runCatching { node.recycle() }
    }
  }

  data class Dump(
    val root: JSONObject,
    val widthPx: Int,
    val heightPx: Int,
    val nodeCount: Int,
    val truncated: Boolean,
    val tookMs: Int,
  )

  data class Found(val node: JSONObject?, val matches: Int, val tookMs: Int)

  /** Bounds the walk so one pathological screen cannot produce a megabyte of JSON on a control socket. */
  class Counter(private val max: Int) {
    var used = 0
      private set
    var truncated = false
    fun take() { used++ }
    fun exhausted(): Boolean {
      if (used >= max) { truncated = true; return true }
      return false
    }
  }

  companion object {
    /** Matches openatx's own `maxDepth` ceiling (R5) — deep enough for every real screen, shallow enough to bound a cycle. */
    const val MAX_DEPTH = 50
    const val MAX_NODES = 5_000

    @Volatile private var active: WeakReference<UiTreeService>? = null

    /** The live service, or `null` when it is not enabled in Settings or not yet connected. */
    fun instance(): UiTreeService? = active?.get()

    /** `AccessibilityServiceInfo.getId()`'s form, the exact string the host writes into `enabled_accessibility_services`. */
    const val COMPONENT_ID = "dev.enkaku.guestagent/dev.enkaku.guestagent.ui.UiTreeService"
  }
}
```

The `walk(...)` helper used by `find` is the same traversal as `toJson` with the JSON build made lazy, so a find that matches nothing never serialises a node. Implement it as a private function in the same file taking a `(AccessibilityNodeInfo, () -> JSONObject) -> Unit` visitor.

**`res/xml/ui_tree_service.xml`** (new):

```xml
<?xml version="1.0" encoding="utf-8"?>
<!--
  The declarative half of UiTreeService's configuration. `onServiceConnected` overwrites
  `serviceInfo` with the same values at runtime (see UiTreeService.kt) because a service that is
  enabled by an adb `settings put` never passes through the Settings UI that would otherwise apply
  these; both halves are kept in step deliberately.
-->
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeWindowContentChanged|typeWindowStateChanged|typeWindowsChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagIncludeNotImportantViews|flagReportViewIds|flagRetrieveInteractiveWindows"
    android:canRetrieveWindowContent="true"
    android:notificationTimeout="0"
    android:description="@string/ui_tree_service_description"
    android:settingsActivity="dev.enkaku.guestagent.StatusActivity" />
```

**`AndroidManifest.xml`** gains one service, beside `EnkakuIme`:

```xml
        <!--
          Plan 221 §4.2 — the first-party inspector. `BIND_ACCESSIBILITY_SERVICE` is a
          system-held permission ATTRIBUTE, exactly like RouteVpnService's BIND_VPN_SERVICE and
          EnkakuIme's BIND_INPUT_METHOD above; this app declares no <uses-permission> of its own
          for it and needs no `pm grant`. `exported="true"` is required for the system to bind it
          at all, and is safe for the same reason: only a caller holding BIND_ACCESSIBILITY_SERVICE
          (the system) can reach it.
        -->
        <service
            android:name=".ui.UiTreeService"
            android:exported="true"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
            android:label="@string/app_name">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/ui_tree_service" />
        </service>
```

**`app/proguard-rules.pro`** gains one keep, beside the existing component keeps:

```
-keep class dev.enkaku.guestagent.ui.UiTreeService { *; }
```

### 4.3 `ui/UiTreeState.kt` (new) — what the status screen reads

Same shape as `ControlChannelState` (atomics, `SystemClock.elapsedRealtime()` stamps, `NEVER = 0L`, nothing secret):

```kotlin
object UiTreeState {
  const val NEVER = 0L
  fun markConnected()
  fun markDisconnected()
  fun recordEvent()
  fun recordDump(nodeCount: Int, tookMs: Int)
  fun recordError(message: String)
  fun isConnected(): Boolean
  fun connectedAt(): Long
  fun lastEventAt(): Long
  fun eventCount(): Int
  fun lastDumpAt(): Long
  fun lastDumpNodes(): Int
  fun lastDumpTookMs(): Int
  fun lastError(): String?
}
```

### 4.4 `ui/UiTreeWatch.kt` (new) — the subscription

```kotlin
object UiTreeWatch {
  /** One watcher per agent: there is exactly one core per device. A second subscribe closes the first. */
  const val DEBOUNCE_MS = 50L

  /** Registers [sink] as the sole watcher, closing whatever was there. Returns the subscription's seq base (always 0). */
  fun subscribe(sink: (JSONObject) -> Unit): Int
  fun unsubscribe()
  fun isWatching(): Boolean
  /** Called from `UiTreeService.onAccessibilityEvent`; coalesces bursts within [DEBOUNCE_MS] into one frame. */
  fun onChanged(packageName: String, reason: String)
}
```

Rules the implementation must follow:

- The debounce is a single-thread `ScheduledExecutorService` (daemon thread `enkaku-ui-watch`), matching `DeadMansSwitch`'s own executor shape. A burst of events inside `DEBOUNCE_MS` produces exactly one frame, carrying the **last** `packageName` and `reason` seen.
- `seq` increments per delivered frame, starting at 1, and resets to 0 on `subscribe`. It is the host's gap detector.
- The frame is `{ "event": "ui.changed", "seq": <int>, "at": <unix seconds>, "packageName": <string>, "reason": "content" | "window" | "windows" }`. It carries **no** node data.
- A frame is written with the same `BufferedWriter` the request/response loop uses on that connection, inside a `synchronized (writer)` block. `ControlService.serve()` must take the same lock around its own `writer.write(...)`/`flush()` so a reply and an event can never interleave mid-line.
- A write failure (the peer went away) calls `unsubscribe()` and lets the connection die; it is never retried and never logged as an error, because a host that closed a subscription is the ordinary case.

### 4.5 `activity/ActivityMirror.kt` (new) — the read-only mirror

```kotlin
object ActivityMirror {
  /** MVP 10 §1.3: "the control-channel timeout". Named once so a change is one constant. */
  const val STALE_AFTER_MS = dev.enkaku.guestagent.route.DeadMansSwitch.DEFAULT_TIMEOUT_MS

  data class Activity(val id: String, val kind: String, val label: String, val actorLabel: String, val startedAt: Long)
  data class Video(val running: Boolean, val widthPx: Int, val heightPx: Int, val fps: Int)
  data class Device(
    val stableId: String?, val label: String?, val number: String?, val group: String?, val tags: List<String>,
  )

  fun setActivities(activities: List<Activity>, video: Video?)
  fun setDevice(device: Device)
  fun activities(): List<Activity>
  fun video(): Video?
  fun device(): Device?
  /** [SystemClock.elapsedRealtime] of the last `activity.set`, or [NEVER]. */
  fun updatedAt(): Long
  /** True once the FARM (not this method) has been silent longer than [STALE_AFTER_MS] — reads `ControlChannelState.lastRequestAt()`. */
  fun isStale(): Boolean
}
```

The mirror stores and reports. It never acts, never starts anything, and never persists: a restarted agent has no list until the host pushes one, and the screen says so ("the farm has not sent an activity list since this app started") rather than showing an old one.

**`activity.set`** request:

```jsonc
{
  "id": "...", "token": "...", "method": "activity.set",
  "activities": [
    { "id": "job:482", "kind": "job", "label": "Running tiktok/login (job #482)", "actorLabel": "Scheduler", "startedAt": 1756900000 }
  ],
  "video": { "running": true, "widthPx": 1080, "heightPx": 2400, "fps": 30 }
}
```

`kind` is `ActivityKindSchema`'s ten members (plan 205 §4.1). `video` is nullable: `null` means "the farm is not running a scrcpy server on this device", which is a fact, not an absence. Result: `{ "accepted": <int> }`, the number of activities stored.

**`device.describe`** request: `{ ..., "method": "device.describe", "stableId": string|null, "label": string|null, "number": string|null, "group": string|null, "tags": string[] }`. Result: `{ "accepted": true }`.

### 4.6 The IME additions

**`text.prefs`** request: `{ ..., "method": "text.prefs", "showSoftKeyboardWithHardware": boolean }`. Result: the read-back, `{ "showSoftKeyboardWithHardware": boolean }`, never the value that was sent.

Persistence: `SharedPreferences` file `enkaku-ime`, key `show_soft_keyboard_with_hardware`, default `false`. A `SharedPreferences` file survives a reboot and a process death, which is what "the operator's choice survives sessions" means (MVP 10 §1.2) and what G10 measures.

`EnkakuIme` gains:

```kotlin
  /**
   * MVP 08 §1.2's UHID side effect, answered on the device: when scrcpy creates a virtual hardware
   * keyboard, Android hides the soft keyboard, and an operator who wants to see it has no way to
   * ask. This is that way. Per device, applied here, persisted in SharedPreferences so it survives
   * the session that set it and the next reboot.
   */
  override fun onEvaluateInputViewShown(): Boolean =
    if (ImePrefs.showSoftKeyboardWithHardware(this)) true else super.onEvaluateInputViewShown()
```

`TextFacet.StatusOutcome` gains two fields, and `text.status`'s result gains the same two:

| Field | Meaning | Read from |
|---|---|---|
| `connected` (existing) | a field is focused right now | `EnkakuIme.instance()?.hasConnection()` |
| `softKeyboardShown` (new) | the soft keyboard is actually showing | `EnkakuIme.instance()?.isInputViewShown` |
| `showSoftKeyboardWithHardware` (new) | the per-device preference | `ImePrefs.showSoftKeyboardWithHardware(context)` |

Both new fields are **added**, and `ime`, `id` and `connected` keep their exact current meaning. `packages/protocol/src/guest-agent.ts`'s `TextStatusResultSchema` gains the two as `.optional()`, because an older agent build omits them and `client.ts:470-477` must keep parsing that build's answer.

### 4.7 Zod, host side (`packages/protocol/src/guest-agent.ts`)

```ts
import { SelectorSchema, UiNodeSchema } from './ui-node'
import { ActivityKindSchema } from './activity'

// ---- capabilities ----

export const GuestAgentCapabilitySchema = z.enum([
  'socks5-route',
  'vpn-status',
  'egress-probe',
  'route-hold',
  'mock-location',
  'screen-label',
  'text-input',
  /** Plan 221 §4.2 — gates `ui.dump` / `ui.find` / `ui.watch` / `ui.unwatch` / `ui.status`. */
  'ui-tree',
  /** Plan 221 §4.5 — gates `activity.set` and `device.describe`. */
  'activity',
])

export const GuestAgentErrorCodeSchema = z.enum([
  'E_UNAUTHORISED',
  'E_BAD_REQUEST',
  'E_UNKNOWN_METHOD',
  'E_NOT_PAIRED',
  'E_NOT_PREPARED',
  /** Plan 221 §4.2 — the build has the service, the device has not enabled it (or it is not connected yet). */
  'E_UI_TREE_UNAVAILABLE',
])

// ---- hello gains the host's own pin ----

export const HelloRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('hello'),
  /**
   * Plan 221 §4.9, MVP 10 §2 — the `deviceArtifact.versionCode` this host has pinned. The agent
   * stores it and its status screen says "host expects build N" when N is higher than its own, so
   * an outdated agent says so itself instead of waiting for someone to compare two numbers by
   * hand. Optional: an older host omits it and the row is simply absent.
   */
  expectVersionCode: z.number().int().positive().optional(),
})

// ---- ui-tree ----

/** Plan 221 §4.2. `maxDepth`/`maxNodes` bound the walk; both default on the device (50 / 5000). */
export const UiDumpRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ui.dump'),
  maxDepth: z.number().int().positive().max(200).optional(),
  maxNodes: z.number().int().positive().max(50_000).optional(),
})
export type UiDumpRequest = z.infer<typeof UiDumpRequestSchema>

/**
 * The tree, in the SAME shape `uiautomator dump` and ui-server already return
 * (`packages/drivers/src/inspector/xml-parser.ts`'s `parseUiDump`): a synthetic
 * `className: 'hierarchy'` root whose children are the window roots. `root` is `UiNodeSchema`
 * itself, not a copy — that identity is what makes plan 222 an engine swap rather than a rewrite.
 * `truncated` is honest, not decorative: a tree that hit the node or depth cap says so, and a
 * caller must never render a truncated tree as complete.
 */
export const UiDumpResultSchema = z.object({
  root: UiNodeSchema,
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  nodeCount: z.number().int(),
  truncated: z.boolean(),
  tookMs: z.number().int(),
})
export type UiDumpResult = z.infer<typeof UiDumpResultSchema>

/**
 * Plan 221 §4.2. `selector` is `SelectorSchema` minus its `{ point }` arm: a point selector is a
 * host-side synthetic node (`selector-match.ts`'s `matchSelector`), so sending one to the device
 * is a caller bug and the client refuses it before the wire.
 */
export const UiFindRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ui.find'),
  selector: z.union([
    z.object({ id: z.string() }).strict(),
    z.object({ desc: z.string() }).strict(),
    z.object({ text: z.string() }).strict(),
  ]),
  maxDepth: z.number().int().positive().max(200).optional(),
  maxNodes: z.number().int().positive().max(50_000).optional(),
})
export type UiFindRequest = z.infer<typeof UiFindRequestSchema>

/** `matches` is the full count, so an ambiguous selector is reported as such (`findDetailed`'s contract). */
export const UiFindResultSchema = z.object({
  node: UiNodeSchema.nullable(),
  matches: z.number().int(),
  tookMs: z.number().int(),
})
export type UiFindResult = z.infer<typeof UiFindResultSchema>

export const UiWatchRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ui.watch'),
})
export const UiUnwatchRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ui.unwatch'),
})

/** The one-line ack. Every later line on that connection is a `UiChangedEvent`, never a response. */
export const UiWatchResultSchema = z.object({ watching: z.literal(true), debounceMs: z.number().int() })
export const UiUnwatchResultSchema = z.object({ watching: z.literal(false) })

/**
 * Plan 221 §4.4 — an unsolicited frame, discriminated by `event` rather than by `ok`, so a reader
 * can tell a push from a reply with one key and never has to guess. It carries no tree: the host
 * calls `ui.dump` or `ui.find` on a different connection when it wants content.
 */
export const UiChangedEventSchema = z.object({
  event: z.literal('ui.changed'),
  seq: z.number().int(),
  at: z.number().int(),
  packageName: z.string(),
  reason: z.enum(['content', 'window', 'windows']),
})
export type UiChangedEvent = z.infer<typeof UiChangedEventSchema>

export const UiStatusRequestSchema = GuestAgentRequestBaseSchema.extend({ method: z.literal('ui.status') })

/**
 * `enabled` is the Settings fact, `connected` is the runtime fact, and they are not the same:
 * a service can be listed in `enabled_accessibility_services` and still not be bound. Reported
 * separately because the repair differs (write the setting, versus wait or reboot).
 */
export const UiStatusResultSchema = z.object({
  enabled: z.boolean(),
  connected: z.boolean(),
  watching: z.boolean(),
  lastDumpAgoMs: z.number().int().nullable(),
  lastDumpNodes: z.number().int().nullable(),
  lastError: z.string().nullable(),
})
export type UiStatusResult = z.infer<typeof UiStatusResultSchema>

// ---- activity mirror ----

export const GuestAgentActivitySchema = z.object({
  id: z.string(),
  kind: ActivityKindSchema,
  label: z.string(),
  /** Already resolved by the host (`DeviceActivity.actor.label`) — the agent never sees an id it would have to resolve. */
  actorLabel: z.string(),
  startedAt: z.number().int(),
})

/**
 * Plan 221 §4.5, MVP 10 §1.3. Read-only on the device: nothing acts on this list, it exists so
 * the phone's own screen can say what the farm is doing to it. `video` is what the HOST started,
 * never a claim that anyone is watching (MVP 10 §2's Video row); `null` means no scrcpy server.
 */
export const ActivitySetRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('activity.set'),
  activities: z.array(GuestAgentActivitySchema).max(64),
  video: z
    .object({
      running: z.boolean(),
      widthPx: z.number().int(),
      heightPx: z.number().int(),
      fps: z.number().int(),
    })
    .nullable(),
})
export const ActivitySetResultSchema = z.object({ accepted: z.number().int() })

/**
 * The farm's own facts about this device, for MVP 10 §2's Device section — the rows only the host
 * knows. `group`, never "cluster" (plan 200 §2.4).
 */
export const DeviceDescribeRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('device.describe'),
  stableId: z.string().nullable(),
  label: z.string().nullable(),
  number: z.string().nullable(),
  group: z.string().nullable(),
  tags: z.array(z.string()).max(32),
})
export const DeviceDescribeResultSchema = z.object({ accepted: z.literal(true) })

// ---- keyboard preference ----

export const TextPrefsRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('text.prefs'),
  showSoftKeyboardWithHardware: z.boolean(),
})
/** The read-back, never the value that was sent — same discipline as `route.status` after `route.start`. */
export const TextPrefsResultSchema = z.object({ showSoftKeyboardWithHardware: z.boolean() })

// ---- text.status gains two optional fields ----

export const TextStatusResultSchema = z.object({
  ime: z.enum(['current', 'enabled', 'disabled']),
  id: z.string(),
  connected: z.boolean(),
  /** Plan 221 §4.6, MVP 08 §1.2. Absent on a build that predates the field; never assume `false`. */
  softKeyboardShown: z.boolean().optional(),
  showSoftKeyboardWithHardware: z.boolean().optional(),
})
```

Every new request schema joins `GuestAgentRequestSchema`'s discriminated union, every new result joins `GuestAgentOkResponseSchema`'s `result` union, and every new name joins the `export { ... } from './guest-agent'` block in `packages/protocol/src/index.ts` (`:880-912`) in the same order as the schema file.

### 4.8 `ControlService.handle()` additions

Nine new branches, each following the file's own re-validation discipline ("the host's Zod already bounds these, but this socket is reached by anything holding the pairing token"):

| Method | Guard | Answer |
|---|---|---|
| `ui.dump` | `UiTreeService.instance()` or `E_UI_TREE_UNAVAILABLE` | `{ root, widthPx, heightPx, nodeCount, truncated, tookMs }` |
| `ui.find` | same; `selector` must be an object with exactly one of `id`/`desc`/`text`, else `E_BAD_REQUEST` with `"selector must be one of id, desc, text"`; a `point` key is refused by name | `{ node, matches, tookMs }` |
| `ui.watch` | same | ack `{ watching: true, debounceMs }`, then event frames on this connection |
| `ui.unwatch` | none | `{ watching: false }` |
| `ui.status` | none | `{ enabled, connected, watching, lastDumpAgoMs, lastDumpNodes, lastError }` |
| `activity.set` | `activities` must be an array, each entry needing `id`, `kind`, `label`, `actorLabel`, `startedAt`, else `E_BAD_REQUEST` | `{ accepted }` |
| `device.describe` | `tags` must be an array | `{ accepted: true }` |
| `text.prefs` | `showSoftKeyboardWithHardware` must be present, else `E_BAD_REQUEST` | the read-back |
| `hello` (changed) | none | unchanged keys, plus `HostExpectation.set(request.optInt("expectVersionCode", 0))` before answering |

`enabled` in `ui.status` is read from `Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)` and checked for `UiTreeService.COMPONENT_ID`; `connected` is `UiTreeService.instance() != null`. They are separate because the repair differs (§4.7's doc comment).

### 4.9 The status screen, complete

`buildReport()` becomes:

```kotlin
    return Report(
      subtitle = subtitle(),
      banner = banner(paired, listening, routeState, vpn),
      sections =
        listOf(
          nowSection(),
          deviceSection(),
          linkSection(paired, listening),
          videoSection(),
          inspectorSection(),
          routeSection(routeState, vpn),
          checksSection(),
          keyboardSection(),
          labelSection(),
          locationSection(),
          buildSection(),
        ),
      takenAt = Date(),
    )
```

`render()` already skips an empty section (`StatusActivity.kt:425`), so a section with no facts disappears on its own. Rows per section:

| Section | Rows, in order | Source | Omitted when |
|---|---|---|---|
| **Banner** | unchanged order, plus one new arm **above** `paired ->`: when the mirror holds a live non-`control` activity, "Connected, running `<label>`"; when it holds only a `control` marker, "Controlled by `<actorLabel>`"; otherwise "Connected to farm, idle". Tone `MUTED`, never `GOOD`: a running job is not a verified good state. | `ActivityMirror` | never (the existing arms remain the fallbacks) |
| **Now** | "no contact from the farm for N" when `isStale()`, tone `WARN`, first; then one row per activity, label `kind`, value `"<label> · <duration> · <actorLabel>"` | `ActivityMirror.activities()` | when the mirror has never been written: one row "the farm has not sent an activity list since this app started", tone `MUTED` |
| **Device** | Farm label (`label` and `number`), Group, Tags, Stable id, Model (`Build.MANUFACTURER` + `Build.MODEL`), Android (`Build.VERSION.RELEASE` + SDK), Battery ("N %, charging" / "N %, on battery"), Screen ("on" / "off") | `ActivityMirror.device()`, `Build`, `BatteryManager`, `PowerManager.isInteractive` | each host-pushed row individually when its value is null |
| **Farm link** | unchanged (`linkSection`) | `Pairing`, `ControlChannelState` | unchanged |
| **Video** | "a scrcpy server is running at `<W>x<H>` at `<fps>` fps" / "no scrcpy server running". A note row: "this says what the farm started, not that anyone is watching." | `ActivityMirror.video()` | the whole section when `video()` is null **and** the mirror was never written |
| **Inspector** | Service ("enabled and connected" / "enabled, not connected" / "not enabled"), Watching ("yes" / "idle"), Last dump ("N nodes, M ms, T ago"), Last error verbatim | `UiTreeState`, `Settings.Secure` | Last dump when `lastDumpAt() == NEVER`; Last error when null |
| **Route** | unchanged (`routeSection`) | | unchanged |
| **Checks** | unchanged (`checksSection`) | | unchanged |
| **Keyboard** | existing three, plus Soft keyboard ("showing" / "hidden") and With a hardware keyboard ("show it anyway" / "let Android hide it") | `TextFacet.status`, `ImePrefs` | the two new rows when the IME is not `current` |
| **Label** | Applied ("yes, on home and lock" / "yes, on home" / "no"), Renderer version | `WallpaperFacet.status` | Applied when `fingerprint` is null |
| **Location** | Mock location ("active" / "not active"), Last fix ("lat, lng" rounded to 3 decimals, plus "T ago") | `MockLocationState` | Last fix when nothing was ever set |
| **This build** | existing six rows, plus **"host expects build N"** when `HostExpectation.versionCode() > our versionCode`, tone `WARN` | `PackageManager`, `Protocol`, `HostExpectation` | the new row when no expectation was pushed or it is not higher |

The three rules are unchanged and are what the executor is judged on: never overstate (a tone of `GOOD` only for something the app verified itself), no secrets (nothing reads `RouteVpnService.currentUpstream()` or `Pairing`'s token), omit a row the app has no fact for.

`activity_status.xml` gains one button in the existing horizontal row, and the row becomes a two-by-two grid of two `LinearLayout`s so four buttons fit on a narrow screen:

```xml
        <Button
            android:id="@+id/accessibility_button"
            android:layout_width="0dp"
            android:layout_weight="1"
            android:layout_height="wrap_content"
            android:text="@string/open_accessibility_settings" />
```

wired in `onCreate` to:

```kotlin
    findViewById<Button>(R.id.accessibility_button).setOnClickListener {
      // The last resort of R4's OEM caveat: on a build where the host could not write
      // `enabled_accessibility_services` from adb, a human holding the phone enables it here.
      // Never a silent no-op — a device with no such screen says so, the same way the keyboard
      // button already does.
      val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      if (intent.resolveActivity(packageManager) != null) startActivity(intent)
      else Toast.makeText(this, R.string.accessibility_settings_missing, Toast.LENGTH_LONG).show()
    }
```

`asText(report)` needs no change: it walks `report.sections` generically (`StatusActivity.kt:523-537`), so Copy report picks up every new section for free.

### 4.10 Accessibility enablement over adb

New method on `GuestAgentLauncher` (`packages/drivers/src/network/guest-agent/launcher.ts`), shaped like `ensurePreGranted()`:

```ts
/**
 * What `ensureAccessibilityEnabled()` learned about this device's accessibility settings.
 * A RESULT, not an exception, for the same reason `GuestAgentVpnConsent` is: "this phone will not
 * enable an accessibility service from adb" is not the same event as "the agent could not be
 * reached", and collapsing the two would cost a device every other facet it has.
 */
export interface GuestAgentAccessibility {
  /** `enabled` — both settings read back correct, by whichever route they got there (adb, or a human on the phone). */
  state: 'enabled' | 'pending'
  /** Verbatim, operator-facing, never summarised. `null` when enabled. */
  reason: string | null
}
```

```ts
/** `AccessibilityServiceInfo.getId()`'s form, matching `UiTreeService.COMPONENT_ID` in the Kotlin. */
export const GUEST_AGENT_UI_TREE_SERVICE = `${GUEST_AGENT_PACKAGE}/${GUEST_AGENT_PACKAGE}.ui.UiTreeService`

/** R4 (plan 200 §5) — Android 13+ restricted settings block enabling an accessibility service for a sideloaded app. */
const RESTRICTED_SETTINGS_OP = 'ACCESS_RESTRICTED_SETTINGS'
```

The sequence, in order, with every command exactly as the executor must emit it (`shellQuote` on the package name, as everywhere else in this file):

| # | Command | Handling |
|---|---|---|
| 1 | `cmd appops set <pkg> ACCESS_RESTRICTED_SETTINGS allow` | Captured, never thrown on. R4 makes this mandatory before the write; the same OEMs that refuse `appops set` for `ACTIVATE_VPN` (`launcher.ts:64-82`, ColorOS) refuse it here, and the read-back at step 6 is what decides. |
| 2 | `settings get secure enabled_accessibility_services` | `stdout.trim()`; `null` and the literal `"null"` both mean empty. |
| 3 | `settings put secure enabled_accessibility_services <list>` | `<list>` is the existing colon-separated value with `GUEST_AGENT_UI_TREE_SERVICE` appended when absent, or the component alone when the previous value was empty. Never a blind overwrite: another accessibility service on the phone is an operator's, not ours to remove. Skipped entirely when the component is already present. |
| 4 | `settings put secure accessibility_enabled 1` | Always run, even when step 3 was skipped: the list can be right while the master switch is off. |
| 5 | `settings get secure enabled_accessibility_services` | Read-back. |
| 6 | `settings get secure accessibility_enabled` | Read-back. |

`state` is `enabled` only when step 5's value contains `GUEST_AGENT_UI_TREE_SERVICE` **and** step 6's value trims to `1`. Otherwise `state: 'pending'` with a reason built the way `classify()` builds its own (`launcher.ts:257-271`): the command that was attempted, the platform's own refusal line via `summariseSetFailure` when there was one, and the recovery a human can perform:

> the guest agent is installed and answering, but its accessibility service is not enabled on this phone and this build will not let adb enable it: `settings put secure enabled_accessibility_services ...` reported no error but the readback still says "". Everything else the agent does works; only the `ui-tree` inspector is blocked, and the farm falls back to ui-server. To clear it, open the agent on the phone and press "Open accessibility settings", then turn Enkaku Guest Agent on: Android records that the same way, so the next provisioning pass will see it and the device turns ready on its own.

`AgentProvisioner.ensure()` calls it after `ensurePreGranted()` on every pass, records `state`/`reason` on the same `devices.preparation['guest-agent']` row the VPN consent already uses, and **never fails the pass on `pending`**: `ui-tree` unavailable is a degraded inspector, not a broken agent.

**Do not** add a `pm grant`, a `<uses-permission>`, or an entry in `GUEST_AGENT_RUNTIME_PERMISSIONS` (§3.2 decision 7). **Do not** revert the setting on session close: this is provisioning-scoped, unlike the IME (§3.2 decision 6).

### 4.11 Host client methods

`packages/drivers/src/network/guest-agent/client.ts`, `GuestAgentClient` gains, in this order after `textStatus`:

```ts
  /**
   * Plan 221 §4.2. Same "always present on the client, gated on `hello().capabilities`" treatment
   * as every other method here — an older build answers `E_UNKNOWN_METHOD`, which plan 222's
   * engine ladder reads as "the `ui-tree` engine is unavailable on this device" and falls back to
   * ui-server, never as a device failure. A build that has the service but has not had it enabled
   * answers `E_UI_TREE_UNAVAILABLE`, which is a DIFFERENT thing and gets a different repair
   * (`ensureAccessibilityEnabled`, §4.10).
   */
  uiDump(opts?: { maxDepth?: number; maxNodes?: number }): Promise<UiDumpResult>
  /** Plan 221 §4.2. Throws `E_BAD_REQUEST` locally, before the wire, for a `{ point }` selector. */
  uiFind(selector: Selector, opts?: { maxDepth?: number; maxNodes?: number }): Promise<UiFindResult>
  /** Plan 221 §4.5. The activity mirror push; read-only on the device. */
  activitySet(activities: GuestAgentActivity[], video: GuestAgentVideo | null): Promise<ActivitySetResult>
  /** Plan 221 §4.5. The farm's own facts about this device, for the status screen's Device section. */
  deviceDescribe(device: DeviceDescribeInput): Promise<DeviceDescribeResult>
  /** Plan 221 §4.6. Writes the per-device soft-keyboard preference; returns the device's read-back. */
  textPrefs(showSoftKeyboardWithHardware: boolean): Promise<TextPrefsResult>
  /** Plan 221 §4.2. Cheap enough to call on every provisioning pass; never starts anything. */
  uiStatus(): Promise<UiStatusResult>
```

`hello()` gains an optional argument, `hello(opts?: { expectVersionCode?: number })`, spread into `HelloRequestSchema.parse` exactly as `locationSet` spreads `accuracy` (`client.ts:406-416`).

`packages/drivers/src/network/guest-agent/ui-watch.ts` (new) holds the subscription, because `sendOnce` (`client.ts:198-266`) reads one line and closes and must not change:

```ts
export interface GuestAgentWatchOptions {
  port: number
  token: string
  connect?: GuestAgentConnect
  /** How long the ack may take. The subscription itself has no timeout: silence is the normal state. */
  ackTimeoutMs?: number
  onEvent: (event: UiChangedEvent) => void
  /** A gap in `seq` means frames were lost; the caller re-dumps rather than trusting its cache. */
  onGap?: (expected: number, received: number) => void
  onClose?: (reason: string) => void
}

export interface GuestAgentWatch {
  /** Resolves once the agent's ack line has been read and validated. */
  readonly ready: Promise<{ debounceMs: number }>
  close(): Promise<void>
}

export function createGuestAgentWatch(opts: GuestAgentWatchOptions): GuestAgentWatch
```

Rules: it opens **one** connection to `127.0.0.1:<port>` (the same forward, so the same host-port ownership guarantee of `launcher.ts:448-468`), writes one `ui.watch` request line, validates the first line against `GuestAgentResponseSchema` then `UiWatchResultSchema`, and from then on parses each line with `UiChangedEventSchema` and calls `onEvent`. A line that parses as neither is dropped with `onClose('unexpected frame')` and the socket ends: never guess at a frame. `close()` writes one `ui.unwatch` line and ends the socket, and is idempotent.

Both files are re-exported from `packages/drivers/src/network/guest-agent/index.ts` and from `packages/drivers/src/index.ts`'s existing block (`:55-74`).

### 4.12 Release and the manifest pin

`scripts/pin-guest-agent.ts` (new), a plain Bun script:

```
Usage: bun run scripts/pin-guest-agent.ts --version <x.y.z> --version-code <int> --sha256 <hex> --size <bytes> --url <url>
```

It reads `packages/toolchain/manifest/enkaku-tools.json`, finds `tools[].id === 'guest-agent'`, and rewrites exactly five fields on `versions[0]`: `version`, `platforms['*'].url`, `platforms['*'].sha256`, `platforms['*'].sizeBytes`, and `deviceArtifact.versionCode`. It also replaces `"compatibleCoreRange": "TODO-M55"` with `">=<version>"`. It touches nothing else, in particular not `deviceArtifact.signatureSha256` (§9 Q1 owns that), and it writes the file with a trailing newline and two-space indent so the diff is the five lines and nothing more. It fails with a non-zero exit and a named error when the entry is missing, when `sha256` is not 64 hex characters, or when `versionCode` is not a positive integer.

`.github/workflows/release.yml` changes:

1. The `build-guest-agent` job's "Report size and sha256" step (`:136-149`) additionally writes `size`, `sha256`, `version` and `code` to `$GITHUB_OUTPUT`.
2. A new step in the same job, gated on `startsWith(github.ref, 'refs/tags/v')`, runs `pin-guest-agent.ts` with those values and the release asset URL (`https://github.com/<owner>/<repo>/releases/download/<tag>/guest-agent.apk`), then commits `packages/toolchain/manifest/enkaku-tools.json` to the tag's commit with `git commit -m "chore(release): pin guest-agent <version>"` and pushes it to the default branch. This is what MVP 10 §3 means by "writes the pin into the toolchain manifest in the same commit as the core release", and it is what closes plan 43 §5.11.
3. The job needs `permissions: contents: write` (the workflow already declares it at `:16-17`).

The chicken-and-egg `README.md:70-74` documents is now the workflow's problem, not a human's: the pin lands on the branch immediately after the tag builds, so the **next** core release embeds it. That one-release lag is inherent (the APK must exist before it can be checksummed) and stays documented, but the manual step goes away.

`.github/workflows/ci.yml`'s `changes` filter gains `packages/toolchain/manifest/enkaku-tools.json` so a hand-edited pin still triggers the `android` job.

## 5. Implementation steps

### 221.1 — The wire contract, both sides, no behaviour

- **Files changed**: `apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/control/Protocol.kt` (the `CAPABILITIES` list of §4.1, the eight new `METHOD_*` constants, `EVENT_UI_CHANGED`, `ERR_UI_TREE_UNAVAILABLE`); `packages/protocol/src/guest-agent.ts` (every schema of §4.7); `packages/protocol/src/index.ts` (the export block at `:880-912`).
- **Files created**: none.
- **Test file**: `packages/protocol/src/guest-agent.test.ts` (extend; it exists, 12.4 KB).
- **Verifiable result**: `bun test packages/protocol/src/guest-agent.test.ts` passes with new tests `GuestAgentCapabilitySchema carries ui-tree and activity`, `UiDumpResultSchema reuses UiNodeSchema unchanged` (asserting `UiDumpResultSchema.shape.root === UiNodeSchema`), `UiFindRequestSchema rejects a point selector`, `TextStatusResultSchema still parses a build that omits the two new fields`, and `GuestAgentRequestSchema discriminates every new method`. `bun run typecheck` clean.
- **Do not**: do not bump `PROTOCOL_VERSION` or `GUEST_AGENT_PROTOCOL` (§3.2 decision 1). Do not redefine a node type in `guest-agent.ts`: import `UiNodeSchema` from `./ui-node`. Do not widen `SelectorSchema` itself to drop `{ point }`; the three-arm union in `UiFindRequestSchema` is local to that request.

### 221.2 — `UiTreeService`, `UiTreeState`, the manifest entry and the service XML

- **Files created**: `apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/ui/UiTreeService.kt` (§4.2), `.../ui/UiTreeState.kt` (§4.3), `apps/guest-agent/app/src/main/res/xml/ui_tree_service.xml` (§4.2).
- **Files changed**: `apps/guest-agent/app/src/main/AndroidManifest.xml` (the `<service>` of §4.2, placed after `EnkakuIme`'s), `apps/guest-agent/app/proguard-rules.pro` (one keep), `apps/guest-agent/app/src/main/res/values/strings.xml` (`ui_tree_service_description`).
- **Test file**: none (§3.2 decision 13).
- **Verifiable result**: `bun run build:guest-agent --debug` exits 0; `rg -n "hierarchy" apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/ui/UiTreeService.kt` shows the synthetic root's `className`.
- **Do not**: do not add a `<uses-permission android:name="android.permission.BIND_ACCESSIBILITY_SERVICE" />`; it is a system-held attribute (§3.2 decision 7). Do not add a Compose dependency, an AndroidX Accessibility library, or anything else to `app/build.gradle.kts`'s `dependencies` block. Do not emit a twelfth key on a node: `UiNodeSchema` has exactly eleven.

### 221.3 — `UiTreeWatch` and the writer lock

- **Files created**: `apps/guest-agent/.../ui/UiTreeWatch.kt` (§4.4).
- **Files changed**: `apps/guest-agent/.../control/ControlService.kt`, where `serve()` (`:145-162`) wraps its `writer.write(...)`/`writer.write("\n")`/`writer.flush()` in `synchronized(writer) { ... }` and passes a `synchronized`-wrapped sink into `UiTreeWatch.subscribe` for the `ui.watch` branch; `serve()` calls `UiTreeWatch.unsubscribe()` in a `finally` when this connection owned the subscription.
- **Test file**: none.
- **Verifiable result**: `bun run build:guest-agent --debug` exits 0.
- **Do not**: do not open a second socket, a second `LocalServerSocket`, or a TCP port for events. Do not send the tree in the event frame (§3.2 decision 4). Do not allow two live subscriptions.

### 221.4 — The activity mirror, the device description, the host expectation

- **Files created**: `apps/guest-agent/.../activity/ActivityMirror.kt` (§4.5), `apps/guest-agent/.../control/HostExpectation.kt` (an atomic holding the last `expectVersionCode`, `0` for none).
- **Files changed**: `apps/guest-agent/.../control/ControlService.kt` (the `activity.set`, `device.describe` branches of §4.8, and `hello` storing `expectVersionCode`).
- **Test file**: none.
- **Verifiable result**: `bun run build:guest-agent --debug` exits 0.
- **Do not**: do not persist the activity list. Do not let anything on the device act on it: no notification, no route change, no service start. Do not use the word "cluster" in a field name or a string; the field is `group` (plan 200 §2.4).

### 221.5 — The IME preference, `text.status`, `MockLocationState`

- **Files created**: `apps/guest-agent/.../input/ImePrefs.kt` (`SharedPreferences` file `enkaku-ime`, key `show_soft_keyboard_with_hardware`, default `false`), `apps/guest-agent/.../identity/MockLocationState.kt` (an atomic holding `{ lat, lng, atElapsedRealtime }` and an `active` flag).
- **Files changed**: `apps/guest-agent/.../input/EnkakuIme.kt` (`onEvaluateInputViewShown` of §4.6), `.../input/TextFacet.kt` (`StatusOutcome` gains `softKeyboardShown` and `showSoftKeyboardWithHardware`), `.../control/ControlService.kt` (the `text.prefs` branch, `text.status` emitting the two new keys, and `location.set`/`location.clear` writing `MockLocationState`).
- **Test file**: none.
- **Verifiable result**: `bun run build:guest-agent --debug` exits 0; `rg -n "onEvaluateInputViewShown" apps/guest-agent/app/src` → one line.
- **Do not**: do not change what `ime`, `id` or `connected` mean in `text.status`; they are added to, never redefined. Do not persist the preference anywhere the host would have to migrate (no new file format, no JSON on `/sdcard`).

### 221.6 — The status screen

- **Files changed**: `apps/guest-agent/.../StatusActivity.kt` (`buildReport()`'s new section list, the six new section builders, the new banner arm, the accessibility button handler), `apps/guest-agent/app/src/main/res/layout/activity_status.xml` (the fourth button and the two-row button grid), `apps/guest-agent/app/src/main/res/values/strings.xml` (every new label and value string, grouped under the same comment headers the file already uses).
- **Test file**: none.
- **Verifiable result**: `bun run build:guest-agent --debug` exits 0; `rg -n "section_now|section_device|section_video|section_inspector|section_label|section_location" apps/guest-agent/app/src/main/res/values/strings.xml` → six lines.
- **Do not**: do not declare rows in XML; `StatusActivity.kt:66-71` says why (a row with nothing to say is never added). Do not use `Tone.GOOD` for a host-pushed fact: the app did not verify it. Do not print the pairing token, the SOCKS5 password, or a raw actor id anywhere. Do not add Compose.

### 221.7 — Host client: the six methods and `hello`'s argument

- **Files changed**: `packages/drivers/src/network/guest-agent/client.ts` (the six methods of §4.11 and `hello(opts?)`), `packages/drivers/src/network/guest-agent/index.ts` and `packages/drivers/src/index.ts` (re-exports).
- **Test file**: `packages/drivers/src/network/guest-agent/client.test.ts` (extend).
- **Verifiable result**: `bun test packages/drivers/src/network/guest-agent/client.test.ts` passes with new tests `uiDump parses a tree in the ui-node shape`, `uiFind sends the selector verbatim`, `uiFind rejects a point selector before the wire`, `activitySet sends every activity and a null video`, `textPrefs returns the device read-back, not the value sent`, `hello omits expectVersionCode when it is not given`. `bun run typecheck` clean.
- **Do not**: do not change `sendOnce` or `call` (§3.2 decision 5). Do not add a retry to any of the six: `hello` is the only method in this file that retries, and its comment at `:132-137` says why.

### 221.8 — Host client: the `ui.watch` subscription

- **Files created**: `packages/drivers/src/network/guest-agent/ui-watch.ts` (§4.11).
- **Files changed**: the two barrels.
- **Test file**: `packages/drivers/src/network/guest-agent/ui-watch.test.ts` (new; framing is on plan 200 §8.3's critical list).
- **Verifiable result**: `bun test packages/drivers/src/network/guest-agent/ui-watch.test.ts` passes with tests `the ack resolves ready and the following lines are events`, `a gap in seq calls onGap`, `an unparseable line closes the watch instead of guessing`, `close writes ui.unwatch exactly once and is idempotent`, all against the injected `GuestAgentConnect` fake `client.test.ts` already uses.
- **Do not**: do not allocate an `adb forward` here; the caller passes a port that a launcher already owns (§3.1, `launcher.ts:448-468`). Do not reconnect automatically: a dropped subscription is the caller's decision.

### 221.9 — Accessibility enablement in the launcher and the provisioner

- **Files changed**: `packages/drivers/src/network/guest-agent/launcher.ts` (`GUEST_AGENT_UI_TREE_SERVICE`, `GuestAgentAccessibility`, `ensureAccessibilityEnabled()` on the `GuestAgentLauncher` interface and its implementation, §4.10), `packages/drivers/src/network/guest-agent/index.ts` and `packages/drivers/src/index.ts` (re-exports), `packages/core/src/device/agent-provisioner.ts` (call it after `ensurePreGranted()`, store `state`/`reason`, never fail the pass on `pending`).
- **Test file**: `packages/drivers/src/network/guest-agent/launcher.test.ts` (extend).
- **Verifiable result**: `bun test packages/drivers/src/network/guest-agent/launcher.test.ts` passes with new tests `ensureAccessibilityEnabled runs the appops call before the settings write`, `it appends to an existing list and never overwrites another service`, `it skips the write when the component is already present but still sets accessibility_enabled`, `a refused write produces state pending with the platform's own line`, `a read-back of 1 plus the component produces state enabled`. Then `bun test packages/core/src/device/agent-provisioner.test.ts` passes.
- **Do not**: do not throw on a refusal. Do not overwrite `enabled_accessibility_services` with our component alone. Do not add a `pm grant` or a `<uses-permission>`. Do not revert the setting anywhere.

### 221.10 — The tree diff and watch-latency tool

- **Files created**: `scripts/ui-tree-diff.ts`.
- **Test file**: none (a device tool; §7.4 runs it).
- **Verifiable result**: `bun run scripts/ui-tree-diff.ts --help` lists `--serial`, `--watch <n>`, `--json <path>` and exits 0.
- **Behaviour**: with `--serial`, it dumps the same screen through both engines (the guest agent's `ui.dump` and `packages/drivers`' `UiServerInspector.dump()`), normalises both (drop `bounds` when the two engines disagree only by the status-bar inset; compare the remaining ten fields), and prints either `identical: N nodes` or the first ten differing paths with both values. With `--watch <n>`, it subscribes with `createGuestAgentWatch`, drives `n` screen changes with `input keyevent APP_SWITCH`/`BACK` pairs, and prints `watch p50/p95: <N> ms` measured from the `adb shell input` return to the event's arrival.
- **Do not**: do not make this a test file; it needs a device and would run in CI. Do not import it from anything in `packages/`.

### 221.11 — Release: pin the APK

- **Files created**: `scripts/pin-guest-agent.ts` (§4.12), `scripts/pin-guest-agent.test.ts`.
- **Files changed**: `.github/workflows/release.yml` (the two steps of §4.12), `.github/workflows/ci.yml` (the `changes` filter gains the manifest path), `packages/toolchain/manifest/enkaku-tools.json` (`"compatibleCoreRange": "TODO-M55"` → `">=0.1.8"`, so the sentinel is gone before the first automated pin overwrites it).
- **Test file**: `scripts/pin-guest-agent.test.ts`.
- **Verifiable result**: `bun test ./scripts/pin-guest-agent.test.ts` passes with tests `pin-guest-agent rewrites exactly the five fields`, `it leaves signatureSha256 untouched`, `it refuses a sha256 that is not 64 hex characters`, `it refuses when the guest-agent entry is missing`. Note the leading `./` (ci.yml `:95-101` records why). `rg -n "TODO-M55" packages/toolchain/manifest/enkaku-tools.json` → empty.
- **Do not**: do not hand-write the manifest in the workflow with `sed` or `jq`; the script is testable and a shell one-liner is not. Do not touch `deviceArtifact.signatureSha256` (§9 Q1). Do not remove the 4 MiB size budget at `release.yml:144`.

### 221.12 — Documentation

- **Files changed**: `apps/guest-agent/README.md`, `docs/research/android-guest-agent.md`.
- **`apps/guest-agent/README.md`**:
  - The "One app, four facets" section becomes **six** facets: two new rows, `ui-tree` with "`AccessibilityNodeInfo` has no shell equivalent that survives without `am instrument`" and `activity` with "the phone's own screen has to say what the farm is doing to it, and only an app can draw it", and the heading and the sentence at `:20` ("Four facets sharing one package") updated to six.
  - `:68` replace "**Tier 3 cannot fire yet on a real release** … only tier 3 is blocked." with a sentence saying the manifest carries a real pin and the release workflow writes it (`scripts/pin-guest-agent.ts`, §4.12).
  - `:70-74` delete the three-step two-tag dance and replace it with two sentences: the workflow pins the APK it just built on the tag's commit, and the manifest therefore lags one release behind the agent build it pins, by construction.
  - A new section, "The inspector (`ui-tree`)", with the enablement commands of §4.10 verbatim, the R4 caveat, and the "Open accessibility settings" fallback.
  - The status-screen section's table gains the six new rows and keeps the three rules verbatim.
  - The text-input section gains the preference and the two new `text.status` fields, and keeps the prep-scoped revert paragraph at `:110` unchanged (it is still true of the IME).
  - `:221`'s `signatureSha256` sentence: correct the quoted hash to whatever `enkaku-tools.json:143` actually holds on the day of execution, or, if §9 Q1 is still open, replace the quoted hash with a pointer to the manifest field and record it in §11.
  - **Guard, and the only place this plan touches the two plan-201 claims**: run `rg -n "has not been built" apps/guest-agent/README.md` and `rg -n "scripts/guest-agent\.ts" apps/guest-agent/README.md`. If either returns a line, plan 201 has not merged; apply plan 201 §5's exact replacement text for `:118` and its deletion of `:122-135` and `:138`, and say so in §11 under "Discrepancies". If both are empty, 201 has landed and this plan changes nothing there.
- **`docs/research/android-guest-agent.md`**: answer §10 item 5 in place, at `:281`: replace "Does the agent replace the `ui-server` inspector eventually, or coexist with it? …" with "**Answered (MVP 02 §4 phase 2, plan 221):** replace. The agent's `ui-tree` `AccessibilityService` becomes the default engine in plan 222; ui-server stays as the fallback for devices where the agent cannot be installed or its service cannot be enabled, and `uiautomator dump` is demoted to last resort."
- **Test file**: none.
- **Verifiable result**: G13's two greps; `rg -n "Does the agent replace" docs/research/android-guest-agent.md` → empty.
- **Do not**: do not delete `scripts/guest-agent.ts` here; plan 201 §10 owns that row and its `test ! -e` proof.

### 221.13 — The four stale lease comments

- **Files changed**: `apps/guest-agent/.../route/DeadMansSwitch.kt:24`, `.../route/RouteVpnService.kt:114-115`, `.../control/ControlService.kt:48`.
- Rewrite each in the MVP vocabulary (plan 200 §2.4) without changing the fact it states:
  - `DeadMansSwitch.kt:24`: "Host-side lease teardown is still the normal path" → "Host-side teardown, when the farm ends the activity that owns the route, is still the normal path".
  - `RouteVpnService.kt:114-115`: "a route belongs to a lease, and the host reapplies it deliberately. Coming back by itself would resurrect a route whose lease has ended." → "a route belongs to the activity that applied it, and the host reapplies it deliberately. Coming back by itself would resurrect a route whose activity has ended."
  - `ControlService.kt:48`: "Host-side lease teardown is the normal path" → "Host-side teardown is the normal path".
- **Test file**: none.
- **Verifiable result**: `rg -n -i "lease" apps/guest-agent/app/src` → empty (G14).
- **Do not**: do not touch `label/LabelRenderer.kt:44`'s "Grapheme-cluster cap": that is the Unicode term, not the product noun, and `GREP_221` excludes it by name.

### 221.14 — Wire the pushes from the core

- **Files changed**: `packages/core/src/api/guest-agent.ts` (a `pushActivity(deviceId, activities, video)` and a `pushDescribe(deviceId, device)` on `GuestAgentRoutesHandle`, both routed through `withGuestAgentClient` so no second token is minted, `vpn-helper.ts:64-87`), `packages/core/src/daemon.ts` (subscribe to plan 205's activity registry `onChange` and call `pushActivity` for that device; call `pushDescribe` after provisioning and on a label, group or tag change).
- **Guard**: both pushes are capability-gated on `hello().capabilities` containing `activity`, are best-effort, and never fail the caller: a `E_UNKNOWN_METHOD` from an older build is logged at `debug` once per device and never again.
- **Coalescing**: at most one `activity.set` per device per second, trailing-edge, so a burst of registry changes is one shell round trip; the heartbeat that already runs while a route is up is unchanged.
- **Test file**: none in `packages/core` (route wiring is explicitly not tested, plan 200 §8.3).
- **Verifiable result**: `bun run typecheck` clean; the owner smoke of §7.4 step 8 sees the row on the phone.
- **Do not**: do not create a second `GuestAgentSession` or mint a token here. Do not push on a timer when nothing changed. Do not block the activity registry's `onChange` on an adb round trip: schedule and return.

## 6. Acceptance criteria

1. `hello()` from a freshly provisioned lab device lists nine capabilities, including `ui-tree` and `activity`, and `GUEST_AGENT_PROTOCOL` is still 1.
2. `ui.dump` on the lab device returns a tree whose every node has exactly the eleven `UiNodeSchema` keys, whose root is `className: "hierarchy"`, and which `scripts/ui-tree-diff.ts` reports as identical to `UiServerInspector.dump()` for the same screen.
3. `ui.find` returns the same node `matchSelector` would pick from that dump for the same selector, with a `matches` count equal to `countMatches`, and refuses `{ point }` with `E_BAD_REQUEST`.
4. `ui.watch` delivers a `ui.changed` frame with p95 under 200 ms over 20 screen changes, `seq` strictly increasing with no gaps, and no frame carrying tree data.
5. `ensureAccessibilityEnabled()` reports `enabled` on the lab device after one provisioning pass, or reports `pending` with the platform's own refusal line and the phone's "Open accessibility settings" button then completes the job.
6. The status screen shows all twelve sections, omits every row it has no fact for, shows a running job in Now within 2 s of the push, and marks the list stale after 90 s with the core stopped.
7. `text.status` reports `softKeyboardShown` and `showSoftKeyboardWithHardware`, and the preference set through `text.prefs` is still `true` after `adb reboot`.
8. A tagged release builds, signs and publishes `guest-agent.apk` and commits a manifest whose `sha256` equals `sha256sum guest-agent.apk` from that same run.
9. `bun run typecheck` is clean, every §7 command passes, and `GREP_221` is empty.

## 7. Test plan

Run one invocation at a time, never two concurrently (`CLAUDE.md`).

### 7.1 Protocol

```bash
bun test packages/protocol/src/guest-agent.test.ts
```

The wire contract is on plan 200 §8.3's critical list. New cases: the capability enum; `UiDumpResultSchema.shape.root === UiNodeSchema` by identity; the `{ point }` refusal in `UiFindRequestSchema`; `TextStatusResultSchema` parsing a build that omits the two new fields; `GuestAgentRequestSchema` discriminating all twenty-two methods; `UiChangedEventSchema` refusing a frame with an unknown `reason`.

### 7.2 Drivers

```bash
bun test packages/drivers/src/network/guest-agent/client.test.ts
bun test packages/drivers/src/network/guest-agent/ui-watch.test.ts
bun test packages/drivers/src/network/guest-agent/launcher.test.ts
```

Framing and the enablement sequence. `launcher.manifest.test.ts` and `version-skew-guard.test.ts` must stay green; run them only if step 221.9 touched anything they read:

```bash
bun test packages/drivers/src/network/guest-agent/launcher.manifest.test.ts
```

### 7.3 Core and scripts

```bash
bun test packages/core/src/device/agent-provisioner.test.ts
bun test ./scripts/pin-guest-agent.test.ts
```

### 7.4 Android and the owner smoke (`ENKAKU_TEST_DEVICE=1`, lab device attached)

No Kotlin unit tests exist and none are added (§3.2 decision 13). The APK is verified by compiling and by this numbered smoke, run by the owner:

```bash
bun run typecheck
bun run build:guest-agent
```

1. Install the freshly built APK: `ENKAKU_GUEST_AGENT_PATH=$PWD/apps/guest-agent/app/build/outputs/apk/release/app-release-unsigned.apk bun run dev`, and let the provisioner admit the lab device.
2. `hello`: confirm nine capabilities in the device row, `ui-tree` and `activity` among them.
3. Read the enablement back by hand and compare with what the provisioner recorded:
   ```bash
   adb -s <serial> shell settings get secure enabled_accessibility_services
   adb -s <serial> shell settings get secure accessibility_enabled
   ```
   Expect the value to contain `dev.enkaku.guestagent/dev.enkaku.guestagent.ui.UiTreeService` and `1`.
4. If step 3 is empty, exercise R4's fallback: open the agent on the phone, press **Open accessibility settings**, enable Enkaku Guest Agent, re-run the provisioning pass, and repeat step 3. **Record the OEM, the Android version, and the platform's refusal line in §11**. This is the observation R4's caveat asks for, and it is the only place it will ever be recorded.
5. Tree parity (G3): `ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts --serial <serial>` on three screens: the launcher, a settings list, and an app under test. Expect `identical: N nodes` each time; paste the three lines into §11.
6. Selector behaviour: run `ui.find` with `{ id }`, `{ desc }`, `{ text }` and `{ point }` (the last through a hand-built request, since the client refuses it) and confirm the first three match the diff tool's own tree and the fourth answers `E_BAD_REQUEST`.
7. Watch latency (G6): `ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts --serial <serial> --watch 20`. Expect `watch p95: <N> ms` with N < 200; paste the line into §11.
8. Now section (G9): start a script job on the lab device and confirm the phone's screen names it within 2 s. Stop the core; after 90 s confirm the screen shows "no contact from the farm for N" and marks the list stale, never current. Restart the core and confirm the row returns.
9. Keyboard preference (G10): `text.prefs { showSoftKeyboardWithHardware: true }`, confirm `text.status` reports it, `adb -s <serial> reboot`, wait for the agent, confirm `text.status` still reports `true` and the Keyboard section says "show it anyway".
10. Read every section on the phone and confirm the three rules: nothing claims a state the app did not verify, no token or password appears anywhere, and no row is rendered empty. Press **Copy** and paste the report into §11.
11. `bun run smoke:guest-agent` unchanged, to prove nothing in the four old facets regressed:
    ```bash
    ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent -- --serial <serial>
    ```

### 7.5 Not run

No `bun test` without a path, ever. No test under `packages/studio` or `packages/ui`: they have none and none is added (plan 200 §8.3). No new Gradle test source set.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | R4's OEM caveat bites: `settings put secure enabled_accessibility_services` is refused on the lab device or on a farm phone, so `ui-tree` never turns on there. | The appops call always runs first (R4's documented workaround), the read-back always decides, a refusal is a `pending` result with the platform's own line, the status screen has the "Open accessibility settings" button, and the farm keeps ui-server as the engine. Nothing in this plan makes `ui-tree` mandatory; plan 222 owns that decision and inherits the fallback. |
| R2 | An accessibility service is a powerful, abusable API, and OEM security software may kill or hide it. | The service reads only; it declares no `canPerformGestures`, no `canRequestFilterKeyEvents`, no `canRequestTouchExplorationMode`, and it is bound only by the system. `ui.status` separates "enabled in Settings" from "connected" so a killed service reports honestly rather than as an empty tree. |
| R3 | UiAutomation suppresses other accessibility services while it is connected, so a running ui-server could silence `UiTreeService` on the same device. | Plan 208 §9 Q4 records this and the `uiAutomationFlags` field that would fix it (2.3.11 and above, R5), and does not send the field. This plan's §9 Q2 carries it forward as the decision plan 222 must make. Until then the two engines are not expected to be up at once: plan 208's inspector is session-scoped and starts only for a session that needs it. |
| R4 | A pathological screen produces a huge tree on a control socket sized for small JSON lines. | `MAX_DEPTH = 50` and `MAX_NODES = 5000`, both overridable per request and both reported through `truncated`. A truncated tree is never presented as complete. |
| R5 | The event frame and a request reply interleave on one connection and corrupt a line. | One `synchronized(writer)` lock around every write on that connection, taken by both `serve()` and the watch sink (step 221.3). The host drops a line it cannot parse rather than guessing. |
| R6 | The release step that commits the manifest races another push to the default branch, or runs on a fork without write access. | The step is gated on `startsWith(github.ref, 'refs/tags/v')`, uses the workflow's existing `contents: write`, and fails the job loudly rather than silently skipping. A failed pin means the next release does not resolve tier 3, which is the state before this plan, not a regression. |
| R7 | `docs/research/android-guest-agent.md` §8: Android developer verification enforcement begins September 2026, with a 20-device cap on the limited tier and no statement on whether `adb install` is exempt. That risk applies to this APK and to the ui-server APK equally. | Out of this plan's control and unchanged by it. Recorded here so the wave-4 gate sees it; §9 Q4 carries the question. |
| R8 | The `activity.set` push adds an adb round trip per activity change on a 20-device farm. | Trailing-edge coalescing at one push per device per second (step 221.14), best-effort, never blocking the registry, and skipped entirely for a device whose `hello()` did not advertise `activity`. |

## 9. Open questions

1. **Which keystore signs the release, and therefore what `deviceArtifact.signatureSha256` must be.** `apps/guest-agent/README.md:221` names `BAA2B36DD52BE50EAE2036404E130065EBF3836D904A6137D740FBE378EDB32F`; `packages/toolchain/manifest/enkaku-tools.json:143` holds `420222E0C1BD95A6EA11C0F735B0F7CEEF48C05877F487308F80FCF5895048B6`. Only the owner knows which keystore `secrets.GUEST_AGENT_KEYSTORE_BASE64` actually holds. `pin-guest-agent.ts` deliberately does not touch this field, so nothing in §5 is blocked; the executor records the discrepancy in §11 and the owner reconciles it before the next signed release.
2. **`uiAutomationFlags` and coexistence.** Plan 208 §9 Q4 leaves open whether `UiTreeService` must coexist with a running ui-server on the same device, which would require sending `uiAutomationFlags` with the "do not suppress accessibility services" bit (believed `0x2`, to verify against the Android reference for `UiAutomation`) and therefore the openatx 2.3.11-or-later pin (R5). This plan does not send it and does not move the pin. Plan 222 decides, because it is the plan that runs both engines in one ladder.
3. **Whether an app on API 29 and above can read another process's `/proc/<pid>/cmdline` on any farm device.** MVP 10 §2 says the Video row is "read from the process list"; §3.2 decision 9 designs it as a host push instead, on the belief that it cannot. To verify on the lab device (`adb shell run-as` is not available for a release APK, so the check is a one-off debug build reading `/proc`). Nothing in §5 depends on the answer: if the read turns out to work, the row can be sourced on-device later without a wire change.
4. **Android developer verification (`docs/research/android-guest-agent.md` §8, §10 item 1).** Enforcement begins September 2026 and the page does not say whether `adb install` is exempt. It is a product-level decision, not this plan's, and it applies to the ui-server APK too.
5. **Whether the status screen should show anything at all when the device is unpaired.** Today the banner says "Not paired" and the sections still render. With Now, Device and Video added, an unpaired phone shows five sections of "the farm has not said". The plan renders them as written; the owner may prefer the three host-pushed sections to be omitted entirely until the first push. One line in `buildReport()` either way.

## 10. Removed

Forbidden words this area introduces or carries (in `apps/guest-agent/`, `packages/drivers/src/network/guest-agent/` and this plan's own files, outside `docs/archive/` and the plan documents): `lease`, `holder`, `held by`, `assist`, `cluster` (as the product noun).

```
GREP_221 = rg -n -i "lease|holder|assist|cluster" apps/guest-agent/app/src packages/drivers/src/network/guest-agent scripts/pin-guest-agent.ts scripts/ui-tree-diff.ts --glob '!**/build/**' | rg -v "Grapheme-cluster"
```

Expected output: empty.

| What | Where it was | Proof |
|---|---|---|
| The "Host-side lease teardown" comment | `apps/guest-agent/.../control/ControlService.kt:48` | `rg -n -i "lease" apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/control/ControlService.kt` → empty |
| The "Host-side lease teardown is still the normal path" comment | `apps/guest-agent/.../route/DeadMansSwitch.kt:24` | `rg -n -i "lease" apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/route/DeadMansSwitch.kt` → empty |
| The two "a route belongs to a lease" / "whose lease has ended" comments | `apps/guest-agent/.../route/RouteVpnService.kt:114-115` | `rg -n -i "lease" apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/route/RouteVpnService.kt` → empty |
| The `TODO-M55` placeholder on the guest-agent manifest entry | `packages/toolchain/manifest/enkaku-tools.json:139` | `rg -n "TODO-M55" packages/toolchain/manifest/enkaku-tools.json` → empty |
| The "Tier 3 cannot fire yet on a real release" claim and the two-tag manual dance | `apps/guest-agent/README.md:68`, `:70-74` | `rg -n "Tier 3 cannot fire yet\|two tag pushes, not one" apps/guest-agent/README.md` → empty |
| The `ui-server` coexistence open question | `docs/research/android-guest-agent.md:281` | `rg -n "Does the agent replace" docs/research/android-guest-agent.md` → empty |
| The claim that `labelling.ts` "has not been built" (plan 201 §10 owns this row; verified here, applied here only if 201 has not merged) | `apps/guest-agent/README.md:118` | `rg -n "has not been built" apps/guest-agent/README.md` → empty |
| The `scripts/guest-agent.ts` bring-up section (plan 201 §10 owns this row; same guard) | `apps/guest-agent/README.md:122-135`, `:138` | `rg -n "scripts/guest-agent\.ts" apps/guest-agent/README.md` → empty |

Nothing in the APK is removed: the four existing facets stay, the single-line `EnkakuIme` strip stays, and ui-server stays as the fallback engine (MVP 10 §5).

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:
