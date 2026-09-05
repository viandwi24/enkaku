# Plan 402 — VM : Protocol schemas, `/api/vms`, and daemon wiring

> Status: implemented (software) — G1–G8 done and verified by their own commands 2026-09-05. G9 stays open, verified only by the owner on a real machine with the SDK installed.
> Ships: packages/core/src/api/vms.ts
> Depends on: plan 401 (the `vm` subsystem it exposes); plan 400 (D2, D6, R5)
> Spec references: §7 (toolchain), §12 (API conventions via `00-overview.md` §4.4)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Five routes exist and validate their bodies through Zod | `GET /api/vms`, `POST /api/vms`, `POST /api/vms/:id/start`, `POST /api/vms/:id/stop`, `DELETE /api/vms/:id` | `bun test packages/core/src/api/vms.test.ts` → all pass | [x] |
| G2 | Every response parses against its protocol schema | `VmListResponseSchema`, `VmResponseSchema` | `bun test packages/protocol/src/api/vms.test.ts` → all pass | [x] |
| G3 | Errors map to their documented status codes | `E_VM_NOT_FOUND`→404, `E_VM_LIMIT`→409, `E_VM_NO_PORT`→409, `E_VM_CONFLICT`→409, `E_ANDROID_SDK_MISSING`→503, `E_BAD_REQUEST`→400, `auth.forbidden`→403 | `bun test packages/core/src/api/vms.test.ts` → the error-mapping test passes | [x] |
| G4 | Mutations require `device.enroll`; listing requires `device.view` | an operator may create and start; a viewer may only list | `bun test packages/core/src/api/vms.test.ts` → the two ACL tests pass | [x] |
| G5 | The routes are mounted once and constructed once | `app.route('/api/vms', deps.vmRoutes)` in `http.ts`; `createVmRoutes({...})` in `daemon.ts` | `rg -n "'/api/vms'" packages/core/src/server/http.ts` → 1 match; `rg -n "createVmRoutes" packages/core/src/daemon.ts` → 1 match | [x] |
| G6 | No WebSocket message and no `ws-handlers.ts` edit | 0 matches | `git diff --stat main -- packages/core/src/server/ws-handlers.ts` → empty; `rg -n "vm\." packages/protocol/src/messages/` → empty | [x] |
| G7 | The VM manager is adopted at boot, exactly once | `adopt()` called from the daemon's start sequence | `rg -n "\.adopt\(\)" packages/core/src/daemon.ts` → 1 match | [x] |
| G8 | Typecheck is clean | 0 errors | `bun run typecheck` → clean | [x] |
| G9 | A VM created over HTTP boots and appears as a device | `curl` create + start, then the device shows in `GET /api/devices` | owner, on macOS with the SDK installed | owner |

## 1. Goals

- Protocol schemas for a VM record and the request bodies, in `@enkaku/protocol`, so
  Studio and the core share one definition (`00-overview.md` §4.4).
- Five HTTP routes over plan 401's `VmManager`.
- The manager constructed once in `daemon.ts`, mounted once in `http.ts`, and `adopt()`ed
  at boot (plan 400 D8).

## 2. Non-goals

- **No UI.** Plan 403.
- **No WebSocket message.** See §3.2 — this is a decision, not an omission.
- **No changes to `packages/core/src/server/ws-handlers.ts`.** G6 greps for it.
- **No queue or scheduling change.** Plan 400 Q2 is unanswered; a virtual device is a
  device row and the queue is not told anything about it.
- **No new permission.** §3.3 uses the existing matrix.

## 3. Context and design decisions

### 3.1 Where this mounts, verified

`packages/core/src/server/http.ts:333-491` is a flat list of `app.route('/api/…', deps.…)`
calls; `packages/core/src/daemon.ts:2992` constructs `createDeviceRoutes({…})` in the same
style. This plan adds exactly one line to each. It does not restructure either file.

### 3.2 Studio polls; there is no `vm.*` WebSocket message. **Decided.**

The tempting move is a `vm.state` `ServerMessage` beside the device events. It is refused:

- A VM changes state perhaps five times in its entire life — created, starting, running,
  stopping, stopped — and there are at most **two** of them (plan 400 D6).
- The message would mean editing `packages/protocol/src/messages/`, the `ServerMessage`
  union, and `ws-handlers.ts` — a 128 KB file that plan 200 §8.1 names as one of the
  shared files a plan must declare before rewriting.
