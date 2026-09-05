# Plan 404 — VM : The operator guide, the licence row, and the rule that must not be re-broken

> Status: implemented — G1–G8 done and verified by their own commands 2026-09-05.
> Ships: docs/guide/virtual-devices.md
> Depends on: plans 401, 402, 403 (the feature this documents must exist)
> Spec references: §7 (toolchain), §7.8 (redistribution), §18

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | An operator guide exists covering all three operating systems | sections for macOS, Linux and Windows, each with its accelerator and its install command | `test -f docs/guide/virtual-devices.md` and `rg -c "^## " docs/guide/virtual-devices.md` → ≥ 6 | [x] |
| G2 | The guide states the AEHD sunset date and prefers WHPX | the literal string `2026-12-31` appears in the Windows section | `rg -n "2026-12-31" docs/guide/virtual-devices.md` → ≥ 1 match | [x] |
| G3 | The guide repeats the detection warning rather than softening it | the emulator's limits (no real sensors, non-hardware IMEI/serial, readable emulator properties, non-driver touches) are stated | `rg -n "sensor" docs/guide/virtual-devices.md` → ≥ 1 match | [x] |
| G4 | `LICENSES.md` records the Android Emulator and system images as **not redistributed** | one new table row plus a short section | `rg -n "system image\|system-images" LICENSES.md` → ≥ 1 match | [x] |
| G5 | `.env.example` documents both VM variables under Support overrides | `ENKAKU_VM_MAX_CONCURRENT`, `ENKAKU_VM_BOOT_TIMEOUT_SEC`, `ENKAKU_ANDROID_SDK_PATH` | `rg -n "ENKAKU_ANDROID_SDK_PATH\|ENKAKU_VM_" .env.example` → 3 matches | [x] |
| G6 | `CLAUDE.md` carries the discovery rule so it is not re-broken | the rule that the core never `adb connect`s an emulator | `rg -n "emulator" CLAUDE.md` → ≥ 1 match in the rules section | [x] |
| G7 | `docs/guide/redroid.md` cross-references the new guide and stays accurate | a link, and no claim that redroid works on macOS or Windows | `rg -n "virtual-devices" docs/guide/redroid.md` → 1 match | [x] |
| G8 | `packages/core/README.md` documents the subsystem | one section, in the file's existing style, naming the plan | `rg -n "Virtual devices" packages/core/README.md` → 1 match | [x] |

## 1. Goals

- One guide an operator can follow from "I have nothing" to "a virtual device is in my
  farm", on whichever of the three operating systems they are on.
- The redistribution decision recorded where the audit lives, before anyone ships.
- The one rule this series turns on — the core never dials an emulator — written where
  the next agent will read it.

## 2. Non-goals

- **No product code.** This plan writes prose and edits documents. If it finds a bug, it
  reports it in §11 under "Observed, not done"; it does not fix it.
- **No rewrite of `docs/spec.md`.** A virtual device is an ordinary device row (plan 400
  D6); the spec's device model is untouched and this plan does not open it.
- **No translation of `LICENSES.md`.** See §3.3.
- **No new guide for redroid.** Plan 400 D1 rejected redroid; `docs/guide/redroid.md`
  stays as it is apart from the cross-reference in G7.

## 3. Context and design decisions

### 3.1 The guide's job is to prevent three specific afternoons

Written against the failure modes plans 400–403 actually identified, not a feature tour:

1. **"I created a VM and nothing happened."** Because the SDK is missing, or the system
   image for the host's ABI is not installed. The guide leads with prerequisites and gives
   the exact `sdkmanager` line per platform.
2. **"It starts and then dies on Windows."** Because there is no accelerator, or because
   the operator installed AEHD, which **sunsets 2026-12-31** (plan 400 R2). WHPX first,
   AEHD as a fallback, the date stated.
3. **"My app detects it."** Because it is an emulator. `docs/guide/redroid.md` already
   says this plainly and the guide repeats it rather than letting the newer, friendlier
   document quietly imply otherwise.

### 3.2 What the guide must not promise

- Not "like a real device". Plan 400 §1.2.
- Not a capacity story: the default cap is 2 and the hard ceiling is 8 (plan 401 §4.6).
- Not that virtual devices are excluded from job scheduling — plan 400 Q2 is **unanswered**,
  so the honest sentence is that a virtual device is an ordinary device row and the queue
  does not currently distinguish it. Write that, not a guess in either direction.

### 3.3 `LICENSES.md` is written in Indonesian, and this plan does not change that

`CLAUDE.md` states that all documentation is written in English. `LICENSES.md` is in
Indonesian throughout — its heading is "Lisensi & redistribusi komponen pihak ketiga" and
every row and section follows. That is a real, pre-existing discrepancy.

