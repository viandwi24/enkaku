# Plan 38 — M17d : Device Clipboard (get and set)

> Status: draft
> Depends on: Plan 08 (the scrcpy session and control socket). Independent of the rest of M17.
> Spec references: §7.6 (version-locked scrcpy), §9 (script API), §10.1 (server-authoritative control), §13 (protocol).

---

## 1. Goals

- Read and write the device's clipboard from Studio and from a script.
- Works through the existing scrcpy control socket — no new device-side component, no new adb command in the hot path.
- An adb fallback exists for sessions where scrcpy is unavailable, and its limitations are stated rather than hidden.
- Clipboard writes obey the same lease rule as every other input, and are audited.

## 2. Non-goals

- Clipboard *synchronisation* with the operator's own machine (auto-copy on focus). Recorded in §9.
- Clipboard history, or reading the clipboard of a specific app.
- Rich clipboard content (images, HTML). Plain UTF-8 text only — which is all the scrcpy protocol carries.

## 3. Context and design decisions

### 3.1 Half of this already exists

`packages/scrcpy/src/version.ts:39-40` already pins the control message types:

```ts
GET_CLIPBOARD: 8,
SET_CLIPBOARD: 9,
```

They are unused. `packages/scrcpy/src/control/messages.ts` has encoders for keycodes, text, touch, UHID, `resetVideo`, and `setDisplayPower` — but none for clipboard. Adding the two encoders is perhaps thirty lines.

### 3.2 The blocker is that the control socket is write-only

`packages/scrcpy/src/session.ts:137` opens the control socket with empty handlers:

```ts
const controlSocket = await connectWithRetry(port, () => {}, () => {})
```

and exposes only `write(bytes)`. Nothing ever reads from it.

That is fine for every existing control message, because they are all fire-and-forget. `GET_CLIPBOARD` is not: the server answers with a **device message** on the same socket. So this plan's real work is adding a device-message reader — a small framed-stream parser, in the same shape as the existing `VideoDemuxer`.

This is worth doing beyond clipboard: the device-message channel also carries `ACK_CLIPBOARD` and UHID output reports, both of which future work will want. The reader is written generically and clipboard is its first consumer.

### 3.3 Device message framing

scrcpy device messages are `[type u8][payload]`:

| Type | Name | Payload |
|---|---|---|
| 0 | `CLIPBOARD` | `[len u32BE][utf8 text]` |
| 1 | `ACK_CLIPBOARD` | `[sequence u64BE]` |
| 2 | `UHID_OUTPUT` | `[id u16BE][size u16BE][data]` |

The reader accumulates bytes, emits complete messages, and — importantly — must tolerate a message split across TCP chunks, exactly as `VideoDemuxer` already does for video packets. Unknown types are skipped by length where the length is knowable and otherwise cause the reader to log once and stop parsing rather than desynchronise silently.

**The pinned server version is the contract.** These type numbers belong to the version in `packages/scrcpy/src/version.ts`; per spec §7.6 that file is the single source of the scrcpy version and the Java side is never forked. If a future bump changes the numbering, it changes there.

### 3.4 `SET_CLIPBOARD` and the paste flag

`SET_CLIPBOARD` carries `[sequence u64][paste u8][len u32][text]`. The `paste` flag makes the device immediately paste into the focused field — genuinely useful for filling a login form, and genuinely surprising if it happens when you only meant to set the clipboard.

So it is an explicit parameter, defaulting to **false**, in both the WS message and the script API. The `sequence` is a non-zero id the server echoes in `ACK_CLIPBOARD`, which is how a caller knows the write landed; `setClipboard` resolves on that ack, with a 2-second timeout.

### 3.5 The adb fallback, and its honest limits

Without scrcpy (the `screencap-loop` fallback path), there is no control socket. `adb shell cmd clipboard` exists but is unavailable or permission-restricted on many builds, and reading the clipboard from the shell is blocked entirely on Android 10+ unless the shell is the foreground app.

So: the fallback attempts `cmd clipboard set-text` for writes, and **refuses reads** with `E_CLIPBOARD_UNAVAILABLE` rather than returning an empty string that looks like an empty clipboard. Silently returning "" for "cannot read" is the kind of lie that costs someone an afternoon.

