# Plan 27 — M12f : A Lease-Scoped adb Endpoint for Local Devices

> Status: draft — **the largest and riskiest plan in the M12 series. Start with the spike in step 27.1 and stop if it fails.**
> Depends on: **Plan 22.1** (deadlines), **Plan 26** (the permission, lease, and audit model this reuses). Plan 24's lane supplies the stream budget.
> Blocks: Plan 28 (the cloud variant reuses this shim wholesale).
> Spec references: §10.1 (server-authoritative control), §10.2 (leases), §10.4 (adb serialisation), §11.3 (not a sandbox).

---

## 1. Goals

- While holding a device lease, a user can run `adb connect <host>:<port>` from their own machine and use that farm device with their **own** adb: `shell`, `install`, `push`/`pull`, `logcat`, Android Studio, their own scripts.
- The endpoint exists only for the life of the lease, on an ephemeral port, and disappears when the lease is released.
- It binds to loopback by default; exposing it beyond the host is a deliberate setting with a stated consequence.
- Every connection and every stream it opens is audited, so "what did that session do" is answerable.
- The farm's own traffic is not starved: endpoint streams draw from a bounded budget.

## 2. Non-goals

- Cloud / agent-owned devices — Plan 28 (it reuses everything here).
- Replacing the Plan 26 terminal. The terminal stays the zero-setup path; this is the power path.
- ADB authentication with the user's RSA key (§3.4 explains why it is skipped and what replaces it).
- `adb pair` / wireless pairing flows. The enrolment wizard already owns those.

## 3. Context and design decisions

### 3.1 Why this shape at all

A web terminal is a small window onto a device. Mature device farms tend to solve the same problem the other way round: instead of rebuilding developer tooling in a browser, they lend the developer a real adb endpoint for the duration of their session. The user then keeps every tool they already have.

For this farm the concrete wins are `install`, `push`/`pull`, and attaching a debugger — none of which a `shell:` one-shot can offer.

### 3.2 What `adb connect` actually requires

`adb connect host:port` makes the user's **local adb server** connect and speak the ADB *transport* protocol — the same protocol `adbd` speaks over TCP. That is not the smartsocket protocol `packages/adb` implements today (which is what a *client* speaks to its *server*).

So the endpoint must impersonate `adbd`:

- 24-byte message header: `command`, `arg0`, `arg1`, `data_length`, `data_crc32`, `magic` (= `~command`), little-endian.
- `CNXN` handshake with a version and `maxdata`, answered with a system banner (`device::ro.product.name=…;ro.product.model=…;features=…`).
- `OPEN` / `OKAY` / `WRTE` / `CLSE` per stream, with the ready-based flow control (a `WRTE` must be acknowledged by `OKAY` before the next one on that stream).

The inside of the bridge is straightforward, and this is what makes the plan viable: after `host:transport:<serial>`, the smartsocket delivers a **raw byte stream for whatever service was requested** — `shell:…`, `sync:`, `reverse:…`. That is byte-for-byte what an ADB stream carries. So each `OPEN` maps to one smartsocket connection, and the shim is protocol framing on the outside and existing plumbing on the inside.

### 3.3 Why not simply `adb tcpip 5555`

The obvious shortcut — switch the device to TCP mode and proxy to port 5555 — has three problems: it only works for devices on a routable network, it can disturb the farm's own USB connection to that device, and it leaves the device listening for anyone on that network after the session ends. It stays documented as a manual fallback for devices already in TCP mode, and is not the implementation.

### 3.4 Authentication: skipped in the protocol, enforced around it

`adbd` normally challenges with `AUTH` and requires the client to sign a token with its RSA key. Verifying arbitrary user keys would mean a key-management feature nobody asked for.

Instead the endpoint behaves like an `adbd` with authentication disabled, and the access control sits around it:

1. `device.adb` permission (new, admin-only by default, same `shell.mode` switch as Plan 26).
2. A held **manual lease** on that device — the endpoint is created by the lease holder and dies with the lease.
3. An **ephemeral port**, allocated per session and never reused while alive.
4. **Loopback binding by default.** With the default, only processes on the core's host can connect; that is the single-machine case and it is safe. Widening it is a setting whose description states plainly that anyone who can reach the port gets full control of the device.
5. Idle timeout: no TCP connection for `adb.endpointIdleSec` (default 300) closes it.

This must be written down honestly in the docs: **an open endpoint is exactly as sensitive as an open shell**, and that is why it is short-lived, narrow, and audited.

### 3.5 Stream budget

A single `adb` session opens several streams (a shell here, a sync there, `logcat` in another window). These bypass `PerDeviceQueue` on purpose — they are long-lived, and Plan 24 §3.1 already established that long-lived work must not hold queue slots.

They therefore draw from a dedicated budget, `adb.maxEndpointStreams` (default 8 per device), rejecting further `OPEN`s with `CLSE` rather than queuing.

