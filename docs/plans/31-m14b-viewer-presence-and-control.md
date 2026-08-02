# Plan 31 — M14b : Viewer Presence and Control Ownership

> Status: implemented (2026-08-02) — see §3.1: the reported two-browser symptom did NOT reproduce; a distinct lease.revoked scoping bug was found and fixed instead
> Depends on: Plans 17–21 complete. Independent of Plan 30.
> Spec references: §10.1 (device states), §10.2 (leases), §13 (protocol), §14 (auth and audit).

---

## 1. Goals

- A device page lists every browser session currently watching it, live.
- Exactly one of those sessions is marked as holding control, and everyone sees the same answer at the same time.
- A viewer can tell at a glance whether the holder is themselves or someone else, without clicking anything and getting an error.
- When control changes hands or a viewer leaves, every other viewer's page reflects it within a second.

## 2. Non-goals

- Requesting control from the current holder, or forcibly taking it. Recorded as an open question.
- Chat, cursors, or any other collaborative-editing feature. This is about who is driving, nothing more.
- Presence for jobs or scripts. Devices only — they are the exclusive resource.
- Changing the lease model itself. The lease stays exactly as it is; this plan makes it *visible*.

## 3. Context and design decisions

### 3.1 The reported symptom

Testing with two browsers: browser 1 takes control, and browser 2's button appeared to become a control-release button. Reading the code, `hasLease` is derived from a local `expiresAt` that only the acquiring client ever sets, so browser 2 should render a disabled "Take control". **The report could not be reproduced from the code alone, and no reproduction has been captured yet** — step 31.1 is to reproduce it before building anything, because a fix aimed at the wrong cause is worse than none.

**31.1 result: NOT REPRODUCED.** Setup: a throwaway core (`ENKAKU_DATA_DIR` under `/private/tmp/.../scratchpad/plan31-data`, port 18173) with one synthetic device row (`fake-device-0001`, status `idle`, inserted directly via Drizzle — no real adb/hardware involved) and Studio dev on port 18174 pointed at it. Two browser tabs (tab A / tab B, `mcp__claude-in-chrome`) opened `/device?id=fake-device-0001` simultaneously. Three scenarios were exercised, each captured with screenshots:

1. **Sequential take.** A clicks "Take control" → A's header shows the primary "Release control" button and the green "You have control." banner. B's header, observed immediately after (same WS broadcast round-trip), shows the *disabled* "Take control" button (grey, hand icon, tooltip on hover) and the banner "Someone else is controlling this device. You can keep watching; input stays off until they release it." — never a release-styled button. Zoomed screenshot of B's header confirms the button text and disabled styling.
2. **Simultaneous take-race.** Both A and B click "Take control" in the same `browser_batch` round (no delay between the two clicks). The server's `acquireManual` (an atomic Map check-then-set, single-threaded Bun event loop) let exactly one win; the loser received a `device_busy` error over the request/reply channel, which the client's `catch` routes into `setError`, never into `setExpiresAt`. The loser's button rendered exactly as in scenario 1 — disabled "Take control", correct banner. No flash of a release-styled button was observed.
3. **Idle-timeout revoke.** With `ENKAKU_LEASE_MANUAL_IDLE_TIMEOUT=20` and `ENKAKU_LEASE_REAPER_MS=2000`, A took control and both tabs were left alone past the timeout. The reaper released the lease and broadcast `lease.revoked` (reason `idle_timeout`) plus `lease.changed`. Both tabs correctly returned to "Take control" (enabled, since the device is idle again) — no lingering release-styled button on either side.

