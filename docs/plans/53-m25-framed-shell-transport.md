# Plan 53 — M25 : Framed Shell Transport (replaces the exit-marker workaround)

> Status: implemented — `AdbClient.exec` speaks `shell,v2,raw`, falls back to `shell:` honestly, and the exit-marker workaround is deleted. Hardware verification (53.5) still pending.
> Ships: packages/adb/src/shell-frames.ts
> Depends on: Plans 22–26 complete (adb deadlines, streaming lane, ShellPort, terminal).
> Spec references: §10.4 (adb serialisation), §13 (API conventions), `00-overview.md` §4.3.

---

## 1. Goals

- `AdbClient.exec` returns what actually happened: `{ stdout, stderr, exitCode }`, with the three separated by the device, not by us.
- `packages/core/src/device/exit-marker.ts` is **deleted**. No command is rewritten before it is sent.
- A script can tell a command that failed from one that succeeded — today it cannot.
- One shell path exists. No parallel old and new (`00-overview.md` §4.3).

## 2. Non-goals

- Exposing shell to scripts through the SDK. That is a separate decision about what a script is allowed to do; this plan only makes the answer *knowable*.
- Changing `execOut` (binary stdout via the `exec:` service). It has no exit-code problem and no stderr to separate.
- Changing `execStream` (the Plan 24 streaming lane). Long-running monitors are a different shape; a follow-up may adopt framing there.
- Interactive terminal behaviour (Plan 26). It keeps its session semantics; only what it is built on changes.

## 3. Context and design decisions

### 3.1 Measured, on a real device

The current transport sends `shell:<cmd>` and reads until the socket closes. Running `echo hello-stdout; echo oops-stderr 1>&2; exit 7` on a moto g06 power (Android 15):

```
shell:            "hello-stdout\noops-stderr\n"        ← merged, no exit code
shell,v2,raw:     stdout → "hello-stdout\n"
                  stderr → "oops-stderr\n"
                  exit   → 7
```

The failure is invisible in the first form. That is not a theoretical gap: a proxy-configuration script that runs `am broadcast -n com.example/.Receiver` cannot distinguish "delivered" from "no such component", and a farm device then runs with the wrong egress IP for as long as nobody notices.

### 3.2 What the workaround costs

Plan 26 §3.5 solved the exit code by rewriting the command:

```ts
`${cmd} ; printf '\n__ENKAKU_EXIT__%d' $?`
```

It is the standard trick and it was the right call at the time. Its limits are real, and all three disappear with framing:

- **stderr is still merged.** The marker recovers the exit code and nothing else.
- **The marker can be lost** — output truncated at the byte cap, or a command that kills the shell — and `exitCode` is then honestly `null`.
- **The user's command is mutated.** Anything sensitive to trailing shell syntax, or to `$?` being consumed, behaves differently from what the operator typed.

### 3.3 The wire format

Each packet: `[id: 1 byte][length: u32 little-endian][payload]`, with ids `0` stdin, `1` stdout, `2` stderr, `3` exit, `4` close-stdin. The exit payload is one byte: the code. Verified against the bytes captured in §3.1.

`raw` and not `pty`: no terminal echo, no CR/LF translation, output exactly as the program wrote it. Plan 26's interactive terminal is the one place that wants `pty`, and it asks for it explicitly.

### 3.4 Negotiation, and being honest when it fails

The framed service needs support on the device (Android 7+) and in the adb server. Where it is missing the connection fails at the service request, and the client falls back to `shell:` — with `exitCode: null` and everything on `stdout`.

`null` is the point. It means "this device cannot tell us", which is different from `0`. Reporting a fabricated `0` would put us back where we started, except now the lie is structured.

### 3.5 Why `exec` changes shape rather than gaining a sibling

A second method (`execFull`, `execWithStatus`, …) would leave both paths alive forever, and every future call site would have to know which one to pick. `00-overview.md` §4.3 forbids exactly that. The repository holds the only client, so the migration is one commit.

Call sites, counted: **57** outside tests — 21 in `session`, 18 in `core`, 17 in `drivers`, 1 in `adb`. Almost all want stdout and become `.stdout`.

## 4. Technical design

### 4.1 The frame parser

`packages/adb/src/shell-frames.ts`:

```ts
export interface ShellResult {
  stdout: string
  stderr: string
  /** null when the device could not report one (§3.4). */
  exitCode: number | null
}

/** Incremental — TCP chunk boundaries never align with packets. */
export class ShellFrameParser {
  push(chunk: Uint8Array): void
  /** Everything decoded so far, plus the exit code if its packet arrived. */
  result(): ShellResult
}
```

Unit tests must include: a packet split across two `push` calls, a chunk holding several whole packets, interleaved stdout/stderr, a missing exit packet, and a truncated trailing header.

### 4.2 The client

`packages/adb/src/client.ts`:

- `runOneShot` takes `service: 'shell-framed' | 'shell' | 'exec'`. `shell-framed` sends `shell,v2,raw:<cmd>` and feeds the parser; the other two are unchanged.
- `exec(serial, cmd, opts): Promise<ShellResult>` tries framed, falls back to `shell:` on a service-level failure, and caches the per-serial verdict so the fallback is paid once, not per command.
- The existing byte cap, timeouts, queue, and metrics are unchanged — this changes what is read off the socket, nothing about how the call is governed.

