# Release checklist

The document a release-cutter follows before tagging `v*`. It exists because a
green CI badge and an honest release are not the same claim — plan 87 (M52)
found three plan status lines in a row that drifted from the code underneath
them, and plan 85 (M50) shipped a Windows-scale fix whose own hardware ladder
has still never been run. This checklist is where those two facts live where
someone about to cut a tag will actually see them, instead of only inside a
plan document nobody re-reads at cut time.

**Do not tag an MVP release with any unchecked item in §3.** A checked box
here means "verified this cycle," not "was true once."

## 1. What CI already proves — do not re-run these by hand

`.github/workflows/ci.yml`'s `check` job (every push and PR, `ubuntu-latest`):

- `bun run typecheck` — every package.
- `bun test` — every package except `packages/studio` (see CLAUDE.md's
  Commands section for why that split exists; a bare `bun test` does **not**
  cover Studio).
- `bun run --cwd packages/studio test` — Studio's own component/page tests.
- `bun run --cwd plugins/networking test`, `bun run --cwd plugins/tiktok-automation-pack test`,
  `bun run --cwd examples test` — the packs embedded in the release binary.
- `bash scripts/check-plan-status.sh` — every plan's declared status agrees
  with the code (see §2 below for what this does not catch).
- `bash scripts/check-harness-provenance.sh` — `packages/harness` has not
  drifted from the upstream copy it must stay diffable against.
- `bun run spec:check` — warns (does not fail) on a table, route, or screen
  missing from `docs/spec.md`; see `FAIL_ON_GAP` in `scripts/spec-check.ts`.

`.github/workflows/release.yml` (tag push or manual dispatch):

- Builds `linux-x64`, `linux-arm64`, `windows-x64` (on `ubuntu-latest`) and
  `darwin-arm64`, `darwin-x64` (on `macos-latest`, code-signed ad-hoc).
- The `smoke` job boots the actual built binary on `ubuntu-latest`,
  `macos-latest`, and `windows-latest`, polls `/api/health` until
  `adb.state` reaches a terminal value (`ready`/`orchestrator`/`error`, not
  just a `200`), and confirms Studio's HTML is served.
- `publish` only runs if `smoke` passes, and only on a `v*` tag.

That is real, useful coverage. It is also the full extent of what this
project's automation proves — everything below it does not prove.

## 2. What a green CI does NOT prove

- **No hardware verification has ever run for this project.** Every
  device-dependent test is gated behind `ENKAKU_TEST_DEVICE=1` specifically
  because CI runners have no phone attached (CLAUDE.md, plan 50 §0/§3.3) — a
  green `check` run says the workspace typechecks and its fakes pass, and
  nothing about whether a real device behaves the way those fakes assume.
- **`check-windows` has never executed even once.** It only runs on a push
  to `main` or a PR carrying the `windows` label — neither condition is a tag
  push, so a release can go out having never once run the test suite on
  Windows in this cycle. Confirm the Actions tab shows a recent green
  `check-windows` run before relying on "CI passed" as Windows proof.
- **The Plan 85 (M50) §7.3 Windows fleet ladder — 5, then 10, then 20 real
  devices, on the actual release binary — has never been run at all.** It is
  a named release gate for this MVP (plan 85 §7.3, plan 87 acceptance
  criterion 5), and its table is still entirely blank. `release.yml`'s
  `smoke` job boots one device-less binary per OS; it says nothing about
  what happens with a real multi-device farm plugged into Windows, which is
  the exact scenario plan 85 exists to fix.
- **`debug.enkaku.instrumented` (the device-under-automation marker) has
  never been checked against a real phone.** `packages/session/src/farm-tag.ts`'s
  own header comment says so directly: it was written from Android's
  documented SELinux `property_contexts` behavior, not from having run
  `adb shell setprop debug.enkaku.instrumented 1` on hardware. Verify it
  once with the two-line command that same comment gives before trusting the
  disclosure mechanism in a release.
- **The guest agent smoke test does not run in CI.** `bun run smoke:guest-agent`
  drives the on-device APK through its real lifecycle and is gated behind
  `ENKAKU_TEST_DEVICE=1` for the same no-phones-in-CI reason as above — it
  has to be run by hand, against a real phone, this cycle.
