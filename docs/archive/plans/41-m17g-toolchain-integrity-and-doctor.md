# Plan 41 — M17g : On-device Artifact Verification and `enkaku doctor`

> Status: implemented — verified by the presence of the artefact below
> Ships: packages/drivers/src/inspector/ui-server/verify.ts
> Depends on: Plan 02 (the Toolchain Manager and its sha256 verification) and Plan 22.1 (coded adb errors, which give `doctor` something precise to report).
> Spec references: §7.2 (app data paths), §7.6 (version-locked scrcpy), §7.7 (tool endpoints), §10.4 (adb), §16 (NFR).

---

## 1. Goals

- The APKs the farm installs on devices are verified to be **the ones we shipped**, not merely packages with the right name.
- A mismatch is detected, reported, and repaired by reinstalling — automatically, once, with the reason recorded.
- `enkaku doctor` gives a first-run or a broken install a single command that says what is wrong and what to do about it.
- `doctor` runs without a running core, and also against a running one, because the two failure modes are different.
- Every check has a specific, actionable remedy in its output. A diagnostic that says "adb: FAIL" and nothing else is worse than none.

## 2. Non-goals

- Signing our own APKs, or a trust chain beyond the sha256 the toolchain manifest already carries.
- Verifying the *user's* APKs uploaded through Plan 39. That is their build; we record who uploaded it and stop there.
- A repair mode that rewrites configuration. `doctor` diagnoses and, at most, offers a command to run; it does not mutate the user's install.
- Replacing the Tools UI. `doctor` is the terminal-side complement to it.

## 3. Context and design decisions

### 3.1 The download is verified; the installed artifact is not

`packages/toolchain/src/download.ts:105-111` hashes every download in a single streaming pass and refuses on mismatch. That part is sound.

What is not checked is what ends up **on the device**. `packages/drivers/src/inspector/ui-server/launcher.ts:35` decides the ui-server is present with:

```ts
const out = await deps.exec(`pm list packages ${UI_SERVER_PACKAGE}`)
```

A package name. Any APK claiming `com.github.uiautomator` satisfies it — a different version, a stale build from a previous farm, or something installed deliberately. The launcher then instruments it and trusts what comes back over port 9008, which is the inspector feeding every `find` and `waitFor` a script performs.

This is not hypothetical drift: the devices in this farm already had a v2.3.3 APK installed by something other than the current toolchain run.

### 3.2 Verify by version and signature, not by re-hashing

Re-downloading the APK from the device to hash it costs a pull of several megabytes on every session start. Two cheaper checks together are sufficient:

- `dumpsys package <pkg> | grep versionCode` — catches a stale or newer build.
- `pm list packages -f <pkg>` then `apksigner`-free signature read via `dumpsys package <pkg> | grep -A1 signatures` — catches a *different* APK that happens to share the name and version.

The toolchain manifest gains the expected `versionCode` and the signing certificate digest for each device-side artifact, populated when the artifact is added. Both are cheap shell reads under the `probe` profile.

Where the manifest has no expectation recorded (an older manifest), the check **skips with a logged notice** rather than failing — refusing to start an inspector because our own metadata is incomplete would be a worse failure than the one being prevented.

### 3.3 Repair once, then stop

On a mismatch: `pm uninstall`, reinstall from the toolchain's verified copy, re-verify. If it still mismatches, fall back to `uiautomator dump`, record `device.artifact.mismatch` on the Plan 18 main stream, and do not loop.

Looping on a device where a system policy reinstalls a conflicting package would burn the farm's time forever. One attempt, then a visible degradation.

### 3.4 `doctor` must run when nothing works

The failure that most needs a diagnostic is the one where the core will not start — a bad config, a busy port, a missing data directory, no adb. So `doctor` cannot be an API endpoint.

It is a subcommand of the same binary, and it must run **without** a core. `packages/core/src/index.ts:10` currently dispatches only on `--job-child`; there is no subcommand layer at all. This plan adds a minimal one — `enkaku doctor`, `enkaku --version`, and the existing job-child dispatch — deliberately small, because a CLI framework is not the point.

When a core *is* running, `doctor` additionally queries it (devices, adb stats, tool status) and reports live state. Both modes are useful and they report different things, so the output says which mode it ran in.

