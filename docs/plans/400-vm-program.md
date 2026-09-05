# Plan 400 — VM : The program — one backend, the discovery decision, waves, verified references

> Status: draft
> Ships: none — this is a programme document, not a milestone plan
> Depends on: nothing. Cut from `main` after the Flow series (plans 300–312).
> Spec references: §5 (driver layers), §7 (toolchain), §9 (network layer)

## 1. What this series is

A **virtual device**: an Android Emulator instance the farm starts, boots, and hands to
the operator as an ordinary device — remote control, scripts, jobs, all of it — without
any phone being plugged in.

The owner's framing, 2026-09-05, is the parameter this whole series is sized against:

> "toh ini juga paling hanya untuk testing aja bukan jadi main use, jadi paling dipakai
> 1 atau 2 devices aja lewat virtual ini"

**One or two instances, for testing, never the main use.** Every decision below follows
from that sentence. A design that would be right for a hundred virtual devices is wrong
here, because it buys density nobody asked for at a cost the maintainer pays forever.

### 1.1 What already exists (verified 2026-09-05, by reading these files)

| Fact | Where | Consequence for this series |
|---|---|---|
| The device reconciler re-derives adb's own truth on an interval (`host:devices-l`) and admits what it finds | `packages/core/src/registry/reconcile.ts:1-30` — "a periodic, independent re-derivation of adb's own truth (`host:devices-l`)" | **An emulator needs no registration code at all.** See D2. |
| `adb connect <host:port>` exists on the client | `packages/adb/src/client.ts:761` — "`adb connect <host:port>` via host service (wireless / adb-tcp)" | Not used by this series. See D2. |
| Remembered network addresses, with a reconnect ladder | `packages/core/src/registry/endpoints.ts:15-45` | Not used by this series. An emulator is not a network endpoint. |
| Device identity is `stableId` (ro.serialno → ANDROID_ID fallback); the adb serial is only a transport address | `CLAUDE.md` | An emulator's `emulator-5554` is a transport address like any other. The VM row keys on it; the device row does not. |
| The guest agent APK resolves in three tiers, first match wins, and is **never auto-built** | `packages/core/src/api/guest-agent.ts:150-179` (`resolveGuestAgentApkPath`), tiers at `:162`, `:166-178` | The Android SDK resolves the same way, and is never auto-downloaded. See D3. |
| A doctor check may mirror a resolver "WITHOUT provisioning anything: a doctor check must never trigger a download" | `packages/core/src/doctor/checks/guest-agent.ts:19` | The SDK doctor check is written the same way. |
| Toolchain artefacts are pinned per platform with a sha256 and a size | `packages/toolchain/src/types.ts:15-22` (`ToolArtifactSchema`) | Deliberately NOT used for system images. See D3. |
| `adb kill-server` is forbidden outside `adb-server-control.ts`'s `cycle()`, and a workspace-wide test asserts it | `CLAUDE.md`; `packages/core/src/tools/adb-server-control.test.ts` | Nothing in this series may cycle the adb server. An emulator arrives on the **shared** server on 5037. |
| adb, scrcpy-server and ui-server are downloaded on first run, never redistributed | `LICENSES.md:11`, `:19` | The same reasoning forbids shipping system images. See D3. |
| Next free Drizzle migration index is **77** (`_journal.json` ends at `idx: 76`, `0076_pretty_nemesis`) | `packages/core/drizzle/meta/_journal.json` | Plan 401 takes 0077 and says so in its §11. |
| Studio device dialogs live beside the Devices screen (`ScanNetworkDialog.tsx`, `DiscoverySheet.tsx`), toolbar at `DevicesToolbar.tsx` | `packages/studio/src/components/devices/` | Plan 403 lands its dialog there, not in a new area. |
| API routes mount in `http.ts` (`app.route('/api/devices', deps.deviceRoutes)` at `:376`) and are constructed in `daemon.ts` (`createDeviceRoutes({...})` at `:2992`) | `packages/core/src/server/http.ts:333-491`, `packages/core/src/daemon.ts:2992` | Plan 402 adds exactly one mount and one construction. |

### 1.2 What this programme is not

- Not a replacement for physical devices. `docs/guide/redroid.md` already states the
  case plainly and this series does not soften it: an emulator has no real sensors, its
  IMEI and serial are not hardware, emulator properties are readable, and its touches do
  not come from a physical input driver. Simple automation detection flags it immediately.
