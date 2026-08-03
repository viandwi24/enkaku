# Plan 24 — M12c : The adb Streaming Lane and the Device Monitor

> Status: implemented — verified by the presence of the artefact below
> Ships: packages/core/src/device/monitors.ts
> Depends on: **Plan 22.1** (deadlines, coded errors, forced socket termination). Plan 23 is recommended but not required.
> Blocks: Plan 25 (cloud parity) and Plan 26 (the interactive terminal both build on the lane and the protocol defined here).
> Spec references: §7.1 (display engines), §10.4 (adb serialisation), §13 (protocol), §15.2 (thermal).

---

## 1. Goals

- Long-running adb commands (`logcat`, `top`) stream to the browser **without ever entering the per-device queue**, so video, input, and jobs are unaffected.
- A device page gains a **Monitor** tab: live logcat with filters, CPU/memory, thermal, processes — read-only, no lease required, usable while a job is running.
- One adb stream per (device, monitor) is fanned out to every viewer; ten watchers do not mean ten `logcat` processes.
- A stream cannot outlive its usefulness: idle timeout, absolute timeout, byte cap, and an explicit kill of the process left on the device.
- A viewer joining late immediately sees recent context instead of an empty pane.
- The last N lines can be saved as an artifact on demand.

## 2. Non-goals

- Free-form command entry. Every monitor here is a **fixed command builder with validated options**; there is no path from this plan's API to an arbitrary shell string. That is Plan 26, and it carries a lease and a permission because of it.
- Cloud devices. This plan is local-mode only; Plan 25 gives the same UI parity over the tunnel.
- Persisting logcat continuously. Explicitly rejected in §3.6.
- Audio. Out of scope for the whole M12 series.
- A pty / interactive shell (adb shell protocol v2). Recorded as an open question in Plan 26.

## 3. Context and design decisions

### 3.1 The lane exists because the queue must not hold a long command

Plan 22.1 made a hung command survivable. It did not make a *legitimately* long-running command safe: `logcat` holds its socket open by design, and every second it holds a per-device queue slot is a second the fallback screencap loop, the inspector, and every job device call are blocked behind it.

`packages/scrcpy/src/session.ts:90-98` already documents exactly this outcome for the scrcpy server launch, and its fix was to route around the queue entirely. The same reasoning applies here, so the same shape is used: **streams get their own lane**.

`packages/session/src/session.ts:123-135` records the measured cost of getting this wrong — inspector work starving the screencap loop took video from 11 frames to 1 frame per 20 seconds.

### 3.2 The lane needs its own budget, not a slice of the global one

The global semaphore (`client.ts:34`) is farm-wide. If streams drew from it, six people watching logcat would freeze every device on the farm. The lane therefore has separate limits:

- **1 concurrent stream per device** by default (`adb.maxStreamsPerDevice`)
- **4 concurrent streams farm-wide** by default (`adb.maxStreams`)

Exceeding either rejects `E_ADB_STREAM_LIMIT` — a clear error, not a silent queue.

### 3.3 Three clocks per stream

An absolute deadline alone would kill a healthy long watch. An idle timer alone would kill a healthy quiet device. Both, plus a byte cap:

| Clock | Default | Meaning |
|---|---|---|
| idle | 60 s | no bytes at all — the far end is probably gone |
| absolute | 10 min | a forgotten tab must not hold a device stream all night |
| bytes | 5 MB | a pathological producer must not exhaust the heap |

Bun's native `socket.timeout(seconds)` plus the `timeout?(socket)` handler (`bun-types@1.3.14`, `bun.d.ts:5840`) implements the idle clock directly. The absolute clock is a timer; the byte cap is the `ByteQueue` guard from Plan 22.1 §4.3, reused with a larger value.

### 3.4 Killing the process on the device, not just the socket

Closing the socket normally causes `adbd` to hang up the child, which usually kills it. *Usually* is not good enough for a farm that runs for weeks: a process ignoring SIGHUP (`screenrecord` is the classic) accumulates.

So each stream learns its own PID and kills it explicitly:

```
shell:echo $$; exec logcat -v time
```

`$$` is the shell's PID, and `exec` replaces that shell with the target command, so the printed PID **is** the command's PID. The reader strips the first line before emitting data. On stop — for any reason, including timeout — the core issues a normal one-shot `kill <pid>` (queued, `input` profile, best-effort).

A `pkill -f` fallback keyed on a per-stream marker is documented in the code comment but not implemented unless the smoke test shows the PID path failing.

### 3.5 One stream per (device, monitor), fanned out

