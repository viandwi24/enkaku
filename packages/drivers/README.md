# @enkaku/drivers

Implementations of the five driver layers (spec §7): Transport / DisplaySource / InputSink / Inspector / NetworkRoute.

## M2 engines

| Engine | Layer | Notes |
|---|---|---|
| `adb-usb` | transport | Wraps @enkaku/adb; every exec goes through the per-device queue |
| `adb-tcp` | transport | Adds the `adb connect/disconnect` host services |
| `screencap-loop` | display | **Fallback / MVP** — `exec-out screencap -p`, PNG at roughly 2–3 fps, high latency, wasteful bandwidth. The production default is scrcpy (Plan 08) |
| `adb-input` | input | **Fallback** `sdk` mode (InputManager injection — detectable as injected, spec §9.1). `input text` handles printable ASCII only. The production default is scrcpy-uhid (Plan 08) |

Inspectors arrive in Plan 05 (`uiautomator-dump`) and Plan 06 (`ui-server`). Plan 222 adds `ui-tree` (`inspector/ui-tree/`), the default since that plan: the guest agent's own `AccessibilityService`, reached over the agent's control channel, with no `instrumentation` lock (the ladder — `ui-tree` → `ui-server` → `uiautomator-dump` — never runs two of the three on one device, so the reverse hazard of a live `UiAutomation` suppressing an accessibility service does not arise).

## Inspection capabilities (plan 56)

All three inspector engines declare `dump`/`find`/`screenshot` in their `EngineDescriptor.capabilities` (`descriptors.ts`) — that list is what Studio's Inspect tab (plan 56) checks before it lets an operator read a device's UI tree: a session running an engine that has not declared `dump` is refused with a named reason, never handed a fabricated empty tree. `ui-tree` additionally declares `watch`, read by `device-executor.ts`'s `waitFor` as "this engine can push a change instead of being polled" (plan 222 §3.5). Neither `uiautomator-dump` nor `ui-tree` has any element-action capability (`set-text`/`long-click`/`double-click`); only `ui-server` implements `InspectorElementActions`.

The three matching helpers a selector's behaviour is defined by — `matches`, `matchSelector`, `centerOf` — live in `@enkaku/protocol` (`selector-match.ts`), not here. Studio counts selector matches against a dumped tree, and it must never depend on this package (adb and Bun-side transports would leak into a browser bundle), so the ONE comparison both a driver's `find()` and Studio's match count run is defined once, in the package both already depend on. `packages/protocol/src/selector-analysis.ts` builds on it for the ranked, counted candidates the Inspect tab proposes.

## The network layer (spec §7.9)

The fifth layer, and the only optional one — its default engine is `none`, and a device with `none` behaves exactly as it did before the layer existed.

Four engines, on spec §7.9's three-rung ladder. **The rungs are not equals**, and the capability column is the honest form of that — every `false` in it is a fact worth publishing, not a gap to hide:

| Engine | Capabilities | Enforcing? | Notes |
|---|---|---|---|
| `none` | — | — | The default. Never touches the device's routing |
| `adb-proxy` | *(none)* | **no — advisory** | `settings put global http_proxy host:port` over the transport (`network/adb-proxy/http-proxy.ts`, plan 114). Apps that honour the system proxy use it; an app with its own networking, its own resolver, or a pinned client ignores it and nothing on the phone stops it. Android's value has no credential field and is world-readable by every app on the device, so one is **refused**, never written (`E_HTTP_PROXY_NO_AUTH`) |
| `adb-reverse-proxy` | *(none)* | **no — advisory** | The same advisory setting, pointed at `127.0.0.1:<devicePort>` on the device side of an `adb reverse` (`network/adb-proxy/reverse-proxy.ts`, plan 114). This is the rung on which an authenticated upstream becomes possible **at all** — the account lives in the listener on the farm's machine and never reaches the phone — but the engine itself supports no authentication, hence `auth: false`. Exercised over USB only; wireless `adb reverse` is untested |
| `vpn-helper` | auth, enforcing, udp, probe | **yes** | A SOCKS5 full tunnel via the on-device guest agent (`network/guest-agent/`). The only rung an app under test cannot ignore |

Two things follow from that table and neither is optional wording:

**`health` is structurally `unverified` for both advisory rungs, forever.** Their `egress` check is a permanent `skip`, and `deriveHealth()` (`@enkaku/protocol`) gates `ok` behind a passing `egress` and nothing else — so the top state is unreachable for them by construction, not by omission. That is the correct answer: an egress probe has to run *on the device* to say anything, and the only thing a device-side probe could ever prove about an advisory setting is that a client which honours it can reach the proxy — never that any app under test does. Reporting that as a pass would promote `health` to `ok` and be a false statement about the phone. What these rungs' `setting` check does prove is real and worth showing: the device accepted the write and reports the value back. That is not success. **`unverified` must never be worded as success** (CLAUDE.md), and for these two it is the terminal state.

