# Plan 39 — M17e : File Transfer and APK Install

> Status: draft
> Depends on: Plan 22.1 (deadlines), Plan 24 (the streaming lane and device-scoped artifacts), Plan 27 (`AdbClient.openRaw`, which the sync protocol rides on). Plan 26's permission model is reused.
> Spec references: §9 (script API), §10.1 (server-authoritative control), §10.4 (adb serialisation), §12 (artifacts).

---

## 1. Goals

- Install an APK on a device from Studio, from a script, and across a cluster — without writing a script to do it.
- Push a file to a device and pull one back, from the same three places.
- The APK comes from a **server-side resolved artifact**, never from a URL the client hands over.
- Transfers use the streaming lane, so a 60 MB APK does not block video, input, or jobs on that device.
- Progress is visible, transfers are cancellable, and every install is audited.

## 2. Non-goals

- A general file browser for the device. Push, pull, and install only.
- Split APKs / app bundles (`install-multiple`), instant apps, or `adb install --user`. Recorded in §9.
- Uninstall. It is one command and trivially added later, but it is a destructive verb that deserves its own confirmation design.
- Replacing the Plan 27 adb endpoint. That remains the power path; this is the zero-setup path.

## 3. Context and design decisions

### 3.1 What is missing, precisely

There is no HTTP or WS route anywhere in `packages/core/src/api` for install, push, or pull. To get a build onto a device today an operator must author, bundle, and publish a script — for the single most common operation in a QA workflow (install this build, then run the suite).

Plan 27's adb endpoint narrowed this: a developer can now `adb connect` and use their own tooling. That does not help the operator running a batch across twenty devices from a browser, which is the farm's actual use case.

### 3.2 The transport already exists

`adb install` is not a protocol verb. What the tool does is: push the APK over the **sync** service, then run `pm install` on the pushed file. Both halves are available to us today:

- Plan 27 added `AdbClient.openRaw(serial, service)`, which opens `sync:` and hands back a raw stream. The sync protocol itself is four packet types (`SEND`, `DATA`, `DONE`, `OKAY`/`FAIL`) with a `path,mode` header — small, well-documented, and testable against a fake.
- `pm install -r -g <path>` is an ordinary shell command with an `appLifecycle` budget, except that a large install can exceed it (§3.4).

So no new transport, and no dependency on the adb CLI binary for the data path.

### 3.3 Transfers belong on the streaming lane

A 60 MB push takes tens of seconds. Plan 24 §3.1 established the rule: anything long-lived must not sit in `PerDeviceQueue`, or video, input, and jobs queue behind it on that device.

Transfers therefore take a lane slot, with the lane's absolute cap raised for this use (a large APK over USB 2.0 can legitimately take minutes). The per-device stream budget must account for it — with the ui-server (Plan 34), the crash watcher (Plan 37), a human monitor, and a transfer, `adb.maxStreamsPerDevice` needs to be **4**. This plan sets it and says why.

### 3.4 `pm install` needs its own budget, not the default

Installing a large APK on a slow device routinely exceeds 15 seconds — Play Protect verification alone can take longer. Running it under the `appLifecycle` profile would kill healthy installs at exactly the moment the device is working hardest.

So a new timeout profile, `install`, defaulting to 300 000 ms, added to `ADB_TIMEOUTS` in `packages/adb/src/timeouts.ts`. It is under the 120 s `MAX_EXEC_TIMEOUT_MS` ceiling? **No — it is not**, and that matters: Plan 22.1 set that ceiling deliberately. Rather than raising a global safety limit for one case, the install runs on the **streaming lane** too (its output is a single line at the end, but its duration is stream-shaped), with the lane's absolute timeout. The ceiling in `timeouts.ts` stays where it is.

### 3.5 The client never names a source

An endpoint that accepts `{ url }` and downloads it server-side is a server-side request forgery hole: the core would fetch whatever the caller names, from inside the farm's network.

So the API takes an **artifact id**, resolved server-side to a path under the artifact store. Getting a file into the artifact store is a separate, deliberate step: `POST /api/artifacts` with a multipart upload, which is subject to the same auth and produces an auditable record of who uploaded what.

Scripts get the same rule: `ctx.device.install({ artifactId })`, never a path or a URL. A script that wants to install something it built must save it as an artifact first — which it can already do with `ctx.artifact.file()`.

### 3.6 Pull has a size limit, and it is enforced twice

Pulling `/data/local/tmp/whatever` is fine. Pulling a 4 GB video someone left on the device would exhaust the core's disk and the browser's memory.

`stat` the remote path first and refuse above `transfer.maxPullBytes` (default 512 MB) with a clear error; then enforce the same cap again while streaming, because the file can grow between the two. The result lands as a device-scoped artifact (Plan 24 §4.6 made those possible), never as a direct download stream through the WS.

### 3.7 Permission and lease

