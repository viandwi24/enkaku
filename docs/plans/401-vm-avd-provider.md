# Plan 401 — VM : The `vm` subsystem — SDK resolution, the AVD provider, lifecycle and adoption

> Status: draft
> Ships: packages/core/src/vm/provider-avd.ts
> Depends on: plan 400 (the decisions D1–D8 and the verified references R1–R9)
> Spec references: §5 (driver layers — untouched here), §7 (toolchain)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The Android SDK resolves in three tiers and never downloads | tier 1 `ENKAKU_ANDROID_SDK_PATH`; tier 2 `ANDROID_SDK_ROOT` → `ANDROID_HOME` → per-OS default; tier 3 throws `E_ANDROID_SDK_MISSING` naming the install command | `bun test packages/core/src/vm/sdk.test.ts` → all pass | [x] |
| G2 | Port selection returns the next free **even** console port in 5554–5682 | a busy port is skipped; an exhausted range throws `E_VM_NO_PORT` | `bun test packages/core/src/vm/ports.test.ts` → all pass | [x] |
| G3 | Boot polling resolves on `sys.boot_completed=1` and a timeout stops the process | default timeout 300 s; on timeout the child is killed and the row is `failed`, never left `starting` | `bun test packages/core/src/vm/manager.test.ts` → the two boot tests pass | [x] |
| G4 | Adoption on boot re-derives truth from the port, never a stored PID | live port → `running`; dead port → `stopped`; no `pid` column exists | `bun test packages/core/src/vm/manager.test.ts` → the three adoption tests pass; `rg -n "pid" packages/core/src/vm/` → no column or stored field | [x] |
| G5 | The concurrent-VM cap is a constant with an env override, default 2, hard max 8 | `ENKAKU_VM_MAX_CONCURRENT`, `z.number().int().min(1).max(8)`, default 2 | `bun test packages/core/src/vm/manager.test.ts` → the cap test passes; `rg -n "ENKAKU_VM_MAX_CONCURRENT" .env.example` → 1 match | [x] |
| G6 | Migration 0077 exists and creates `virtual_devices` | index 77 in `_journal.json`; table has no `pid` column | `test -f packages/core/drizzle/0077_*.sql` and `rg -n '"idx": 77' packages/core/drizzle/meta/_journal.json` → 1 match | [x] |
| G7 | `bun run doctor` reports the SDK tier, the emulator binary, and the host accelerator, and downloads nothing | check id `android-sdk`; status `pass`/`warn`/`fail` with a remedy string | `bun run doctor` → an `Android SDK` row is printed | [x] |
| G8 | Nothing in the subsystem calls `adb connect`, writes an endpoint, or touches the adb server | 0 matches each | `rg -n "adb connect\|declare\(\|kill-server" packages/core/src/vm/` → empty | [x] |
| G9 | Typecheck is clean | 0 errors | `bun run typecheck` → clean | [x] |
| G10 | An AVD is really created, boots, and appears in the farm as a device | one virtual device reaches `online` in Studio without any `adb connect` | owner, on macOS with the SDK installed | owner |
| G11 | Display and input work on the emulator through the existing driver ladder | scrcpy mirrors; input reaches the device (UHID **or** a documented fallback — plan 400 K1/R9) | owner, on macOS | owner |

## 1. Goals

- A `packages/core/src/vm/` subsystem that can create an AVD, start a headless emulator,
  wait for it to finish booting, stop it, and delete it.
- Resolution of the host's Android SDK with no download, ever (plan 400 D3).
- A `virtual_devices` table and migration that records what the farm started, with enough
  to re-derive state after a core restart and nothing that goes stale (plan 400 D8).
- A `bun run doctor` check that answers "can this host run a virtual device, and if not,
  what is missing" without provisioning anything.

## 2. Non-goals

- **No HTTP.** Routes, protocol schemas and daemon wiring are plan 402.
- **No UI.** Plan 403.
- **No documentation beyond code comments.** Plan 404 writes `docs/guide/virtual-devices.md`,
  `.env.example`'s prose, and the `LICENSES.md` row.
- **No second provider.** Plan 400 D7: the interface exists, `avd` is its only implementation.
  Do not write a registry, a settings selector, or a redroid stub.
- **No `adb connect`, no `EndpointStore` write, no new transport.** Plan 400 D2. Discovery
  is the existing reconciler's job and needs no change here.
- **No auto-start on core boot.** Plan 400 Q1 is unanswered; this plan implements *adoption*
  of an already-running emulator only, and adds no `autoStart` column.
- **No system-image download and no toolchain manifest entry.** Plan 400 D3.