- Not a capacity story. Two instances. If someone later wants fifty, that is a different
  programme with a different backend (see D1's note on redroid).
- Not a change to the device model. A virtual device is a device row created by the
  existing admission path. `docs/spec.md` §5 is untouched.

## 2. The eight decisions

These are decided. A plan in this series implements them; it does not revisit them.

### D1 — The backend is the Android Emulator (AVD). Only. **Decided: yes.**

Researched 2026-09-05 (R1–R4 below). Of the candidates:

| Backend | macOS | Linux | Windows | Verdict |
|---|---|---|---|---|
| Android Emulator (AVD) | ✅ Hypervisor.framework | ✅ KVM | ✅ WHPX / AEHD | **chosen** |
| redroid | ❌ needs `binder`/`ashmem` in the host kernel | ✅ | ❌ | rejected |
| Waydroid | ❌ | ✅ | ❌ | rejected |
| Cuttlefish | ❌ | ✅ KVM | ❌ | rejected |
| Genymotion Desktop | ✅ | ✅ | ✅ | rejected — commercial licence, wrong for a self-hosted OSS farm |

The emulator is the only backend Google ships for all three desktop operating systems,
and Enkaku's core runs on all three (`packages/toolchain/src/types.ts:6-10` enumerates
`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`).

**On redroid, recorded so it is not re-argued:** redroid is genuinely better per instance
— it is a container, shares the host kernel, costs hundreds of MB rather than gigabytes,
and boots in seconds. Every one of those advantages is a *density* advantage, and density
is exactly what the owner's "1 atau 2 devices" removes from scope. It is also Linux-only,
which for a product whose operators are on macOS and Windows means a second backend that
most of them cannot run. If a future programme needs a hundred instances on a Linux node,
redroid is the right answer then, and D7's provider seam is where it would attach.

### D2 — The core never calls `adb connect` for an emulator. **Decided: discovery is already built.**

This is the most important decision in the series and the easiest one to get wrong.

The adb server **discovers local emulators by itself**, by scanning odd-numbered ports
in the range 5555–5585 (R5). An emulator that is running appears in `host:devices-l`
with the serial `emulator-<console-port>` with no client action whatsoever. The Android
documentation is explicit that `adb connect host:port` is for devices over Wi-Fi and that
emulators "do not require an `adb connect` command" (R5).

Enkaku already re-derives `host:devices-l` on an interval and admits what it finds
(`reconcile.ts:1-30`). Therefore:

- **The VM subsystem's job ends when the emulator process is running and booted.**
  Everything after that — discovery, admission, `stableId`, the device row, the driver
  ladder, scrcpy, the inspector — is existing code that needs no change.
- **No `EndpointStore.declare()` call.** An emulator is not a remembered network address.
  Writing one would put a bogus `127.0.0.1:5555` row into the reconnect ladder for a
  transport that does not exist.
- **No new transport layer, and `transport` stays `adb-usb`.** This reads wrong and is
  right: `settings.transport` (`packages/protocol/src/settings.ts:525`) describes how the
  core talks to the device, and for an emulator that is the local adb server on 5037 —
  the same path a USB phone takes. `adb-tcp` means "the core dialled a host:port itself",
  which never happens here.
- **The cap is 16, and it is a discovery cap, not a policy.** Only the first 16 emulators
  land in adb's scan range (R5). The series caps concurrent VMs below that (D6) rather
  than discovering the limit in the field.

An earlier sketch of this feature, in conversation on 2026-09-05, had the core run
`adb connect 127.0.0.1:5555` and then `endpoints.declare()`. That sketch was wrong, and
it is recorded here because it is the obvious move and an executor will reach for it.

### D3 — The Android SDK is resolved, never downloaded. **Decided: three tiers, then a clear error.**

`LICENSES.md:19` already explains why adb is not redistributed, and the guest agent APK
is "never auto-built" (`CLAUDE.md`) because Gradle needs a JDK and the Android SDK and
takes minutes. Both reasons apply here, harder:

- A system image is **1.5–3 GB** and is covered by the Android SDK Terms of Service, the
  same licence that keeps adb out of the release (`LICENSES.md:11`).
