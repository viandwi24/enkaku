# Plan 26 — M12e : The Interactive Device Terminal

> Status: implemented — device.shell permission, shell.mode switch, lease-gated shell.exec handler with audit and cwd emulation shipped (exit-code mechanism since upgraded by Plan 53's framed shell,v2,raw transport)
> Ships: packages/core/src/server/ws-handlers.ts
> Depends on: **Plan 24** (the lane and the WS protocol), **Plan 25** (`ShellPort`, so cloud works from day one). Plan 23 supplies the settings pattern.
> Spec references: §10.1 (server-authoritative control), §10.2 (leases), §11.3 (crash containment, **not** a sandbox), §13 (protocol), Plan 09 (ACL), Plan 18 (the device event log).

---

## 1. Goals

- A terminal on the device page that runs arbitrary `adb shell` commands and shows the output, with an exit code.
- Every command is gated by the **same** server-authoritative lease rule as input — including refusal while a job is running — and by a dedicated permission.
- Every command and its outcome lands in the device event log, with no way to run one silently.
- Output is bounded, commands are deadlined, and a long-running command is streamed rather than buffered.
- All viewers of a device see the terminal transcript; only the lease holder can type.
- Works identically on local and cloud devices, with no branching in Studio.
- The feature is **off by default** on a server-mode install and must be switched on deliberately.

## 2. Non-goals

- A real pty / interactive stdin (adb shell protocol v2). Recorded in §9; v1 one-shot covers the intended use.
- Lending a full adb endpoint to the user's own machine — Plans 27 and 28.
- Blocking "dangerous" commands by parsing them. Explicitly rejected in §3.4.
- File upload/download, `install`, `push`/`pull`. Those need the adb endpoint, not a shell.

## 3. Context and design decisions

### 3.1 Reuse the lease rule; do not invent a second one

`checkInputAllowed` (`packages/core/src/lease/lease-manager.ts:140-160`) already encodes exactly the policy this feature needs:

| Device status | Result |
|---|---|
| `busy` (a job is running) | refused — "Device is running an automation job" |
| `offline` / `quarantined` | refused — unavailable |
| `idle` | refused — "take control (lease.acquire) before sending input" |
| `manual`, held by someone else | refused — "another client is controlling this device" |
| `manual`, held by this client | allowed |

That answers the "must we make sure no job is running?" question without new machinery: **yes, and it is already enforced**. The scheduler will not pick a device whose status is `manual`, so a job cannot start underneath an open terminal either.

Every command also calls `touchManual` (as `ws-handlers.ts:332` does for input), so a lease does not idle out while someone is thinking between commands.

### 3.2 A permission and a farm switch, because this is remote code execution

A shell on a device is a genuine remote-execution surface, so two gates sit in front of it:

- A new ACL permission `device.shell` in `packages/core/src/auth/acl.ts`, admin-only by default.
- A farm setting `shell.mode: 'off' | 'admin' | 'operator'`, defaulting to `admin` on a loopback install and **`off`** in server mode (the derived-auth-mode rule: a non-loopback bind means server mode).

The default asymmetry is deliberate. A laptop install is a single-user tool; an exposed install is not, and a feature this powerful should be a decision rather than a discovery.

### 3.3 Every command is audited, with no exception path

`deps.recorder.record(...)` (Plan 18) is already on the input path and is buffered, never blocking (`ws-handlers.ts:333-337`). Terminal commands record to the `input` stream as `shell.exec`, with the command, exit code, byte count, and truncation flag.

Recording happens **after** the lease check passes and **before** the device is awaited — the same ordering as input, so a refused command is never logged as if it ran, and a command that hangs is still on the record.

Redaction: Plan 18 already has redaction rules for the input stream, since typed text can contain passwords. Command lines have the same problem (`... --password hunter2`), so the same redaction pass applies, and the plan adds patterns for common credential-bearing flags.

### 3.4 No command allowlist, and saying so plainly

An allowlist or denylist over command strings does not survive `sh -c '…'`, backticks, `eval`, base64, or a shell alias. Implementing one would create a false impression of a security control while providing none.

The honest position, consistent with spec §11.3's refusal to call crash containment a sandbox: **either a user may run shell commands on a device, or they may not.** The gates are identity, permission, lease, and audit.

There is one concession, and it is a usability feature rather than a control: commands matching a small set of high-consequence patterns (`reboot`, `svc power`, `settings put global adb_enabled`, `stop`/`start`, `rm -rf /`) raise a **confirmation dialog in Studio**, which the server neither enforces nor relies on. The code comment must say so, so nobody later mistakes it for protection.

### 3.5 Exit codes, which shell v1 does not provide

The adb `shell:` service returns output and closes; there is no exit status in the protocol. The standard workaround is to ask for it explicitly:

```
shell:<cmd> ; printf '\n__ENKAKU_EXIT__%d' $?
```

The core strips the trailing marker and reports the code. If the marker is absent — the command killed the shell, or output was truncated at the cap — the exit code is reported as `null` rather than guessed.

> **Superseded by Plan 53 (2026-08-04).** This marker workaround has been replaced by the framed `shell,v2,raw` adb service, which reports stdout, stderr, and the exit code as three separate fields off the wire — no command rewriting involved. `exit-marker.ts`/`withExitMarker`/`parseExitMarker` no longer exist. `ws-handlers.ts`'s `shell.exec` handler now reads `exitCode` directly off `ShellPort.exec`'s result, and `ShellResultMessage` carries `stdout` and `stderr` as separate fields all the way to the terminal, which renders stderr as its own stream (§3.7's cwd emulation is unaffected — a successful `cd` still consumes `stdout` into the cwd and prints nothing). The `null`-when-unknown contract described above is unchanged in spirit — it now also covers a device/adb build old enough to lack `shell,v2,raw` entirely, which falls back to the pre-Plan-53 merged-output behaviour with `exitCode: null`. See `docs/plans/53-m25-framed-shell-transport.md`.

### 3.6 One-shot or stream, chosen by the core, not the user

A user typing `logcat` should not hang the terminal. The core decides:

- Send the command as a one-shot with the `default` profile (15 s).
- If it hits its deadline **and** produced output along the way, it is a streaming-shaped command: the failure is reported with a hint offering to re-run it as a stream on the Plan 24 lane.

Deliberately not automatic. Silently converting a command into a background stream is surprising, and the hint costs one click.

### 3.7 The working directory is emulated, and that is visible

Each `shell:` invocation is a fresh shell, so `cd` cannot persist. The terminal keeps a per-session `cwd` and prefixes commands with `cd <quoted> && `. When `cd` is the whole command, the core verifies the target exists before storing it.

The prompt shows the emulated cwd, and the help text says it is emulated — an emulation that pretends to be real is worse than one that is honest, because the first surprising difference then looks like a bug.

### 3.8 Everyone watches, one person types

The transcript (command, output, exit code, who ran it) is broadcast to every WS subscriber of that device, exactly like the Plan 24 monitor fan-out. Only the lease holder can submit.

This is a farm operated by a team: seeing that a colleague just ran `pm clear` explains the device's behaviour far better than discovering it later in an audit log. The submitter's identity is shown on every line.

## 4. Technical design

### 4.1 ACL and settings

`packages/core/src/auth/acl.ts` — add `device.shell` to the permission union; `OPERATOR` includes it only when `shell.mode === 'operator'`, so the check is `can(role, 'device.shell') && shellModeAllows(role)`.

`packages/protocol/src/settings.ts` — a new `shell` block, following the `.describe().meta()` pattern:

```ts
shell: z.object({
  mode: z.enum(['off', 'admin', 'operator']).default('admin')
    .describe('Who may run shell commands on a device. Off disables the terminal entirely.')
    .meta({ title: 'Device terminal access' }),
  execTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000)
    .describe('Budget for a single terminal command.').meta({ title: 'Terminal command timeout (ms)' }),
  maxOutputBytes: z.number().int().min(4_096).max(4_194_304).default(262_144)
    .describe('Output kept per command before truncation.').meta({ title: 'Max output per command (bytes)' }),
}).default({}),
```

The server-mode default of `off` is applied at config load, where the auth mode is already derived from the bind address — not in the Zod default, which cannot see the bind address.

### 4.2 Protocol — `packages/protocol/src/messages/shell.ts` (extending Plan 24's file)

```ts
// client → server
{ type: 'shell.exec', payload: { deviceId, cmd: z.string().min(1).max(4096), cwd?: string } }

// server → client (broadcast to every subscriber of the device)
{ type: 'shell.echo',   payload: { deviceId, cmd, cwd, actor, at } }
{ type: 'shell.result', payload: { deviceId, stdout, exitCode: number | null,
                                   truncated: boolean, durationMs, cwd,
                                   hint?: 'stream_suggested' } }
```

`shell.echo` is emitted the moment the command is accepted, so observers see what is running before it finishes.

### 4.3 Handler — `packages/core/src/server/ws-handlers.ts`

```
case 'shell.exec':
  1. can(user.role, 'device.shell') && shellModeAllows  → else auth.forbidden
  2. deps.leases.checkInputAllowed(deviceId, clientId)  → else the existing coded error
  3. resolve the ShellPort (Plan 25 §4.3) — local or remote
  4. deps.leases.touchManual(deviceId, clientId)
  5. deps.recorder.record({ stream: 'input', kind: 'shell.exec', actor,
                            meta: { cmd: redact(cmd), cwd } })
  6. broadcast shell.echo to the device's subscribers
  7. port.exec(withCwd(cwd, cmd) + exitMarker, { timeoutMs, maxOutputBytes })
  8. broadcast shell.result (stdout, exitCode, truncated, durationMs)
  9. record the outcome: kind 'shell.result', meta { exitCode, bytes, truncated }
```

Steps 1–2 are server-authoritative per spec §10.1 — Studio disabling the input box is a convenience, never the control.

### 4.4 cwd handling — `packages/core/src/device/shell-session.ts` (new)

Per (deviceId, clientId): the current `cwd` (default `/`), and a bounded history for reconnects.

- `cd <path>` alone → `cd <quoted> && pwd`; on success store the printed path, on failure report the error and leave `cwd` unchanged.
- Any other command → prefixed with `cd <quoted> && `.
- The state is dropped when the lease is released — a new controller starts at `/`.

### 4.5 Studio — the Terminal tab

`packages/studio/src/components/terminal/` beside the Plan 24 monitor pane.

- A transcript pane (command, actor, output, exit code, duration) plus a single-line input with history (↑/↓, kept in component state) and a `cwd` prompt.
- When the viewer is not the lease holder: the input is replaced by "Take control to run commands", and the transcript keeps updating (§3.8).
- Non-zero exit codes are rendered with `text-danger`; truncation shows an explicit "output truncated at N KB" line. Design tokens only, never bracket syntax (`docs/design.md`).
- A confirmation dialog for the §3.4 pattern list, with a comment stating it is a usability guard and not a control.
- The `stream_suggested` hint renders a "Run as a stream" button that starts a Plan 24 stream with the same command.
- No `xterm.js`. Without a pty there is nothing to emulate — no cursor addressing, no colours, no resize — and adding a terminal emulator to a static export would cost bundle size for behaviour that does not exist. A line-oriented pane matches what the transport can actually deliver.

## 5. Implementation steps

**26.1 — Permission and settings**
- Add `device.shell` to the ACL; add the `shell` settings block; apply the server-mode `off` default at config load (§4.1).
- Result: with `mode: 'off'`, `shell.exec` is refused and the Studio tab is hidden.

**26.2 — Protocol**
- Extend `packages/protocol/src/messages/shell.ts` with `shell.exec` / `shell.echo` / `shell.result` (§4.2); register them in the unions.

**26.3 — cwd session state**
- `packages/core/src/device/shell-session.ts` (§4.4), dropped on lease release.

**26.4 — The handler**
- Implement §4.3 in `ws-handlers.ts`, including the exit marker (§3.5) and the stream hint (§3.6).
- Extend the Plan 18 redaction list with credential-bearing flag patterns.

**26.5 — Studio Terminal tab**
- The pane, the input, history, the read-only mode for non-holders, the confirm dialog, the stream hint (§4.5).

**26.6 — Cloud parity check**
- Run the whole smoke script against an agent-owned device; no Studio change may be required.

## 6. Acceptance criteria

1. With no lease, `shell.exec` is refused with the existing `no_lease` error — even if Studio's input is forced open (server-authoritative).
2. While a job runs, `shell.exec` is refused with `device_busy`.
3. A user without `device.shell` is refused, and with `shell.mode: 'off'` everyone is refused.
4. A server-mode install (non-loopback bind) defaults to `shell.mode: 'off'`.
5. Every accepted command produces exactly two device-event records (`shell.exec`, `shell.result`); a refused command produces none.
6. Credential-bearing flags are redacted in the event log.
7. `echo hi` returns `hi` with exit code 0; `false` returns exit code 1; a command exceeding the output cap reports `truncated: true` and a `null` exit code.
8. `logcat` hits its deadline, reports the coded error, and offers the stream hint; clicking it starts a Plan 24 stream.
9. `cd /data/local/tmp` then `pwd` prints `/data/local/tmp`; a failed `cd` leaves the cwd unchanged.
10. A second viewer without the lease sees every command and its output live, with the actor's identity, and cannot type.
11. Releasing the lease resets the cwd, and the next holder starts at `/`.
12. Everything above behaves identically on an agent-owned device, with no Studio changes.
13. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit (no device):**
- `acl.test.ts` — `device.shell` across roles and all three `shell.mode` values.
- `shell-session.test.ts` — cwd transitions, quoting, failed `cd`, reset on release.
- `ws-handlers.test.ts` — the refusal matrix (no lease / busy / wrong holder / no permission / mode off) and the record-ordering rule (refusals record nothing).
- `redact.test.ts` — credential flags removed from a recorded command.
- exit-marker parsing: present, absent, and split across chunk boundaries.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`):**
```bash
bun run dev && bun run dev:studio
# 1. without control: input disabled; force a shell.exec over WS → no_lease
# 2. take control → getprop ro.serialno returns the expected value, exit 0
# 3. enqueue a job → the terminal refuses with device_busy for its duration
# 4. cd /data/local/tmp && pwd  → the prompt updates
# 5. logcat → deadline error + "Run as a stream" → the Plan 24 pane opens
# 6. second browser tab: sees every command and output, cannot type
# 7. Logs tab: shell.exec / shell.result present with the actor
# 8. settings shell.mode = off → the tab disappears and the WS refuses
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Someone runs `reboot` or disables adb and the device drops off the farm. | Confirmation dialog (a usability guard, stated as such), full audit with actor, and Plan 23's health tracker quarantines and auto-recovers the device rather than leaving it in limbo. |
| The terminal is mistaken for a sandboxed environment. | The UI states plainly that commands run with the device's adb shell privileges; the code comments repeat spec §11.3's rule against calling anything here a sandbox. |
| Command lines leak credentials into the event log. | Redaction on the recorded command, reusing and extending Plan 18's rules; covered by a test. |
| An operator on a shared install gains shell without the owner realising. | `shell.mode` defaults to `off` in server mode and `admin` on loopback; granting `operator` is an explicit, single, visible setting. |
| The exit marker appears in legitimate output and confuses parsing. | The marker is matched only as the final line, and the string is distinctive (`__ENKAKU_EXIT__`); if it is absent the exit code is `null`, never guessed. |
| A stuck command holds the lease and blocks the device. | The Plan 22.1 deadline bounds it; the lease has its own idle timeout and the existing force-release path is unchanged. |

## 9. Open questions

1. **Shell protocol v2 (`shell,v2,pty:`)** would give real interactive stdin, separated stderr, and a native exit code, on devices advertising the `shell_v2` feature (API 24+). It is the natural upgrade once v1 is proven; deciding it now would expand this plan past one working session.
2. Should the transcript persist across a page reload? Currently it lives in component state and is lost. The event log already holds commands; replaying output would need a server-side ring buffer like Plan 24's.
3. Should there be a per-user rate limit on commands? Not obviously needed for a trusted team; the audit trail will show whether it is.