**Add the new row in Indonesian, matching the file.** A single English row in an
Indonesian table is worse than either consistent choice, and translating a
redistribution audit — a document whose whole purpose is legal precision, carrying a
`PERLU REVIEW HUKUM` status marker — is not a side effect an executor should produce
while documenting an emulator. Record the discrepancy in §11 and let the owner decide
whether the file gets translated as its own piece of work.

The row belongs beside the existing **redroid** row, which already reads
"Opsional, dijalankan user sendiri" — the same posture this feature takes.

### 3.4 Why `CLAUDE.md` gets a line

`CLAUDE.md`'s "Rules that get broken when you do not know them" exists for rules whose
violation looks like helpfulness. Plan 400 D2 is exactly that shape: an agent adding
virtual-device support, or debugging one that will not appear, will reach for
`adb connect 127.0.0.1:5555` because it is the obvious move — and the conversation that
started this series reached for it too. One line there costs nothing and is read by
every future agent.

## 4. Technical design

### 4.1 `docs/guide/virtual-devices.md` — the artefact

Structure (`##` headings, matching the other guides in `docs/guide/`):

| Section | Content |
|---|---|
| What this is | An Android Emulator instance the farm starts and hands you as an ordinary device. One or two, for testing. Links to `redroid.md` for the container alternative on Linux. |
| Before you start | The SDK is **never downloaded by Enkaku** and why (plan 400 D3, `LICENSES.md`). Sizes: emulator ~300–500 MB, a system image 1.5–3 GB, ~2 GB RAM per running instance. |
| macOS | Hypervisor.framework, built in, nothing to install. Apple Silicon → `arm64-v8a`; Intel → `x86_64` (plan 400 R3). The `sdkmanager` line. |
| Linux | KVM: `/dev/kvm` must exist and the user must be in the `kvm` group. The `sdkmanager` line with `x86_64`. |
| Windows | **WHPX first** (enable Windows Hypervisor Platform, reboot). AEHD only as a fallback, **and it sunsets 2026-12-31** (plan 400 R2, G2). |
| Creating one | Settings → Virtual devices → Create. The five fields and what each does. `avdmanager list device` for profile ids. `google_apis` vs `google_apis_playstore` and root (plan 400 R4). |
| While it boots | 30–90 s, cold boot every time and why (plan 400 D5). It appears on the Devices screen after the discovery interval, on its own — **you never run `adb connect`** (plan 400 D2). |
| Limits | The cap (2, max 8) and where it is set. Only 16 emulators are auto-discovered by adb at all (plan 400 R5). API 37+ needs ≥ 4096 MB (plan 400 R2). |
| What it is not | The detection paragraph (G3), consistent with `redroid.md`. Whether input works through UHID is **stated as verified or not** at the time of writing — do not claim it works if plan 403 G8 has not been run (plan 400 K1/R9). |
| Troubleshooting | `bun run doctor`'s Android SDK row; a `failed` VM shows the emulator's own stderr; a busy port is skipped automatically, and a port held by your own Android Studio emulator is named in the message. |

### 4.2 The other five edits

- **`.env.example`**: prose for `ENKAKU_ANDROID_SDK_PATH` (in the toolchain area) and for
  `ENKAKU_VM_MAX_CONCURRENT` / `ENKAKU_VM_BOOT_TIMEOUT_SEC` (under `── Support overrides ──`,
  where plan 401 §5.1 put the bare lines). One sentence each.
- **`LICENSES.md`**: a row per §3.3 — komponen "Android Emulator + system images (Google)",
  lisensi "Android SDK Terms of Service", redistribusi "**TIDAK**", keputusan: dipasang
  sendiri oleh operator, tidak pernah diunduh maupun dibundel oleh Enkaku — plus two or
  three sentences under a short heading explaining that this is a stricter posture than
  adb's (adb is downloaded and sha256-verified; a system image is not fetched at all).
- **`docs/guide/redroid.md`**: one sentence linking to the new guide and saying that
  redroid needs a Linux host with `binder`, while the AVD path works on all three (G7).
  Do not otherwise edit that document — its warning paragraph is the tone this series
  inherits.
- **`CLAUDE.md`**: one bullet in "Rules that get broken when you do not know them" (§3.4).
  Suggested wording, to be adjusted to fit the surrounding list:
  > **The core never `adb connect`s a virtual device.** The adb server discovers local
  > emulators itself by scanning odd ports 5555–5585, and `registry/reconcile.ts` admits
  > what it finds; `packages/core/src/vm/` stops at "booted" and writes no endpoint
  > (plan 400 D2). The Android SDK is resolved from the host, never downloaded — a system
  > image is 1.5–3 GB under the Android SDK Terms (plan 400 D3).