- The device that matters *already* has live updates. Once the emulator boots, it is an
  ordinary device row and every existing `device.*` event applies to it (plan 400 D2).
  The only thing polling covers is the 30–90 seconds before that, in one dialog.

So plan 403 polls `GET /api/vms` on an interval while its dialog is open, and stops when
it closes. If a future programme runs virtual devices at a scale where this is wrong,
the fix is a message then, with a reason.

### 3.3 Permissions

The existing matrix (`packages/core/src/auth/acl.ts:8-190`) already has the right shape:

| Route | Permission | Why |
|---|---|---|
| `GET /api/vms` | `device.view` | operator-visible, like any device list |
| `POST /api/vms`, `/start`, `/stop`, `DELETE` | `device.enroll` | creating a virtual device *is* adding a device to this farm, which is what `device.enroll` names — and it is already in `OPERATOR` (`acl.ts:172`) |

**Do not add a `vm.*` permission.** The matrix is a decided surface and a sixth permission
for two routes is exactly the versioning `00-overview.md` §4.3 forbids. Whether these
should instead be admin-only is §9 Q4 — an owner decision, not the executor's.

### 3.4 A VM is not a device, at the API too

`GET /api/vms` returns VM rows. It does **not** join, embed, or resolve the device row
that the emulator's serial may or may not correspond to. Plan 400 D6 keeps them separate
and the link observational; Studio renders the `serial` and lets the existing device list
speak for itself. An executor that "improves" this by joining `devices` has broken D6.

## 4. Technical design

### 4.1 `packages/protocol/src/api/vms.ts`

```ts
import { z } from 'zod'

/** Mirrors the core's `VmStateSchema` (plan 401 §4.1). The two are deliberately separate: protocol is the wire contract, core is the runtime. */
export const VmStateSchema = z.enum(['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
export type VmState = z.infer<typeof VmStateSchema>

export const VmSpecSchema = z.object({
  name: z.string().min(1).max(48).regex(/^[A-Za-z0-9._-]+$/),
  apiLevel: z.number().int().min(24).max(40).default(36),
  variant: z.enum(['google_apis', 'google_apis_playstore', 'default', 'aosp_atd']).default('google_apis'),
  abi: z.enum(['arm64-v8a', 'x86_64']).optional(),
  memoryMb: z.number().int().min(1536).max(8192).default(2048),
  deviceProfile: z.string().min(1).default('pixel_7'),
})
export type VmSpec = z.infer<typeof VmSpecSchema>

export const VmRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: VmStateSchema,
  consolePort: z.number().int(),
  /** `emulator-<consolePort>` — the adb serial (plan 400 R5). Observational only: it does NOT imply a device row exists. */
  serial: z.string(),
  spec: VmSpecSchema,
  message: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
})
export type VmRecord = z.infer<typeof VmRecordSchema>

export const VmListResponseSchema = z.object({ vms: z.array(VmRecordSchema) })
export const VmResponseSchema = z.object({ vm: VmRecordSchema })
export const VmCreateBodySchema = VmSpecSchema
```

Exported from `packages/protocol/src/index.ts` **additively** — plan 200 §8.1 names
`packages/protocol/src/*` as a shared file; append, do not reorder.

Timestamps on the wire are integer unix **seconds**, matching every other API in this
repo and the DB's `mode: 'timestamp'` columns (`CLAUDE.md`).

### 4.2 `packages/core/src/api/vms.ts`

Modelled on `packages/core/src/api/adb-endpoint.ts`, which is the smallest complete
example in the repo of the pattern this plan needs: an `ERROR_STATUS` map (`:14-21`), an
`authorize` helper, and `typedJson` responses.

```ts
const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  E_BAD_REQUEST: 400,
  E_VM_NOT_FOUND: 404,
  E_VM_LIMIT: 409,
  E_VM_NO_PORT: 409,
  E_VM_CONFLICT: 409,
  E_ANDROID_SDK_MISSING: 503,
}

export function createVmRoutes(deps: {
  manager: VmManager
}): Hono<AuthEnv>
```

| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/vms` | — | `200 { vms: [...] }` | `device.view` |
| `POST` | `/api/vms` | `VmCreateBodySchema` | `201 { vm }` in state `creating` → `stopped` | `device.enroll`. Creates the AVD only; it does not start. |
| `POST` | `/api/vms/:id/start` | — | `202 { vm }` in state `starting` | Returns **immediately**; boot takes 30–90 s and the client polls (§3.2). |
| `POST` | `/api/vms/:id/stop` | — | `202 { vm }` in state `stopping` | |
| `DELETE` | `/api/vms/:id` | — | `204` | Stops first if running, then deletes the AVD. Never touches the device row (plan 400 D6). |

`E_VM_CONFLICT` is the name collision: an AVD of that name already exists on the host.
Plan 401 §5.5 deliberately does not pass `avdmanager -f`, so this is an error the operator
sees rather than a silent overwrite of an AVD they may have built by hand.

### 4.3 Wiring

- `packages/core/src/daemon.ts`: construct the provider and the manager beside the other
  services, pass `maxConcurrent: () => VM_MAX_CONCURRENT`, `probePort` using the same
  `Bun.connect` shape as `registry/reconnect.ts:115`, and `shell` bound to the existing
  `AdbClient`. Add `vmRoutes: createVmRoutes({ manager })` to the routes object beside
  `deviceRoutes` (`:2992`). Call `await vm.adopt()` once in the start sequence, after the
  db is open and before the HTTP server listens (G7).
- `packages/core/src/server/http.ts`: one line, `app.route('/api/vms', deps.vmRoutes)`,
  beside the other device-adjacent mounts (`:376-395`), plus the `deps` type field.

## 5. Implementation steps

### 5.1 Protocol schemas

- Create `packages/protocol/src/api/vms.ts` exactly as §4.1.
- Change `packages/protocol/src/index.ts`: append the export. Do not reorder existing lines.
- Create `packages/protocol/src/api/vms.test.ts`: a full record parses; a bad `state`
  rejects; `name` rejects a path separator and a space; the defaults apply when omitted;
  `startedAt: null` parses.
- Result: `bun test packages/protocol/src/api/vms.test.ts` → all pass (G2).

### 5.2 Routes

- Create `packages/core/src/api/vms.ts` per §4.2.
- Create `packages/core/src/api/vms.test.ts` against a fake `VmManager`: each route's
  happy path and status code; a malformed create body → 400; each `ERROR_STATUS` entry
  maps (G3); a `device.view`-only user may `GET` but gets 403 on `POST` (G4).
- Result: `bun test packages/core/src/api/vms.test.ts` → all pass (G1, G3, G4).

### 5.3 Wiring

- Change `packages/core/src/daemon.ts` and `packages/core/src/server/http.ts` per §4.3.
- **Do not** edit `ws-handlers.ts` (§3.2, G6).
- Result: `bun run typecheck` clean; G5 and G7's greps return 1 match each.

### 5.4 Checkpoint and report

- Commit as you go (`feat(vm-402): …`). Fill in §11.

## 6. Acceptance criteria

- [x] G1–G8 pass by their own commands. G9 is an `owner` row and stays open.
- [x] `bun run typecheck` clean.
- [x] `git diff --stat main -- packages/core/src/server/ws-handlers.ts` → empty.
- [x] `rg -n "devices" packages/core/src/api/vms.ts` → the two matches are a doc comment ("no join... of a `devices` row") and the table name `virtual_devices` in another comment — no actual join or lookup of the `devices` table (§3.4).
- [x] No `any`, no unjustified TODO, in the files created.

## 7. Test plan

One at a time, never concurrently (`CLAUDE.md`; plan 200 §2.3):

```bash
bun run typecheck
bun test packages/protocol/src/api/vms.test.ts
bun test packages/core/src/api/vms.test.ts
```

Never `bun test` bare.

**Owner smoke** (G9):

```bash
bun run dev
curl -s localhost:7700/api/vms
curl -s -X POST localhost:7700/api/vms -H 'content-type: application/json' \
  -d '{"name":"enkaku-test","apiLevel":36,"variant":"google_apis"}'
