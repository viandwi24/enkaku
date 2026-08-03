# Plan 42 — M18 : View Lifecycle, Lease State, and the Fleet Wall

> Status: draft
> Depends on: Plans 24 (monitors), 26 (terminal), 31 (presence), 32 (topology), 39 (files) — all implemented. Independent of Plans 40 and 41.
> Spec references: §7.1 (display engines), §10.1 (server-authoritative control), §10.2 (leases), §13 (protocol), §16 (NFR).

---

## 1. Goals

- Switching tabs on the device page never restarts the video session. Coming back to **Control** shows the live picture immediately.
- Taking control updates every tab at once. No tab shows "take control first" while the button already says you have it.
- A gated panel keeps its controls **visible but disabled**, instead of replacing itself with a sentence.
- `install`, `push`, and `pull` work from the Studio buttons — today they throw before reaching the server.
- A device session survives briefly after the last viewer leaves, so returning to a device is instant rather than a fresh wake-up.
- The devices list gains a **Wall** mode: every device's screen live in a grid, so monitoring the fleet does not mean opening N device pages.

## 2. Non-goals

- Changing the wake-up progress panel itself (Plan 17). This plan removes needless *occurrences* of it, not the panel.
- Keeping device screens awake permanently. `DeviceSettings.prep.keepAwake` already exists (Plan 17 §3.4) and is out of scope here; §3.6 explains why it is not the fix for repeat loading.
- Control from the wall. Tiles are read-only; clicking one opens that device's page.
- Recording or exporting the wall.

## 3. Context and design decisions

### 3.1 The tab bug: conditional rendering unmounts the video

`packages/studio/src/app/device/page.tsx:386` renders the Control tab as `{tab === 'control' && (…)}`. React unmounts that whole subtree on a tab change, taking `LiveView` — its decoder, its frame subscription, and its WS stream registration — with it.

Returning mounts a fresh component, which starts the whole acquisition path again. Whether the operator then sees the full `Connecting → Waking → Starting video → Waiting for the first frame` sequence or just a brief flicker depends on whether the **core-side** session happened to still be alive. That is exactly why the symptom is intermittent, and why "it had only been a few seconds" does not contradict the diagnosis.

Fix: keep every tab's subtree mounted and toggle visibility with CSS. A hidden `<video>` keeps decoding, which is what makes the return instant.

The cost is that all tabs are live at once. That is acceptable for the panels that are cheap, but **not** for the ones that hold server resources: `MonitorPane` (a logcat stream) and `CrashesPanel` must not keep a stream open for a tab nobody is looking at. So those two keep mount-on-demand, and only the Control tab (plus the cheap panels) stays mounted. §4.1 says which is which, explicitly.

### 3.2 One lease truth, delivered to every tab

`iHoldControl` is derived once in the page from the Plan 31 presence list, then passed down (`canUse`, `canType`, `canOpen`, `inputEnabled`). That is already a single source — but the tabs it feeds are unmounted and remounted around it, so what an operator experiences is a panel that "catches up" only when re-created.

Once §3.1 keeps them mounted, the prop change propagates immediately. The remaining work is to make the gated panels behave properly when the prop flips: today `FilesPanel` returns a sentence *instead of* its UI (`FilesPanel.tsx:145-151`), so the operator sees the controls appear out of nowhere.

Rule for this plan: **a gated panel always renders its controls, disabled, with one line saying why.** That is how the Control tab's own input already behaves, and it makes the state change legible instead of structural.

### 3.3 The install/push/pull failure is one missing word

`packages/studio/src/lib/actions.ts:24-29`:

```ts
const res = await fetch(`${coreBase()}${path}`, {
  ...rest,
  ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json', ... } } : {}),
})
```

`method` is never set, so `fetch` defaults to `GET`, and the browser refuses a GET with a body:

> Failed to execute 'fetch' on 'Window': Request with GET/HEAD method cannot have body

Seven callers pass `json` **and** an explicit `method`. The three that do not are `FilesPanel.tsx:106` (install), `:123` (push), and `:136` (pull) — which is why exactly those three buttons fail while everything else works.

