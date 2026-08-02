# Plan 25 — M12d : Shell and Monitors over the Cloud Tunnel

> Status: draft
> Depends on: **Plan 24** (the lane, the monitor builders, and the WS protocol it defines), Plans 11–12 (the cloud tunnel and remote sessions).
> Blocks: Plan 26 gains cloud support for free once this lands; Plan 28 reuses the correlation layer built here.
> Spec references: §13 (protocol), plan 11 §4.2 (tunnel envelope), plan 12 §4.4 (remote sessions).

---

## 1. Goals

- Every monitor from Plan 24 works identically on an agent-owned device, with no change to the Studio code.
- The tunnel gains a **correlated request/response** layer, so a caller in the control plane can await a reply from an agent instead of firing and forgetting.
- Stream data from an agent travels on a **binary channel**, not as JSON envelopes.
- The control plane's WS handler stays free of "local or remote" branching: one `ShellPort` interface, two implementations.
- An agent disconnecting mid-stream produces a clear ended-reason, not a stalled pane.

## 2. Non-goals

- The interactive free-form terminal — Plan 26 (it consumes this plan's `ShellPort` and gets both modes at once).
- Exposing a raw adb endpoint over the tunnel — Plan 28.
- Changing how the agent enrols, authenticates, or reports devices.
- Audio channels. The `kind` enum already contains `audio`; this plan does not implement it.

## 3. Context and design decisions

### 3.1 The agent already has everything it needs locally

`packages/agent/src/hosts.ts:1,39` shows the agent constructs its own `AdbClient` and its own `SessionManager`. So the deadline work in Plan 22.1 and the streaming lane in Plan 24 — both of which live in `@enkaku/adb` — are already available agent-side the moment the agent is rebuilt. Nothing about the adb layer needs a cloud-specific variant.

What is missing is the plumbing between control plane and agent.

### 3.2 The tunnel is fire-and-forget, and a shell needs an answer

`TunnelRouter.sendToDevice()` returns a `boolean` (`packages/core/src/tunnel/router.ts:108`) — "handed to the agent" or not. Input works that way because a tap has no result (`device-proxy.ts:41-46`).

A one-shot command has a result: stdout, and an exit code. There is no correlation layer today, although `RoutedEnvelopeSchema` already carries an optional `id` (`packages/protocol/src/tunnel.ts:14`) reserved for exactly this.

So this plan builds it once, generically: a pending-request map keyed by envelope `id`, with a timeout, agent-offline rejection, and cleanup on disconnect. Plan 28 needs it too, and so will anything else that ever asks an agent a question.

### 3.3 Stream data goes on the binary channel that already exists

`TunnelChannelOpenMessage` (`packages/protocol/src/tunnel.ts:94`) already allocates numbered channels with `kind: 'video' | 'audio' | 'control-raw'`, and `encodeTunnelFrame` / `decodeTunnelFrame` already frame them as `[0x02][channelId u16BE][payload]`.

Adding `'shell'` to that enum gives a multiplexed byte stream for logcat with no new transport. Sending log lines as JSON control messages instead would put a high-rate stream on the same path as leases and job dispatch — the channel mechanism exists precisely to avoid that.

### 3.4 One interface, two implementations

`createDeviceProxy` (`packages/core/src/tunnel/device-proxy.ts`) already proves the pattern: wrap a remote device so it has the same shape as a local `DeviceSession`, and the WS handler never branches. Plan 12 §4.4 states this as the design intent.

This plan applies it to shell work with a `ShellPort` interface. `MonitorHub` (Plan 24 §4.5) then talks to a `ShellPort` rather than to `AdbClient` directly, and gains cloud support without knowing it did.

### 3.5 Backpressure is the agent's problem to detect, the core's to bound

An agent on a poor uplink cannot push logcat as fast as the device produces it. The agent applies the same 100 ms line batching as the core, and if its outbound buffer exceeds a threshold it ends the stream with reason `backpressure` rather than growing without bound. A truthful "the stream stopped, the link could not keep up" beats a pane that silently lags minutes behind.

## 4. Technical design

### 4.1 Correlated requests — `packages/core/src/tunnel/rpc.ts` (new)

```ts
export interface TunnelRpc {
  /** Rejects E_AGENT_OFFLINE if unroutable, E_AGENT_TIMEOUT after timeoutMs. */
  request<T>(deviceId: string, type: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>
  /** Resolve a pending request from an inbound agent envelope. */
  handleReply(env: RoutedEnvelope): boolean
  /** Reject everything outstanding for an agent that just dropped. */
  failAllForAgent(agentId: string, reason: string): void
}
```

- `id` is `crypto.randomUUID()`, carried on the envelope's existing optional field.
- Default `timeoutMs` 20 000, always above the agent-side adb budget so the agent's own coded error wins the race and reaches the user.
- Every pending entry records its `agentId` so `failAllForAgent` can clear them on disconnect — otherwise a dropped agent leaves promises hanging until timeout.

Agent side: `packages/agent/src/tunnel.ts` gains a symmetric reply helper that echoes `id` back.

### 4.2 Protocol additions — `packages/protocol/src/tunnel.ts`

```ts
kind: z.enum(['video', 'audio', 'control-raw', 'shell'])   // extended
```

New request/response message pairs (control plane → agent, replies carry the same `id`):

```ts
{ type: 'shell.exec.request',  payload: { deviceId, cmd, profile?, timeoutMs?, maxOutputBytes? } }
{ type: 'shell.exec.reply',    payload: { ok, stdout?, exitCode?, truncated?, error?: { code, message } } }

{ type: 'shell.stream.request', payload: { deviceId, cmd, channelId, idleTimeoutMs?, absoluteTimeoutMs?, maxBytes? } }
{ type: 'shell.stream.reply',   payload: { ok, streamId?, error?: { code, message } } }
{ type: 'shell.stream.stop',    payload: { streamId } }
{ type: 'shell.stream.ended',   payload: { streamId, reason } }
```

`cmd` crossing the tunnel is deliberate: the agent is not a security boundary against its own control plane (it runs the control plane's jobs already), and the monitor builders on the core side are the only producers of these strings in this plan. Plan 26 adds the permission and audit layer that governs who may cause an arbitrary `cmd` to be sent.

### 4.3 `ShellPort` — `packages/core/src/device/shell-port.ts` (new)

```ts
export interface ShellExecResult { stdout: string; exitCode: number | null; truncated: boolean }

export interface ShellPort {
  exec(cmd: string, opts?: { profile?: AdbTimeoutProfile; timeoutMs?: number; maxOutputBytes?: number }): Promise<ShellExecResult>
  stream(cmd: string, opts: { onData(chunk: Uint8Array): void; onEnd(reason: string): void; idleTimeoutMs?: number; absoluteTimeoutMs?: number; maxBytes?: number }): Promise<{ streamId: string; stop(): Promise<void> }>
}

export function createLocalShellPort(deps: { client: AdbClient; serial: string }): ShellPort
export function createRemoteShellPort(deps: { rpc: TunnelRpc; router: TunnelRouter; deviceId: string }): ShellPort
```

Resolution mirrors the existing pattern in `ws-handlers.ts:317-320`: if `remote.agentIdFor(deviceId)` returns an agent, use the remote port; otherwise the local one. A missing agent throws `agent_offline`, matching today's input behaviour.

`MonitorHub` (Plan 24 §4.5) is refactored to take a `ShellPort` factory rather than an `AdbClient`. That refactor is the whole of this plan's core-side change — the hub logic, ring buffer, fan-out, and WS protocol are untouched.

### 4.4 Agent side — `packages/agent/src/shell.ts` (new)

- Handles `shell.exec.request` via its `AdbClient.exec` with the Plan 22.1 profiles, replying with the result or the coded error verbatim.
- Handles `shell.stream.request` via `AdbClient.execStream` (Plan 24 §4.2), writing batched output into the allocated channel with `sendFrame(channelId, payload)` — the same mechanism `hosts.ts:154-159` already uses for video.
- Enforces the same lane limits locally, so an agent cannot be pushed past its own stream budget by a control plane that lost track.
- On `shell.stream.stop`, or the tunnel dropping, stops the stream and kills the device-side PID exactly as the local path does.
- Applies backpressure per §3.5 and reports `ended` with reason `backpressure`.

### 4.5 Channel lifecycle

1. The core allocates a channel id and sends `tunnel.channel.open { deviceId, kind: 'shell', channelId }`.
2. The core sends `shell.stream.request` carrying that `channelId`; the agent replies with a `streamId`.
3. Data flows as tunnel frames; the core decodes and feeds `MonitorHub`, which fans out to WS subscribers exactly as in local mode.
4. Stop, timeout, agent disconnect, or device loss → `shell.stream.ended` (or `failAllForAgent`) → `tunnel.channel.close` → the channel id is returned to the pool.

Channel ids must be released on every path; a leak here is silent until the 65 536 space is exhausted. The registry that allocates them owns the release, in a `finally`.

## 5. Implementation steps

**25.1 — The RPC layer**
- `packages/core/src/tunnel/rpc.ts` (§4.1) plus the agent-side reply helper; hook `handleReply` into the router's inbound path and `failAllForAgent` into agent disconnect.
- Result: unit tests cover reply correlation, timeout, offline rejection, and disconnect cleanup with a fake router.

**25.2 — Protocol additions**
- Extend the channel `kind` enum and add the six message shapes (§4.2) to `packages/protocol/src/tunnel.ts`, wired into the agent/control-plane unions.

**25.3 — `ShellPort` and the hub refactor**
- Add `shell-port.ts` with both implementations (§4.3).
- Refactor `MonitorHub` to consume a `ShellPort`; keep every existing test green — behaviour must not change for local devices.

**25.4 — Agent handlers**
- `packages/agent/src/shell.ts` (§4.4); register the handlers in `packages/agent/src/index.ts` alongside the existing `tunnel.channel.*` cases (`index.ts:192-198`).

**25.5 — Channel lifecycle and cleanup**
- Allocation/release with `finally` on every path (§4.5); handle agent disconnect mid-stream by ending every stream that agent owned with reason `agent_offline`.

**25.6 — Parity verification**
- Run the whole Plan 24 §7 smoke script against a cloud device with no Studio changes.

## 6. Acceptance criteria

1. Every monitor works on an agent-owned device with **zero changes** to `packages/studio`.
2. `TunnelRpc.request` resolves on reply, rejects `E_AGENT_TIMEOUT` on silence, and rejects `E_AGENT_OFFLINE` when the device is unroutable.
3. An agent disconnecting mid-request rejects that request immediately, rather than after the timeout.
4. An agent disconnecting mid-stream ends the stream with reason `agent_offline`, and Studio shows it.
5. Stream data travels on a `kind: 'shell'` binary channel; no log line is sent as a JSON control message.
6. Channel ids are released on stop, timeout, error, and disconnect — verified by asserting the allocator returns to its initial size.
7. Stopping a cloud stream kills the process on the agent's device (`ps -A` on that device shows nothing left).
8. The agent enforces its own stream-lane limits and rejects with the same coded errors.
9. Local-mode behaviour is byte-for-byte unchanged; all Plan 24 tests still pass.
10. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit (no device, no agent):**
- `rpc.test.ts` — correlation, timeout, offline, disconnect cleanup, no id leak.
- `shell-port.test.ts` — the remote port against a fake rpc/router: exec result mapping, error passthrough, stream start/stop, channel release.
- `monitor-hub.test.ts` — unchanged tests must still pass against the refactored constructor.

**Manual smoke (a real agent, `bun run dev:cloud` + `bun run dev:agent`):**
```bash
bun run dev:cloud
ENKAKU_CP_URL=... ENKAKU_ENROLL_TOKEN=... bun run dev:agent
# 1. the agent's device appears in Studio
# 2. Monitor → logcat streams from the cloud device
# 3. two tabs → one stream (verify on the agent host: ps -A | grep logcat)
# 4. kill the agent process mid-stream → the pane reports agent_offline within seconds
# 5. restart the agent → a new stream starts cleanly, no leaked channel ids
# 6. run a job on that device while the monitor streams; both keep working
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Channel-id leaks exhaust the 16-bit space over days of use. | Release in `finally` on every path; a test asserts the allocator returns to its initial size after start/stop cycles, and `/api/adb/stats` (Plan 23) is extended with open-channel counts. |
| A slow uplink makes the cloud pane lag far behind reality without anyone noticing. | Agent-side backpressure ends the stream with an explicit reason instead of buffering; Studio shows the reason. |
| The RPC timeout races the agent's adb timeout and reports the wrong error. | The RPC default (20 s) is deliberately above the adb `default` profile (15 s) so the agent's specific error wins. |
| The hub refactor regresses local mode. | The refactor is constructor-only; every Plan 24 test runs unchanged as the guard (§6.9). |
| A control plane bug sends an arbitrary `cmd` to an agent. | In this plan the monitor builders are the only producers; Plan 26 adds the permission and audit gate before free-form commands exist at all. |

## 9. Open questions

1. Should the agent cache a short backlog too, so a control-plane reconnect can resume a stream rather than restart it? Deferred until reconnect behaviour is observed in practice.
2. Should `shell.exec.request` be rate-limited per agent? Plan 26's audit trail will show whether that is needed.