### 3.6 Writing to the clipboard is input

Setting the clipboard changes device state and, with `paste`, injects content into whatever is focused. It goes through the same gate as `input.*`: `checkInputAllowed` plus a `touchManual`, and it is recorded on the Plan 18 `input` stream.

Reading is not a state change, so it needs no lease — but the content may be sensitive, so the recorded event stores only the **length**, never the text.

## 4. Technical design

### 4.1 Encoders — `packages/scrcpy/src/control/messages.ts`

```ts
export function encodeGetClipboard(copyKey: 'none' | 'copy' | 'cut' = 'none'): Uint8Array
export function encodeSetClipboard(sequence: bigint, text: string, paste = false): Uint8Array
```

`copyKey` asks the server to send a copy/cut keystroke first so the *selection* becomes the clipboard; `none` reads the clipboard as it stands, which is the default.

### 4.2 Device message reader — `packages/scrcpy/src/control/device-messages.ts` (new)

```ts
export type DeviceMessage =
  | { type: 'clipboard'; text: string }
  | { type: 'ackClipboard'; sequence: bigint }
  | { type: 'uhidOutput'; id: number; data: Uint8Array }

export function createDeviceMessageReader(onMessage: (m: DeviceMessage) => void, onError: (e: Error) => void): (chunk: Uint8Array) => void
```

`packages/scrcpy/src/session.ts` wires it into the control socket's data handler (replacing the empty `() => {}`) and `ScrcpySession` gains `onDeviceMessage(cb)`.

### 4.3 Control API — `packages/scrcpy/src/control/index.ts`

```ts
getClipboard(opts?: { copyKey?: 'none' | 'copy' | 'cut'; timeoutMs?: number }): Promise<string>
setClipboard(text: string, opts?: { paste?: boolean; timeoutMs?: number }): Promise<void>
```

Both are promise-based over an inherently async socket: `getClipboard` resolves on the next `clipboard` device message, `setClipboard` on the matching `ackClipboard` sequence. Each has a 2 s default timeout and rejects `E_CLIPBOARD_TIMEOUT` — a device that never answers must not hang a WS handler.

Only one clipboard request is in flight per session; a second concurrent call queues behind the first.

### 4.4 Session and fallback — `packages/session/src/session.ts`

`DeviceSession` gains:

```ts
clipboard: {
  get(): Promise<string>
  set(text: string, opts?: { paste?: boolean }): Promise<void>
} | null      // null when no engine can do it
```

Backed by scrcpy when present; otherwise a shim whose `set` uses `cmd clipboard set-text <quoted>` (with `shellQuote`, `appLifecycle` profile) and whose `get` rejects `E_CLIPBOARD_UNAVAILABLE` (§3.5).

### 4.5 Protocol and handlers

`packages/protocol/src/messages/clipboard.ts` (new):

```ts
{ type: 'clipboard.get', payload: { deviceId } }                            // client → server
{ type: 'clipboard.set', payload: { deviceId, text: z.string().max(65536), paste: z.boolean().default(false) } }
{ type: 'clipboard.value', payload: { deviceId, text } }                    // server → requester only
{ type: 'clipboard.ok', payload: { deviceId } }
```

`clipboard.value` goes **only to the requesting connection**, not broadcast — unlike the Plan 26 terminal transcript, clipboard content is likely to be a password or a token, and fanning it out to every viewer would be a privacy hole introduced by accident.

`ws-handlers.ts`: `clipboard.set` runs the `checkInputAllowed` + `touchManual` + record sequence (the Plan 26 pattern); `clipboard.get` requires only `device.view`.

For agent-owned devices, both route through the Plan 25 `TunnelRpc` — a request/response pair, which is exactly what that layer was built for.

### 4.6 Script API — `packages/sdk/src/types.ts`

```ts
device: {
  // … existing …
  clipboard: {
    get(): Promise<string>
    set(text: string, opts?: { paste?: boolean }): Promise<void>
  }
}
```

Implemented as two more `device.call` methods in `runner/ipc.ts` and `device-executor.ts` — the established path, no new mechanism.