Two fixes, both wanted: set the method at the three call sites, **and** make `api()` default to `POST` when `json` is present so the class of bug cannot recur. A caller that genuinely wants another verb still passes it and still wins.

### 3.4 Sessions that outlive the last viewer

`packages/session/src/manager.ts` closes a device session as soon as it is released. Every return to a device therefore pays the full start-up: transport connect, wake, scrcpy push and launch, first keyframe.

An idle TTL fixes this directly: when the last subscriber leaves, mark the session idle and close it only after `session.idleTtlSec` (default 300) with no new subscriber. A viewer returning inside that window re-attaches to a live session and sees a picture within one keyframe request — which Plan 17 already provides (`requestKeyframe`).

Bounded on purpose:
- Idle sessions are closed immediately when the device goes offline, is quarantined, or a job needs it.
- A farm-wide cap (`session.maxIdleSessions`, default 8) evicts the least-recently-used, so a big fleet cannot hold every session open.
- The TTL is settable to 0, which restores today's behaviour exactly.

### 3.5 The wall: one design decision made up front

A grid of live screens is the feature. The trap is quality: 20 devices at the current session profile (`max_size 1600`, `max_fps 30`, `4 Mbps`) is ~80 Mbps and 20 WebCodecs decoders in one tab. That does not work, and discovering it after building the grid would mean rebuilding it.

So the session gains a **quality profile**, decided when it starts:

| Profile | `max_size` | `max_fps` | bitrate | Used by |
|---|---|---|---|---|
| `control` | 1600 | 30 | 4 Mbps | the device page |
| `wall` | 480 | 5 | 800 kbps | wall tiles |

Rules:
- A device already streaming at `control` quality is **shared** by the wall as-is — never restarted, never downgraded. Someone controlling a device must not have their picture degraded because a colleague opened the wall.
- A device not streaming starts at `wall` quality.
- Opening Control on a device that is streaming at `wall` quality **upgrades** it: the session restarts at `control` quality. That restart is visible, and it is the honest trade — the alternative is a permanently blurry Control view.
- The wall renders at most `wall.maxTiles` (default 8) live tiles and pages beyond that, because 8 low-rate decoders is a figure a laptop can hold. Devices beyond the page show their last frame plus status, not a live stream.

This keeps one decoder path, one protocol, and no new transport — the wall is the existing video stream at a different profile.

### 3.6 Why keep-awake is not the fix here

Making devices never sleep would remove the `Waking` step and nothing else: `Starting video → Waiting for the first frame` is the scrcpy session lifecycle, not the screen state. And keeping panels lit 24/7 on a rack costs OLED burn-in and battery wear — the farm already auto-quarantines on temperature for related reasons, and `standbyScreenOff` exists precisely so mirroring can continue with the panel dark.

`keepAwake` remains a per-device setting where it belongs. The repeat-loading complaint is answered by §3.1 (do not unmount) and §3.4 (idle TTL), which is why this plan does both and leaves the power settings alone.

## 4. Technical design

### 4.1 Tab lifecycle — `packages/studio/src/app/device/page.tsx`

Replace `{tab === 'x' && <Panel/>}` with a wrapper that keeps the subtree mounted and hides it:

```tsx
function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return <div hidden={!active} aria-hidden={!active}>{children}</div>
}
```

| Tab | Stays mounted? | Why |
|---|---|---|
| Control | **yes** | the whole point — the decoder must survive |
| Jobs, Logs, Settings, Files, Terminal | yes | cheap; state and scroll position persist |
| Monitor | **no** | holds a device-side `logcat` stream (Plan 24) |
| Crashes | **no** | same |

`hidden` must be the HTML attribute (not only a class) so hidden panels are out of the accessibility tree and untabbable. Verify the video element still decodes while hidden — browsers may throttle a hidden `<video>`; if the first frame after unhiding is stale, request a keyframe on becoming active (`requestKeyframe` already exists from Plan 17).

### 4.2 Gated panels render disabled, not absent

`FilesPanel` (and any panel with the same shape) keeps its form and disables the inputs and buttons when `canUse` is false, showing one muted line: *"Take control of this device to push, pull, or install files."* Same for the terminal's input, which already does this correctly and is the reference.