### 3.6 Auditing at the stream level

Recording "a TCP connection happened" is useless. Recording the destination of every `OPEN` is not: `shell:pm install …`, `sync:`, `shell:logcat` tell the whole story of a session.

Every `OPEN` destination is recorded on the Plan 18 `input` stream as `adb.open`, with the same redaction as Plan 26, plus `adb.endpoint.opened` / `adb.endpoint.closed` on the `main` stream.

## 4. Technical design

### 4.1 New package area — `packages/adb/src/transport/`

| File | Responsibility |
|---|---|
| `wire.ts` | Encode/decode the 24-byte header, CRC, magic validation, `maxdata` handling. Pure, exhaustively unit-tested. |
| `banner.ts` | Build the `device::…` system banner from the device row (model, product, API level, `features=cmd,shell_v2,stat_v2`). |
| `stream-mux.ts` | The per-connection stream table: local/remote ids, ready-window flow control, `CLSE` propagation. |
| `adbd-shim.ts` | Ties it together: accepts a socket, performs `CNXN`, and bridges each `OPEN` to a smartsocket stream. |

```ts
export interface AdbdShimDeps {
  /** Opens a raw smartsocket stream: host:transport:<serial> then <service>. */
  openService(serial: string, service: string): Promise<RawStream>
  serial: string
  banner: string
  maxStreams: number
  onOpen(service: string): void          // audit hook
  onClose(reason: string): void
  log(level: 'debug' | 'warn', msg: string): void
}

export function createAdbdShim(deps: AdbdShimDeps): (socket: import('bun').Socket) => void
```

`openService` is a thin addition to `AdbClient` (`openRaw(serial, service)`), reusing `AdbSocket` but returning the socket after the handshake rather than reading it to completion.

Features advertised in the banner must match what the shim actually passes through. Claiming `shell_v2` and then not carrying it is worse than not claiming it — the client will use the feature and get a broken stream.

### 4.2 Endpoint manager — `packages/core/src/device/adb-endpoint.ts` (new)

```ts
export interface AdbEndpointManager {
  open(deviceId: string, clientId: string, userId: string | null): Promise<{ host: string; port: number; expiresAt: number }>
  close(deviceId: string, reason: string): void
  get(deviceId: string): { port: number; connections: number; openedAt: number } | null
  closeAllForClient(clientId: string): void
}
```

- One endpoint per device. A second `open` from the same lease holder returns the existing one.
- `Bun.listen` on `adb.endpointBind` (default `127.0.0.1`) with port `0`, so the OS allocates.
- Subscribes to lease release, device offline, and WS disconnect; each closes the listener and destroys live connections.
- Reports `connections` for the Studio panel and `/api/adb/stats`.

### 4.3 API and settings

```
POST   /api/devices/:id/adb-endpoint    → { host, port, expiresAt, command: "adb connect host:port" }
DELETE /api/devices/:id/adb-endpoint
GET    /api/devices/:id/adb-endpoint    → null | { port, connections, openedAt, expiresAt }
```

All three require `device.adb` **and** the manual lease, checked with the same `checkInputAllowed` call Plan 26 uses — one policy, one implementation.

Settings (`shell` block from Plan 26 §4.1 gains):

```ts
endpointEnabled: z.boolean().default(false)
  .describe('Allow lease holders to open a temporary adb endpoint for this farm.')
  .meta({ title: 'Allow adb endpoint' }),
endpointBind: z.string().default('127.0.0.1')
  .describe('Address the temporary adb endpoint binds to. Anything other than 127.0.0.1 exposes full device control to that network.')
  .meta({ title: 'adb endpoint bind address' }),
endpointIdleSec: z.number().int().min(30).max(3600).default(300)
  .describe('Close the endpoint after this long with no connection.')
  .meta({ title: 'adb endpoint idle timeout (s)' }),
maxEndpointStreams: z.number().int().min(1).max(32).default(8)
  .describe('Concurrent adb streams allowed per endpoint.')
  .meta({ title: 'Max endpoint streams' }),
```

Default `false`: this is opt-in even on a laptop.

### 4.4 Studio

On the device page, beside the terminal: an "adb endpoint" card, visible only to the lease holder when enabled. It shows the copyable `adb connect …` line, a live connection count, the idle countdown, and a close button, plus one sentence stating the endpoint grants full adb access to whoever can reach the address.

## 5. Implementation steps

**27.1 — Spike first (timeboxed, throwaway)** *(do not proceed if this fails)*
- Minimal `CNXN` + one `OPEN shell:echo hi` bridged to the smartsocket, in a scratch script.
- Prove that a real `adb connect 127.0.0.1:<port>` followed by `adb -s <host:port> shell echo hi` returns `hi`.
- Record what the client sent, its version and `maxdata`, and which features it needed. **This measurement drives every default below.**