### 4.3 Transport and callers

`Transport.exec` in `packages/protocol/src/driver.ts` returns `Promise<ShellResult>`; `AdbUsbTransport`/`AdbTcpTransport` pass it through.

Every call site migrates in the same commit. Three shapes:

| Today | After |
|---|---|
| `const out = await t.exec(cmd)` then parse `out` | `const { stdout } = await t.exec(cmd)` |
| `await t.exec(cmd)` for effect, result ignored | unchanged — the object is simply discarded |
| `.catch(() => '')` to tolerate failure | `.catch(() => ({ stdout: '', stderr: '', exitCode: null }))` |

A call that genuinely wants to know whether it worked should now check `exitCode`. Do not retrofit that judgement across all 57 — change behaviour only where a plan or a test already asked for it, and note the rest as follow-up.

### 4.4 Removals

- `packages/core/src/device/exit-marker.ts` and its test — deleted.
- `withExitMarker` / `parseExitMarker` usage in `shell-port.ts` — deleted; the port reads `stderr` and `exitCode` directly.
- Plan 26 §3.5 gains a note recording that the workaround it specified has been replaced, and why.

## 5. Implementation steps

### 53.1 Parser
- [x] `packages/adb/src/shell-frames.ts` per §4.1, with the five split cases as tests.
- Result: parser green before anything depends on it.

### 53.2 Client
- [x] `runOneShot` learns the framed service; `exec` returns `ShellResult` with the per-serial fallback verdict.
- [x] Test the fallback: a stubbed service failure yields `exitCode: null` and merged output on `stdout`.
- Result: `exec` returns the object; the workspace does not compile yet, which is expected.

### 53.3 Migrate the callers
- [x] `packages/protocol/src/driver.ts`, then adb → drivers → session → core, in that order.
- [x] Do not change failure semantics beyond mechanical `.stdout`, except where a test already asserts an outcome.
- Result: `bash scripts/typecheck.sh` green again.

### 53.4 Delete the workaround
- [x] Remove `exit-marker.ts` and its test; simplify `shell-port.ts`.
- [x] Note the replacement in Plan 26 §3.5.
- Result: `grep -r "EXIT_MARKER" packages` finds nothing.

### 53.5 Verify on hardware
- [ ] Run `echo out; echo err 1>&2; exit 7` through the terminal and through a `ShellPort`, and confirm the three fields.
- Result: `exitCode` is 7 and `stderr` is separate, observed rather than assumed.

## 6. Acceptance criteria

1. `exec` returns `{ stdout, stderr, exitCode }`, and a failing command reports its real exit code.
2. stderr never appears in `stdout`.
3. A device that cannot support framing reports `exitCode: null` — never a fabricated `0`.
4. `exit-marker.ts` no longer exists and nothing rewrites a user's command.
5. No second shell method exists; `grep -rE "execFull|execWithStatus|shellV2"` finds nothing.
6. Existing timeout, byte-cap, queue and metric behaviour is unchanged, proven by the Plan 22 tests still passing untouched.
7. `bash scripts/typecheck.sh`, `bun test` and `bun run build:studio` are green.
8. `bash scripts/check-plan-status.sh` passes with this plan's status updated.

## 7. Test plan

**Unit** — `packages/adb/src/shell-frames.test.ts`: split packets, batched packets, interleaving, missing exit, truncated header. Client-level: fallback path yields `exitCode: null`.

**Manual smoke** (one device attached)

```bash
bun run dev
# through the terminal, and through a ShellPort:
#   echo out; echo err 1>&2; exit 7
#   expect stdout="out", stderr="err", exitCode=7
adb -s <serial> shell 'am broadcast -a x -n com.nope/.Nope'   # a real failure
#   expect a non-zero exitCode and the error text on stderr, not stdout
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A device or adb build without framing. | Detected at the service request, falls back to `shell:`, verdict cached per serial, `exitCode: null` reported honestly. |
| 57 mechanical edits introduce a silent behaviour change. | Migration is `.stdout` only; failure semantics change only where a test already asserts them. The Plan 22 timeout/cap tests must pass untouched — they are the regression net. |
| A caller was relying on stderr appearing in stdout. | It becomes visibly missing rather than silently wrong, and the compiler flags every call site during the migration. |
| The framed parser mis-handles a chunk boundary. | Five explicit split cases in §7; this is the one piece where a subtle bug would corrupt output invisibly. |

## 9. Open questions

1. Should `execStream` (Plan 24 monitors) adopt framing too, so a monitor can report why it ended? Proposed: follow-up — the shapes differ and this plan is already 57 call sites.
2. Should a non-zero `exitCode` throw rather than return? Proposed: return. Most callers run probes where failure is expected and normal (`dumpsys` on a missing service); throwing would make every one of them wrap a try/catch.
3. Does the SDK expose `device.shell()` now that failure is detectable? Proposed: a separate decision — it changes what a script is trusted to do, which is a product question, not a transport one.