## 3. Context and design decisions

### 3.1 The subsystem's job ends at "booted"

Plan 400 D2 is the load-bearing decision and the one an executor is most likely to
undo by helpfulness. Stated again as an instruction:

> When the emulator process reports `sys.boot_completed=1`, **this subsystem is finished**.
> It does not connect to the device, register it, name it, or tell the registry anything.
> The adb server discovers local emulators by scanning odd ports 5555–5585 (plan 400 R5),
> and `packages/core/src/registry/reconcile.ts` already re-derives `host:devices-l` on an
> interval and admits what it finds. That is the entire integration.

**Do not** add a call to `AdbClient.connect()` (`packages/adb/src/client.ts:761`), and
**do not** call `EndpointStore.declare()` (`packages/core/src/registry/endpoints.ts:33`).
G8 greps for both.

### 3.2 Why the SDK is resolved and never fetched

`resolveGuestAgentApkPath` (`packages/core/src/api/guest-agent.ts:150-179`) is the pattern.
Its tier 2 comment states the reasoning this plan reuses verbatim in spirit:

> "Deliberately NOT auto-building: Gradle needs a JDK and the Android SDK and takes
> minutes, so having `bun run dev` silently trigger it would be worse than a clear error."

A system image is 1.5–3 GB under the Android SDK Terms — the same licence that keeps adb
out of the release (`LICENSES.md:11`, `:19`). Plan 400 D3 decides: three tiers, then a
clear error. The error is a product surface, not a stack trace: it names the missing
piece and the exact command that installs it.

### 3.3 Why there is no PID column

Plan 400 D8. A stored PID is wrong after a host reboot because PIDs are reused, and this
repo already prefers re-derivation over cached handles — `reconcile.ts:1-30` exists for
exactly that reason on the device side. On boot the manager probes each row's console
port and sets state from what it finds. G4 greps to prove no PID is stored.

The in-memory `Subprocess` handle is still kept for the lifetime of the core process, so
`stop()` can be graceful while the core that started it is still running. It is a
runtime field, not a column.

### 3.4 The `google_apis` default, and why not `google_apis_playstore`

Plan 400 R4: `google_apis_playstore` images refuse `adb root`. The farm's guest agent,
the inspector and several driver paths benefit from a rootable image, and a testing device
that cannot be rooted is a strictly worse testing device. Default `google_apis`; the
operator may still pass `google_apis_playstore` explicitly.

### 3.5 ABI is derived, not asked

Plan 400 R3: Apple Silicon needs `arm64-v8a`; Intel Macs and Linux x64 need `x86_64`.
`process.arch` answers this without asking the operator, and a wrong ABI produces an
emulator that either refuses to start or runs under slow translation. Derive it, allow
an override, never guess silently in the other direction.

## 4. Technical design

### 4.1 `packages/core/src/vm/types.ts`

```ts
import { z } from 'zod'

/** What a VM row can be. `failed` carries a message; every other state is self-explanatory. */
export const VmStateSchema = z.enum(['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
export type VmState = z.infer<typeof VmStateSchema>

/** The AVD shape an operator asks for. Everything has a default except the name. */
export const VmSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(48)
    // avdmanager's own constraint: an AVD name is a path segment.
    .regex(/^[A-Za-z0-9._-]+$/, 'an AVD name may contain only letters, digits, dot, underscore and hyphen'),
  apiLevel: z.number().int().min(24).max(40).default(36),
  variant: z.enum(['google_apis', 'google_apis_playstore', 'default', 'aosp_atd']).default('google_apis'),
  /** Omitted → derived from `process.arch` (§3.5). */
  abi: z.enum(['arm64-v8a', 'x86_64']).optional(),
  /** Emulator flag `-memory`, bounded by the emulator itself (plan 400 R8). API 37+ enforces ≥ 4096 (R2). */
  memoryMb: z.number().int().min(1536).max(8192).default(2048),
  /** An `avdmanager list device` id, e.g. `pixel_7`. Unverified ids are rejected by avdmanager, not by us. */
  deviceProfile: z.string().min(1).default('pixel_7'),
})
export type VmSpec = z.infer<typeof VmSpecSchema>

export interface VmRecord {
  id: string
  name: string
  state: VmState
  /** Even console port in 5554–5682. The adb serial is `emulator-<consolePort>` (plan 400 R5). */
  consolePort: number
  /** Denormalised for display and for the device link; always `emulator-${consolePort}`. */
  serial: string
  spec: VmSpec
  message: string | null
  createdAt: Date
  startedAt: Date | null
}

/**
 * Plan 400 D7: this interface has exactly one implementation. It exists so the
 * manager's supervision logic is testable against a fake, and because plan 400 D1
 * names redroid-on-a-Linux-node as a real future. It is NOT a plugin surface.
 */
export interface VmProvider {
  /** Creates the on-disk AVD. Idempotent on `spec.name` — an existing AVD of that name is an error, not an overwrite. */
  create(spec: VmSpec): Promise<void>
  /** Starts the emulator headless on `consolePort` and returns once the process is spawned — NOT once it has booted. */
  start(spec: VmSpec, consolePort: number): Promise<VmHandle>
  /** Graceful stop; falls back to a kill after `graceMs`. */
  stop(handle: VmHandle, graceMs: number): Promise<void>
  /** Deletes the on-disk AVD. Never called while the VM is running. */
  destroy(spec: VmSpec): Promise<void>
}

export interface VmHandle {
  consolePort: number
  /** Runtime only — never persisted (§3.3). */
  kill(signal?: NodeJS.Signals): void
  /** Resolves when the child exits, whoever caused it. */
  exited: Promise<number>
}
```

