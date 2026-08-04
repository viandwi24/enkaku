# Plan 50 — M24a : CI on every push, and a device smoke test

> Status: implemented — `.github/workflows/ci.yml` runs typecheck/test on every push plus a path-conditional Android build job, and `scripts/smoke-guest-agent.ts` (wired as `bun run smoke:guest-agent`) drives the 12-stage device smoke test.
> Ships: .github/workflows/ci.yml
> **Depends on:** nothing. This is a prerequisite for Plans 51 and 52, and should land before either.
> **Spec references:** §16 (NFR), `00-overview.md` §7 (Definition of Done).

---

## 0. Why this plan exists, in one paragraph

The proxy bring-up session found **six defects, and every single one of them only appeared on physical hardware**: a missing `INTERNET` permission, an ANR from blocking the main thread, token rotation invalidating live sessions, an activity launch mode that silently dropped every token after the first, an uninstall that undid itself, and a wire schema that rejected any frame carrying an error. The test suite was green throughout. It stayed green because nothing in it ever touched a device.

The same session also showed the second half of the problem: `bun run typecheck` and `bun test` are run by hand, if at all. `scripts/typecheck.sh` was written to drop into CI and never was. Twice during that session a package went red from another builder's in-flight work and nobody noticed until someone happened to run it.

Adding features on top of that is how a day gets repeated.

## 1. Goals

1. Every push and every pull request runs `bun run typecheck` and `bun test`, and a red result is visible without anyone asking.
2. A device smoke test exists, gated behind `ENKAKU_TEST_DEVICE=1`, that exercises the guest agent end to end against a real phone.
3. That smoke test would have caught **all six** of the defects listed in §0. Each one has a named assertion.
4. Running it is one command, and its output says which stage failed rather than just failing.
5. The Android app builds in CI, so a manifest or Gradle change cannot break the build unnoticed.

## 2. Non-goals

- **Running the device smoke test in CI.** GitHub runners have no phone. It stays a local/self-hosted-runner command; wiring a physical device into CI is a separate problem and probably a self-hosted runner later.
- Publishing or signing the APK — that is Plan 43 §5.11.
- Coverage targets, linting, or formatting. There is still no linter by choice; this plan does not add one.
- Rewriting existing tests.

## 3. Context and design decisions

### 3.1 Why the smoke test is device-side, not mocked

Every defect in §0 lived in the seam between the host and Android: a permission, a launch mode, a foreground-service rule, a token lifecycle, a JSON shape produced by Kotlin and parsed by Zod. Fakes on the host side cannot see any of it — the unit tests that exist are good and they all passed while the feature was completely broken.

So the smoke test drives a real device over adb, and asserts on what the device reports rather than on what the host believes.

### 3.2 Why it is gated, not skipped

`ENKAKU_TEST_DEVICE=1` already exists as the repo's convention (`00-overview.md` §4.4). Without it the suite must stay green with nothing plugged in — `bun test` is run constantly and must never require hardware.

### 3.3 What CI can and cannot catch

CI catches the class of failure that bit us twice in one session: a shared file left red by a parallel builder. It cannot catch anything in §0. Both halves of this plan are needed, and neither substitutes for the other — say so in the CI job's own description so nobody mistakes a green CI badge for a working agent.

## 4. Technical design

### 4.1 CI workflow

A new `.github/workflows/ci.yml`, separate from the existing release workflow:

- Triggers: `push` (all branches) and `pull_request`.
- Job `check` on `ubuntu-latest`: `oven-sh/setup-bun`, `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`.
- Job `android` on `ubuntu-latest`, conditional on `apps/guest-agent/**` or `scripts/build-guest-agent.sh` changing: JDK 17, Android SDK via `sdkmanager`, `git submodule update --init --recursive`, then `bash scripts/build-guest-agent.sh --debug`. It builds only; it does not sign or publish.
- Concurrency group per ref so a fast follow-up push cancels the previous run.

The Android job is conditional because it provisions several hundred megabytes of SDK and would otherwise dominate every unrelated push.

### 4.2 The smoke test

A single runner at `scripts/smoke-guest-agent.ts`, invoked as `bun run smoke:guest-agent -- --serial <S>`, driving one device through the whole lifecycle. It is a script rather than a `bun test` file because it needs ordered stages, a device, and readable per-stage output — and because a failure part-way must leave the device clean.

Stages, each printed with a pass/fail line:

