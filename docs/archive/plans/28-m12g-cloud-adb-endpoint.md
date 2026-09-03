# Plan 28 — M12g : The adb Endpoint for Cloud Devices

> Status: partial — the protocol additions, remote `openService`, agent-side handler, and delivery-acknowledged flow control (§3.3) are all built and tested; step 28.5 (measuring real throughput/latency and writing the numbers into the guide) was never done, so `docs/guide/cloud.md` still says "not yet measured" and acceptance criterion 10 is unmet.
> Ships: packages/core/src/tunnel/adb-remote.ts
> Depends on: **Plan 27** (the adbd shim, the endpoint manager, the permission and lease model), **Plan 25** (the tunnel RPC and binary channels).
> Spec references: §10.2 (leases), §13 (protocol), plan 11 §4.2 (tunnel envelope), plan 12 (cloud sessions).

---

## 1. Goals

- `adb connect` works against an **agent-owned** device exactly as it does for a local one, from the control plane's address.
- ADB streams are carried over the existing tunnel binary channels; the agent terminates them into its own adb server.
- Failure modes are explicit: an agent that drops mid-transfer produces a clear error, not a stalled `adb push`.
- Throughput and latency limits are measured and documented rather than discovered by a user mid-install.
- No change to Studio beyond what Plan 27 already built.

## 2. Non-goals

- Direct peer-to-peer connections between the user's machine and the agent (NAT traversal, WebRTC data channels). Everything relays through the control plane, as video already does.
- Changing the ADB protocol implementation. The shim from Plan 27 is reused unmodified; only its `openService` dependency changes.
- Multi-agent aggregation (one endpoint fronting devices from several agents).

## 3. Context and design decisions

### 3.1 The shim was written with exactly one seam

Plan 27 §4.1 defines the shim's only device-facing dependency:

```ts
openService(serial: string, service: string): Promise<RawStream>
```

Local mode implements it with `AdbClient.openRaw`. Cloud mode implements it by opening a tunnel channel to the agent and asking the agent to run the same call. Everything else — the `CNXN` handshake, flow control, the stream table, the banner, the audit hooks, the endpoint manager, the Studio card — is untouched.

That seam is what makes this plan tractable, and it is why Plan 27 must land first and be proven.

### 3.2 One tunnel channel per ADB stream

`TunnelChannelOpenMessage` already allocates 16-bit channel ids and frames data as `[0x02][channelId u16BE][payload]` (`packages/protocol/src/tunnel.ts:94-120`). Plan 25 added `kind: 'shell'`; this plan adds `kind: 'adb-raw'`.

Mapping one ADB stream to one channel keeps the design simple: the tunnel channel *is* the stream, close is close, and there is no second layer of multiplexing to debug. A busy session uses perhaps a dozen channels out of 65 536.

The alternative — multiplexing every ADB stream inside a single channel — would mean reimplementing stream framing and flow control on top of a transport that already offers it. Rejected.

### 3.3 Flow control has to survive two hops

Locally, one `WRTE`/`OKAY` window sits between the user's adb and the device. In cloud mode the path is:

```
user's adb ⇄ shim (control plane) ⇄ tunnel channel ⇄ agent ⇄ agent's adb server ⇄ device
```

If the shim acknowledges a `WRTE` as soon as it hands the bytes to the tunnel, it is lying about delivery, and a large `push` will buffer without limit in the control plane. So the acknowledgement must follow the **agent's** acknowledgement: the agent reports how many bytes it has written downstream, and the shim releases its window only then.

That is one extra message type and it is the single most important correctness detail in this plan.

### 3.4 Expectations must be measured, not assumed

`adb install` of a 50 MB APK across a relayed WAN link is not the same experience as over USB. Rather than let a user discover that during a demo, step 28.5 measures throughput and round-trip latency on a real link, and the numbers go into `docs/guide/cloud.md` alongside the feature.

If the measurement shows `sync:` is impractical over a typical link, the honest response is to document it and consider gating `sync:` behind a warning — not to hide it.

### 3.5 Agent disconnection is a first-class outcome

Plan 25 §4.1 already fails outstanding RPCs when an agent drops. Here the same event must close every ADB stream that agent owned, tear down the endpoint, and let the user's adb see the device go offline promptly — which it does the moment the TCP connection closes. Half-open streams that never resolve are the worst possible failure for a file transfer.

## 4. Technical design

### 4.1 Protocol additions — `packages/protocol/src/tunnel.ts`

```ts
kind: z.enum(['video', 'audio', 'control-raw', 'shell', 'adb-raw'])   // extended

{ type: 'adb.open.request', payload: { deviceId, service: z.string().max(1024), channelId } }
{ type: 'adb.open.reply',   payload: { ok, error?: { code, message } } }
{ type: 'adb.close',        payload: { channelId, reason } }
/** Delivery acknowledgement for §3.3: bytes actually written downstream. */
{ type: 'adb.ack',          payload: { channelId, bytes } }
```

Payload bytes travel as tunnel frames on `channelId`, in both directions.

### 4.2 Remote `openService` — `packages/core/src/tunnel/adb-remote.ts` (new)

```ts
export function createRemoteOpenService(deps: { rpc: TunnelRpc; router: TunnelRouter }): AdbdShimDeps['openService']
```