Two operators watching the same device's logcat should cost one `logcat`. The core keeps a registry keyed by `deviceId:monitor:optionsHash` with a subscriber set; the adb stream starts on the first subscriber and stops when the last leaves.

This is also what makes the multi-viewer requirement work: output is broadcast to every subscriber, not to a single owner. It matches the decision that all viewers can see, and it makes Plan 26's rule — everyone sees the terminal, only the lease holder types — a natural extension rather than a special case.

A **ring buffer of the last 2000 lines** per active stream is kept in memory and replayed to a joining subscriber, so a late viewer sees context immediately. This is a deliberate, local exception to the "no snapshot replay on `/ws`" rule: that rule is about the device list, and a log pane that starts blank for 30 seconds is unusable.

### 3.6 Streaming, not recording

Continuously persisting logcat for 30 devices would write tens of gigabytes a day, need its own retention policy, and mostly store noise. The Plan 18 event log already covers what matters durably.

So: streams are ephemeral, with an explicit **"Save last N lines"** action that writes an artifact. That keeps the useful case (something just went wrong, capture it) without the storage burden.

### 3.7 Read-only means no free-form string, and that is a structural guarantee

Attempting to classify an arbitrary command as safe is futile — `sh -c '…'` defeats any parser. The guarantee here comes from the shape of the API instead: the client sends `{ monitor: 'logcat', options: {...} }`, the core builds the command from a fixed template, and every interpolated value is either drawn from a Zod enum or shell-quoted.

That is why this plan needs no lease and no shell permission, and why Plan 26 needs both.

## 4. Technical design

### 4.1 `AdbSocket` streaming mode — `packages/adb/src/socket.ts`

```ts
/**
 * Switch to streaming: any bytes already buffered are handed to `onData`
 * first, then every later chunk goes straight through without accumulating.
 */
streamFrom(onData: (chunk: Uint8Array) => void, onEnd: (err?: unknown) => void): void
/** Native idle timer (Bun). 0 disables. */
setIdleTimeout(seconds: number): void
```

`ByteQueue` gains a `drain(cb)` that flushes and switches to pass-through, so the accumulate-everything behaviour of `takeUntilEnd()` is bypassed entirely for streams.

### 4.2 `AdbClient.execStream` — `packages/adb/src/client.ts`

```ts
export interface AdbStreamOptions {
  onData: (chunk: Uint8Array) => void
  onEnd: (reason: 'closed' | 'idle' | 'deadline' | 'bytes' | 'stopped' | 'error', err?: unknown) => void
  idleTimeoutMs?: number      // default 60_000
  absoluteTimeoutMs?: number  // default 600_000
  maxBytes?: number           // default 5 * 1024 * 1024
  signal?: AbortSignal
}

export interface AdbStreamHandle {
  readonly pid: number | null
  stop(): Promise<void>       // terminates the socket, then kills the pid
}

execStream(serial: string, cmd: string, opts: AdbStreamOptions): Promise<AdbStreamHandle>
```

Implementation notes:
- Takes a slot from `streamLane` (a second `Semaphore`), **never** from `PerDeviceQueue`.
- Sends `shell:echo $$; exec ${cmd}`; the first line is parsed as the PID and removed from the data path (§3.4).
- On any end reason, in order: release the lane slot → terminate the socket → `kill <pid>` through the normal queue with the `input` profile, failure ignored.

New errors: `E_ADB_STREAM_LIMIT`, `E_ADB_STREAM_IDLE`, `E_ADB_STREAM_DEADLINE`.

### 4.3 Monitor definitions — `packages/protocol/src/messages/monitor.ts` (new)

```ts
export const MonitorKindSchema = z.enum(['logcat', 'top', 'thermal', 'ps', 'meminfo', 'df'])

export const LogcatOptionsSchema = z.object({
  priority: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).default('V'),
  buffer: z.enum(['main', 'system', 'crash', 'events', 'all']).default('main'),
  /** Matched on the device with grep -F; shell-quoted, never interpolated raw. */
  filter: z.string().max(200).optional(),
  tag: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).optional(),
})
```

Command builders live in `packages/core/src/device/monitors.ts` — one function per kind, the **only** place a monitor command string is produced:

| Kind | Command |
|---|---|
| `logcat` | `logcat -v time -b <buffer> *:<priority>` (+ `| grep -F <quoted>` when a filter is set) |
| `top` | `top -b -d 2` |
| `thermal` | a 5 s loop over `dumpsys thermalservice` + `dumpsys battery` |
| `ps` | `ps -A` (one-shot, not a stream) |
| `meminfo` | `dumpsys meminfo` (one-shot) |
| `df` | `df -h` (one-shot) |