**27.2 — `wire.ts`**
- Header encode/decode, CRC, magic check, `maxdata` clamping; property tests over random payloads and truncated buffers.

**27.3 — `stream-mux.ts`**
- The stream table, ready-window flow control, `CLSE` both ways, the stream cap (§3.5).
- Tested against a scripted byte-level peer — no device needed.

**27.4 — `adbd-shim.ts` and `AdbClient.openRaw`**
- Full handshake, banner from `banner.ts`, per-`OPEN` bridging, audit hooks.

**27.5 — Endpoint manager, API, settings**
- §4.2 and §4.3, including lease-release / disconnect / offline teardown and the idle timer.

**27.6 — Audit**
- `adb.endpoint.opened` / `.closed` on the main stream; `adb.open` per stream on the input stream, redacted.

**27.7 — Studio card**
- §4.4.

**27.8 — Documentation**
- `docs/guide/install.md`: how to use it, and an explicit warning about `endpointBind`.

## 6. Acceptance criteria

1. With the lease held and the feature enabled, `adb connect <host>:<port>` succeeds and the device appears in the user's `adb devices`.
2. `adb -s <host:port> shell getprop ro.serialno` returns the expected serial.
3. `adb -s <host:port> install <apk>` and `push`/`pull` succeed (the `sync:` service is carried correctly).
4. `adb -s <host:port> logcat` streams and stops cleanly on Ctrl-C.
5. Releasing the lease closes the listener and drops live connections within a second; the user's adb reports the device offline.
6. With no connection for `endpointIdleSec`, the endpoint closes by itself.
7. Without `device.adb`, without a lease, or with `endpointEnabled: false`, the API refuses.
8. The default bind is `127.0.0.1`; a connection attempt from another host fails.
9. Opening more than `maxEndpointStreams` streams is refused with `CLSE`, and existing streams keep working.
10. The event log shows the endpoint's open and close plus every `OPEN` destination, redacted.
11. Farm traffic is unaffected while an endpoint is in use: video FPS, tap latency, and battery polling stay within their Plan 24 §6 bounds.
12. The advertised feature list matches what the shim carries (no feature is claimed and then broken).
13. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit (no device):**
- `wire.test.ts` — round-trips, CRC, bad magic, truncation, `maxdata` clamping.
- `stream-mux.test.ts` — flow control, interleaved streams, `CLSE` from either side, the cap, no id leaks.
- `adb-endpoint.test.ts` — lifecycle against a fake shim: lease release, idle timeout, disconnect, one endpoint per device.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, a real device and a real `adb` on the host):**
```bash
bun run dev && bun run dev:studio
# take control, enable the feature, open the endpoint, then:
adb connect 127.0.0.1:<port>
adb -s 127.0.0.1:<port> shell getprop ro.serialno
adb -s 127.0.0.1:<port> install ./test.apk
adb -s 127.0.0.1:<port> push ./f.txt /data/local/tmp/ && adb -s ... pull /data/local/tmp/f.txt
adb -s 127.0.0.1:<port> logcat   # Ctrl-C
# while all of the above runs: video keeps streaming, taps land, battery polls
# release the lease → adb devices shows it offline
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The ADB transport protocol turns out to need more than the spike covers (STLS, protocol v2 negotiation, feature quirks per adb version). | Step 27.1 is a hard gate: measure against the real client before building. If the spike fails, the fallback is documented (§3.3) and the plan stops without sunk cost. |
| Flow-control bugs cause deadlock or corruption during large `push`/`pull`. | `stream-mux` is tested byte-level against a scripted peer, and the smoke test includes a multi-megabyte transfer with a checksum comparison. |
| Someone sets `endpointBind: 0.0.0.0` and exposes a device to the network. | Default loopback; the setting's own description states the consequence; the Studio card repeats it; the endpoint is still lease-bound, short-lived, and audited. |
| Skipping ADB auth is mistaken for a system-wide weakening. | It applies only to this ephemeral, lease-bound, loopback-by-default listener — never to how the core talks to devices. Documented in the guide and in the code comment. |
| Endpoint streams starve the farm. | A separate budget (§3.5), never the global semaphore; verified by acceptance criterion 11. |
| The plan is too large for one working session. | The file boundaries in §4.1 are the split points: `wire` → `stream-mux` → `shim` → manager are four independently testable steps, and the first two need no device. |

## 9. Open questions

1. Should the endpoint offer a **shared read-only** mode (a second port that permits only `shell:` and refuses `sync:`)? Deferred until there is demand.
2. Should the port be stable per device so a user's `adb connect` line does not change between sessions? Stability is friendlier; ephemeral is safer. Currently ephemeral.
3. Does `reverse:` need special handling, or does passing it through suffice? To be answered by the spike.