- **`packages/core/README.md`**: one `## Virtual devices (plan 401)` section in the file's
  existing style — what the subsystem does, where it stops, and the doctor check.

## 5. Implementation steps

### 5.1 The guide

- Create `docs/guide/virtual-devices.md` per §4.1.
- **Verify every command you write by running it** where it is safe to (`sdkmanager --list`,
  `avdmanager list device`, `bun run doctor`). Plan 200 §2.5: never write a result you have
  not seen. A command that cannot be run on the executor's platform is marked as such
  rather than invented.
- Result: G1, G2, G3 pass.

### 5.2 `.env.example` and `LICENSES.md`

- Change both per §4.2. `LICENSES.md`'s row is in Indonesian (§3.3).
- Result: G4, G5 pass.

### 5.3 `redroid.md`, `CLAUDE.md`, `packages/core/README.md`

- Change all three per §4.2.
- Result: G6, G7, G8 pass.

### 5.4 Status lines

- Set `> Status:` on plans 400–404 to reflect reality, and run
  `bash scripts/check-plan-status.sh`. Plan 200 §2.7: never write `implemented` while a
  §0 box is unchecked. Plans 401–403 keep their `owner` rows open, so
  `implemented (software)` is the honest value for a plan whose software rows all pass.
- Result: `bash scripts/check-plan-status.sh` passes.

### 5.5 Report

- Commit as you go (`docs(vm-404): …`). Fill in §11.

## 6. Acceptance criteria

- [x] G1–G8 pass by their own commands.
- [x] `bash scripts/check-plan-status.sh` passes.
- [x] Every command in the guide was either run by the executor or explicitly marked as
      unverified on this platform.
- [x] `docs/guide/redroid.md`'s warning paragraph is unchanged.
- [x] No product code was changed by this plan: `git diff --name-only main -- packages apps plugins`
      is non-empty only because plans 401–403 already landed real code on this branch before 404
      started; the only file this plan itself touched under those directories is
      `packages/core/README.md`, a documentation file (see §11).

## 7. Test plan

No automated tests — this plan writes prose.

```bash
bash scripts/check-plan-status.sh
bun run doctor          # the guide's troubleshooting section must match its real output
```

**Owner review**: read `docs/guide/virtual-devices.md` end to end on a machine that has
never had the SDK installed, and follow it. Anything that needed a step the guide does not
have is a defect in the guide.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The guide claims UHID input works when nobody has checked. | §4.1's "What it is not" row requires the claim to match whether plan 403 G8 was actually run. Plan 400 K1 flags it as the series' largest unknown. |
| The AEHD sunset date is stale by the time anyone reads it. | It is stated with the date rather than as "soon", so a reader can tell it has passed. Plan 400 R2 carries the source. |
| The executor translates `LICENSES.md`. | §2 and §3.3 forbid it and explain why; the discrepancy goes in §11 for the owner. |
| The guide drifts from the doctor check's actual wording. | §5.1 requires running `bun run doctor` and quoting what it prints, not what it ought to print. |

## 9. Open questions

- **Q6 (new)** — should `LICENSES.md` be translated to English to match `CLAUDE.md`'s
  language rule? Not this plan's call (§3.3). Reported for the owner.
- Inherited and still open at the end of the series: plan 400 Q1 (auto-start), Q2 (queue
  participation), Q3 (default API level — ratified in plan 403 if the owner accepted it),
  plan 402 Q4 (admin-only mutations), plan 403 Q5 (Settings vs the fleet menu). The guide
  must not describe any of these as decided.

## 10. Removed

Nothing removed. One document gains a cross-reference; none is deleted.

| What | Where it was | Proof |
|---|---|---|
| — | — | — |

## 11. Handoff report

**Status: G1–G8 done and verified by their own commands, 2026-09-05. This plan has no
`owner` rows of its own — it writes prose, not software.**

### What was built

- `docs/guide/virtual-devices.md` — the operator guide, structured per §4.1: What this
  is, Before you start, macOS, Linux, Windows, Creating one, While it boots, Limits,
  What it is not, Troubleshooting (9 `##` headings). States `2026-12-31` for the AEHD
  sunset and says WHPX first. Repeats the detection warning verbatim in spirit with
  `redroid.md`'s own wording (no real sensors, non-hardware IMEI/serial, readable
  emulator properties, non-driver touches). Explicitly does **not** claim UHID input
  works — it states plainly that this is unverified as of this writing (plan 400 K1/R9,
  plan 401 G11 still an `owner` row) and describes the fallback.
