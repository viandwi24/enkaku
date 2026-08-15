# @enkaku/drivers

Implementations of the five driver layers (spec §7): Transport / DisplaySource / InputSink / Inspector / NetworkRoute.

## M2 engines

| Engine | Layer | Notes |
|---|---|---|
| `adb-usb` | transport | Wraps @enkaku/adb; every exec goes through the per-device queue |
| `adb-tcp` | transport | Adds the `adb connect/disconnect` host services |
| `screencap-loop` | display | **Fallback / MVP** — `exec-out screencap -p`, PNG at roughly 2–3 fps, high latency, wasteful bandwidth. The production default is scrcpy (Plan 08) |
| `adb-input` | input | **Fallback** `sdk` mode (InputManager injection — detectable as injected, spec §9.1). `input text` handles printable ASCII only. The production default is scrcpy-uhid (Plan 08) |

Inspectors arrive in Plan 05 (`uiautomator-dump`) and Plan 06 (`ui-server`).

## Inspection capabilities (plan 56)

Both inspector engines declare `dump`/`find`/`screenshot` in their `EngineDescriptor.capabilities` (`descriptors.ts`) — that list is what Studio's Inspect tab (plan 56) checks before it lets an operator read a device's UI tree: a session running an engine that has not declared `dump` is refused with a named reason, never handed a fabricated empty tree. `uiautomator-dump` additionally lacks any element-action capabilities (`set-text`/`long-click`/`double-click`); only `ui-server` implements `InspectorElementActions`.

The three matching helpers a selector's behaviour is defined by — `matches`, `matchSelector`, `centerOf` — live in `@enkaku/protocol` (`selector-match.ts`), not here. Studio counts selector matches against a dumped tree, and it must never depend on this package (adb and Bun-side transports would leak into a browser bundle), so the ONE comparison both a driver's `find()` and Studio's match count run is defined once, in the package both already depend on. `packages/protocol/src/selector-analysis.ts` builds on it for the ranked, counted candidates the Inspect tab proposes.

## The network layer (spec §7.9)

The fifth layer, and the only optional one — its default engine is `none`, and a device with `none` behaves exactly as it did before the layer existed.

| Engine | Capabilities | Notes |
|---|---|---|
| `none` | — | The default. Never touches the device's routing |
| `vpn-helper` | auth, enforcing, udp, probe | A SOCKS5 full tunnel via the on-device guest agent (`network/guest-agent/`). The only rung an app under test cannot ignore — `settings put global http_proxy` is advisory and can be bypassed |

`vpn-helper` advertises `probe` (since plan 51 §4.2/§5.4 — a real egress probe measured from inside the tunnel). Advertising it is not the same as passing it: `deriveHealth()` (`@enkaku/protocol`) still reports `unverified` until an `egress` check actually passes — a successful `apply()` means the command succeeded, not that traffic is genuinely leaving through the proxy, and `unverified` must never be worded as success (CLAUDE.md).

Both hold the `network-route` lock, so two network engines can never be active at once.

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
