# Plan 404 — VM : The operator guide, the licence row, and the rule that must not be re-broken

> Status: draft
> Ships: docs/guide/virtual-devices.md
> Depends on: plans 401, 402, 403 (the feature this documents must exist)
> Spec references: §7 (toolchain), §7.8 (redistribution), §18

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | An operator guide exists covering all three operating systems | sections for macOS, Linux and Windows, each with its accelerator and its install command | `test -f docs/guide/virtual-devices.md` and `rg -c "^## " docs/guide/virtual-devices.md` → ≥ 6 | [ ] |
| G2 | The guide states the AEHD sunset date and prefers WHPX | the literal string `2026-12-31` appears in the Windows section | `rg -n "2026-12-31" docs/guide/virtual-devices.md` → ≥ 1 match | [ ] |
| G3 | The guide repeats the detection warning rather than softening it | the emulator's limits (no real sensors, non-hardware IMEI/serial, readable emulator properties, non-driver touches) are stated | `rg -n "sensor" docs/guide/virtual-devices.md` → ≥ 1 match | [ ] |
| G4 | `LICENSES.md` records the Android Emulator and system images as **not redistributed** | one new table row plus a short section | `rg -n "system image\|system-images" LICENSES.md` → ≥ 1 match | [ ] |
| G5 | `.env.example` documents both VM variables under Support overrides | `ENKAKU_VM_MAX_CONCURRENT`, `ENKAKU_VM_BOOT_TIMEOUT_SEC`, `ENKAKU_ANDROID_SDK_PATH` | `rg -n "ENKAKU_ANDROID_SDK_PATH\|ENKAKU_VM_" .env.example` → 3 matches | [ ] |
| G6 | `CLAUDE.md` carries the discovery rule so it is not re-broken | the rule that the core never `adb connect`s an emulator | `rg -n "emulator" CLAUDE.md` → ≥ 1 match in the rules section | [ ] |
| G7 | `docs/guide/redroid.md` cross-references the new guide and stays accurate | a link, and no claim that redroid works on macOS or Windows | `rg -n "virtual-devices" docs/guide/redroid.md` → 1 match | [ ] |
| G8 | `packages/core/README.md` documents the subsystem | one section, in the file's existing style, naming the plan | `rg -n "Virtual devices" packages/core/README.md` → 1 match | [ ] |

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

- [ ] G1–G8 pass by their own commands.
- [ ] `bash scripts/check-plan-status.sh` passes.
- [ ] Every command in the guide was either run by the executor or explicitly marked as
      unverified on this platform.
- [ ] `docs/guide/redroid.md`'s warning paragraph is unchanged.
- [ ] No product code was changed: `git diff --name-only main -- packages apps plugins` → empty.

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

_To be written by the executing agent, in plan 200 §3.2's format and order._