- **`bun run spec:check` is warning-only.** `FAIL_ON_GAP` in
  `scripts/spec-check.ts` is `false` — a table, route, or screen missing from
  `docs/spec.md` is reported, not blocked. Read its output; it will not stop
  the release for you.
- **macOS binaries are ad-hoc signed, not notarized.** A browser download
  will be flagged "damaged" by Gatekeeper until the user manually clears the
  quarantine flag (the release notes template already says this — confirm it
  is still accurate for the OS versions in use).
- **Windows binaries are unsigned.** SmartScreen will warn on first run.
  Expected, not a regression — but worth remembering before assuming a
  support report about it is a new bug.

## 3. Manual checklist — run this cycle, before tagging

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run --cwd packages/studio test` (a bare `bun test` from the root
      never runs this — see CLAUDE.md)
- [ ] `bash scripts/check-plan-status.sh` passes, and every plan touched
      this cycle has an honest, current `> Status:` / `> Ships:` header —
      not just a passing exit code. Check its own report for plans with no
      `Ships:` line at all (`undeclared` in its output): each one needs
      either a real artefact or an explicit `Ships: none — ...` reason, not
      silence.
- [ ] `bash scripts/check-harness-provenance.sh`
- [ ] `bun run spec:check` — read the gap count, do not just confirm exit 0
- [ ] Confirm `check-windows` ran (green) on the commit being tagged — push
      to `main` triggers it automatically; if the tag is cut from a branch
      that never reached `main`, trigger it manually (the `windows` PR
      label, or a dry run on `main` first)
- [ ] Windows fleet ladder (plan 85 §7.3): at minimum the 5-device rung run
      once against the actual release binary before an MVP tag, with the
      table filled in and committed (not left blank). The 10- and 20-device
      rungs follow plan 85 §7.3's own escalation rule — do not advance a
      rung until the previous one is green.
- [ ] `debug.enkaku.instrumented` verified on one real device:
      `adb shell setprop debug.enkaku.instrumented 1` then
      `adb shell getprop debug.enkaku.instrumented` reports `1`
- [ ] `ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent -- --serial <SERIAL>`
      passes against a real phone
- [ ] `enkaku backup` exercised end to end at least once this cycle: back up
      a live `enkaku.db`, restore it per `docs/guide/install.md`'s Backup
      and restore section, confirm the core boots against the restored copy
- [ ] `enkaku doctor` runs clean (or every `warn`/`fail` is understood and
      accepted) against a real dev environment, not just the fake-context
      unit tests
- [ ] Any Studio surface that a permission change this cycle now returns
      `403` on (e.g. the 87.4 ACL sweep's job-cancel/device-ownership gate)
      is actually hidden or disabled for the roles that lose access, not
      left visible and broken

## 4. Tagging and publishing

1. Push the `v*` tag. `release.yml` runs `build-nix`, `build-darwin`, then
   `smoke` across all three OS matrices, then `publish` — in that order,
   and `publish` only runs if `smoke` is green.
2. Watch the Actions run to completion rather than assuming it will pass
   because it did last time — `smoke` polls `adb.state` to a terminal value
   specifically because a naive `/api/health` `200` check would pass before
   first-run tool provisioning even started (see the workflow's own
   comments).
3. Once published, download at least one artifact by hand (not just trust
   `SHA256SUMS.txt` matched in CI) and boot it locally.
4. File or update the tracking issue for every unchecked §3 item that
   shipped anyway — an MVP release with a known gap is a legitimate call for
   the owner to make, but it has to be a recorded call, not a silent one.

## 5. Known open release gates (update as they close)

This section is a living list, not a permanent one — delete a line once its
gate is actually closed, do not just leave it checked from memory.

- Plan 85 §7.3 Windows fleet ladder (5/10/20 devices): **not started.**
- `debug.enkaku.instrumented`: **never verified against real hardware.**
- `check-windows`: has run, but only ever on `main`/`windows`-labeled PRs —
  confirm it covered the specific commit being tagged each time.