Per call:
1. Allocate a channel id; send `tunnel.channel.open { kind: 'adb-raw' }`.
2. `rpc.request('adb.open.request', { service, channelId })`; a failure releases the channel and rejects, which the shim turns into `CLSE`.
3. Return a `RawStream` whose writes become tunnel frames and whose reads come from inbound frames on that channel.
4. `adb.ack` from the agent advances the delivery window (§3.3).
5. Close on either side → `adb.close` → `tunnel.channel.close` → release the id in a `finally`.

### 4.3 Agent side — `packages/agent/src/adb-raw.ts` (new)

- On `adb.open.request`: `AdbClient.openRaw(serial, service)` against its own adb server, reply, then pipe both directions.
- Emits `adb.ack` after each successful downstream write, with the byte count.
- Enforces its own per-device stream cap (`maxEndpointStreams`), so an agent cannot be pushed past its limit.
- On tunnel loss, device loss, or `adb.close`: destroys the smartsocket stream immediately.

### 4.4 Endpoint manager wiring

`AdbEndpointManager.open` (Plan 27 §4.2) picks the `openService` implementation the same way `ws-handlers.ts:317` already picks a session: an agent-owned device gets the remote one, everything else the local one. The listener, port allocation, lease binding, idle timer, and teardown are unchanged.

Audit gains the agent id on `adb.endpoint.opened`, so a session can be traced to the machine that served it.

## 5. Implementation steps

**28.1 — Protocol**
- Extend the channel `kind` enum; add the four message shapes (§4.1).

**28.2 — Remote `openService`**
- `packages/core/src/tunnel/adb-remote.ts` (§4.2), including channel release in `finally` on every path.

**28.3 — Agent handler**
- `packages/agent/src/adb-raw.ts` (§4.3), registered alongside the Plan 25 shell handlers.

**28.4 — Delivery-acknowledged flow control**
- Implement §3.3 end to end: the shim's window advances only on `adb.ack`.
- Result: a large `push` over an artificially delayed link does not grow control-plane memory (measured, not assumed).

**28.5 — Measure and document**
- Throughput and RTT for `shell`, `logcat`, `install`, and `push`/`pull` on a real link.
- Write the numbers into `docs/guide/cloud.md` with a note on what is comfortable and what is not.

**28.6 — Failure paths**
- Agent disconnect, device offline, and lease release each close every stream and the endpoint promptly (§3.5).

## 6. Acceptance criteria

1. `adb connect <control-plane>:<port>` against an agent-owned device works, and `adb devices` lists it.
2. `shell`, `logcat`, `install`, `push`, and `pull` all work against a cloud device.
3. A pushed file arrives byte-identical (checksum compared in the smoke test).
4. Control-plane memory stays flat during a large `push` over a delayed link — the window follows `adb.ack`, not local buffering.
5. Killing the agent mid-`push` fails the transfer with a clear error within seconds; nothing hangs.
6. Releasing the lease closes every stream and the endpoint; the user's adb reports the device offline.
7. Channel ids are released on every path; the allocator returns to its initial size after repeated sessions.
8. Exceeding the agent's stream cap is refused with a coded error, and existing streams keep working.
9. Local-mode behaviour from Plan 27 is unchanged; every Plan 27 test still passes.
10. `docs/guide/cloud.md` states the measured throughput and latency.
11. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit (no device, no agent):**
- `adb-remote.test.ts` — against a fake rpc/router: open, data both ways, ack-driven window, close from either side, channel release, agent-offline rejection.
- A flow-control test that asserts the window does not advance without `adb.ack`.

**Manual smoke (a real agent with a real device):**
```bash
bun run dev:cloud
ENKAKU_CP_URL=... bun run dev:agent
# take control of the agent's device, open the endpoint, then from a third machine or the same host:
adb connect <control-plane>:<port>
adb -s <cp:port> shell getprop ro.serialno
adb -s <cp:port> install ./test.apk
adb -s <cp:port> push ./big.bin /data/local/tmp/ && adb -s <cp:port> pull /data/local/tmp/big.bin ./out.bin
shasum ./big.bin ./out.bin        # must match
adb -s <cp:port> logcat           # Ctrl-C
# kill the agent mid-push → the transfer fails promptly with a clear message
# restart the agent, reconnect, repeat → no leaked channels (check /api/adb/stats)
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Acknowledging writes too early buffers a whole APK in the control plane. | §3.3's delivery acknowledgement is a named acceptance criterion (§6.4) with its own unit test, not an implementation detail. |
| File transfer is too slow to be useful over a real WAN link. | Measured in step 28.5 and documented honestly; if it is impractical, say so in the guide rather than shipping a surprise. |
| Channel-id leaks across many short sessions. | Release in `finally` on every path; asserted by test and visible in `/api/adb/stats`. |
| An agent crash leaves the user's adb waiting forever. | Plan 25's `failAllForAgent` plus stream closure on disconnect; the smoke test kills an agent mid-transfer deliberately. |
| The endpoint is reachable from the internet on a hosted control plane. | The Plan 27 bind setting applies unchanged, defaulting to loopback; a hosted deployment must opt in explicitly, and the guide states what that means. |

## 9. Open questions

1. Should a cloud endpoint be offered at all when the measured link is poor — for instance, refusing `sync:` above a size threshold with a clear message? Answer after step 28.5.
2. Would a direct agent↔user path (WebRTC data channel, as video already uses) be worth the NAT complexity for large transfers? Out of scope here; worth revisiting if 28.5 shows relaying is the bottleneck.
3. Should the endpoint follow a device that migrates between agents? Currently the endpoint is bound to the agent that owned the device when it opened.