- The toolchain manifest requires a `sha256` and a `sizeBytes` per platform artefact
  (`packages/toolchain/src/types.ts:15-22`). Pinning system images there would mean
  hand-verifying multi-gigabyte artefacts for every API level and ABI the farm might
  want, and re-verifying them whenever Google rotates the repository — a permanent
  maintenance cost for a feature the owner scoped at two instances.

So the SDK resolves in three tiers, first match wins, mirroring
`resolveGuestAgentApkPath` (`api/guest-agent.ts:150-179`):

1. `ENKAKU_ANDROID_SDK_PATH` — an explicit override, always wins.
2. `ANDROID_SDK_ROOT`, then `ANDROID_HOME`, then the per-OS default location.
3. **A clear error naming what to install and the command to install it.** Never a
   download, never a silent fallback, never a partial success.

`bun run doctor` gains a check that reports which tier would be taken and what is missing,
and — like the guest-agent check — provisions nothing.

### D4 — Drive the `emulator` and `avdmanager` binaries, not the new `android` CLI. **Decided: yes, with a revisit trigger.**

Google deprecated `sdkmanager`, `avdmanager` and `emulator` in favour of a unified
`android` CLI shipped in cmdline-tools (R6, R7). The new CLI is nonetheless **not usable
here**, for one disqualifying reason: its own documentation states that "Windows support
for `android emulator` command is currently disabled" (R7, verified 2026-09-05). A
feature whose entire justification is that it works on all three operating systems cannot
be built on a tool that does not run on one of them.

The deprecated binaries still ship, still work on all three platforms, and expose the
flags this series needs with documented semantics (R8). The plans therefore call:

- `avdmanager create avd -n <name> -k "system-images;android-<api>;<variant>;<abi>"` —
  full control over API level, variant and ABI, which `android emulator create`'s
  profile-only interface does not offer (R7).
- `emulator @<name> -no-window …` — start.

**Revisit trigger, written down so it is not forgotten:** when `android emulator` gains
Windows support, or when a cmdline-tools release removes the legacy binaries, this
decision is reopened. Whichever plan notices records it in its §11.

### D5 — Headless, cold-booted, one AVD per VM row. **Decided: yes.**

- `-no-window` (R8). The operator's surface is Studio's Device Control; a second
  emulator window on the host is a confusing duplicate, and on a headless Linux node
  there is no display at all. Headless has been supported since emulator 29.0.6 (R2).
- `-no-snapshot` — cold boot every time. Quick Boot restores a saved state, which for a
  device used to *test* things is a source of "it only fails on the second run". Determinism
  is worth the seconds.
- `-no-audio`, `-no-boot-anim` — nothing consumes them and they cost boot time (R8).
- **One AVD per VM row, never shared.** Two emulators on one AVD requires `-read-only`
  and a shared image, which trades correctness for a density this series does not want.

### D6 — A VM row owns a process, not a device. **Decided: yes.**

The VM row is the emulator process and its AVD. The **device** row is created by the
existing admission path when adb sees the emulator (D2). They are linked by the serial
`emulator-<port>`, and the link is observational — exactly the status the adb serial
already has in this repo ("the adb serial is only a transport address", `CLAUDE.md`).

Consequences a plan must implement, not infer:

- Deleting a VM stops the process and deletes its AVD. It does **not** delete, block, or
  otherwise touch the device row. A device row for a stopped emulator goes offline through
  the ordinary sweep, like a phone that was unplugged.
