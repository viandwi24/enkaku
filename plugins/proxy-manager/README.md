# @enkaku/plugin-proxy-manager

A catalogue of proxy records, a three-tab React screen, and a service that runs a local HTTP or
SOCKS5 bridge per enabled record — either forwarding through a vendor upstream (`socks5`/`http`)
or, as of plan 117 (M82), dialling out of the farm's own machine directly (`direct`). Read
`src/index.ts`'s own module header for the full design story; this file covers what an operator
needs to know to use it, plus the parts that only make sense once egress binding exists.

## Tabs

| tab | what it is |
|---|---|
| **Catalogue** | Every proxy record: upstream protocol, listener, credentials, capacity, and the range generator for creating several at once from one pattern. |
| **Assignments** | One note per device — which catalogue record it is meant to use — and the **Apply** button that actually asks the farm to change the phone's networking, as an HTTP proxy or as a VPN route. |
| **Runs** | This plugin's own job history. |

Nothing on the Catalogue or Assignments tab changes a phone by itself. A catalogue edit is a
record; a note is an intention; only **Apply**, pressed once per device, asks the farm to act —
see `src/service/apply.ts`'s own header for why that call goes through a capability rather than a
plain `fetch`.

## Egress binding (`direct` upstream, plan 117)

Three vendor protocols (`socks5`, `http`, `https`) forward through *someone else's* proxy. The
fourth, `direct`, has no upstream at all — the farm's own host machine performs the egress,
optionally bound to one of the host's own addresses:

```ts
upstream: { proto: 'direct', bindAddress: '192.0.2.11', resolveThroughEgress: true }
```

- **`bindAddress`** is the local source address the record's outgoing sockets bind to
  (`net.connect({ localAddress })` — the same thing `curl --interface` does, and nothing more).
  **An empty `bindAddress` means "dial out however this host normally would"** — a plain local
  bridge, useful even with no proxy account of any kind. What a non-empty address actually maps to
  physically (a second NIC, a policy-routed alias, a VRF) is entirely the operator's own doing; see
  `docs/guide/install.md`'s "Egress binding: one proxy per way out" for the recipe and why this
  pack never reads or writes that mapping itself.
- **`resolveThroughEgress`** (default **on**, only meaningful with a non-empty `bindAddress`)
  decides whether the destination hostname is looked up through the *same* bound address as the
  connection itself, using a `node:dns/promises` resolver with `setLocalAddress(bindAddress)`.
  **On** — a name is resolved via that address, and a resolver failure is reported as
  `E_PROXY_DNS_EGRESS_FAILED` rather than silently retried through the host's default resolver,
  because a silent fallback is exactly the mismatch this option exists to prevent (a lookup that
  leaves through the office network while the connection itself leaves through an LTE link, with
  nothing reporting the difference). **Off** — the host's ordinary DNS resolution is used, and the
  record's own description says so.
- **`capacity`** (`0` = unlimited) and **`exclusive`** bound how many devices may be noted against
  one record at once, enforced at Apply time (`E_PROXY_CAPACITY_FULL`, naming the count and the
  devices already holding it) — the guard against quietly putting six devices behind one address.
  This counts the assignment *note*, not observed traffic: an HTTP-mode proxy is advisory (an app
  can ignore it), so the count is of what the operator asked this record to carry, and applies the
  same way to both apply modes.

### VPN mode sends a credential to the phone

Both apply modes exist because they trade off differently, and this trade-off does not change for
a `direct` record:

- **HTTP mode** — the bridge stays on this machine (`adb reverse`); no proxy account or listener
  credential ever leaves the farm; an app with its own networking can simply ignore the setting.
- **VPN mode** — the guest agent on the phone dials the bridge directly over the network, so an
  app cannot opt out, and the trade is that **a credential is sent to the phone** to do it. For a
  vendor record that credential is the vendor account; for a `direct` record it is the record's own
  **listener** credential (the same one a LAN client would have to present to that bridge) — never
  the plaintext of anything else, and per-record, so one credential recovered from a phone opens
  one egress rather than every record this pack manages.

A non-loopback listener bind is refused (`E_PROXY_LISTENER_AUTH_REQUIRED`) unless the record has a
saved listener credential — the loopback rule is not relaxed, it is made conditional on the thing
that made it necessary in the first place (an unauthenticated proxy reachable off-host is an open
relay).

### What this pack is honest about, and what it is not

- **The observed public address is a measurement, not a promise.** A record that has not passed
  the egress probe reads `unverified` on the Catalogue tab — never worded as success — and the
  probe reports `skip`, never a false `ok`, when no probe endpoint is configured.
- **Capacity counts intent, not packets.** See above — do not read a record's `3 of 5 noted` as
  "3 devices are currently sending traffic through this link."
- **Nothing here knows about any particular router, VLAN, or modem.** `bindAddress` names a host
  address; what that address is wired to is the operator's own infrastructure, done once, outside
  this pack entirely.

## Permissions this pack declares

```ts
service: defineService({ permissions: ['device.list', 'device.network.set'] })
```

- **`device.list`** — maps a device's stable id to its farm row id, and (for VPN Apply) reads the
  guest agent's own provisioning state.
- **`device.network.set`** — the one capability Apply calls, under a `plugin:proxy-manager`
  principal, checked against the farm's real ACL and audited, so a device's Network panel reports
  correctly *who* set its route.

## Development

```bash
bunx enkaku dev ./src/index.ts --farm http://localhost:7700
```

See `packages/sdk/README.md` for what `definePlugin`, `defineService`, `ctx.farm`, and a plugin's
`surface` actually are.