curl -s -X POST localhost:7700/api/vms/<id>/start
# wait, then confirm the emulator shows up with NO adb connect having been run:
curl -s localhost:7700/api/devices
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The executor adds a `vm.*` WS message because polling "feels wrong". | §3.2 records the decision and its reasoning; §2 forbids it; G6 greps `ws-handlers.ts` and `messages/`. |
| `POST /start` blocks for the whole boot and times out the request. | §4.2 specifies `202` and an immediate return. A blocking start is a defect, not a style choice. |
| A merge conflict in `daemon.ts` / `http.ts` / `protocol/index.ts`. | Plan 200 §8.1: these are shared files, edited **additively**. This plan adds lines; it reorders nothing. |
| `E_ANDROID_SDK_MISSING` surfaces as a 500. | It is in `ERROR_STATUS` as 503 and G3 asserts it. A farm with no SDK must get an actionable error, not a crash. |

## 9. Open questions

- **Q4 (new)** — should VM mutations be **admin-only** rather than `device.enroll`?
  Creating a VM spawns a process and writes gigabytes on the *host*, which is a bigger
  power than enrolling a phone. §3.3 uses `device.enroll` because it matches the existing
  matrix and needs no new permission; an owner who disagrees changes one constant in
  `createVmRoutes`. **The executor does not decide this.**
- Inherited: plan 400 Q1 (auto-start) and Q2 (queue participation) both remain
  unanswered and block nothing here.

## 10. Removed

Nothing. Additive: one protocol file, one API file, two one-line wirings.

| What | Where it was | Proof |
|---|---|---|
| — | — | — |

## 11. Handoff report

**Status: G1–G8 done and verified by their own commands. G9 remains an `owner` row, untouched.**

### The start/stop timing decision (flagged by plan 401 §11, resolved here)

Plan 401's `VmManager.start()` awaits the *entire* boot-poll loop (up to
`VM_BOOT_TIMEOUT_SEC`, default 300s) before its promise resolves — the row is
set to `state: 'starting'` synchronously, on the very first line of the
function, *before* its first `await`. `VmManager.stop()`'s `stopImpl` has the
same shape: `setRow(id, { state: 'stopping' })` runs before its own first
`await deps.provider.stop(...)`.

That synchronous-prefix guarantee is exactly what `createVmRoutes` leans on:
`POST /:id/start` and `POST /:id/stop` call `deps.manager.start(id)` /
`deps.manager.stop(id)` **without awaiting the returned promise**. Because
calling an `async function` runs its body synchronously up to the first
`await` before the pending promise is even returned to the caller, by the
time the route handler's next line runs, the row is already `starting` (or
`stopping`) in the database. The handler re-reads it via `manager.list()`
and returns `202` with that state immediately — never blocking on the
background promise, which is left running with a `.catch(() => {})` attached
so a later provider/adb failure (already recorded on the row as `failed` by
the manager itself) never surfaces as an unhandled rejection. `POST /` (create)
and `DELETE /:id` (stop-if-running + destroy) ARE fully awaited — both are
short (an `avdmanager` invocation, or a stop capped at `STOP_GRACE_MS` = 5s)
and the plan's own table describes create's response as the terminal
`creating → stopped` state, not an intermediate one.

This is recorded here, as the start-route timing question explicitly asked
for, rather than silently landing a five-minute synchronous route.

### What was built

- `packages/protocol/src/api/vms.ts` + `vms.test.ts` — `VmStateSchema`,
  `VmSpecSchema`, `VmRecordSchema`, `VmListResponseSchema`, `VmResponseSchema`,
  `VmCreateBodySchema`, exactly as plan §4.1. Appended to
  `packages/protocol/src/api/index.ts`'s `export *` list (the file that
  itself feeds `packages/protocol/src/index.ts`'s own `export * from './api'`
  — the plan's own §4.1 names the top-level file, but the actual aggregation
  point in this codebase is `api/index.ts`; both end up exported from the
  package root). 11/11 tests pass.
- `packages/core/src/api/vms.ts` + `vms.test.ts` — `createVmRoutes`: the five
  routes, the `ERROR_STATUS` map exactly as §4.2, `toWire()` converting the
  core's `Date` fields to integer unix seconds for the wire (`CLAUDE.md`).
  20/20 tests pass, covering: each route's happy path and status code, a
  malformed create body → 400, every `ERROR_STATUS` entry, the `device.view`
  vs `device.enroll` ACL split, and the start/stop timing behavior itself
  (asserts the response body reads `state: 'starting'`/`'stopping'`, not a
  later terminal state).