### 3.5 Every check states its remedy

The output format is fixed: check name, status, what was observed, and — when not OK — exactly what to do. A diagnostic that only reports status transfers the problem back to the user; a diagnostic that names the command transfers the solution.

## 4. Technical design

### 4.1 Manifest additions — `packages/toolchain`

Each device-side artifact gains optional expectations:

```ts
deviceArtifact?: {
  packageName: string
  versionCode: number
  /** Hex SHA-256 of the signing certificate, uppercase, colon-free. */
  signatureSha256?: string
}
```

Optional so an older manifest still loads (§3.2).

### 4.2 Verifier — `packages/drivers/src/inspector/ui-server/verify.ts` (new)

```ts
export type VerifyResult =
  | { ok: true; versionCode: number }
  | { ok: false; reason: 'not_installed' | 'version_mismatch' | 'signature_mismatch' | 'unreadable'
      observed?: { versionCode?: number; signature?: string } }

export function verifyDeviceArtifact(
  exec: (cmd: string, opts?: TransportExecOptions) => Promise<string>,
  expected: { packageName: string; versionCode?: number; signatureSha256?: string },
): Promise<VerifyResult>
```

`launcher.ts`'s `isInstalled()` is replaced by this. `ensureInstalled()` becomes: verify → if `ok` return; if `not_installed` install; otherwise uninstall, install, re-verify once (§3.3).

### 4.3 `doctor` — `packages/core/src/doctor/` (new)

```ts
export interface Check {
  id: string
  title: string
  run(ctx: DoctorContext): Promise<CheckResult>
}
export interface CheckResult {
  status: 'ok' | 'warn' | 'fail' | 'skip'
  observed: string
  /** Required whenever status is warn or fail (§3.5). */
  remedy?: string
}
```

Checks, in order:

| id | What it checks | Example remedy |
|---|---|---|
| `runtime` | Bun version, platform, architecture | "Bun 1.2+ is required; you have 1.1.4 — upgrade with `bun upgrade`" |
| `data-dir` | exists, writable, free space | "`~/Library/Application Support/Enkaku` is not writable — `chmod u+w …`" |
| `config` | parses; reports the effective bind, mode, and TLS state | "`ENKAKU_BIND=0.0.0.0` implies server mode, which requires TLS — set `ENKAKU_TLS_CERT` or `ENKAKU_ALLOW_INSECURE=1`" |
| `port` | the configured port is free (or held by our own core) | "Port 7700 is held by pid 1234 (`node`) — stop it or set `ENKAKU_PORT`" |
| `db` | opens, integrity-checks, reports schema version and pending migrations | "`enkaku.db` failed `PRAGMA integrity_check` — restore from a backup" |
| `tools` | each required tool provisioned, version, sha256 matches the manifest | "adb is not provisioned — it downloads on first run; check network or proxy" |
| `adb-server` | reachable on 5037; reports its version; **never** kills it | "No adb server — it starts automatically; if Android Studio owns 5037 that is fine" |
| `devices` | lists devices adb sees, flags `unauthorized` and `offline` | "ZP2222T7K5 is `unauthorized` — accept the RSA prompt on the device" |
| `egress` | can reach the toolchain host | "Download host unreachable — set `HTTPS_PROXY` if you are behind a corporate proxy" |
| `core` | (only when running) `/api/health`, `/api/adb/stats`, quarantined devices | "2 devices are quarantined: `adb:unreachable` — check cables" |

Output is human-readable by default and `--json` for scripting. Exit code is 0 when nothing failed, 1 when any check failed; warnings do not fail the exit code.

### 4.4 CLI dispatch — `packages/core/src/index.ts`

```ts
const [, , cmd] = process.argv
if (process.argv.includes('--job-child')) { /* unchanged */ }
else if (cmd === 'doctor') await runDoctor({ json: process.argv.includes('--json') })
else if (cmd === '--version' || cmd === '-v') console.log(VERSION)
else await startDaemon()
```

`entry-release.gen.ts` (the compiled entrypoint) gets the same dispatch so the shipped binary behaves identically — a `doctor` that only works from source would miss its whole audience.

### 4.5 Studio

The Tools page gains a "Run diagnostics" action that renders the same checks (core-running mode) using the `--json` shape, so the browser and the terminal never disagree about what is wrong.