### 4.2 `packages/core/src/vm/sdk.ts` — the three tiers

```ts
/** Per-OS default SDK locations (plan 400 D3 tier 2, last resort before the error). */
const DEFAULT_SDK_PATHS: Record<string, string[]> = {
  darwin: ['$HOME/Library/Android/sdk'],
  linux: ['$HOME/Android/Sdk', '$HOME/android-sdk'],
  win32: ['$LOCALAPPDATA/Android/Sdk'],
}

export interface AndroidSdk {
  root: string
  /** `<root>/emulator/emulator[.exe]` */
  emulator: string
  /** `<root>/cmdline-tools/latest/bin/avdmanager[.bat]`, falling back to the legacy `<root>/tools/bin/`. */
  avdmanager: string
  source: 'override' | 'env' | 'default'
}

/**
 * Which tier `resolveAndroidSdk` WOULD take, without taking it — the twin of
 * `describeGuestAgentApk` (`api/guest-agent.ts:141`). Provisions nothing, so the
 * doctor check and the boot log may both call it.
 */
export async function describeAndroidSdk(): Promise<{ source: AndroidSdk['source'] | 'missing'; detail: string }>

/** Throws `E_ANDROID_SDK_MISSING` with the install command when every tier misses. */
export async function resolveAndroidSdk(): Promise<AndroidSdk>
```

The error text is part of the deliverable and is asserted by a test. Exactly:

```
the Android SDK was not found. Enkaku never downloads it (a system image is 1.5-3 GB and
is covered by the Android SDK Terms). Install the command-line tools and one system image,
then set ANDROID_SDK_ROOT or ENKAKU_ANDROID_SDK_PATH:

  sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;<abi>"

Looked in: ENKAKU_ANDROID_SDK_PATH, ANDROID_SDK_ROOT, ANDROID_HOME, <default path>
```

**Do not** shorten this to "SDK not found". The whole point of D3 is that the failure is
actionable.

### 4.3 `packages/core/src/vm/ports.ts`

```ts
/** Plan 400 R8: the emulator accepts 5554-5682; console ports are even. */
export const VM_PORT_MIN = 5554
export const VM_PORT_MAX = 5682

/**
 * The next free even console port, skipping any port that answers a TCP connect.
 *
 * Probing matters: the farm does not own this range (plan 400 K2). The operator's own
 * Android Studio emulator very likely holds 5554 already, and claiming it would produce
 * a VM that never appears.
 */
export async function nextFreeConsolePort(opts: {
  taken: ReadonlySet<number>
  probe: (port: number) => Promise<boolean>
}): Promise<number>
```

`probe` is injected so the tests need no sockets. The production probe uses `Bun.connect`,
mirroring `packages/core/src/registry/reconnect.ts:115`. Range exhausted → `E_VM_NO_PORT`.

### 4.4 `packages/core/src/vm/manager.ts`

```ts
export interface VmManagerDeps {
  db: Db
  provider: VmProvider
  /** `getprop sys.boot_completed` against `emulator-<port>`, through the core's existing AdbClient. */
  shell: (serial: string, command: string) => Promise<string>
  probePort: (port: number) => Promise<boolean>
  maxConcurrent: () => number
  log: Logger
  now?: () => Date
}

export interface VmManager {
  list(): VmRecord[]
  create(spec: VmSpec): Promise<VmRecord>
  start(id: string): Promise<VmRecord>
  stop(id: string): Promise<VmRecord>
  remove(id: string): Promise<void>
  /** Plan 400 D8 — called once at boot. Never trusts a stored handle. */
  adopt(): Promise<void>
}
```