### 4.3 `api()` defaults to POST when it has a body

`packages/studio/src/lib/actions.ts`:

```ts
const res = await fetch(`${coreBase()}${path}`, {
  ...(json !== undefined ? { method: 'POST' } : {}),   // a caller's own method still wins
  ...rest,
  ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) } } : {}),
})
```

Order matters: the default is spread **before** `rest`, so an explicit `method` overrides it. Add `method: 'POST'` at `FilesPanel.tsx:106/123/136` as well — belt and braces, and it reads clearly at the call site.

### 4.4 Idle session TTL — `packages/session/src/manager.ts`

```ts
export interface SessionManagerDeps {
  // … existing …
  /** Seconds a session stays alive with no subscriber. 0 = close immediately (pre-plan-42 behaviour). */
  idleTtlSec?: () => number
  maxIdleSessions?: () => number
}
```

- On the last subscriber leaving: record `idleSince` and start a timer instead of closing.
- On a new subscriber: cancel the timer and reuse the session.
- On expiry, device offline/quarantine, or a job claiming the device: close it.
- When idle sessions exceed `maxIdleSessions`, evict the least-recently-used immediately.
- Expose idle sessions in `/api/adb/stats` so the effect is measurable rather than assumed.

Settings (`packages/protocol/src/settings.ts`, following the `.describe().meta()` pattern):

```ts
session: z.object({
  idleTtlSec: z.number().int().min(0).max(3600).default(300)
    .describe('How long a device session stays alive after the last viewer leaves, so returning is instant. 0 closes it immediately.')
    .meta({ title: 'Idle session TTL (s)' }),
  maxIdleSessions: z.number().int().min(0).max(64).default(8)
    .describe('How many idle sessions may be held open across the farm before the oldest is closed.')
    .meta({ title: 'Max idle sessions' }),
}).default({}),
```

### 4.5 Quality profiles

`CreateSessionOpts` gains `quality?: 'control' | 'wall'` (default `control`), mapping to the `max_size` / `max_fps` / `video_bit_rate` values in §3.5 where `startScrcpySession` is configured (`packages/core/src/daemon.ts`, `packages/agent/src/hosts.ts`).

`DeviceSession` exposes its current `quality`. `stream.start` gains an optional `quality` in its payload; the manager's rule:

- requested `wall`, session exists at any quality → reuse, no restart;
- requested `control`, session exists at `control` → reuse;
- requested `control`, session exists at `wall` → close and restart at `control`, emitting the Plan 17 progress phases so the UI explains itself.

### 4.6 The Wall — `packages/studio/src/app/page.tsx` plus `components/wall/`

A view toggle on the devices list: **List | Wall**. Wall renders a responsive grid of tiles; each tile is a small `LiveView` in read-only mode plus label, status dot, battery, and temperature.

- Tiles subscribe with `quality: 'wall'`.
- At most `wall.maxTiles` (default 8, a farm setting) tiles stream at once; the rest render a placeholder with status and a "show live" action that swaps them into the live set.
- Offline, quarantined, and unauthorised devices render as a static card with the reason — never a blank rectangle.
- Clicking a tile navigates to that device page with `next/link` (a plain `<a>` would remount everything and kill the WS).
- Tiles are read-only: no input handlers, and the server refuses input without a lease anyway.
- Tailwind v4 token classes only (`bg-surface`, `text-fg-muted`) — never bracket syntax.

The same grid component is reused on the topology page (Plan 32) behind its existing tile, so there is one wall implementation rather than two.

## 5. Implementation steps

**42.1 — `api()` and the three call sites** (§4.3). Smallest, unblocks a broken feature; do it first and verify by hand in the browser.

**42.2 — Tab lifecycle** (§4.1): the `TabPanel` wrapper, the mounted/not-mounted split, keyframe-on-activate if needed.

**42.3 — Gated panels disabled, not absent** (§4.2).

**42.4 — Idle session TTL** (§4.4): manager changes, settings, eviction, `/api/adb/stats` exposure, unit tests with a fake clock.