## 5. Implementation steps

**41.1 — Manifest expectations.** Add `deviceArtifact` to the toolchain manifest types and populate it for the ui-server APKs.

**41.2 — Verifier.** `verify.ts` with tests against captured `dumpsys package` output (installed/correct, wrong version, wrong signature, absent, unreadable).

**41.3 — Launcher integration.** Replace the name-only check; the one-shot repair; the `device.artifact.mismatch` event; the fallback path unchanged.

**41.4 — Doctor core.** The check registry, the result shape, the renderer (human and `--json`), exit codes.

**41.5 — Checks.** Implement the ten checks in §4.3, each unit-tested against injected fakes — no check may require real hardware to be tested.

**41.6 — CLI dispatch.** `index.ts` and `entry-release.gen.ts`; `bun run doctor` script; a section in `docs/guide/install.md`.

**41.7 — Studio.** The Tools-page diagnostics view.

## 6. Acceptance criteria

1. An installed ui-server whose `versionCode` differs from the manifest is detected, reinstalled once, and verified.
2. A package with the right name but a different signing certificate is detected as `signature_mismatch` and reinstalled.
3. A repair that fails a second time falls back to `uiautomator dump`, records `device.artifact.mismatch`, and does not loop.
4. A manifest without expectations skips the check with a notice — it never blocks the inspector.
5. `enkaku doctor` runs with no core running and reports runtime, data dir, config, port, db, tools, adb, devices, and egress.
6. `enkaku doctor` with a core running additionally reports live device and quarantine state.
7. Every `warn` or `fail` result carries a remedy string; a unit test asserts this for every registered check.
8. `--json` emits the same results as the human output, and Studio renders that shape.
9. Exit code is 1 when any check fails, 0 otherwise; warnings do not fail it.
10. `doctor` never runs `adb kill-server` (repo rule), and a test asserts the string appears nowhere in the doctor package.
11. The compiled binary supports `doctor` and `--version`, not only the source entrypoint.
12. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `verify.test.ts` (fixtures for each `dumpsys` shape); `doctor/checks.test.ts` (each check against injected fakes: unwritable dir, occupied port, corrupt db, missing tool, unreachable adb, unauthorized device); `doctor/render.test.ts` (remedy present for every non-ok result, `--json` parity, exit codes).

**Manual smoke:**
```bash
bun run doctor                      # with no core running
bun run dev & bun run doctor        # with one running — extra live checks
# break something on purpose:
ENKAKU_PORT=7700 bun run doctor     # while the core holds it → port check fails with the pid
# ui-server verification (ENKAKU_TEST_DEVICE=1):
adb -s <serial> install -r <an-older-uiautomator.apk>
# start a session that needs the inspector → mismatch detected, reinstalled, verified
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Signature reading differs across Android versions and produces false mismatches, causing needless reinstalls. | The signature check is optional per artifact and skipped when the manifest has no expectation; an `unreadable` result is treated as skip, not fail; repair happens at most once. |
| Reinstalling the ui-server mid-session interrupts a running job. | Verification happens in `ensureInstalled()`, which already runs before the instrumentation starts, not during a session. A repair triggered while a job holds the device is deferred to the next start. |
| `doctor` reports secrets (tokens, TLS paths) in its output. | It reports presence and shape, never values: "TLS cert configured" rather than the path's contents, and no env var values are echoed. |
| The port check kills or interferes with another process. | It only *reads* — `lsof`-equivalent via Bun, no signals sent. The remedy names the pid and lets the user decide. |
| A CLI layer grows into a framework nobody wanted. | Three commands, one `if/else` chain, explicitly bounded in §3.4. |

## 9. Open questions

1. Should `doctor` offer `--fix` for the safe subset (create the data dir, re-provision a tool)? Attractive, and it crosses from diagnosing into mutating — deferred deliberately.
2. Should artifact verification extend to the scrcpy server jar pushed to the device (`/data/local/tmp/scrcpy-server.jar`)? It is re-pushed every session, so drift is less likely, but the same reasoning applies.
3. Should a mismatch quarantine the device rather than degrade the inspector? Currently it degrades, on the grounds that a working slow path beats an unavailable device.