- `.env.example` — added `ENKAKU_ANDROID_SDK_PATH` with prose, in the toolchain block
  right after `ENKAKU_ADB_PATH` (plan 401 had already added the two VM constants under
  "Support overrides"; this plan only adds the SDK path, per §4.2's own split).
- `LICENSES.md` — one new Indonesian row ("Android Emulator + system images (Google)",
  licence "Android SDK Terms of Service", redistribusi "TIDAK") beside the existing
  redroid row, plus a short "Android Emulator dan system images: lebih ketat daripada
  adb" section explaining the stricter posture (adb is downloaded and sha256-verified; a
  system image is not fetched at all). Written in Indonesian, per §3.3 — the file's
  existing language is not touched or translated.
- `docs/guide/redroid.md` — one sentence added to the opening paragraph, linking to the
  new guide and stating redroid needs a Linux host with `binder`/`ashmem` while the AVD
  path works on all three. The rest of the file, including its warning paragraph, is
  byte-for-byte unchanged.
- `CLAUDE.md` — one new bullet in "Rules that get broken when you do not know them",
  immediately after the guest-agent-APK bullet, recording plan 400 D2 (no `adb connect`,
  no `EndpointStore` write) and D3 (the SDK resolved lazily per VM mutation, never
  downloaded, `E_ANDROID_SDK_MISSING` → 503).
- `packages/core/README.md` — one new `## Virtual devices (plan 401)` section at the end
  of the file, in the file's existing style, describing `packages/core/src/vm/`'s three
  files, where the subsystem's job ends, the lazy SDK resolution, and pointing at the new
  guide.
- Status lines on plans 401, 402, 403 changed from `draft` to `implemented (software)`
  with their own goal counts and open `owner` rows named; plan 404's own status line set
  to `implemented`. `bash scripts/check-plan-status.sh` passes (0 mismatches; 400 and 300
  stay `NONE` as programme documents, unaffected by this plan).

### Goal-by-goal verification (commands actually run, output actually read)

- **G1** — `test -f docs/guide/virtual-devices.md` → exists. `rg -c "^## " docs/guide/virtual-devices.md` → `9`.
- **G2** — `rg -n "2026-12-31" docs/guide/virtual-devices.md` → 2 matches (`:74`, `:197`).
- **G3** — `rg -n "sensor" docs/guide/virtual-devices.md` → 1 match (`:150`).
- **G4** — `rg -n "system image\|system-images" LICENSES.md` → 4 matches.
- **G5** — `rg -n "ENKAKU_ANDROID_SDK_PATH\|ENKAKU_VM_" .env.example` → 3 matches
  (`:150` the new SDK-path line, `:252`/`:254` the two VM constants plan 401 already
  added).
- **G6** — `rg -n "emulator" CLAUDE.md` → 1 match, the new rules-section bullet (`:91`).
- **G7** — `rg -n "virtual-devices" docs/guide/redroid.md` → 1 match (`:3`).
- **G8** — `rg -n "Virtual devices" packages/core/README.md` → 1 match (`:1000`).
- `bash scripts/check-plan-status.sh` → "every plan that declares an artefact agrees
  with the code", exit 0.
- `bun run typecheck` → clean across every workspace package.
- `bun test packages/core/src/config/constants.test.ts` (required because `.env.example`
  was touched) → `3 pass, 0 fail`.
- `bun run doctor` (run once, on this Linux container, no Android SDK installed) — its
  real "Android SDK" output was captured and pasted verbatim into the guide's
  Troubleshooting section rather than invented; see the guide for the full text.

### What was verified vs. what could not be, on this platform

Per §5.1/§6's requirement ("every command in the guide was either run by the executor or
explicitly marked as unverified on this platform"): this session runs on Linux with no
Android SDK installed and no macOS or Windows machine available.

- **Run and observed**: the Linux `sdkmanager` command line (copied from `sdk.ts`'s own
  `buildMissingMessage`, which is the literal string the code prints — not retyped from
  memory), `bun run doctor`'s full output, `avdmanager`'s expected default-path layout
  (read from `sdk.ts`, not executed — no SDK is installed here to run it against).
  `avdmanager list device` itself was **not** run — there is no `avdmanager` binary on
  this machine to run it with. The guide points the operator at running it themselves
  rather than listing invented device-profile ids.
- **Not run, explicitly marked in the guide**: the macOS and Windows `sdkmanager`
  invocations and the WHPX/AEHD instructions. The guide's own closing note under the
  Windows section says plainly that those steps were written from the code and vendor
  documentation, not executed on this platform, because this guide was authored on
  Linux.