**42.5 — Quality profiles** (§4.5): session option, `stream.start` payload, the reuse/upgrade rules, tests for each of the three cases.

**42.6 — The Wall** (§4.6): the grid, the tile, the live-set cap and paging, the view toggle, reuse on topology.

## 6. Acceptance criteria

1. Switching Control → Monitor → Control shows the live picture immediately, with no wake-up sequence and no gap in decoding.
2. Monitor and Crashes stop their device-side streams when their tab is left (verified: no leftover `logcat` on the device).
3. Pressing "Take control" while on the Files tab enables that tab's controls immediately, with no tab switch.
4. A gated panel shows its controls disabled with one explanatory line, never an empty panel.
5. Install, push, and pull work from the Studio buttons against a real device.
6. `api()` sends POST whenever `json` is present, and an explicit `method` still wins — covered by a unit test.
7. Leaving a device and returning within the idle TTL re-attaches to the same session; returning after it starts a fresh one.
8. A job claiming a device closes an idle session immediately.
9. Idle sessions never exceed `maxIdleSessions`; the least-recently-used is evicted.
10. `idleTtlSec: 0` reproduces today's behaviour exactly.
11. Wall mode shows live screens for up to `wall.maxTiles` devices; devices already streaming at `control` quality are shown without being restarted or downgraded.
12. Opening Control on a device streaming at `wall` quality upgrades it, and the progress phases explain the restart.
13. Offline and quarantined devices appear on the wall with their reason, not as blank tiles.
14. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `actions.test.ts` (POST default, explicit method wins, no body ⇒ no method forced); `manager.test.ts` with an injected clock (TTL expiry, reuse inside the window, eviction order, job pre-emption, `0` closes immediately); quality-profile reuse/upgrade matrix.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, two devices, a real APK):**
```bash
bun run dev && bun run dev:studio
# 1. Control → wait for video → Monitor → Control  → picture is there instantly
# 2. adb shell ps -A | grep logcat  after leaving Monitor → nothing left
# 3. On Files without control: fields visible but disabled; press Take control → enabled at once
# 4. Install a real APK from the Files tab → succeeds (this is the bug that blocked it)
# 5. Leave the device page, return within 5 minutes → no wake-up sequence
# 6. Enqueue a job on that device while idle → the idle session closes and the job runs
# 7. Devices list → Wall → both screens live; open Control on one → it upgrades and the other keeps streaming
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Keeping every tab mounted makes the page heavy or keeps server resources open. | Only cheap panels stay mounted; Monitor and Crashes — the two that hold device-side streams — keep mount-on-demand, with an acceptance criterion (§6.2) proving nothing is left running on the device. |
| A hidden `<video>` is throttled by the browser and the first frame after unhiding is stale. | Request a keyframe on becoming active (`requestKeyframe`, Plan 17). Acceptance criterion §6.1 is written as "no gap in decoding" so this is tested, not assumed. |
| Idle sessions hold devices away from jobs. | A job claiming a device closes the idle session first (§6.8); idle sessions are also capped and LRU-evicted, and the TTL is settable to 0. |
| The wall saturates the browser or the network. | Fixed `wall` profile (480 px, 5 fps, 800 kbps), a default cap of 8 live tiles with explicit paging, and the rest rendered as placeholders. Measure the figures in the smoke test and record them. |
| Upgrading a `wall` session to `control` produces a visible restart that looks like a bug. | The Plan 17 progress phases are emitted for the restart, and the UI says the stream is upgrading — the alternative (a permanently low-res Control view) is worse. |
| The wall degrades a colleague's control session. | Explicit rule: a `control`-quality session is never restarted or downgraded for a wall viewer (§6.11). |

## 9. Open questions

1. Should the wall show a device's **last frame** when its session is not live, rather than a placeholder? Nice, and it needs a stored thumbnail with its own retention — deferred.
2. Should idle-session TTL differ per device (a device on a phone rack vs one on someone's desk)? Farm-wide for now.
3. Should the wall be its own route (`/wall`) rather than a mode on the devices list? Currently a mode, so filters and tags apply to it unchanged.
