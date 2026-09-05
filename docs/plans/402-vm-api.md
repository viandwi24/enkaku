# Plan 402 — VM : Protocol schemas, `/api/vms`, and daemon wiring

> Status: draft
> Ships: packages/core/src/api/vms.ts
> Depends on: plan 401 (the `vm` subsystem it exposes); plan 400 (D2, D6, R5)
> Spec references: §7 (toolchain), §12 (API conventions via `00-overview.md` §4.4)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Five routes exist and validate their bodies through Zod | `GET /api/vms`, `POST /api/vms`, `POST /api/vms/:id/start`, `POST /api/vms/:id/stop`, `DELETE /api/vms/:id` | `bun test packages/core/src/api/vms.test.ts` → all pass | [ ] |
| G2 | Every response parses against its protocol schema | `VmListResponseSchema`, `VmResponseSchema` | `bun test packages/protocol/src/api/vms.test.ts` → all pass | [ ] |
| G3 | Errors map to their documented status codes | `E_VM_NOT_FOUND`→404, `E_VM_LIMIT`→409, `E_VM_NO_PORT`→409, `E_VM_CONFLICT`→409, `E_ANDROID_SDK_MISSING`→503, `E_BAD_REQUEST`→400, `auth.forbidden`→403 | `bun test packages/core/src/api/vms.test.ts` → the error-mapping test passes | [ ] |
| G4 | Mutations require `device.enroll`; listing requires `device.view` | an operator may create and start; a viewer may only list | `bun test packages/core/src/api/vms.test.ts` → the two ACL tests pass | [ ] |
| G5 | The routes are mounted once and constructed once | `app.route('/api/vms', deps.vmRoutes)` in `http.ts`; `createVmRoutes({...})` in `daemon.ts` | `rg -n "'/api/vms'" packages/core/src/server/http.ts` → 1 match; `rg -n "createVmRoutes" packages/core/src/daemon.ts` → 1 match | [ ] |
| G6 | No WebSocket message and no `ws-handlers.ts` edit | 0 matches | `git diff --stat main -- packages/core/src/server/ws-handlers.ts` → empty; `rg -n "vm\." packages/protocol/src/messages/` → empty | [ ] |
| G7 | The VM manager is adopted at boot, exactly once | `adopt()` called from the daemon's start sequence | `rg -n "\.adopt\(\)" packages/core/src/daemon.ts` → 1 match | [ ] |
| G8 | Typecheck is clean | 0 errors | `bun run typecheck` → clean | [ ] |
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

- [ ] G1–G8 pass by their own commands. G9 is an `owner` row and stays open.
- [ ] `bun run typecheck` clean.
- [ ] `git diff --stat main -- packages/core/src/server/ws-handlers.ts` → empty.
- [ ] `rg -n "devices" packages/core/src/api/vms.ts` → no join or lookup of a device row (§3.4).
- [ ] No `any`, no unjustified TODO, in the files created.

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

_To be written by the executing agent, in plan 200 §3.2's format and order._