**`vpn-helper` advertises `probe` (plan 51 §4.2/§5.4 — a real egress probe measured from inside the tunnel), and advertising it is not the same as passing it**: `deriveHealth()` still reports `unverified` until an `egress` check actually passes. A successful `apply()` means the command succeeded, not that traffic is genuinely leaving through the proxy.

All four hold the `network-route` lock, so two network engines can never be active at once — switching a device from one to another reverts the incumbent first, in the same request, and a failed revert refuses the new apply rather than leaving two half-applied routes.

Both advisory engines capture the device's own four `global` proxy values before their first write and restore them verbatim on revert. Where the captured value was empty, or where nothing was ever captured, they write `:0` **then** `delete` — `delete` alone does not reliably stop the framework using a proxy it has already read, and `:0` alone would leave a literal string a pristine device never had. `:0` is a step, never the terminal state; plan 33 §5.5's original prescription said otherwise and was corrected.

The guest agent behind `vpn-helper` is a first-party APK with four facets, not a single-purpose proxy shim — see `apps/guest-agent/README.md` for the membership rule that decides what belongs in it, and `packages/core/README.md`'s "The agent is a device property, not a session step" section for how it is provisioned onto every admitted device (plan 90).

## Text input: a three-rung ladder, and how to read `via` (plan 90 §3.2, §3.3)

Typing non-ASCII text has three possible paths, tried in this fixed order by `packages/session/src/text-input.ts`'s `resolveTextRoute` (a pure resolver — no I/O — shared by the WS handler, the script executor, and any future multi-device fan-out):

| Rung | `via` | Path | Unicode | Side effects | Needs |
|---|---|---|---|---|---|
| 1 | `agent-ime` | `text.commit` over the guest agent's control channel | ✓ | none | a guest agent advertising `text-input`, with its IME current |
| 2 | `scrcpy-text` | scrcpy `INJECT_TEXT` (control type 1) | ✓ (UTF-8 on the wire) | none | a scrcpy control socket — `text-unicode`, declared by `scrcpy-uhid`/`scrcpy-sdk` |
| 3 | `adb-ascii` | `adb shell input text` | ✗ (`\x20`-`\x7e` only) | none | nothing — always available, declared as `text-ascii` |

`text-ascii`/`text-unicode` (`descriptors.ts`) are read by the resolver, not merely declared — a CJK or emoji string that cannot be carried by any available rung refuses with a **named precondition** (`E_TEXT_UNICODE_UNSUPPORTED`, `action: 'install-agent'`) rather than reaching a driver and dying as a runtime error. `input.text`'s reply and a script's `type()` result both carry `via`, so "my text appended instead of replacing" or "why didn't this land" is debuggable from which rung actually ran, without reading server logs.

**A fourth rung — clipboard paste — was designed, fully built, and then removed** (`docs/plans/96-m61-hotfixes.md` §96.7, §96.8): it was proven architecturally unreachable, because its own precondition (a scrcpy control socket) is the exact same boolean that gates rung 2, and rung 2 has no side effect while the clipboard rung does — so rung 2 always won first, on every input this codebase can produce. `clipboard.overwritten` no longer exists as a device event. **The `Cmd/Ctrl+V` paste chord Studio exposes is a separate, live feature** (`clipboard.set(..., {paste: true})` over the scrcpy control socket, plan 38) — it is not part of this ladder and was never removed; do not confuse the two.

## The ui-server watchdog: starting is not the same as running

`UiServerWatchdog` draws a hard line between a **start** and the **runtime** that follows it, and the two have different rules (plan 129, from a field report on an Android 16 farm where the server never came up at all).

**A start either succeeds or throws.** `start()` runs the launcher, then pings until `startTimeoutMs`. If the server never answers, it marks itself dead and throws — it does not spend a restart cycle, and it does not resolve. That throw is load-bearing: `createInspectorForSession` catches it and returns a `uiautomator-dump` handle instead, which is how a session on a phone with a broken ui-server still gets a working inspector. Before this, `start()` resolved either way, so a dead server was reported as a live one and that fallback — which had existed all along — was unreachable.

**The runtime is where the circuit breaker lives.** The idle ping timer and `reportFailure()` spend cycles against `maxRestartsPerWindow` / `restartWindowMs`, and a server that dies an hour into a session is restarted in place. That budget is deliberately not spent on the start path: a second start-time wait doubles the delay before the working engine takes over, and on the farm this was measured against it never once produced a healthy server.

**Client errors never name a timeout that did not happen.** `UiServerClient` reports `did not respond within Nms` only for a request genuinely aborted by its own deadline; anything else — a refused connection, a socket closed under a stale `adb forward` — reports the elapsed time it actually took. The previous wording stamped the timeout budget onto every failure, so a connection refused in 5 ms read as a 20-second timeout and sent an investigation after the wrong cause.