Install and push change the device. They require the lease, exactly like `input.*` and the Plan 26 terminal, and a permission: `device.files` (admin by default, operator when `shell.mode` allows — reusing Plan 26's switch rather than inventing a second one).

Pull is a read, but reads the device's filesystem, so it needs the same permission and lease. There is no meaningful "safe read" of an arbitrary path.

Batch installs (§4.5) run through the batch machinery, which already holds job leases per device.

## 4. Technical design

### 4.1 Sync protocol — `packages/adb/src/transport/sync.ts` (new)

```ts
export interface SyncTransfer {
  readonly bytesSent: number
  cancel(): Promise<void>
}

export function pushFile(stream: RawStream, opts: {
  localPath: string
  remotePath: string
  mode?: number                          // default 0o644
  onProgress?(sent: number, total: number): void
  signal?: AbortSignal
}): Promise<void>

export function pullFile(stream: RawStream, opts: {
  remotePath: string
  localPath: string
  maxBytes: number
  onProgress?(received: number): void
  signal?: AbortSignal
}): Promise<{ bytes: number }>

export function statRemote(stream: RawStream, remotePath: string): Promise<{ size: number; mode: number; mtime: number } | null>
```

Packet layout (little-endian, as adb defines it): a 4-byte ASCII id plus a 4-byte length, then payload. `SEND` carries `<path>,<mode>`; `DATA` chunks are capped at 64 KB; `DONE` carries the mtime; the peer answers `OKAY` or `FAIL` with a message.

The `RawStream` comes from `AdbClient.openRaw(serial, 'sync:')`, so local and — via Plan 28's remote `openService` — agent-owned devices both work with no branching.

### 4.2 Device operations — `packages/core/src/device/transfer.ts` (new)

```ts
export interface TransferService {
  push(deviceId: string, artifactId: string, remotePath: string, opts: TransferOpts): Promise<void>
  pull(deviceId: string, remotePath: string, opts: TransferOpts): Promise<{ artifactId: string; bytes: number }>
  install(deviceId: string, artifactId: string, opts: InstallOpts & TransferOpts): Promise<InstallResult>
  cancel(transferId: string): void
}

export interface InstallOpts {
  reinstall?: boolean      // -r, default true
  grantPermissions?: boolean  // -g, default true
  allowDowngrade?: boolean // -d, default false
}

export interface InstallResult { package: string | null; durationMs: number; output: string }
```

`install` is push-then-`pm install`-then-delete:

1. Resolve the artifact server-side; refuse if it is not a `.apk`.
2. Push to `/data/local/tmp/enkaku-<uuid>.apk` on the lane, with progress.
3. `pm install -r -g <path>` on the lane; parse `Success` / `Failure [REASON]`.
4. Delete the staged file in a `finally`, so a failed install does not leave 60 MB behind. This cleanup runs even on cancel.
5. Read back the installed package name via `pm list packages -f | grep <path>`… **no** — the staged path is gone by then. Instead parse it from the APK before pushing is also not possible without `aapt`. So `InstallResult.package` is populated only when `pm install` reports it, and is `null` otherwise, rather than guessed.

### 4.3 Settings

```ts
transfer: z.object({
  enabled: z.boolean().default(true)
    .describe('Allow file transfer and APK install from Studio and scripts.')
    .meta({ title: 'Allow file transfer' }),
  maxPushBytes: z.number().int().min(1_048_576).default(536_870_912)
    .describe('Largest file that may be pushed or installed.').meta({ title: 'Max push size (bytes)' }),
  maxPullBytes: z.number().int().min(1_048_576).default(536_870_912)
    .describe('Largest file that may be pulled from a device.').meta({ title: 'Max pull size (bytes)' }),
  installTimeoutMs: z.number().int().min(10_000).max(1_800_000).default(300_000)
    .describe('Budget for pm install once the APK is on the device.').meta({ title: 'Install timeout (ms)' }),
}).default({}),
```

### 4.4 API and protocol

```
POST /api/artifacts                       multipart upload → { artifactId }
POST /api/devices/:id/install             { artifactId, reinstall?, grantPermissions? }
POST /api/devices/:id/push                { artifactId, remotePath }
POST /api/devices/:id/pull                { remotePath } → { artifactId, bytes }
```

Progress is a WS message so it can reach every viewer of the device:

```ts
{ type: 'transfer.progress', payload: { deviceId, transferId, kind: 'push'|'pull'|'install', sent, total, phase } }
{ type: 'transfer.done',     payload: { deviceId, transferId, ok, error?, result? } }
{ type: 'transfer.cancel',   payload: { transferId } }   // client → server
```

All three routes require `device.files` **and** `checkInputAllowed`, and record on the Plan 18 `input` stream: `device.install` with `{ artifactId, package, ok }`, `device.push` / `device.pull` with paths and byte counts.

### 4.5 Batch install

`POST /api/batches` gains a built-in script id `internal:install` taking `{ artifactId }`, so an install across a cluster reuses Plan 20's concurrency, ordering, reporting, and cancel with no new orchestration. It is registered in the `ExecutorRegistry` beside `internal:sleep`.

### 4.6 Script API

```ts
device: {
  install(opts: { artifactId: string; reinstall?: boolean; grantPermissions?: boolean }): Promise<InstallResult>
  push(opts: { artifactId: string; remotePath: string }): Promise<void>
  pull(opts: { remotePath: string }): Promise<{ artifactId: string; bytes: number }>
}
```

Three more `device.call` methods through the existing IPC path. `remotePath` is validated (absolute, no `..`, no metacharacters) and quoted with `shellQuote`.

### 4.7 Studio

- Device page: an **Install APK** action that uploads and installs in one flow, with a progress bar and the parsed result; a Files panel with push (file picker + remote path) and pull (remote path → artifact link).
- Devices list: multi-select → **Install on selected**, which creates a batch (§4.5) rather than N parallel requests.
- Progress is driven by `transfer.progress`, so a second viewer sees it too.

## 5. Implementation steps

**39.1 — Sync protocol.** `sync.ts` with `pushFile`/`pullFile`/`statRemote`, tested byte-level against a scripted fake peer (no device needed), including `FAIL`, cancel mid-transfer, and a chunk-boundary split.

**39.2 — Transfer service.** `transfer.ts` on the streaming lane, with staged-file cleanup in `finally`, caps enforced twice on pull, and the artifact resolution rule (§3.5).

**39.3 — Settings, API, protocol.** The `transfer` block, the four routes, the three WS messages, the permission and lease gates, the audit events. Raise `adb.maxStreamsPerDevice` to 4 with its justification.

**39.4 — Artifact upload.** `POST /api/artifacts` multipart, size-capped, with an audit record.

**39.5 — Batch install.** The `internal:install` executor registered for batches.

**39.6 — Script API.** The three `device.call` methods plus path validation.

**39.7 — Studio.** Install flow, Files panel, multi-select batch install, live progress.

## 6. Acceptance criteria

1. Uploading an APK and installing it on a device succeeds from Studio, and the device shows the app installed.
2. Installing while the device streams video does not stall the video or input — the transfer is on the lane, and `queueDepth` for that device stays at 0.
3. A failed `pm install` reports the parsed reason (for example `INSTALL_FAILED_VERSION_DOWNGRADE`), not a generic error.
4. The staged file under `/data/local/tmp` is deleted after success, after failure, and after cancel.
5. Push and pull round-trip a file with an identical checksum.
6. A pull above `maxPullBytes` is refused before any bytes move, and a file that grows past the cap mid-transfer is aborted.
7. Every route rejects an absent lease, an absent `device.files` permission, and `transfer.enabled: false`.
8. No endpoint accepts a URL or a filesystem path from the client; only artifact ids resolve to sources.
9. Cancelling mid-transfer stops it within a second and cleans up.
10. A batch install across a cluster reports per-device results through the Plan 20 batch report.
11. `ctx.device.install/push/pull` work from a script; a `remotePath` containing `..` or metacharacters is rejected.
12. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `sync.test.ts` (packet encoding, `OKAY`/`FAIL`, split chunks, cancel, `statRemote` on a missing path); `transfer.test.ts` (staged cleanup on every exit path, pull cap enforced twice, artifact resolution refusing a non-artifact source); route tests for the permission/lease matrix; `path-validate.test.ts`.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, a real APK):**
```bash
# 1. upload a ~50 MB APK, install on one device, watch progress; app appears
# 2. during the install: video keeps streaming, taps land, /api/adb/stats shows queueDepth 0
# 3. adb shell ls /data/local/tmp → no leftover enkaku-*.apk
# 4. push a file, pull it back, compare shasum
# 5. attempt an install without taking control → refused by the core
# 6. select both devices → Install on selected → batch report shows two results
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A half-finished push leaves large files on devices, filling storage over weeks. | Cleanup in `finally` on every path including cancel, plus a sweep of `/data/local/tmp/enkaku-*.apk` older than a day when a session starts. |
| The sync protocol implementation corrupts large files subtly. | Byte-level tests against a scripted peer, and a checksum comparison in the smoke test (§7). |
| An install exceeds any timeout on a slow device and is killed halfway. | It runs on the lane with a 300 s default, configurable to 30 minutes; a killed install is reported as such, and `pm install` is itself atomic on the device. |
| SSRF via a client-supplied source. | Structurally impossible: the API accepts artifact ids only (§3.5), with an acceptance criterion (§6.8). |
| Transfers consume the per-device stream budget and the Monitor tab stops working. | `adb.maxStreamsPerDevice` raised to 4 as part of 39.3, with the reasoning in the setting description. |
| A malicious APK is installed on a farm device. | Out of scope to judge; the audit records who uploaded and who installed. Plan 41 adds on-device verification of the farm's *own* APKs, which is a different problem. |

## 9. Open questions

1. Split APKs / bundles (`install-multiple`) — common for modern Play builds. Deliberately excluded; needs a multi-artifact upload shape.
2. Should `uninstall` be added here? It is one command, but a destructive verb deserves its own confirmation and audit design.
3. Should pulled files bypass the artifact store for very large captures (a direct download)? Currently everything becomes an artifact, which keeps retention and GC uniform.