- The concurrent-VM cap is a farm constant with an `ENKAKU_*` override, per plan 212's
  rule ("a value that does not differ between farms is a constant in
  `packages/core/src/config/constants.ts`", `CLAUDE.md`), defaulting to **2** — the
  owner's own number — and hard-bounded at 8, well inside adb's discovery range of 16 (D2).

### D7 — One provider interface, one implementation. **Decided: the seam exists, the second provider does not.**

`VmProvider` is an interface with exactly one implementation, `avd`. The seam exists
because D1 names a real future (redroid on a Linux node) and because it keeps the
process-supervision logic testable against a fake. It does **not** come with a registry,
a plugin surface, a settings selector, or a second implementation. Per
`00-overview.md` §4.3 — replace, never version — a `VmProvider` with one implementation
and no abstraction tax is fine; a provider *framework* for one provider is not.

### D8 — Adopt by port probe, never by PID. **Decided: yes.**

The core restarts; the emulators it started do not necessarily die with it. On boot the
VM manager reconciles its rows against what is actually listening on each row's console
port, and adopts or marks accordingly. A stored PID is worse than useless after a reboot
— the number gets reused — and this repo already prefers re-deriving truth over trusting
a cached handle (`reconcile.ts`'s whole rationale).

## 3. Waves and plans

One executor, one plan, one worktree. Sequential — the series is small and each plan
depends on the one before it.

| # | Plan | Ships | Depends on |
|---|---|---|---|
| 401 | `401-vm-avd-provider.md` — the `vm` subsystem: SDK resolution, the AVD provider, lifecycle and adoption, the table and migration 0077, the doctor check | `packages/core/src/vm/provider-avd.ts` | — |
| 402 | `402-vm-api.md` — protocol schemas, `/api/vms` routes, daemon wiring, the concurrency cap | `packages/core/src/api/vms.ts` | 401 |
| 403 | `403-vm-studio.md` — the Create virtual device dialog and the VM controls on the Devices screen | `packages/studio/src/components/devices/CreateVirtualDeviceDialog.tsx` | 402 |
| 404 | `404-vm-docs.md` — the operator guide, `.env.example`, `LICENSES.md`, the redroid guide's cross-reference | `docs/guide/virtual-devices.md` | 403 |

### 3.1 Rules inherited from plan 200 §2, unchanged

Plan 200's §2 is the rulebook for an executing agent in this repo and applies here in
full — scope discipline, read-before-write, the migration-index rule, checkpoint commits,
"a test your change broke is yours to fix", "do not decide an open question", the
`git stash` prohibition in every form, "do not delegate", and "never predict a result you
have not seen". A plan in this series may add rules; it may not relax those.

Plan 200 §2.6's Studio rules apply to plan 403 specifically: `'use client'` is the first
line of any file using a hook or an event handler, Tailwind v4 colour classes are written
`bg-panel` not `bg-[--color-panel]`, and `bun run build:studio` is part of verification,
not only `typecheck`.

### 3.2 Execution setup for this series

Decided with the owner, 2026-09-05:

- **Model**: each plan is executed by **Sonnet 5 with medium thinking**. A plan in this
  series is therefore written to be followed, not interpreted: every step names its files,
  its command, and its verifiable result, and anything an executor could plausibly guess
  wrong is stated as an explicit "do not".
- **Worktrees**: `git worktree add ../openpf-40N -b vm/40N main`, **outside the
  repository** — plan 200 §8.1 records what nesting them under `.claude/worktrees/` cost
  (git-process storms from editors indexing the copies; eight worktrees reaching 9.5 GB
  and a load average of 116). Remove the worktree the moment its branch merges:
  `git worktree remove --force ../openpf-40N`.
- **Branch**: cut from `main`. The MVP series closed (plan 200 §8.16) and the Flow series
  landed on `main`; there is no long-lived integration branch to target.

### 3.3 Vocabulary

Extends plan 200 §2.4. Leftovers stay greppable.

| Use | Never |
|---|---|
| virtual device (in UI copy), VM (in code and API paths) | vm device, emulator device, fake device |
| AVD (the on-disk profile) | image, template, snapshot |
| provider | driver, engine, backend (in identifiers — `engine` already names a driver-layer concept, spec §5) |
| start / stop (a VM) | boot, launch, kill, spawn (as stored states or verbs) |
| `emulator-<port>` serial | address, endpoint |

## 4. Verified external references

Checked **2026-09-05** unless a row says otherwise. A plan cites these by row; an author
who needs a fact not here verifies it and adds a row with the date.

| # | Fact | Source | Caveat |
|---|---|---|---|
| R1 | Hardware acceleration by OS: **macOS** uses the built-in Hypervisor.framework; **Windows** uses WHPX (recommended) or AEHD; **Linux** uses KVM. HAXM is discontinued by Intel and was **removed in emulator 36.2.11** (2025-10-09) — creating an AVD with HAXM now shows a banner prompting AEHD instead. | https://developer.android.com/studio/run/emulator-acceleration, https://learn.microsoft.com/en-us/dotnet/maui/android/emulator/hardware-acceleration | Linux KVM detail was not on the Microsoft page; it is standard and is restated by R2's release notes ("KVM required"). |
| R2 | Latest Android Emulator is **37.1.11 stable, released 2026-07-30**. **AEHD sunsets 2026-12-31** and Android Studio now helps Windows users convert AEHD → WHPX. Android 17 (API 37) phone AVDs **require a minimum 4 GB RAM, strictly enforced** (36.6.11, 2026-06-02). Headless (`-no-window`) support landed in **29.0.6** (2019-05-01) and dropped the Linux `pulseaudio`/`libX11` dependencies for Docker and CI. | https://developer.android.com/studio/releases/emulator | The AEHD sunset date is the single most perishable fact in this table. Plan 404's Windows guidance must say WHPX first, AEHD only as a fallback, and name the date. |
| R3 | System images for `arm64-v8a` with `google_apis` exist for **API 35 and API 36** and install as `system-images;android-36;google_apis;arm64-v8a`. Apple Silicon uses `arm64-v8a`; Intel Macs and Linux use `x86_64`. | https://developer.android.com/studio/run/emulator-acceleration, community guides (dev.to, gist.github.com/nabilfreeman) | The ABI↔host rule is well attested across sources but was not found stated in one normative Google page; plan 401 derives the ABI from `process.arch` and lets the operator override it. |
| R4 | Both `google_apis` and `google_apis_playstore` variants are published for these API levels and ABIs. | as R3 | `google_apis_playstore` images are **not rootable** (`adb root` is refused). Plan 401 defaults to `google_apis` for that reason and plan 404 documents it. |
| R5 | The adb server **discovers emulators by scanning odd-numbered ports 5555–5585** — the range used by the first 16 emulators. Each emulator takes a pair: even = console, odd = adb (5554/5555, 5556/5557, …), and its serial is `emulator-<console-port>`. `adb connect host:port` is for **Wi-Fi devices**; emulators "do not require an `adb connect` command". | https://developer.android.com/tools/adb | This is the whole basis of D2. The emulator itself accepts ports up to 5682 (64 instances, R8), but beyond the 16th nothing auto-discovers it — hence D6's cap. |
| R6 | `avdmanager` is deprecated: "The `avdmanager` tool is deprecated. Instead, use the Android CLI `android emulator` command to create AVDs." `sdkmanager` is likewise deprecated in favour of `android sdk`. `avdmanager create avd -n name -k "sdk_id" [-c {path\|size}] [-f] [-p path]`, where `-k` takes `"system-images;android-VERSION;VARIANT;ARCHITECTURE"`. | https://developer.android.com/tools/avdmanager | The page does not document `-d` (device profile) or `--abi`, though both are accepted by the tool. Plan 401 verifies `-d` against `avdmanager list device` on the host rather than assuming it. |
| R7 | The Android CLI (`android`, shipped in cmdline-tools) provides `android sdk install/list/remove/update`, `android emulator create/start/stop/list`, with package paths written with slashes (`system-images/android-36/google_apis/arm64-v8a`). `android emulator create` selects a `--profile=` only. **"Windows support for `android emulator` command is currently disabled."** | https://developer.android.com/tools/agents/android-cli | The Windows note is the basis of D4. One search result put the current cmdline-tools at 22.0; that number was not confirmed on a Google page and is therefore **not** relied on by any plan. |
| R8 | Emulator startup flags: `-avd <name>` / `@<name>`, `-no-window`, `-no-audio`, `-no-boot-anim`, `-no-snapshot`, `-wipe-data`, `-port <n>`, `-ports <console,adb>`, `-accel {auto\|off\|on}`, `-gpu <mode>` (e.g. `swiftshader_indirect`), `-memory <1536–8192>`, `-list-avds`. Valid port range **5554–5682** (64 instances); console ports should be even. | https://developer.android.com/studio/run/emulator-commandline | The same page carries the R6/R7 deprecation notice for `emulator`; D4 explains why the flags are used anyway. |
| R9 | scrcpy's UHID input simulates a physical HID device via the device's Linux HID kernel module; scrcpy mirroring behaves normally for display id 0. | https://github.com/Genymobile/scrcpy (`doc/`), https://ubuntuhandbook.org/index.php/2025/06/scrcpy-3-3-added-uhid-mouse-to-android-virtual-display/ | **No source confirms UHID works on an emulator.** `/dev/uhid` presence in an AVD is not documented anywhere found. This is the series' largest unknown and is an `owner` row in plan 401 §0, not a claim. |

## 5. Risks, named now

| # | Risk | Mitigation |
|---|---|---|
| K1 | **UHID input may not work on an emulator** (R9). The input layer would fall back, or fail. | Plan 401 §0 carries this as an `owner` row verified on the owner's machine, not as a software claim. If UHID fails, the fallback is the existing `scrcpy` injection path and plan 404 documents the limitation. Nothing in the series is blocked on the answer. |
| K2 | **Port collision with the operator's own emulator or Android Studio.** The farm does not own ports 5554–5585. | The provider probes the console port before claiming it and picks the next free even port in range, rather than assuming 5554. A VM whose port was taken by someone else's emulator is a `failed` row with the port in the message. |
| K3 | **The shared adb server.** An emulator arrives on port 5037 alongside every other adb consumer on the machine. | Nothing in this series calls `adb kill-server`, restarts the server, or touches `adb-server-control.ts`. The existing workspace-wide test (`packages/core/src/tools/adb-server-control.test.ts`) already fails the build if a plan breaks this. |
| K4 | **Disk.** A system image is 1.5–3 GB, and each AVD adds its own userdata. | D3 does not download images at all; the operator installs them. Plan 404's guide states the sizes up front. Plan 402's delete removes the AVD. |
| K5 | **AEHD sunsets 2026-12-31** (R2), inside this feature's plausible lifetime. | Plan 404 documents WHPX first and names the date. The doctor check reports which accelerator the host actually has, so a Windows farm finds out before it fails. |
| K6 | **A stale plan.** Emulator releases move monthly (R2); the CLI is mid-migration (D4). | Every external fact is in §4 with a date and a source. A plan that needs a fact not there verifies it and adds a row. |
| K7 | **Scope creep toward a farm of emulators.** The seam in D7 invites it. | D6's cap is a constant with a hard bound of 8, and D1 records why redroid — not more AVDs — is the answer to a density requirement. An executor that wants to raise the cap writes it in "Observed, not done". |

## 6. What is tested, and what is not

Plan 200 §8.3's policy applies unchanged. For this series specifically:

**Tested** (`packages/core`, backend only):
- Port selection: the next free even port in 5554–5682, skipping a probed-busy port, and the failure when the range is exhausted.
- The three-tier SDK resolution, including the error text when every tier misses.
- Boot-completion polling: the transition, the timeout, and that a timeout stops the process rather than leaking it.
- Adoption on boot (D8): a row whose port is live, a row whose port is dead, a row whose port now answers as something else.
- The concurrency cap.
- The migration.

**Not tested**, deliberately:
- Anything that actually starts an emulator. It needs the SDK, a system image, a
  hypervisor, and minutes of wall-clock; it is an `owner` row, gated behind
  `ENKAKU_TEST_DEVICE=1` like every other hardware-dependent test in this repo.
- **Studio and `@enkaku/ui` have no tests** (plan 200 §8.3). Plan 403 writes none —
  no `*.test.tsx`, no happy-dom, no testing-library. It is verified by
  `bun run typecheck`, `bun run build:studio`, and an owner smoke.

Every executor runs `bun run typecheck` freely and **only** the test files its own §7
names, one invocation at a time. Never a bare `bun test` — `CLAUDE.md`'s measured 140.66 s
suite rule is in force.

## 7. Open questions

Owner decisions. **An executor does not decide these** (plan 200 §2.1); it finishes every
step that does not depend on one and reports.

- **Q1 — Does a VM auto-start when the core boots?** D8 defines *adoption* of a VM that
  is already running, which is a different question from *starting* one that is not. A
  farm that restarts nightly and expects its test device back wants auto-start; a laptop
  that should not spin up a 2 GB VM on `bun run dev` does not. Plan 401 implements
  adoption only and leaves a `autoStart` column unwritten until this is answered.
- **Q2 — Does a virtual device count against farm capacity and take queued jobs like a
  physical one?** The honest default is yes — it is a device row and the queue does not
  know the difference — but a farm that runs real jobs on real phones may want virtual
  devices excluded from general scheduling and reachable only by an explicit target.
  Nothing in 401–404 special-cases the queue; if the answer is "exclude", that is a fifth
  plan touching the queue, not an edit to these.
- **Q3 — Which API level and variant is the default offered in the dialog?** Plan 403
  needs one default to preselect. R3/R4 establish that API 35 and 36 exist for both ABIs
  and that `google_apis` (not `_playstore`) is the rootable variant. The plan proposes
  **API 36 / `google_apis`** and marks it as awaiting ratification.