One-shot kinds go through `exec` with the `appLifecycle` profile and return a single payload; only `logcat`, `top`, and `thermal` open a lane stream. Every interpolated value is enum-constrained or passed through a `shellQuote()` helper (unit-tested against injection attempts).

### 4.4 WS protocol — `packages/protocol/src/messages/shell.ts` (new)

Client → server:
```ts
{ type: 'monitor.start',  payload: { deviceId, kind, options? } }
{ type: 'monitor.stop',   payload: { streamId } }
{ type: 'monitor.oneshot', payload: { deviceId, kind } }   // ps | meminfo | df
```
Server → client:
```ts
{ type: 'monitor.started', payload: { streamId, deviceId, kind, backlog: string[] } }
{ type: 'monitor.data',    payload: { streamId, lines: string[] } }
{ type: 'monitor.ended',   payload: { streamId, reason } }
{ type: 'monitor.result',  payload: { deviceId, kind, text, truncated } }
```

Registered in `ServerMessageSchema` / `ClientMessageSchema`. Data is sent as **lines, batched every 100 ms** rather than per chunk — a chatty logcat otherwise produces thousands of tiny WS frames.

Permission: `device.view`. **No lease, and allowed while the device status is `busy`** — watching a job's logcat is a primary use case.

### 4.5 Stream registry — `packages/core/src/device/monitor-hub.ts` (new)

```ts
export interface MonitorHub {
  subscribe(clientId: string, deviceId: string, kind: MonitorKind, options: unknown): Promise<{ streamId: string; backlog: string[] }>
  unsubscribe(clientId: string, streamId: string): void
  releaseClient(clientId: string): void      // WS disconnect
  stopForDevice(deviceId: string): void      // device offline / session closed
}
```

Keyed by `deviceId:kind:optionsHash`; holds the subscriber set, the ring buffer (2000 lines), and the `AdbStreamHandle`. Starts on first subscriber, stops on last. `releaseClient` must be called from the WS close path or streams leak.

### 4.6 Saving a slice — artifacts need a device owner

`artifacts.jobId` is `notNull` (`schema.ts:181`), so a device-scoped capture does not fit today.

Migration: make `jobId` nullable and add `deviceId text` plus `index('idx_artifacts_device').on(deviceId, createdAt)`. Exactly one of the two is set. `packages/core/src/runner/artifact-store.ts` gains `saveForDevice(deviceId, label, data, ext)`; the artifacts API accepts `?deviceId=`; GC and retention treat device artifacts with the same rules as job artifacts.

`POST /api/devices/:id/monitor/save` with `{ kind, lines }` (max 5000) writes a `.log` artifact and returns its id.

### 4.7 Studio — the Monitor tab

`packages/studio/src/app/device/page.tsx` gains a tab beside the existing ones; the pane lives in `packages/studio/src/components/monitor/`.

- A monitor picker, a filter/priority bar for logcat, and a log pane that follows the tail with a pause toggle (pausing keeps buffering, it does not stop the stream).
- Uses `next/link`-free in-page state only — no navigation, so the WS and video survive.
- Colours by log level using existing design tokens (`text-fg-muted`, `text-danger`, …), never bracket syntax (Tailwind v4 rule, `docs/design.md`).
- "Save last N lines" posts to §4.6 and links to the artifact.
- A visible badge when another viewer is watching the same stream — this is shared, and hiding that would be surprising.
- One-shot kinds render as a refreshable text block.

## 5. Implementation steps

**24.1 — Socket streaming mode**
- `ByteQueue.drain`, `AdbSocket.streamFrom`, `AdbSocket.setIdleTimeout` (§4.1).
- Result: a unit test against a `Bun.listen` fake receives chunks incrementally, and memory does not grow with total bytes.

**24.2 — The lane and `execStream`**
- Add the `streamLane` semaphore and `execStream` with the three clocks, PID capture, first-line strip, and the kill-on-stop path (§4.2).
- Add `adb.maxStreams` / `adb.maxStreamsPerDevice` to farm settings (same `.describe().meta()` pattern as Plan 23 §4.1).
- Result: a stream runs while `exec()` on the same device continues to answer normally — the queue is provably untouched.

**24.3 — Monitor definitions**
- `packages/protocol/src/messages/monitor.ts`, `packages/core/src/device/monitors.ts`, and `shellQuote()` with injection tests.
- Result: no monitor command can be produced outside these builders.