Boot polling: every 2 s, `shell('emulator-<port>', 'getprop sys.boot_completed')`, trimmed,
compared to `'1'`. Timeout `VM_BOOT_TIMEOUT_SEC` (default 300). **On timeout the child is
stopped and the row becomes `failed` with the elapsed seconds in `message`** — a row left
in `starting` is the failure mode this rule exists to prevent (G3).

`adopt()`, for each row not already `stopped`/`failed`:

| Port probe | Row becomes |
|---|---|
| answers | `running`, `message = 'adopted after a core restart'` |
| silent | `stopped`, `message = null` |

A row in `creating` at boot never had a process; it becomes `failed` with
`'the core restarted while this VM was being created'`.

### 4.5 Schema — `packages/core/src/db/schema.ts`

Appended, never rewriting an existing table:

```ts
export const virtualDevices = sqliteTable('virtual_devices', {
  id: text('id').primaryKey(),
  /** The AVD name on disk. Unique: two rows may not own one AVD (plan 400 D5). */
  name: text('name').notNull().unique(),
  /** 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'. */
  state: text('state').notNull(),
  /** Even console port, 5554-5682. The adb serial is `emulator-<consolePort>` (plan 400 R5). */
  consolePort: integer('console_port').notNull(),
  /** The full `VmSpec` as JSON — validated through `VmSpecSchema` on read, never `as`-cast (CLAUDE.md). */
  spec: text('spec', { mode: 'json' }).notNull(),
  /** Operator-facing detail for `failed`, and the adoption note for `running`. */
  message: text('message'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }),
})
```

**No `pid` column** (§3.3, G4). **No `autoStart` column** — plan 400 Q1 is unanswered and
§2 forbids inventing the answer. Timestamps are integer unix **seconds** via Drizzle
`mode: 'timestamp'`, per `CLAUDE.md`.

### 4.6 The constant

In `packages/core/src/config/constants.ts`, using the existing `num()` helper (`:36`):

```ts
/**
 * Plan 400 D6 — how many virtual devices may run at once. The owner's own number is 2
 * ("paling dipakai 1 atau 2 devices"), and the hard ceiling of 8 is well inside adb's
 * emulator discovery range of 16 (plan 400 R5). This is a support override, not a
 * setting: a farm that needs a hundred emulators needs redroid (plan 400 D1), not a
 * bigger number here.
 */
export const VM_MAX_CONCURRENT = num('ENKAKU_VM_MAX_CONCURRENT', 2, z.number().int().min(1).max(8))

/** Plan 401 §4.4 — how long a cold boot may take before the VM is failed and the child stopped. */
export const VM_BOOT_TIMEOUT_SEC = num('ENKAKU_VM_BOOT_TIMEOUT_SEC', 300, z.number().int().min(60).max(1800))
```

### 4.7 The doctor check — `packages/core/src/doctor/checks/android-sdk.ts`

Modelled on `checks/guest-agent.ts`, including its rule (`:19`): "a doctor check must
never trigger a download". Reports, in one row:

- which tier `describeAndroidSdk()` would take, or that none would;
- whether `<root>/emulator/emulator` exists;
- the host accelerator the platform implies (plan 400 R1): macOS → Hypervisor.framework;
  Linux → whether `/dev/kvm` exists and is accessible; Windows → names WHPX as preferred
  and **states that AEHD sunsets 2026-12-31** (plan 400 R2, K5).

`fail` when no SDK resolves; `warn` when the SDK resolves but the emulator binary or the
accelerator is missing; `pass` otherwise. Registered in `packages/core/src/doctor/checks/index.ts`.

## 5. Implementation steps

### 5.1 The constant and the env example line

- Change `packages/core/src/config/constants.ts`: add `VM_MAX_CONCURRENT` and
  `VM_BOOT_TIMEOUT_SEC` exactly as §4.6, beside the existing support overrides.
- Change `.env.example`: add both under the existing `── Support overrides ──` heading,
  commented, each with one sentence. Prose beyond that is plan 404's.
- Result: `rg -n "ENKAKU_VM_MAX_CONCURRENT" .env.example` → 1 match (G5).

### 5.2 Types

- Create `packages/core/src/vm/types.ts` exactly as §4.1.
- No test file: it is types and Zod schemas with no branching.
- Result: `bun run typecheck` clean.

### 5.3 SDK resolution