### 4.7 Studio

On the Control tab, beside the existing controls: a clipboard row with a **Read** button (shows the value, with a copy-to-my-clipboard action) and a text field with **Send** and a "paste into the focused field" checkbox. Disabled with the same rule as the other input controls when the viewer does not hold the lease.

## 5. Implementation steps

**38.1 — Encoders.** `encodeGetClipboard` / `encodeSetClipboard` with byte-level tests against the pinned protocol layout.

**38.2 — Device message reader.** `device-messages.ts` plus tests for split chunks, unknown types, and truncation; wire it into the control socket.

**38.3 — Control API.** Promise-based `getClipboard`/`setClipboard` with sequence tracking, timeouts, and single-flight queuing.

**38.4 — Session and fallback.** `DeviceSession.clipboard`, the adb shim, and the explicit unavailable error.

**38.5 — Protocol, handlers, tunnel.** The four messages, the lease gate on `set`, the targeted (non-broadcast) reply, and the agent path via `TunnelRpc`.

**38.6 — Script API and Studio.** The `ctx.device.clipboard` methods and the Control-tab row.

## 6. Acceptance criteria

1. Reading the clipboard on a device with an active scrcpy session returns text that was copied on the device.
2. Writing sets the device clipboard; with `paste: true` the text lands in the focused field.
3. `setClipboard` resolves only after the server's `ACK_CLIPBOARD`, and rejects `E_CLIPBOARD_TIMEOUT` if none arrives.
4. A device message split across TCP chunks is parsed correctly; an unknown type does not desynchronise the reader.
5. `clipboard.set` without the lease is refused server-side; `clipboard.get` works without one.
6. `clipboard.value` reaches only the requesting connection — a second viewer of the same device receives nothing.
7. The audit event for a set records the text **length**, never the text.
8. On a `screencap-loop` session, `set` attempts the adb path and `get` rejects `E_CLIPBOARD_UNAVAILABLE` — never an empty string.
9. `ctx.device.clipboard.get()/set()` work from a script.
10. The same behaviour holds for an agent-owned device with no Studio changes.
11. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `messages.test.ts` (exact bytes for both encoders, including a multi-byte UTF-8 payload and the length prefix); `device-messages.test.ts` (all three types, split chunks, unknown type, truncated tail); `control.test.ts` (sequence matching, timeout, single-flight).

**Manual smoke (`ENKAKU_TEST_DEVICE=1`):**
```bash
# 1. copy text on the device by hand → Read shows it
# 2. Send "hello" with paste off → long-press a field on the device, Paste shows "hello"
# 3. Send with paste on, focus a text field first → it appears directly
# 4. without taking control → Send is refused by the core, not just disabled in the UI
# 5. Logs tab → clipboard.set recorded with a length, no text
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Adding a reader to the control socket destabilises input, which currently works. | The reader is additive: `write` is untouched, and a parser error stops parsing without closing the socket. Input has its own tests that must stay green. |
| Clipboard content (passwords, tokens) leaks into logs or to other viewers. | The reply is unicast, never broadcast (§4.5); the audit stores only a length; Studio does not persist the value. |
| Android 10+ restricts clipboard reads to the foreground app, so scrcpy reads may return empty on some builds. | scrcpy's server runs with shell identity and is the documented mechanism for this; where it genuinely fails, the promise times out with a coded error rather than returning "". |
| The device-message type numbers change in a future scrcpy bump. | They live beside `SCRCPY_VERSION` in the one file that owns it (spec §7.6); a version bump is already a deliberate, reviewed change. |
| `paste: true` injects text somewhere unexpected. | Default false, an explicit checkbox in the UI, an explicit parameter in the API, and it requires the lease. |

## 9. Open questions

1. Should the operator's browser clipboard sync automatically with the device's while they hold control? Convenient, and a significant privacy decision — deliberately not now.
2. Should `getClipboard` support `copyKey: 'copy'` from the UI (copy the current selection first)? The encoder supports it; no UI exposes it yet.
3. Is a 64 KB text cap right? Chosen to bound a WS message; nobody has asked for more.