| # | Stage | Asserts | Catches (§0) |
|---|---|---|---|
| 1 | install | `cmd package path` returns a path | |
| 2 | permissions | the merged manifest declares `INTERNET`; `dumpsys package` shows it granted | **missing INTERNET** |
| 3 | pre-grant | `appops get … ACTIVATE_VPN` reads `allow` | |
| 4 | bootstrap | control socket answers `hello` within the retry budget | |
| 5 | **token rotation** | bootstrap twice with different tokens; the **second** token works and the first is refused | **launchMode / onNewIntent** |
| 6 | responsiveness | no `ANR in dev.enkaku.guestagent` in logcat after a rapid route on/off/on cycle | **ANR** |
| 7 | route up | `route.start`, then the device reports `up: true` | |
| 8 | egress | traffic actually leaves through the proxy (Plan 51 supplies the probe; until then, assert `dumpsys connectivity` shows the VPN `VALIDATED`) | |
| 9 | error frame | force an error, then assert `route.status` carrying a `lastError` still parses against `@enkaku/protocol` | **lastError schema** |
| 10 | interleaving | a status poll during an active route does not invalidate it (`E_UNAUTHORISED` must not appear) | **token rotation** |
| 11 | uninstall | after uninstall the package is gone **and stays gone** for 30 s (nothing reinstalls it) | **self-undoing uninstall** |
| 12 | teardown | no `tun0`, no VPN in `dumpsys connectivity`, device has working internet | |

Stage 11's dwell is the point: the original bug was that reconcile put the package back seconds later, so an immediate check would have passed.

### 4.3 Output and failure behaviour

Each stage prints `✓`/`✗` with a one-line reason. On failure the script prints the relevant `adb logcat --pid=<agent>` tail — the single diagnostic that eventually found the `INTERNET` bug after hours of guessing — then runs teardown so the device is not left routed.

### 4.4 Credentials

The smoke test needs a working SOCKS5 upstream. It reads `ENKAKU_SMOKE_PROXY` (a `socks5://user:pass@host:port` URL) and **skips stages 7–10 with a clear message** when it is unset, rather than failing. Never commit a credential; the script must refuse to print the password anywhere, including in its failure output.

## 5. Implementation steps

**5.1 CI workflow.** `.github/workflows/ci.yml` per §4.1, `check` job only. → a deliberately broken type shows red on a PR.

**5.2 Android CI job.** The conditional job per §4.1. → touching `apps/guest-agent/**` triggers it; touching `packages/core` does not.

**5.3 Smoke runner skeleton.** `scripts/smoke-guest-agent.ts` with the stage harness, `--serial`, per-stage reporting, guaranteed teardown, and the logcat dump on failure. Stages 1, 4, 12 only. → passes on a real device.

**5.4 The regression stages.** 2, 5, 6, 9, 10, 11 — each one written against the specific defect it exists for, with a comment naming that defect. → temporarily reverting any one fix makes exactly one stage fail.

**5.5 Route stages.** 3, 7, 8 with `ENKAKU_SMOKE_PROXY`, and the skip path when it is unset.

**5.6 Wire it up.** A root `smoke:guest-agent` script; document it in `README.md` under Commands and in `apps/guest-agent/README.md`.

**5.7 Docs.** Update `CLAUDE.md`: CI now runs on push (it currently says release-only, which will be out of date the moment 5.1 lands).

## 6. Acceptance criteria

1. A PR with a type error is red before review.
2. A PR touching only `packages/core` does not run the Android job; one touching `apps/guest-agent/**` does.
3. `bun test` with no device attached is green and does not require `ENKAKU_SMOKE_PROXY`.
4. `bun run smoke:guest-agent -- --serial <S>` passes against a real phone.
5. **Reverting any one of the six §0 fixes makes exactly one named stage fail**, and the failure message identifies it.
6. A failed run prints the agent's logcat tail and leaves the device with no route and working internet.
7. No credential appears in any output, including failures.

## 7. Test plan

The smoke test is itself the test. Validate it by reverting each of the six fixes in turn on a scratch branch and confirming criterion 5 — that is the only way to know the assertions are real and not decorative.

For CI: open a throwaway PR with a deliberate type error, confirm red; fix, confirm green.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Smoke test becomes flaky and gets ignored | Every wait is a poll with a deadline, never a fixed sleep — the fixed-sleep-after-bootstrap assumption already produced one spurious failure |
| It leaves a device routed after a crash | Teardown runs in a `finally`; stage 12 asserts the clean state |
| CI slows every push | Android job is path-conditional; concurrency cancels superseded runs |
| A credential leaks into CI logs | The proxy is env-only, never a file; the script never prints it |
| Green CI mistaken for a working agent | The job description says explicitly what it does not cover |

## 9. Open questions

1. Is a self-hosted runner with a phone attached worth it later, so stages 1–12 run on every push? It would have caught everything in §0 automatically, but it is real infrastructure to own.
2. Should the smoke test run across a matrix of Android versions? Three of the six defects were version-sensitive behaviours (`@hide` app op, FGS types, stopped state), and the research explicitly recommends pinning them per release.