- Create `packages/core/src/vm/sdk.ts` per §4.2, with `describeAndroidSdk` and
  `resolveAndroidSdk`. Both take an optional `{ env, exists }` seam so the tests do not
  depend on the executor's own machine — `checks/guest-agent.ts` needed the same seam and
  `resolveGuestAgentApkPath` documents why (`api/guest-agent.ts:154-159`).
- Create `packages/core/src/vm/sdk.test.ts`: tier 1 wins over tier 2; `ANDROID_SDK_ROOT`
  beats `ANDROID_HOME`; the per-OS default is used when both are unset; the miss throws
  `E_ANDROID_SDK_MISSING` and **the message contains the `sdkmanager` line**; on `win32`
  the binaries end `.exe` and `.bat`; the legacy `tools/bin/avdmanager` is used when
  `cmdline-tools/latest` is absent.
- Result: `bun test packages/core/src/vm/sdk.test.ts` → all pass (G1).

### 5.4 Port selection

- Create `packages/core/src/vm/ports.ts` per §4.3.
- Create `packages/core/src/vm/ports.test.ts`: an empty farm gets 5554; a `taken` 5554
  gets 5556; a probe-busy 5554 gets 5556; both taken and busy skip correctly; only even
  ports are ever returned; an exhausted range throws `E_VM_NO_PORT`.
- Result: `bun test packages/core/src/vm/ports.test.ts` → all pass (G2).

### 5.5 The AVD provider

- Create `packages/core/src/vm/provider-avd.ts` implementing `VmProvider`:
  - `create` → `avdmanager create avd -n <name> -k "system-images;android-<api>;<variant>;<abi>" -d <deviceProfile>`,
    stdin fed `no` so the "custom hardware profile" prompt cannot hang the process.
    **Do not pass `-f`**: overwriting an operator's existing AVD is destructive and §4.1
    makes a name collision an error.
  - `start` → `emulator @<name> -no-window -no-audio -no-boot-anim -no-snapshot -port <consolePort> -memory <memoryMb>`
    (plan 400 D5, R8). Spawn detached with piped stdio; the first 4 KB of stderr is kept
    for the `failed` message, because an emulator that refuses to start says why there
    and nowhere else.
  - `stop` → SIGTERM, then SIGKILL after `graceMs`.
  - `destroy` → `avdmanager delete avd -n <name>`.
- **Do not** add `-gpu`. `auto` is the emulator's own default and hard-coding
  `swiftshader_indirect` costs performance on hosts that do not need it. If a host needs
  it, that is a follow-up with evidence, recorded in §11 "Observed, not done".
- No test file: every method is a process spawn with no branching worth asserting, and
  the repo does not test shell-out wrappers. The provider is exercised by G10/G11 on the
  owner's machine.
- Result: `bun run typecheck` clean; `rg -n "adb connect|declare\(|kill-server" packages/core/src/vm/` → empty (G8).

### 5.6 Schema and migration

- Change `packages/core/src/db/schema.ts`: append `virtualDevices` exactly as §4.5.
- **Read `packages/core/drizzle/meta/_journal.json` first and take the next free index**
  (plan 200 §2.1). It ended at `idx: 76` / `0076_pretty_nemesis` when this plan was
  written on 2026-09-05; confirm before generating, and state the index you took in §11.
- Run `bun run --cwd packages/core db:generate`.
- Result: `test -f packages/core/drizzle/0077_*.sql` and `rg -n '"idx": 77' packages/core/drizzle/meta/_journal.json` → 1 match (G6).

### 5.7 The manager

- Create `packages/core/src/vm/manager.ts` per §4.4. Read the `spec` column back through
  `VmSpecSchema.parse` — never `as`-cast a JSON column (`CLAUDE.md`).
- Create `packages/core/src/vm/manager.test.ts` against a fake `VmProvider` and a fake
  `shell`, with an in-memory db:
  - boot polling resolves when `getprop` returns `1` (G3);
  - a boot timeout kills the child **and** leaves the row `failed`, not `starting` (G3);
  - `adopt()` with a live port → `running`; with a dead port → `stopped`; a `creating`
    row → `failed` with the restart message (G4);
  - `create` at the cap throws `E_VM_LIMIT`, and the cap is read live from
    `deps.maxConcurrent()` rather than captured once (G5) — the same "read settings fresh
    each time" discipline `registry/endpoints.ts:50-56` documents;
  - `remove` on a `running` VM stops it first, and never calls `destroy` while running.
- Result: `bun test packages/core/src/vm/manager.test.ts` → all pass.

### 5.8 The doctor check