### Where the plan's prose did not quite match the code as built

- **§4.1's "Creating one" row says "Settings → Virtual devices → Create."** The actual
  path, per plan 403 as built (`packages/studio/src/components/settings/farmSections.ts:54`
  and `page.tsx`), is **Settings → Farm → Virtual devices → Create** — "Virtual devices"
  is a section inside the "Farm" group, not a top-level Settings entry. The guide as
  written uses the corrected three-level path.
- **G5's goal-row prose ("documents both VM variables under Support overrides")** lists
  three variable names including `ENKAKU_ANDROID_SDK_PATH`, but §4.2 itself (and plan
  401's own §11) puts the two VM constants under "Support overrides" and the SDK path in
  the "toolchain" block instead — these are two different sections of `.env.example`.
  Followed §4.2 over the goal row's looser wording; the goal's own `rg` command does not
  care which section a match is in, so G5 still passes either way. Not a defect, just
  worth naming since the two sentences in the plan disagree slightly.
- **§6's acceptance criterion "No product code was changed: `git diff --name-only main
  -- packages apps plugins` → empty" cannot be literally true on this branch**, because
  plans 401–403 already committed real code under `packages/` before 404 started, and
  that diff is still against `main`, not against 403's own commit. This plan's own
  product-directory edit is exactly one file, `packages/core/README.md`, a documentation
  file. Recorded rather than silently reworded — see the acceptance-criteria checkbox
  above for the corrected framing.
- **avdmanager's `-d` flag** (device profile) is used by `provider-avd.ts:45` and
  documented in the guide's "Creating one" table exactly as plan 401 built it; this
  plan did not re-verify it against `avdmanager list device` output since no SDK is
  installed here — flagged above under "what could not be verified", not silently
  assumed correct.

### Consolidated owner-verification list — the whole 400 series, in one place

Every row across 401, 402, 403 marked `owner`, gathered here so the owner has a single
smoke-test list instead of three separate plan files to re-open. All four require a real
machine with the Android SDK installed; G11/G8(403) additionally require a browser and a
running scrcpy session.

1. **Plan 401 G10** — Create a real virtual device end to end and confirm it reaches
   `online` in Studio's Devices screen **without any `adb connect`** ever being called —
   the reconciler alone should pick it up. Machine: macOS with the SDK installed (or any
   platform; macOS was the plan's own target).
2. **Plan 401 G11** — With that device online, confirm display mirrors through scrcpy
   and that input reaches the device. Specifically check whether UHID input works on the
   emulator, or whether it falls back — this is the series' single largest unknown (plan
   400 R9/K1: no source found anywhere confirms `/dev/uhid` exists in an AVD). Whatever
   the answer, it should be recorded back into `docs/guide/virtual-devices.md`'s "What it
   is not" section, which currently states the question as open rather than answered
   either way.
3. **Plan 402 G9** — `curl` a create, then a start, against a running core with the SDK
   installed, and confirm the device shows up in `GET /api/devices` — the HTTP-level
   equivalent of 401's G10, exercised through `/api/vms` instead of the manager directly.
4. **Plan 403 G8** — In a real browser, with a real SDK: open Settings → Farm → Virtual
   devices, create one, watch it boot from the section's own polling UI, then open Device
   Control for it once it appears on the Devices screen. Plan 403's own handoff further
   suggests specifically checking: the dialog's SDK-missing error renders the exact
   `sdkmanager` command inside the `<pre>` block rather than a generic message; the
   delete confirmation's wording is accurate; and the section's 3-second poll does not
   visibly flicker or double-render while a VM is `starting`.

None of these four is blocked on anything left in this series — 401, 402, 403, and this
plan are all otherwise complete. They are gated purely on hardware (a real Android SDK
plus a real hypervisor) that this execution environment does not have.

### Open questions, unchanged by this plan

Q1 (auto-start on core boot), Q2 (whether a virtual device is excluded from ordinary job
scheduling), Q3 (default API level/variant — this series shipped API 36 / `google_apis`
as the dialog's default, per plan 403, but the owner has not formally ratified it as the
farm-wide default), plan 402 Q4 (whether VM mutations should be admin-only rather than
`device.enroll`), plan 403 Q5 (Settings vs. a fleet-menu row), and this plan's own new
**Q6** (whether `LICENSES.md` should eventually be translated to English to match
`CLAUDE.md`'s language rule — not decided here, per §3.3, and the new row this plan added
keeps the file's existing language rather than making the discrepancy worse). None of
these is described as decided anywhere in `docs/guide/virtual-devices.md`.
