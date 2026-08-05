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
| `vpn-helper` | auth, enforcing, udp | A SOCKS5 full tunnel via the on-device guest agent (`network/guest-agent/`). The only rung an app under test cannot ignore — `settings put global http_proxy` is advisory and can be bypassed |

`vpn-helper` does **not** advertise `probe`, because the egress probe does not exist yet. Its route status is therefore reported as `unverified`, never `ok`: a successful apply means the command succeeded, not that traffic is genuinely leaving through the proxy. Claiming otherwise is exactly the failure the capability list exists to prevent.

Both hold the `network-route` lock, so two network engines can never be active at once.