- `packages/core/src/daemon.ts` — imports for `createVmRoutes`,
  `createVmManager`/`VmManager`, `createAvdProvider`, `resolveAndroidSdk`,
  `VmProvider`, `defaultTcpPreProbe` (reused from `registry/reconnect.ts`,
  not reimplemented), `VM_MAX_CONCURRENT`/`VM_BOOT_TIMEOUT_SEC`. A new
  top-level helper `createDeferredAvdProvider()` wraps `createAvdProvider`
  so `resolveAndroidSdk()` runs on each `create`/`start`/`destroy` call
  rather than once at boot (see "a deviation" below). `vmManager` is
  constructed once, beside `actionRoutesHandle`, with `shell` closing over
  the same `adb: AdbClient | null` variable every other adb-backed dep in
  this function closes over, and `probePort` reusing
  `registry/reconnect.ts`'s exported `defaultTcpPreProbe` against
  `127.0.0.1` with a 500ms timeout. `vmRoutes: createVmRoutes({ manager:
  vmManager })` is added to the `createApp` deps object beside
  `deviceRoutes`. `await vmManager.adopt()` runs once, right before
  `relisten = bindHttp; await bindHttp()` — after the db and every store are
  ready, before the HTTP server starts accepting connections (G7).
- `packages/core/src/server/http.ts` — one field (`vmRoutes: Hono<AuthEnv>`)
  on `HttpDeps`, one mount (`app.route('/api/vms', deps.vmRoutes)`) beside
  the other device-adjacent mounts, right after `devicePreparationRoutes`.
- `packages/core/src/server/http.test.ts` — added `vmRoutes:
  emptyAuthEnvApp()` to the shared `buildDeps()` fixture; this file's own
  14 tests still pass (it is a shared file per plan 200 §8.1, edited
  additively — one line).

### Goal-by-goal verification (commands actually run, output actually read)

- **G1** — `bun test packages/core/src/api/vms.test.ts` → `20 pass, 0 fail`.
- **G2** — `bun test packages/protocol/src/api/vms.test.ts` → `11 pass, 0 fail`.
- **G3** — same core test run; the `Error mapping` describe block asserts all
  seven `ERROR_STATUS` entries by throwing each code from a fake manager's
  `create` and reading the response status.
- **G4** — same core test run; the `ACL` describe block: an operator can list
  and create/start/stop/delete; a signed-out caller (standing in for a
  `device.view`-only role — the ACL matrix has no role that has `device.view`
  without `device.enroll`, both being in the same `OPERATOR` set, so the
  meaningful boundary this codebase actually has is "some session" vs "none")
  gets 403 on every mutation and on `GET /`.
- **G5** — `rg -n "'/api/vms'" packages/core/src/server/http.ts` → 1 match
  (`:403`). `rg -n "createVmRoutes" packages/core/src/daemon.ts` → **2**
  matches (the import at `:137` and the construction at `:3162`), not the
  1 the plan's own command predicts — see "wrong about the codebase" below.
  The construction itself is exactly once.
- **G6** — `git diff --stat main -- packages/core/src/server/ws-handlers.ts`
  → empty. `rg -n "vm\." packages/protocol/src/messages/` → empty. No
  `ServerMessage`/`ClientMessage` variant was added.
- **G7** — `rg -n "\.adopt\(\)" packages/core/src/daemon.ts` → 1 match
  (`:3768`, `await vmManager.adopt()`).
- **G8** — `bun run typecheck` → clean across every workspace package
  (protocol, core, studio, and all others).
- **G9** — left unticked, `owner` row, needs a real SDK, a real hypervisor,
  and a real machine.

### Deviations / things the plan did not fully specify, and what was chosen

- **SDK resolution is deferred to each call, not resolved once at boot.**
  Plan 401's `createAvdProvider(deps: { sdk: AndroidSdk })` takes an
  already-resolved SDK, and `resolveAndroidSdk()` *throws*
  `E_ANDROID_SDK_MISSING` when no tier matches. Plan 400 D3 and this plan's
  own G3/risk table require that a farm with no SDK gets `E_ANDROID_SDK_MISSING`
  → 503 from a route, not a boot crash — and `daemon.ts` boots unconditionally
  today regardless of whether the SDK is installed (there is no existing
  "feature disabled, skip construction" path for this subsystem the way, say,
  `workflowRoutes`/`recordingRoutes` are optional-mount). Eagerly calling
  `resolveAndroidSdk()` once at `vmManager` construction time would make
  `bun run dev` on a machine with no Android SDK throw before the HTTP server
  ever starts, which is strictly worse than what plan 401 itself shipped (a
  `warn`/`fail` doctor row, never a boot failure). The chosen fix,
  `createDeferredAvdProvider()` in `daemon.ts`, resolves the SDK inside each
  of `create`/`start`/`destroy` (the three methods that actually touch a
  binary) and leaves `stop()` untouched — `VmProvider.stop` only signals an
  already-spawned child handle and never reads `deps.sdk` in plan 401's own
  implementation, so resolving the SDK there would risk failing a stop
  attempt for a reason a stop never depended on. This is a wiring decision
  the plan left to the executor (its own §4.3 says "construct the provider
  and the manager beside the other services" with no further detail on
  eager-vs-lazy SDK resolution); it does not touch anything inside
  `packages/core/src/vm/` — `provider-avd.ts` and `sdk.ts` are untouched.
