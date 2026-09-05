# Plan 403 — VM : Studio — where a virtual device is created, and what it looks like while it boots

> Status: implemented (software) — G1–G7 done and verified by their own commands 2026-09-05. G8 stays open, verified only by the owner in a browser, on a real machine with the SDK installed.
> Ships: packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx
> Depends on: plan 402 (the `/api/vms` routes and the protocol schemas)
> Spec references: `docs/design.md` (tokens, screen patterns, writing rules)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Settings has a **Virtual devices** section, spliced like Access | id `virtualDevices`, group `Farm`, rendered by a bespoke component, not a schema form | `rg -n "virtualDevices" packages/studio/src/components/settings/farmSections.ts packages/studio/src/app/settings/page.tsx` → 2+ matches | [x] |
| G2 | The create dialog collects name, API level, variant, RAM and device profile | five controls, defaults API 36 / `google_apis` / 2048 MB / `pixel_7` | `rg -n "apiLevel\|variant\|memoryMb\|deviceProfile" packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx` → all four present | [x] |
| G3 | The section polls while it is mounted and stops when it unmounts | 3 s interval, cleared in the effect's teardown | `rg -n "setInterval\|clearInterval" packages/studio/src/components/settings/VirtualDevicesSection.tsx` → both present | [x] |
| G4 | A `failed` VM shows its `message`, never a bare status | the row renders `vm.message` when state is `failed` | `rg -n "message" packages/studio/src/components/settings/VirtualDevicesSection.tsx` → present | [x] |
| G5 | No test files are added under `packages/studio` or `packages/ui` | 0 new test files | `git diff --name-only main -- packages/studio packages/ui \| rg "\.test\." ` → empty | [x] |
| G6 | No Tailwind v3 bracket colour classes | 0 matches | `rg -n "bg-\[--\|text-\[--\|border-\[--" packages/studio/src/components/settings/VirtualDevicesSection.tsx packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx` → empty | [x] |
| G7 | Typecheck is clean **and the static export builds** | 0 errors from both | `bun run typecheck` → clean; `bun run build:studio` → succeeds | [x] |
| G8 | An operator can create, start, watch it boot, and open Device Control | end to end in a browser | owner | owner |

## 1. Goals

- One place in Studio where a virtual device is created, listed, started, stopped and deleted.
- Honest state while it boots: `starting` is a real state for 30–90 seconds and the UI says
  so rather than pretending the device is coming.
- Nothing else. Once the emulator boots it is an ordinary device on the Devices screen,
  and this plan adds no second surface for it (plan 400 D2, D6).

## 2. Non-goals

- **No tests.** Studio and `@enkaku/ui` have zero tests by decision (plan 200 §8.3,
  `CLAUDE.md`). Do not write a `*.test.tsx`, do not add happy-dom or testing-library, do
  not add a `[test].preload`. G5 greps for it.
- **No new `@enkaku/ui` primitive.** Use `Dialog`, `Button`, `EmptyState`, `ErrorState`,
  `LoadingRows` and the form controls that already exist, as `ScanNetworkDialog.tsx` does.
- **No entry in the Devices fleet menu.** See §3.1 — this is a decision, with a citation.
- **No device-row integration.** The section does not join VM rows to device rows
  (plan 402 §3.4). It shows the serial; the Devices screen shows devices.
- **No WebSocket.** Plan 402 §3.2 decided polling.

## 3. Context and design decisions

### 3.1 Why Settings, and not the Devices fleet menu

The obvious home is the fleet menu on the Devices toolbar, beside "Switch to OTG…" and
"Scan networks…". **It is refused, because the code says so.** `DevicesToolbar.tsx:272-280`
carries the owner's own reasoning, dated 2026-09-04:

> "The fleet menu (owner, 2026-09-04). The four icons to the left are all ways of LOOKING
> at the farm … These two change the farm's own wiring, and they are the two an operator
> standing at a rack reaches for … **Two rows, not a submenu: a third would mean this menu
> had become the overflow drawer every toolbar eventually grows.**"