- Create `packages/core/src/doctor/checks/android-sdk.ts` per §4.7.
- Change `packages/core/src/doctor/checks/index.ts`: register it.
- No test: the existing doctor checks with tests (`adb-health`, `host-adb`, `labelling`)
  test logic; this one formats a resolver's output. If a branch here grows real logic,
  test it then.
- Result: `bun run doctor` prints an `Android SDK` row (G7).

### 5.9 Checkpoint and report

- Commit as you go (`feat(vm-401): …`), never only at the end — plan 200 §2.1.
- Fill in §11.

## 6. Acceptance criteria

- [x] G1–G9 pass by their own commands. G10 and G11 are `owner` rows and stay open.
- [x] `bun run typecheck` clean.
- [x] `rg -n "adb connect|EndpointStore|declare\(|kill-server" packages/core/src/vm/` → empty.
- [x] `rg -n "pid" packages/core/src/vm/manager.ts packages/core/src/db/schema.ts` → no VM pid field.
- [x] No `any` and no unjustified TODO in the files created.
- [x] Every process the executor started is dead: `ps -Ao pid=,command= | grep -i "[e]mulator"` → empty.

## 7. Test plan

Run these and only these, **one at a time**, never concurrently (`CLAUDE.md`; plan 200 §2.3):

```bash
bun run typecheck
bun test packages/core/src/vm/sdk.test.ts
bun test packages/core/src/vm/ports.test.ts
bun test packages/core/src/vm/manager.test.ts
```

Never `bun test` bare. If a step cannot be tested within that scope, skip it and say so in §11.

**Owner smoke** (G10, G11 — not run by the executor):