**24.4 — Protocol and hub**
- `packages/protocol/src/messages/shell.ts` (§4.4) wired into the message unions.
- `monitor-hub.ts` (§4.5); handlers in `packages/core/src/server/ws-handlers.ts`; `releaseClient` on WS close and `stopForDevice` on session end.
- Result: two browser tabs watching the same device share one stream; closing one leaves the other running; closing both stops it.

**24.5 — Device artifacts**
- Migration making `artifacts.jobId` nullable and adding `deviceId` (§4.6); `bun run --cwd packages/core db:generate`.
- `saveForDevice`, the API route, GC/retention coverage.

**24.6 — Studio Monitor tab**
- The tab, the pane, filters, pause, save, the shared-viewer badge (§4.7).

## 6. Acceptance criteria

1. While `logcat` streams, `exec()` on the same device answers with unchanged latency, and manual taps stay responsive — measured, not assumed (§7).
2. With scrcpy active, video FPS while streaming is within 10% of the FPS without it.
3. On the screencap-loop fallback, starting a monitor does not reduce the frame rate — the stream is not in the queue.
4. Killing the browser tab stops the stream and the process on the device (`ps -A | grep logcat` shows nothing left).
5. Idle, absolute, and byte limits each end the stream with the correct reason and clean up the device process.
6. Exceeding `maxStreamsPerDevice` or `maxStreams` rejects `E_ADB_STREAM_LIMIT`.
7. Two viewers on the same (device, monitor) share one adb stream, both receive data, and the last to leave stops it.
8. A viewer joining a running stream receives the backlog immediately.
9. A monitor can be started while the device status is `busy`, with no lease.
10. `shellQuote` unit tests show that filter text containing `;`, `` ` ``, `$(`, and quotes cannot escape its argument.
11. "Save last N lines" produces a downloadable artifact tied to the device.
12. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit (no device):**
- `socket.test.ts` — incremental delivery; idle timeout fires; byte cap ends the stream.
- `monitors.test.ts` — command strings per kind and option; `shellQuote` injection cases.
- `monitor-hub.test.ts` — with a fake `execStream`: fan-out, ref counting, backlog replay, `releaseClient`, `stopForDevice`.
- `client.test.ts` — the stream lane never touches `PerDeviceQueue` (assert `pending(serial)` stays 0 for the stream's lifetime).

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, one physical device):**
```bash
bun run dev && bun run dev:studio
# 1. start the stream, open Monitor → logcat; lines flow
# 2. while it flows: tap the screen (responsive), watch the FPS badge (within 10%)
# 3. open a second tab on the same device → same stream, backlog appears at once
# 4. adb shell ps -A | grep logcat  → exactly one
# 5. close both tabs → no logcat process remains
# 6. enqueue a script job; the monitor keeps streaming while the job runs
# 7. filter with:  a"b;c$(id)`  → appears literally, nothing executes
# 8. Save last 500 lines → artifact downloads and matches the pane
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A chatty device floods the WS and stalls the browser. | 100 ms line batching, a 2000-line ring buffer, a 5 MB byte cap, and a client-side pause that buffers rather than disconnects. |
| The `echo $$; exec` trick behaves differently across OEM shells and the first line is not a PID. | Parse defensively: if the first line is not an integer, treat the PID as unknown, log once, and fall back to socket termination only. The stream still works; only the explicit kill is skipped. |
| Streams leak when a WS drops without a clean close. | `releaseClient` on the WS close path plus the absolute deadline as a backstop; `/api/adb/stats` (Plan 23) shows lane occupancy for verification. |
| The nullable-`jobId` migration breaks existing artifact queries. | Every existing query is by `jobId` and keeps working; the new column is additive. Covered by a migration test that reads pre-existing rows. |
| Someone later adds a free-form path into the monitor API and quietly removes the read-only guarantee. | The builders are the only producers of a command string, they take typed options rather than strings, and a test asserts the API rejects an unknown `kind`. Plan 26 adds free-form deliberately, elsewhere, with a lease. |

## 9. Open questions

1. Should `thermal` be a stream at all, or should it reuse the existing battery poll broadcast? It duplicates data the battery monitor already collects — worth reconsidering once the panel exists.
2. Is 2000 lines the right backlog? Chosen to cover roughly a minute of a busy logcat. Revisit after real use.
3. `logcat -b all` on some devices produces enormous initial dumps. Consider defaulting to `-T 200` (last 200 lines) rather than the full buffer; deferred until measured on the test devices.