So the specific reported rendering (B's button looking like a release-control button) did not occur in any of these three scenarios, matching the code-only prediction: `hasLease` is truly local, and the only two writers of `expiresAt` (a client's own successful `lease.acquire` reply, and `noteActivity`'s refresh while already non-null) are both gated on that client's own action.

**A related-but-distinct bug was found and evidenced in the process (scenario 3):** `lease.revoked` is broadcast via `hub.broadcast(...)` to *every* connected client, not scoped to the lease's former holder. Studio's handler for it is unconditional on `deviceId` alone:
```ts
} else if (msg.type === 'lease.revoked' && msg.payload.deviceId === deviceId) {
  setNotice('Control was released automatically after a period of inactivity. Take it again to continue.')
```
In the idle-timeout test, **tab B — which never held control — displayed the exact same first-person notice** ("Control was released automatically... Take it again to continue.") as tab A, the actual former holder. This is a real UX defect adjacent to the reported one: a bystander is told about a control transition as if it were theirs. It is not the reported symptom (no button mislabeling occurred), but it is precisely the class of problem this plan's presence work fixes — once each viewer's own `sessionId` is known and `holdsControl` is derived server-side per viewer, this notice can be shown only to the session that actually lost control. No code change was made for this during 31.1 per the plan's instruction to reproduce first, not fix; 31.3/31.4 below address it structurally (the banner and notice derive from the published viewer list, and `device.viewers` — not a broadcast blind to identity — is what every viewer reads).

Either way the underlying weakness is real and worth fixing: the current design infers a global fact (who is driving) from local state plus a device status string. There is no shared list of who is present, so the interface cannot say "Budi has control" — only "someone does, and it is not you".

### 3.2 What already exists

- The core assigns a `clientId` (a UUID) to every WS connection in `ConnState`. It is already the identity the lease manager uses (`acquireManual(deviceId, clientId)`).
- Plan 18 changed `conns` from a `WeakMap` to a `Map`, so the set of live connections is already enumerable — the hard part is done.
- `lease.changed` already broadcasts *that* control moved. It deliberately carries no identity ("a viewer already knows whether the lease is its own"). That was the right minimum then; this plan supersedes it.

So presence is mostly a matter of publishing what the core already knows.

### 3.3 Identity: session, not user

A person may have three tabs open. Each tab is a session with its own `clientId`, and only one of them can hold control. Presence is therefore per **session**, with the user as an attribute:

```
Budi — this tab            ● holding control    2m
Budi — another tab                              5m
Sari                                            just now
```

In local auth mode there is one implicit admin user, so the label falls back to the session's short id. Getting this wrong in the other direction — showing one row per user — would hide the "my other tab is holding it" case, which is the confusing one.

### 3.4 Why a snapshot plus deltas, not deltas alone

The `/ws` protocol has no snapshot replay (an established constraint: a client must `GET` first, then subscribe). Presence follows the same rule: `GET /api/devices/:id/viewers` returns the current list, then `device.viewers` messages carry changes. A client that connects mid-session gets the truth immediately rather than inferring it from whatever happens next.

### 3.5 Cost

Presence changes are rare — a tab opening, closing, or taking control. Broadcasting the whole viewer list per change is simpler than diffing and small enough not to matter. Send it only to clients that have a stream open on that device, the same scoping Plan 18 uses for its log subscriptions.

## 4. Technical design

### 4.1 Protocol

`packages/protocol/src/messages/presence.ts`:

```ts
export const ViewerSchema = z.object({
  /** The WS connection id. Stable for the life of the tab. */
  sessionId: z.string(),
  /** Display name; null in local mode where there is one implicit admin. */
  userLabel: z.string().nullable(),
  /** Unix seconds — when this viewer opened the stream. */
  since: z.number(),
  /** Exactly one viewer in the list may be true. */
  holdsControl: z.boolean(),
})

export const DeviceViewersMessage = z.object({
  type: z.literal('device.viewers'),
  payload: z.object({ deviceId: z.string(), viewers: z.array(ViewerSchema) }),
})
```

The core also tells each client its own id once, so the UI can mark "this tab":

```ts
export const HelloMessage = z.object({
  type: z.literal('hello'),
  payload: z.object({ sessionId: z.string() }),
})
```

`hello` is sent on connect. It is a small addition with wider use than this plan — any future per-connection feature needs it.

### 4.2 Core

`packages/core/src/server/ws-handlers.ts`:

- Send `hello` immediately on connection.
- Maintain `viewersOf(deviceId)` by walking `conns` for connections with a stream bound to that device. No new bookkeeping structure — the stream bindings already record the device.
- Broadcast `device.viewers` to that device's viewers on: stream start, stream stop, disconnect, lease acquire, lease release, lease revoke.
- `holdsControl` comes from the lease manager, which remains the single source of truth. Presence never stores its own copy.

`GET /api/devices/:id/viewers` returns the same array.

The existing `lease.changed` message stays for compatibility and remains the cheap signal; `device.viewers` is the detailed one.

### 4.3 Studio

`packages/studio/src/components/ViewerList.tsx`, on the device page's Control tab beside the live view:

- One row per viewer: name (or `session 4f2a`), "this tab" marker, time watching (ticking via `useNow`), and a control badge on the holder.
- Hovering the holder highlights the corresponding state in the control banner, and vice versa — the visual link the operator asked for.
- The control button's state derives from the viewer list, not from local `expiresAt` alone: if some *other* session holds control, the button is disabled with "held by <name>" rather than the generic unavailable copy.

That last point is what makes the reported symptom impossible by construction: the button reads a fact the server published, instead of inferring one locally.

## 5. Implementation steps

### 31.1 Reproduce first
- [x] Two browsers on one device page. Browser 1 takes control. Record exactly what browser 2 renders — button label, disabled state, banner text — with a screenshot.
- [x] If it reproduces, find the cause before continuing and record it here. If it does not, say so here and continue: the presence work stands on its own.
- Result: a written, evidenced answer either way. Do not skip this step. **Not reproduced** — see §3.1 for the three scenarios tested and the related bug found instead (unscoped `lease.revoked` notice).

### 31.2 Protocol
- [x] `packages/protocol/src/messages/presence.ts`; register `DeviceViewersMessage` and `HelloMessage` in `ServerMessageSchema`.
- Result: typecheck green.

### 31.3 Core
- [x] Send `hello` on connect.
- [x] `viewersOf(deviceId)` derived from existing stream bindings plus the lease manager.
- [x] Broadcast on the six events in §4.2; scope to that device's viewers.
- [x] `GET /api/devices/:id/viewers`.
- Result: two WS clients on one device — both receive an updated list when either takes control. Verified live against a throwaway core plus the built Studio export, and by `packages/core/src/server/presence.test.ts`.

### 31.4 Studio
- [x] `ViewerList.tsx`; place it on the Control tab.
- [x] Derive the control button and banner from the viewer list.
- [x] Hover linking between the list and the banner.
- Result: the two-browser scenario from 31.1 now shows the truth on both screens — verified live (screenshots): the non-holder renders a disabled "Take control" naming the holder, never a release-styled button.

### 31.5 Regression test
- [x] A test that two sessions on one device produce a two-entry list with exactly one `holdsControl`, and that releasing flips it to zero.
- Result: the invariant "at most one holder" is enforced by a test, not by reading — `packages/core/src/server/presence.test.ts`, 6 tests, all passing.

## 6. Acceptance criteria

1. Opening a device page in two browsers shows two viewers in both.
2. Taking control in one marks that row in both, within a second, with no reload.
3. The non-holder's control button is disabled and names the holder.
4. Closing a tab removes its row from the other's list.
5. A third tab from the same user appears as its own row, and "this tab" marks the right one.
6. At most one viewer ever has `holdsControl` — asserted by test.
7. Releasing control clears the marker everywhere; an idle-timeout revoke does the same.
8. `bash scripts/typecheck.sh`, `bun test`, and `bun run build:studio` are green.

## 7. Test plan

**Unit**
- `viewersOf` derives from stream bindings: two bindings on one device → two viewers; a binding on another device is excluded.
- Exactly one `holdsControl`, sourced from the lease manager.
- A disconnect removes the viewer.

**Manual smoke** — two browser windows on the same device page:

```
1. both open        → each lists 2 viewers, none holding
2. window A takes   → both show A holding; B's button disabled, names A
3. window A releases→ both clear within ~1 s
4. close B          → A lists 1 viewer
5. A takes, then idles past the lease timeout → both clear on revoke
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Presence and the lease disagree. | Presence never stores control state; it reads the lease manager. One source of truth. |
| Broadcast storms on a busy farm. | Scoped to viewers of that device, and presence changes are rare by nature. |
| Session ids leak information about other users. | The id is a random per-connection UUID, not a user id. The user label respects the same permissions as the rest of the API. |
| The reported two-browser symptom has a different root cause and survives this work. | Step 31.1 requires reproducing it first; the plan explicitly does not assume the cause. |

## 9. Open questions

1. Should a viewer be able to **request** control from the holder (a prompt), or is "wait for them to release" enough? Proposed: not in this plan — it needs a decision about who can override whom.
2. Should an admin be able to force-release someone else's lease? The lease manager could support it today. Proposed: yes eventually, audited, but out of scope here.
3. In local auth mode every session is the same implicit admin. Is a short session id enough to tell tabs apart, or should the UI show the user agent / opened-at? Proposed: session id plus opened-at; user agent is noisy and fingerprint-ish.
4. Should presence extend to jobs (who is watching this run)? Proposed: no — nothing is exclusive there, so there is nothing to arbitrate.