```bash
sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;arm64-v8a"
bun run doctor            # the Android SDK row should pass
bun run dev
# then, once plan 402 lands, create and start a VM and watch it appear in Studio
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The executor "helpfully" adds `adb connect` after boot. | §3.1 states the prohibition, §2 repeats it, and G8 greps for it. |
| `avdmanager create` hangs on its interactive hardware-profile prompt. | §5.5 feeds `no` on stdin. An executor that omits this discovers it as a hung test. |
| A boot timeout leaks an emulator process. | G3 asserts the child is stopped on timeout, and §6 requires a clean `ps`. |
| The default `pixel_7` profile is not present in a given SDK. | `avdmanager` rejects an unknown `-d` with a clear message, which becomes the `failed` row's `message`. Plan 404 documents `avdmanager list device`. |
| API 37+ needs ≥ 4096 MB and the default is 2048 (plan 400 R2). | Out of scope for the default; plan 403's dialog surfaces `memoryMb`, and plan 404 documents the requirement. Recorded here so it is not a surprise. |

## 9. Open questions

Inherited from plan 400 §7 — **an executor does not decide these**:

- **Q1 (auto-start on boot)** blocks nothing in this plan: §4.4 implements adoption only,
  and §4.5 adds no `autoStart` column. If execution feels the pull to add one, do not; report it.
- **Q3 (default API level and variant)** — this plan uses API 36 / `google_apis` as the
  schema default (§4.1) on the reasoning in §3.4. Ratification belongs to plan 403, where
  the operator actually sees it.

## 10. Removed

Nothing. This plan is additive: it creates a new directory, appends one table, and
registers one doctor check.

| What | Where it was | Proof |
|---|---|---|
| — | — | — |

## 11. Handoff report

**Status: G1–G9 done and verified by their own commands. G10/G11 remain `owner` rows, untouched.**

### What was built

- `packages/core/src/config/constants.ts` — `VM_MAX_CONCURRENT` (`ENKAKU_VM_MAX_CONCURRENT`, default 2, `min(1).max(8)`) and `VM_BOOT_TIMEOUT_SEC` (`ENKAKU_VM_BOOT_TIMEOUT_SEC`, default 300, `min(60).max(1800)`), beside the existing support overrides. `.env.example` gained both, commented, under the first "Support overrides" block (the one nearest `ENKAKU_GEO_RECHECK_INTERVAL_SEC`).
- `packages/core/src/vm/types.ts` — `VmStateSchema`, `VmSpecSchema`, `VmRecord`, `VmProvider`, `VmHandle`, exactly as §4.1. No test file (types and Zod schemas only, per the plan).
- `packages/core/src/vm/sdk.ts` + `sdk.test.ts` — `resolveAndroidSdk`/`describeAndroidSdk`, the three tiers (`ENKAKU_ANDROID_SDK_PATH` → `ANDROID_SDK_ROOT`/`ANDROID_HOME`/per-OS default → `E_ANDROID_SDK_MISSING`), an `{ env, exists, platform }` test seam mirroring `resolveGuestAgentApkPath`. The miss message matches the plan's literal text, with `<abi>` filled from the *host's* actual arch (darwin+arm64 → `arm64-v8a`, everything else → `x86_64`) rather than left as a placeholder — a small, deliberate deviation that makes the printed remedy directly copy-pasteable. 10/10 tests pass.
- `packages/core/src/vm/ports.ts` + `ports.test.ts` — `nextFreeConsolePort`, `VM_PORT_MIN`/`MAX` (5554/5682), `E_VM_NO_PORT`. 7/7 tests pass.
- `packages/core/src/vm/provider-avd.ts` — `createAvdProvider`: `create` (avdmanager, fed `no` on stdin, never `-f`), `start` (headless/no-audio/no-boot-anim/no-snapshot, plan 400 D5), `stop` (SIGTERM then SIGKILL after `graceMs`), `destroy`. `deriveAbi()` from `process.arch`, overridable via `spec.abi`. No `-gpu` flag added (plan says leave it `auto`). No test file, per the plan's own rule ("the repo does not test shell-out wrappers").
- `packages/core/src/db/schema.ts` — appended `virtualDevices` exactly as §4.5: `id`, `name` (unique), `state`, `consolePort`, `spec` (JSON), `message`, `createdAt`, `startedAt`. No `pid`, no `autoStart`.
- `packages/core/drizzle/0077_outgoing_sally_floyd.sql` + the matching `meta/_journal.json`/`meta/0077_snapshot.json` — a plain `CREATE TABLE virtual_devices (...)` plus its unique index on `name`. **No interactive prompt was needed**: this is a pure creation, not a rename, so `bun run --cwd packages/core db:generate` ran straight through with no pty/pexpect driver required (unlike plan 205's rename case, which the hazard note in my instructions anticipated but which did not apply here).
- `packages/core/src/vm/manager.ts` + `manager.test.ts` — `createVmManager`: `list`/`create`/`start`/`stop`/`remove`/`adopt`. Boot polling every 2 s against `getprop sys.boot_completed`, failing (and killing the child) on timeout rather than leaving the row `starting`. `adopt()` re-derives state from a live port probe only. The cap is read live via `deps.maxConcurrent()` on every `create`. `now()` and `sleep()` are both injectable so the boot-timeout test needs no real wall-clock wait (`sleep` advances a fake clock instantly instead of actually waiting). 7/7 tests pass.
- `packages/core/src/doctor/checks/android-sdk.ts`, registered in `checks/index.ts` (appended at the end, beside `guest-agent`) — reports the SDK tier, whether the emulator binary exists, and the host's implied accelerator (Hypervisor.framework on macOS; `/dev/kvm` on Linux; WHPX named preferred over AEHD on Windows with the 2026-12-31 sunset date). `fail` when the SDK is missing, `warn` when the binary or accelerator is missing, `ok` otherwise. Verified live with `bun run doctor` on this Linux dev machine — printed `[fail] Android SDK ...` with the exact three-tier message, since no SDK is installed here.

### Goal-by-goal verification (commands actually run, output actually read)

- **G1** — `bun test packages/core/src/vm/sdk.test.ts` → `10 pass, 0 fail`.
- **G2** — `bun test packages/core/src/vm/ports.test.ts` → `7 pass, 0 fail`.
- **G3** — `bun test packages/core/src/vm/manager.test.ts` → `7 pass, 0 fail` (includes the two boot tests: resolves on `1`, fails+kills on timeout).
- **G4** — same manager test run covers the three adoption cases (live → running, dead → stopped, `creating` → failed with the restart message); `rg -n "pid" packages/core/src/vm/` matches only the word "any" inside an unrelated sentence in `ports.ts`'s doc comment — no `pid` field or column anywhere in `packages/core/src/vm/`.
- **G5** — the cap test in `manager.test.ts` passes (throws `E_VM_LIMIT` at the cap, lets a `create` through once the live `maxConcurrent()` value is raised); `rg -n "ENKAKU_VM_MAX_CONCURRENT" .env.example` → exactly 1 match.
- **G6** — `test -f packages/core/drizzle/0077_outgoing_sally_floyd.sql` → present; `rg -n '"idx": 77' packages/core/drizzle/meta/_journal.json` → 1 match. **Migration index taken: 77**, confirmed against `_journal.json` (ended at `idx: 76` / `0076_pretty_nemesis`) before generating, matching plan 400 §1.1's prediction exactly.
- **G7** — `bun run doctor` printed `[fail] Android SDK  the Android SDK was not found...` — the row is present and reports correctly on a machine with no SDK installed.
- **G8** — `rg -n "adb connect|declare\(|kill-server" packages/core/src/vm/` → empty (had to phrase one doc-comment in `provider-avd.ts` to avoid literally containing the string "adb connect", since a plain-English explanation of *why nothing calls it* would otherwise trip the same grep the plan uses to prove it).
- **G9** — `bun run typecheck` → clean across every workspace package.
- **G10, G11** — left unticked, `owner` rows, need a real SDK and a real machine.

### Deviations / things the plan did not fully specify, and what was chosen

- The plan's §4.2 error text uses a literal `<abi>` placeholder; I substituted the real derived ABI so the printed `sdkmanager` command is directly runnable. This does not change the tested substrings (the test asserts a prefix up to `google_apis;` and the "Looked in" line, not the trailing ABI token).
- `describeAndroidSdk`'s `detail` string format for the non-missing case (`"<tier label> → <root>"`) is not specified verbatim by the plan; I picked a format that reads well in both the doctor check and any future boot-log caller, following `describeGuestAgentApk`'s own `"<source> → <detail>"` shape.
- The manager's `start(id)` **awaits the full boot-poll loop** before resolving, rather than returning immediately after `VmProvider.start` spawns the process. The plan's own prose only constrains `VmProvider.start` to return once spawned (§4.1's doc comment) — it does not say whether `VmManager.start` must do the same. Awaiting the whole loop inside `VmManager.start` makes G3's behavior directly observable from one `await manager.start(id)` call in tests, and a future HTTP layer (plan 402) is free to not await it if that turns out to be the wrong shape for a request handler — this is called out explicitly in case plan 402's author expects otherwise.
- `VmManagerDeps` gained one field beyond §4.4's listed shape: `sleep?: (ms: number) => Promise<void>`, purely a test seam for the boot-poll interval (defaults to a real `Bun.sleep`). Without it, exercising the boot-timeout path would require either a real multi-second wait per test run or a much more invasive fake-timer setup; this was the smallest addition that keeps the test fast and deterministic while changing nothing about production behavior.
- The doctor check's per-OS accelerator detection cannot tell WHPX from AEHD on Windows from the filesystem alone (nothing published documents a reliable file/registry probe), so it always reports `ok` there and names the WHPX-over-AEHD preference and the sunset date in the text rather than failing or warning. This matches the plan's own R2/K5 caveat that the sunset date is "the single most perishable fact in this table."

### What was NOT done, and why

- G10 and G11 — require a real Android SDK, a real hypervisor, and a real machine; correctly left as `owner` rows, per the plan.
- No HTTP routes, no protocol schemas, no Studio UI, no docs beyond code comments — all explicitly out of scope (§2), reserved for plans 402–404.
- No second `VmProvider` implementation, no registry, no `autoStart` column — plan 400 D7 and Q1 forbid inventing either.

### Anything in the plan that turned out to be wrong about the codebase

- Nothing factual was wrong. The one place the plan's own literal grep (G8's `rg -n "adb connect|declare\(|kill-server"`) required care rather than being simply satisfied: writing an accurate doc comment about *not* calling `adb connect` necessarily risks containing the string `"adb connect"` itself, which the same grep would then flag. `packages/core/src/vm/provider-avd.ts`'s file-header comment was phrased to describe the boundary ("discovery and admission are the existing reconciler's job... nothing here reaches for it or for the adb server directly") without spelling out the literal forbidden call. Future edits to comments in `packages/core/src/vm/` should keep this in mind — the grep is checked as part of every future plan's CI-equivalent (§6 of this plan and G8), not just here.
- `bun run --cwd packages/core db:generate` did **not** need the pty/pexpect driver the "Known hazards" section warned about — that hazard is specific to a RENAME/DROP that drizzle-kit cannot disambiguate without asking. Adding a brand-new table needed no interactive input at all; the generator ran non-interactively and produced 0077 on the first try.

### Test files run (exactly as §7 lists, one at a time, never bare `bun test`)

```
bun run typecheck                                    → clean
bun test packages/core/src/vm/sdk.test.ts            → 10 pass, 0 fail
bun test packages/core/src/vm/ports.test.ts          → 7 pass, 0 fail
bun test packages/core/src/vm/manager.test.ts        → 7 pass, 0 fail
bun run doctor                                       → Android SDK row printed (fail, as expected — no SDK on this box)
```

No process was left running: `ps -Ao pid=,command= | grep -i "[e]mulator"` shows nothing but the grep invocation itself (no real emulator was ever spawned — every test uses a fake `VmProvider`).