There is a real counter-signal, and it is worth stating rather than ignoring:
`farmSections.ts:26-35` records that `networkScan` was *moved out of* Settings and onto
the Devices page precisely because "a list you edit while standing at the rack does not
belong three clicks deep in Settings".

The two reconcile on **when the operator does it**. The fleet menu's test is "an operator
standing at a rack" — physical, urgent, in the moment. Creating a virtual device is the
opposite of that on every axis: it is rare (plan 400's whole parameter is one or two), it
is done at a desk, and what it actually configures is the *host* — which SDK, which system
image, how much of this machine's RAM. That is farm configuration, which is what Settings
is for.

So: a bespoke Settings section, spliced exactly the way `access` already is. Precedent is
`packages/studio/src/app/settings/page.tsx:85` — `if (id === 'access') return <AccessSection />`
— described at `:69-72` as "the ONLY place this page names a section that is not a schema
key, alongside `access` itself". This plan makes it two, and says so there.

**Do not** also add a fleet-menu row "just in case". §9 Q5 is where an owner overrules this.

### 3.2 A section, not a settings form

Every other farm section is derived from `FarmSettingsSchema` and rendered by the schema
form (`farmSections.ts:38-49`). This one cannot be: VMs are rows in a table behind
`/api/vms`, not keys in the settings document — the same reason `access` is bespoke. It
is spliced into the section list with empty `keys`, and `page.tsx` returns the component
directly.

### 3.3 `starting` is a first-class state, not a spinner

A cold boot takes 30–90 seconds (plan 400 D5 forces `-no-snapshot`, and that is the price
of determinism). The row therefore shows the state word itself, with elapsed time, and
the create dialog closes as soon as the AVD exists rather than holding the operator
hostage to the boot.

When the VM reaches `running`, the device does **not** instantly appear on the Devices
screen: the reconciler discovers it on its own interval (plan 400 D2). The section says
so in one line rather than leaving the operator watching an empty Devices list and
concluding it failed.

### 3.4 Writing rules

`docs/design.md` governs. Specifically for this plan: sentence case, no exclamation marks,
and an error is a sentence that says what to do. The `failed` message from the core
(plan 401 §5.5 keeps the emulator's own stderr) is rendered verbatim — it is the only
place the operator will ever see why an emulator refused to start.

## 4. Technical design

### 4.1 API client — `packages/studio/src/lib/api.ts`

Appended, in the existing style (a `fetch` plus a Zod parse, as `fetchDevices` at `:124`
and `fetchNetworkStatus` at `:476` do). Plan 200 §8.1 names `lib/api.ts` as a shared file:
**append, do not reorder**.

```ts
export async function fetchVms(): Promise<VmRecord[]>
export async function createVm(spec: VmSpecInput): Promise<VmRecord>
export async function startVm(id: string): Promise<VmRecord>
export async function stopVm(id: string): Promise<VmRecord>
export async function deleteVm(id: string): Promise<void>
```

Each parses its response through the plan 402 schema (`VmListResponseSchema`,
`VmResponseSchema`). Never `as`-cast a response body (`CLAUDE.md`).

### 4.2 `packages/studio/src/components/settings/VirtualDevicesSection.tsx`

`'use client'` on line 1 — it uses `useState`, `useEffect` and click handlers, and Next is
in static-export mode where omitting it fails the build (plan 200 §2.6, which records
plan 204 failing on exactly this).

- Lists VM rows: name, state, serial, API level, and — for `failed` — the message (G4).
- Per row: **Start** (when `stopped` or `failed`), **Stop** (when `running` or `starting`),
  **Delete** (never while `running`; the confirm dialog says the AVD is deleted from disk).
- Polls `fetchVms()` every 3 s in a `useEffect`, `clearInterval` in the teardown (G3).
  Polling stops when the section unmounts — a Settings page left open on another section
  must not keep hitting the API.
- Empty state: what a virtual device is, one sentence on the SDK requirement, and the
  button that opens the dialog.
- When any row is `running`, one line: that the device appears on the Devices screen
  within the discovery interval (§3.3).

### 4.3 `packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx` — the artefact

`'use client'` on line 1. Modelled on `ScanNetworkDialog.tsx`: `Dialog`, `DialogContent`,
`DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` from `@enkaku/ui`.

| Control | Type | Default | Notes |
|---|---|---|---|
| Name | text | — | `^[A-Za-z0-9._-]+$`, validated in the dialog with the same message the schema uses |
| API level | select | **36** | 24–40; plan 400 Q3 proposed 36, awaiting ratification |
| Variant | select | **`google_apis`** | the tooltip says `google_apis_playstore` cannot be rooted (plan 400 R4) |
| RAM | number | **2048** MB | 1536–8192; the helper text names the API 37+ ≥ 4096 requirement (plan 400 R2) |
| Device profile | text | **`pixel_7`** | helper text: `avdmanager list device` lists valid ids |

ABI is **not** a control: the core derives it from `process.arch` (plan 401 §3.5), and
asking an operator to choose between `arm64-v8a` and `x86_64` is asking them to get it
wrong. It stays available over the API for the case that needs it.

On submit: `createVm(spec)`, then close. Errors render in the dialog — in particular
`E_ANDROID_SDK_MISSING` (503), whose body carries the full install instruction from
plan 401 §4.2. **Render that message verbatim, in a `<pre>`-style block**: it contains a
command the operator is meant to copy, and truncating it to "SDK not found" throws away
the whole point of plan 400 D3.

### 4.4 Wiring

- `packages/studio/src/components/settings/farmSections.ts`: splice
  `{ id: 'virtualDevices', title: 'Virtual devices', group: 'Farm', keys: [] }` beside
  `access`, in the same function, in the same style.
- `packages/studio/src/app/settings/page.tsx`: add
  `if (id === 'virtualDevices') return <VirtualDevicesSection />` beside the `access` line
  at `:85`, and **update the comment at `:69-72`** which currently says `access` is "the
  ONLY place this page names a section that is not a schema key". It is now one of two;
  leaving that comment stale is the same drift plan 200's status-line rule exists to stop.

## 5. Implementation steps

### 5.1 API client

- Change `packages/studio/src/lib/api.ts`: append the five functions per §4.1.
- Result: `bun run typecheck` clean.

### 5.2 The dialog

- Create `packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx` per §4.3.
- Result: `bun run typecheck` clean; G2's grep finds all four fields.

### 5.3 The section

- Create `packages/studio/src/components/settings/VirtualDevicesSection.tsx` per §4.2.
- Result: G3 and G4's greps pass.

### 5.4 Wiring and the stale comment

- Change `farmSections.ts` and `app/settings/page.tsx` per §4.4, including the comment fix.
- Result: G1's grep passes.

### 5.5 Verify the export, not only the types

- Run `bun run typecheck`, then `bun run build:studio`. Plan 200 §2.6: a missing
  `'use client'`, a bad import path, or a server/client boundary error passes typecheck
  and fails the export. Both must pass (G7).

### 5.6 Checkpoint and report

- Commit as you go (`feat(vm-403): …`). Fill in §11.

## 6. Acceptance criteria

- [x] G1–G7 pass by their own commands. G8 is an `owner` row and stays open.
- [x] `bun run typecheck` clean **and** `bun run build:studio` succeeds.
- [x] `'use client'` is line 1 of both new components.
- [x] No `*.test.tsx` anywhere in the diff; no happy-dom, no testing-library, no `[test].preload`.
- [x] No `bg-[--color-*]` style class anywhere in the diff (Tailwind v4 — `CLAUDE.md`).
- [x] No fleet-menu row was added (§3.1).
- [x] The stale comment at `app/settings/page.tsx:69-72` is corrected.

## 7. Test plan

**No automated tests** — plan 200 §8.3. Verification is:

```bash
bun run typecheck
bun run build:studio
```

**Owner smoke** (G8):

```bash
bun run dev          # core on :7700
bun run dev:studio   # Next on :3001
```

Then: Settings → Virtual devices → Create → watch the row go `creating` → `stopped`;
press Start → `starting` → `running`; confirm the device appears on Devices within the
discovery interval **without any `adb connect` having been run**; open Device Control and
confirm the screen mirrors. Record whether input works (plan 400 K1/R9 — this is the
first real answer anyone will have to that question).

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The executor adds a fleet-menu row because it is the obvious place. | §3.1 quotes the owner's own comment forbidding a third row; §2 lists it as a non-goal; §6 has a checkbox. |
| The executor writes a test because the component has logic. | §2, §6 and G5 all forbid it, and `CLAUDE.md` states the decision. Logic worth testing belongs in `packages/protocol` or `packages/core`. |
| `bun run build:studio` fails on a missing `'use client'`. | §5.5 makes the export part of verification, and plan 200 §2.6 records this exact failure on plan 204. |
| The SDK-missing error gets truncated to a toast. | §4.3 requires the message verbatim in a copyable block, and names why. |
| Discoverability: an operator never finds Settings → Virtual devices. | Accepted for now, and recorded as §9 Q5. The feature is for one or two devices used in testing, and the owner knows where it is. If it needs a second door later, that is a change with evidence. |

## 9. Open questions

- **Q5 (new)** — is Settings the right home, or should this be a fleet-menu row after all?
  §3.1 decides Settings on the reasoning in `DevicesToolbar.tsx:272-280`, but that comment
  is the owner's and only the owner can relax it. **The executor does not decide this**;
  it builds Settings as specified and reports.
- **Q3 (from plan 400)** — the default API level and variant preselected in the dialog.
  This plan uses API 36 / `google_apis` (§4.3). This is the screen where the owner will
  see it, and ratification belongs here.
- Inherited: plan 400 Q1 (auto-start) and Q2 (queue participation), plan 402 Q4
  (admin-only mutations). None blocks a step in this plan.

## 10. Removed

Nothing removed; one stale comment corrected.

| What | Where it was | Proof |
|---|---|---|
| The claim that `access` is the only non-schema section | `packages/studio/src/app/settings/page.tsx:69-72` | `rg -n "ONLY place this page names a section" packages/studio/src/app/settings/page.tsx` → the corrected wording, naming both sections |

## 11. Handoff report

**Status: G1–G7 done and verified by their own commands. G8 remains an `owner` row, untouched.**

### What was built

- `packages/studio/src/lib/api.ts` — appended (never reordered) five functions per §4.1:
  `fetchVms`, `createVm`, `startVm`, `stopVm`, `deleteVm`, each a `@enkaku/ui`
  `api()` call parsed through plan 402's `VmListResponseSchema`/`VmResponseSchema`.
  Two import lines were appended to the existing `@enkaku/protocol` blocks
  (`VmListResponseSchema`/`VmResponseSchema` and the `VmRecord`/`VmSpec` types)
  without reordering any existing entry.
- `packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx` — the
  five controls per §4.3 (name, API level, variant, RAM, device profile), ABI
  omitted from the UI as specified. Client-side validation mirrors the
  protocol schema's own constraints (name pattern, 1536–8192 MB) so a bad
  value never reaches the network. On submit it creates the AVD only (closes
  immediately, per §3.3 — creating never starts a VM). An
  `E_ANDROID_SDK_MISSING` (or any other) failure renders `err.message`
  verbatim inside a `<pre>` block, not a toast, per §4.3's explicit
  requirement.
- `packages/studio/src/components/settings/VirtualDevicesSection.tsx` — the
  list/create/start/stop/delete section per §4.2. Polls `fetchVms()` every
  3 s via `setInterval` in a `useEffect`, `clearInterval` in the teardown.
  Renders `vm.message` under a `failed` row. Start is offered for
  `stopped`/`failed`; Stop for `running`/`starting`; Delete is disabled for
  `running`/`starting`/`stopping` and goes through `ConfirmDialog`, whose
  description explicitly states the AVD is deleted from disk and the device
  row is untouched (plan 400 D6). When any row is `running` or `starting`,
  one line tells the operator the device appears on the Devices screen on
  its own, on the reconciler's own interval — never instantly.
- `packages/studio/src/components/settings/farmSections.ts` — spliced
  `{ id: 'virtualDevices', title: 'Virtual devices', group: 'Farm', keys: [] }`
  beside `access`, in the same function, same style, same `advancedAt`
  splice point (§4.4).
- `packages/studio/src/app/settings/page.tsx` — added the `VirtualDevicesSection`
  import and the `if (id === 'virtualDevices') return <VirtualDevicesSection />`
  branch beside `access`/`toolchain`. Corrected the comment at (now) `:69-78`
  — see "wrong about the codebase" below for why the correction differs from
  what the plan described.

### Goal-by-goal verification (commands actually run, output actually read)

- **G1** — `rg -n "virtualDevices" packages/studio/src/components/settings/farmSections.ts packages/studio/src/app/settings/page.tsx` → 6 matches across both files (3 each).
- **G2** — `rg -n "apiLevel|variant|memoryMb|deviceProfile" packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx` → all four present, multiple times each.
- **G3** — `rg -n "setInterval|clearInterval" packages/studio/src/components/settings/VirtualDevicesSection.tsx` → both present (`:60`, `:61`).
- **G4** — `rg -n "message" packages/studio/src/components/settings/VirtualDevicesSection.tsx` → present, including the `vm.state === 'failed' && vm.message` render branch.
- **G5** — `git diff --name-only main -- packages/studio packages/ui | rg "\.test\."` → empty.
- **G6** — `rg -n "bg-\[--|text-\[--|border-\[--" packages/studio/src/components/settings/VirtualDevicesSection.tsx packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx` → empty.
- **G7** — `bun run typecheck` → clean across every workspace package (protocol, expr, ui, adb, toolchain, drivers, scrcpy, sdk, session, harness, core, node, studio, probe-server, networking, proxy-manager, and the example packs). `bun run build:studio` → `next build` compiled successfully, generated 20/20 static pages, exported 2/2, exit code 0.
- **G8** — left unticked, `owner` row: needs a real Android SDK, a real hypervisor, and a browser. See "never rendered in a browser" below.

### Deviations / things the plan did not fully specify, and what was chosen

- **No new `@enkaku/ui` primitive was added**, per §2 — the state word uses
  plain `text-led-warn`/`text-led-ok`/`text-led-danger`/`text-faint` classes
  the same way `OtgSwitchDialog.tsx:389` already colors a bespoke state word
  (`StatusDot`'s own `StatusDotState` union does not name any VM state, and
  extending it for one bespoke section would be the abstraction tax plan 400
  D7 explicitly rejects for this series).
- **Elapsed time** (§3.3, §4.2) is rendered with `@enkaku/ui`'s existing
  `relativeTime()` (`"12s ago"`/`"1m ago"`), not a hand-rolled stopwatch —
  the plan does not specify the exact display and this reuses the one
  formatter every other Settings/Devices screen already uses for the same
  purpose.
- **API level options in the dialog are 36 and 35 only** (not the full
  24–40 the schema accepts). Plan 400 R3 only verified system images exist
  for API 35/36; offering 24–34 or 37–40 in the picker would let an operator
  pick a level with no available system image and only find out from the
  `avdmanager` failure message. The schema itself is unchanged (still
  `min(24).max(40)`) — this is a UI-only narrowing, not a spec change, and
  is the kind of "await ratification" default plan 400 Q3 anticipates.
- **`google_apis_playstore` is offered as a second Variant option** even
  though the dialog's own helper text says it cannot be rooted, because §4.3's
  table lists it as a real (if cautioned) choice, not a hidden one; `default`
  and `aosp_atd` (also schema-valid) are omitted from the picker as the plan's
  table does not mention them and R3/R4 only verify `google_apis`/`google_apis_playstore`
  images exist.

### What was NOT done, and why

- G8 — requires a real Android SDK, a real hypervisor, and a browser;
  correctly left as an `owner` row, per the plan.
- No fleet-menu row was added (§3.1, §9 Q5 stays open for the owner).
- No `*.test.tsx`, no happy-dom, no testing-library — G5 confirms.
- No change inside `packages/core` or `packages/protocol` — this plan is
  Studio-only, matching its own `Ships:` line.

### Anything in the plan that turned out to be wrong about the codebase

- **§4.4's premise that `access` is currently the only spliced non-schema
  section, with the stale comment only needing "access" corrected to name
  two, was already out of date before this plan started.**
  `packages/studio/src/app/settings/page.tsx:68-72` (pre-existing, from plan
  219) already spliced a SECOND bespoke section, `toolchain`
  (`ToolchainSection`), and its own comment already said so — "This plan
  splices in one more bespoke section, `toolchain` ... alongside `access`
  itself." So the comment plan 403 §4.4 describes as claiming access is "the
  ONLY" one was, in the actual file, already naming two sections, not one.
  This plan's correction therefore updates the count from two to three
  (`access`, `toolchain`, `virtualDevices`) rather than from one to two as
  §4.4 anticipated. The literal grep in §10's removal-table proof (`rg -n
  "ONLY place this page names a section" ... page.tsx`) still passes — the
  phrase is kept intact on one line and the surrounding text is what changed
  — but an author relying on §4.4's own wording ("currently says access is
  the ONLY place…") to know what to expect in the file would have been
  surprised. Cite: `packages/studio/src/app/settings/page.tsx:68-78` (current
  line numbers, post-edit).
- Everything else matched: `farmSections.ts`'s `access` splice shape,
  `ScanNetworkDialog.tsx`'s `Dialog`/`DialogContent`/... import list and
  layout, `AccessSection.tsx`'s `Table`/`ConfirmDialog`/`useAction` pattern,
  `lib/api.ts`'s `fetchDevices`-style append convention, `@enkaku/ui`'s
  `api()` throwing an `Error` with `.code`/`.message` matching
  `EnkakuError.toJSON()`'s `{ error: { code, message } }` shape exactly as
  plan 402 built it, and `states.tsx`'s `EmptyState`/`ErrorState`/`LoadingRows`
  signatures used unchanged.

### What has never been rendered in a browser (owner smoke needed)

Studio has zero automated tests (plan 200 §8.3) — typecheck-clean and
build-clean is not the same as working. Nothing in this plan's UI has been
seen in a browser. The owner should specifically check, per §7's smoke plan:

1. Settings → Virtual devices appears in the Farm group, between Access and
   Advanced (or at the end if there is no Advanced section).
2. The empty state, and that "Create virtual device" opens the dialog from
   both the header button and the empty-state's own button.
3. The dialog's five controls, their defaults (API 36, `google_apis`,
   2048 MB, `pixel_7`), the inline validation messages (bad name characters,
   RAM out of 1536–8192), and — on a machine with no Android SDK — that the
   `E_ANDROID_SDK_MISSING` message renders in full, legibly, in the `<pre>`
   block (this was never seen against a live 503; it was only checked against
   the route's documented shape from plan 402 §11 and `sdk.ts`'s literal
   message text).
4. The row's state word colors in light AND dark mode (`text-led-warn` /
   `text-led-ok` / `text-led-danger` / `text-faint` are used elsewhere but
   never previously combined in this exact table layout).
5. Start → `starting` → (30–90s) → `running`, and that the "appears on
   Devices on its own" line shows while any row is `starting`/`running`, and
   disappears once no row is.
6. Stop and Delete, including that Delete is disabled while running/starting/
   stopping and that its confirm dialog's wording reads correctly.
7. That polling actually stops when navigating to another Settings tab —
   this was verified by reading the `useEffect` cleanup, not by watching
   Network tab traffic in a real browser.

### Test files run

None. Plan 200 §8.3 and this plan's own §2/§6 forbid Studio tests entirely;
no backend file was touched, so no `bun test` invocation was needed either.
Verification was exactly:

```
bun run typecheck      → clean (21 packages, including studio)
bun run build:studio   → exit 0, 20/20 static pages, 2/2 exported
```