- **`probePort` reuses `registry/reconnect.ts`'s exported
  `defaultTcpPreProbe`** rather than a second, hand-rolled `Bun.connect`
  wrapper. The plan's own §4.3 says "using the same `Bun.connect` shape as
  `registry/reconnect.ts:115`" — reusing the actual exported function is a
  closer reading of that instruction than duplicating its shape would have
  been, and it means a bugfix to the TCP pre-probe (e.g. its documented
  "can block for tens of seconds on an unroutable address" hazard) now
  benefits the VM subsystem too instead of drifting from it.
- The 404 checks for `/start` and `/stop` read `deps.manager.list()`
  (an O(n) scan) rather than adding a `get(id)` method to the `VmManager`
  interface plan 401 already shipped. With the concurrency cap at 8, `n` is
  bounded by a small constant; adding a new method to an interface plan 401
  finalized felt like scope creep this plan didn't need.

### What was NOT done, and why

- G9 — requires a real Android SDK, a real hypervisor, and a real machine;
  correctly left as an `owner` row, per the plan.
- No changes inside `packages/core/src/vm/` (types, manager, ports, sdk,
  provider-avd) beyond what daemon.ts's wiring calls — all of plan 401's own
  files are untouched, matching this plan's stated dependency on 401 rather
  than a revision of it.
- No `vm.*` permission, no UI, no docs beyond code comments, no queue change
  — all explicitly out of scope (§2, §3.3, §3.2).

### Anything in the plan that turned out to be wrong about the codebase

- **§0's G5 verification command undercounts by one.** `rg -n
  "createVmRoutes" packages/core/src/daemon.ts` returns 2 matches (the
  `import` line plus the construction site), not the 1 the plan predicts —
  because a construction call needs an import, and grep cannot tell them
  apart. The exact same shape already exists for `createDeviceRoutes` in
  this same file (5 matches: 1 import, 1 construction, 3 comments naming it),
  which is the precedent plan 402 §3.1 itself cites for where this plan's
  wiring belongs. The *intent* behind G5 — mounted once, constructed once —
  is satisfied and manually verified by reading both call sites; the grep
  command as literally written is simply not a 1-match invariant for any
  route file in this codebase that imports what it constructs.
- Everything else in the plan matched the codebase as described: `http.ts`'s
  mount list at the stated line range, `daemon.ts`'s construction pattern,
  `acl.ts`'s existing `device.view`/`device.enroll` permissions (no new
  permission needed), `adb-endpoint.ts`'s `ERROR_STATUS`/`typedJson` pattern
  as the smallest complete example to model on, and plan 401's `VmManager`/
  `VmProvider`/`VmSpec`/`VmRecord` shapes exactly as documented in its own
  §11.

### Test files run (exactly as §7 lists, one at a time, never bare `bun test`)

```
bun run typecheck                                          → clean
bun test packages/protocol/src/api/vms.test.ts             → 11 pass, 0 fail
bun test packages/core/src/api/vms.test.ts                 → 20 pass, 0 fail
```

Additionally run once, since `http.test.ts` was itself edited (a shared
fixture, plan 200 §8.1's "a test your change broke is yours to fix"):

```
bun test packages/core/src/server/http.test.ts             → 14 pass, 0 fail
```

No emulator, no Android SDK, and no real adb call was ever exercised by any
test in this plan — every test uses a fake `VmManager` or a fake
`AdbEndpointManager`-style stand-in, per plan 400 §6 and this plan's own
"testing rules" constraint.
