# Plan 63 — M32a : The Capability Registry — One Declaration, Three Surfaces

> Status: implemented — 28 capabilities across `packages/core/src/capability/{device-input,device-inspect,device-app,device-files,device-clipboard,device-state,script,job}.ts`, assembled by `capability/index.ts`'s `buildCoreCapabilityRegistry()`. Shared types/errors/JSON-Schema conversion/device-arg schemas live in `packages/protocol/src/capability/`. `invoke()` (`capability/invoke.ts`) is the one door: parse → permission → device grant → lease → readiness → deadline-bounded run → audit, every path audited via a new `capability.invoke` action in `auth/audit.ts`. Three generated surfaces: `POST /api/v1/cap/:id` + `GET /api/v1/cap` (`api/cap.ts`), `GET /api/openapi.json` (`api/openapi.ts`, built once at boot), and hand-rolled JSON-RPC MCP `initialize`/`tools/list`/`tools/call` at `/mcp` (`mcp/server.ts`, given its own `authMiddleware` application in `server/http.ts` since it sits outside `/api/*`). `device.*` capability handlers delegate to `@enkaku/session`'s existing `createDeviceExecutor` through one `CapabilityContext.deviceCall` chokepoint (`capability/context.ts`) — no driver logic was rewritten. `script.*`/`job.*` delegate to `scripts/service.ts` (new, extracted from `scripts/routes.ts` without behaviour change) and the existing `JobService`. Step 63.7 done: `DeviceCallSchema` (`packages/session/src/runner/ipc.ts`) now derives its seventeen `args` shapes from `@enkaku/protocol`'s new `DEVICE_CALL_ARGS` — the SAME schemas the `device.*` capabilities extend with `{ deviceId }` — rather than duplicating them; the pre-existing script/job/session test suite passes with zero test-file edits (baseline 1549 → 1611 passing, all +62 new). `bun run typecheck` and `bun test` are green; manually smoke-tested against a live `bun run dev` boot (`GET /api/v1/cap` → 28 entries, `GET /api/openapi.json` → 28 paths validating as `openapi: "3.1.0"`, `POST /api/v1/cap/device.tap` refusing `E_NEEDS_LEASE`/`E_NO_GRANT` correctly, MCP `initialize`/`tools/list`/`tools/call` all working end to end). **Deviations, recorded rather than silent:** (1) `CapabilityContext` and `CapabilityResult`'s error-code union live in `@enkaku/core`, not `@enkaku/protocol` as §4.1's bullet list suggested — protocol has zero non-Zod dependencies and cannot type driver/session access; only the generic `Capability<I,O,Ctx>`, `AnyCapability`, and the seven refusal codes live in protocol. (2) `device.tap`/`device.find`'s output schemas ship the narrower `{ok:false, reason:'not-found'}` only, NOT the plan's illustrative `rejected-oversized`/`ambiguous`/`bounds`/`matches` — the current driver (`find-guard.ts`, `device-executor.ts`) collapses every non-match into a single `null` (or discards the resolved point for `tap` entirely), and producing the richer shape would have required changing `device-executor.ts`'s behaviour, which step 63.4 forbids. Recorded as the predicted §8 risk, resolved by narrowing (never to `z.unknown()`), not by touching the driver. (3) `job.cancel` requires `job.cancel.any` (admin-only under the static ACL), which is STRICTER than the pre-existing `POST /api/jobs/:id/cancel` route (no permission check at all) — an existing gap the capability closes rather than inherits, left unfixed on the legacy route as out of scope. (4) `device.get`/`.wake`/`.sleep`/`script.*`/`job.*` all declare `lease: 'none'` even though several take a `deviceId`, so `invoke`'s online check never runs for them — `readiness.set` (wake/sleep) and the various services already carry their OWN more precise refusals (`device_offline`, `job_running`, `device_in_use`, ...), and gating on `isDeviceOnline` first would have pre-empted those with a less accurate answer, and would have broken viewing an offline device's record (matching `GET /api/devices/:id`'s existing behaviour).
> Ships: packages/core/src/capability/registry.ts
> Depends on: Plan 61 (the word "agent" must be free), Plan 22.1 (deadlines — a capability without one parks a queue slot forever), Plan 62 (`ScriptRef`, used by the script capabilities).
> **Hard prerequisite for Plans 65–68.** An agent's tool list is generated from this registry; without it, every agent would carry a hand-maintained copy of the device surface.
> Spec references: §7 (drivers), §10.1 (server-authoritative control), §10.2 (leases), §11.3 (crash containment, not a sandbox).

---

## 1. Goals

- **One place** declares every operation the farm can perform: id, input schema, output schema, required permission, lease requirement, deadline, side-effect class, and a description written for a model to read.
- Three surfaces are **generated** from that one declaration and cannot drift from it: the **agent tool list**, an **MCP server**, and an **OpenAPI document**.
- Executing a capability enforces permission, device grant, lease, and deadline **in one place**, so a caller cannot reach a device by picking a softer entrance.
- The script IPC surface (`DeviceCallSchema`) stops being a second, parallel definition of the same operations.

## 2. Non-goals

- Reimplementing any operation. Every entry's handler calls the service that already performs it. If this plan changes what `tap` does, it has failed.
- Exposing the registry publicly on the internet. The OpenAPI document describes the existing authenticated API; it does not open a new unauthenticated one.
- The agent runtime, agent records, or any LLM call. That starts at Plan 65. This plan produces the surface those consume, and is independently useful without them.
- Deleting the WS message protocol. Studio keeps talking over `/ws`; §3.5 explains why that is not a contradiction.

## 3. Context and design decisions

### 3.1 The registry already exists — it is just missing its metadata

`packages/session/src/runner/ipc.ts:20-117` declares `DeviceCallSchema`: a Zod discriminated union of eighteen device operations, each with a `method` literal and an `args` object — `tap`, `swipe`, `scroll`, `fling`, `type`, `key`, `find`, `dump`, `waitFor`, `screenshot`, `app.launch`, `app.forceStop`, `clipboard.get`, `clipboard.set`, `install`, `push`, `pull`.

That is a capability registry. It has ids and validated inputs. What it lacks is everything a *caller who is not a script* needs to use it safely:

| Missing | Why it matters |
|---|---|
| output schema | an agent must be able to reason about what came back; a script just gets a typed return |
| required permission | the job runner's authority is fixed, so the check happens elsewhere; an agent's authority is per-agent |
| lease requirement | the runner always holds a `job` lease, so it never had to ask |
| deadline | Plan 22.1 gave adb deadlines; the *operation* still has no declared budget |
| side-effect class | nothing today needs to know that `pull` reads and `install` writes |
| model-facing description | there has never been a model reading it |

So this plan is not "build a registry". It is "take the registry that exists, give it the six fields it is missing, and make everything else read from it instead of maintaining a parallel copy."

### 3.2 What a capability declares

```ts
export interface Capability<I extends z.ZodType, O extends z.ZodType> {
  /** Stable, dotted, and never reused: 'device.tap', 'script.publish'. */
  id: string
  input: I
  output: O
  /** From `packages/core/src/auth/acl.ts` — the SAME set the HTTP routes use. */
  permission: Permission
  /**
   * 'none'    — no device involved (script.list)
   * 'device'  — needs the device online; no exclusivity (device.screenshot)
   * 'control' — needs the caller to hold the lease (device.tap)
   */
  lease: 'none' | 'device' | 'control'
  /** Milliseconds. Enforced by the executor, not by the handler (plan 22.1). */
  deadline: number
  /**
   * 'read'        — observes; safe to retry, safe to run unattended
   * 'write'       — changes device or farm state; retry may duplicate
   * 'destructive' — hard or impossible to undo (device.install, script.delete)
   */
  effect: 'read' | 'write' | 'destructive'
  /**
   * Written for a model, in English, saying what it does, when to use it,
   * and what it returns. This is a prompt, not a code comment — it is the
   * only thing an agent has to choose by.
   */
  description: string
  handler(ctx: CapabilityContext, input: z.infer<I>): Promise<z.infer<O>>
}
```

`effect` is the field that earns its place later: Plan 65's per-agent policy and Plan 66's approval gate both read it, and neither has to keep its own list of dangerous operations.

### 3.3 Every capability declares an output schema, and that is new work

`DeviceCallSchema` types inputs only; results come back over IPC as whatever the driver returned. For a script that is tolerable — the SDK's TypeScript types cover it at the author's desk.

For an agent it is not. A model reasons about a tool result as data, and an untyped result means the agent's view of the device is whatever shape the driver happened to produce that day. Worse, Plan 60 exists precisely because a script could report success while having done nothing; an agent with an untyped result surface would reproduce that failure with no human reading the log.

So every entry declares its output, and `find` in particular returns an explicit discriminated result rather than `null`-or-node:

```ts
output: z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), node: UiNodeSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(['not-found', 'rejected-oversized', 'ambiguous']), matches: z.number() }),
])
```

This is the structured-result rule the bitorex analysis flagged as its worst defect: that harness decided success by matching English prefixes on a string (`"REJECTED"`, `"File '"`), in four separate places, so a tool whose error message started differently rendered as success. Nothing in Enkaku decides success by reading prose.

### 3.4 One executor, one set of checks

```ts
async function invoke(cap: Capability, ctx: CapabilityContext, raw: unknown): Promise<CapabilityResult>
```

In fixed order, and never skippable by choosing a different entrance:

1. **Parse** `raw` through `cap.input`. Invalid → `E_BAD_INPUT` with the Zod issues. Never an `as`-cast (`CLAUDE.md`).
2. **Permission** — `ctx.actor` holds `cap.permission`, through the existing ACL.
3. **Device grant** — if the input names a device, `ctx.actor` may reach *that* device. For a human this is the existing role check; for an agent it is Plan 65's grant list. The executor asks `ctx.canReachDevice(id)` and does not care which.
4. **Lease** — `'control'` requires the caller to hold it. It is **not** acquired implicitly: a capability that silently takes control would let an agent interrupt an operator mid-gesture. Refusal names the holder, following Plan 59's rule that a precondition is not an error.
5. **Readiness** — a sleeping device is woken through Plan 45's path if the capability needs it, before the deadline clock starts.
6. **Run** under `cap.deadline`. On expiry: `E_DEADLINE`, and the underlying adb call is cancelled through Plan 22.1's mechanism, not merely abandoned.
7. **Audit** — id, actor, device, outcome, duration into the existing audit log. Every invocation, including refusals; a refusal an attacker can generate silently is a probe.

Because all six run in `invoke`, an agent cannot reach step 6 by a different door. There is exactly one door.

### 3.5 Three generated surfaces, and one that is deliberately not generated

| Surface | Generated | Consumer |
|---|---|---|
| Agent tool list | yes — `{name, description, input_schema}` per entry | Plan 66's loop |
| MCP server | yes — `tools/list` and `tools/call` over the registry | external clients, Claude Desktop, other IDEs |
| OpenAPI document | yes — one `POST /api/v1/cap/{id}` path per entry | `GET /api/openapi.json`, for scripts and integrations |
| **Studio's `/ws` protocol** | **no** | Studio |

Studio is not migrated, and that is a decision rather than an omission. `/ws` carries streaming video, input at gesture cadence, and lease changes — traffic shaped by latency, not by request/response. Forcing it through a generic capability envelope would make the interactive path slower to serve a symmetry nobody asked for. The registry and `/ws` share their *implementations*; they do not share their transport.

### 3.6 The public REST surface is versioned from birth

`/api/v1/cap/{id}`, with `POST` for everything including reads. Two reasons: capability inputs are objects and do not survive query-string encoding without an encoding scheme nobody wants to debug, and the safety guidance about never putting sensitive data in URLs applies with force to a farm whose capabilities take device ids, file paths, and clipboard contents.

`GET /api/v1/cap` lists the registry, filtered to what the caller may actually invoke — so the discovery document is not a map of the farm for an unauthorised caller.

### 3.7 The scripts surface migrates; the drivers do not

`DeviceCallSchema` is replaced by a union *derived* from the registry, so the eighteen device operations are declared once. `packages/session/src/runner/child-entry.ts` and `job-runner.ts` keep their IPC framing — only the schema's origin moves.

This is the one migration in the plan that touches a working, tested path, so it is last (63.7), and its acceptance criterion is behavioural: **the existing script test suite passes unchanged**. If a test needs editing to accommodate the registry, the registry is wrong.

### 3.8 The registry is where the injection boundary is written down

An agent reads screenshots, UI dumps, and logcat — all of which an app under test controls, and any of which can contain text addressed to the model. Enkaku's own rule is that content arriving through a tool is data, never instructions.

The registry cannot enforce that on its own, but it is where the two facts that *let* Plans 65–66 enforce it are recorded: `effect`, which says which operations are worth gating, and the description, which is the only place capability text is authored by us rather than by whatever is on the screen. Capability results are returned as structured data (§3.3) rather than prose for the same reason — a JSON object with a `reason` enum is a much poorer carrier for an injected instruction than a free-text status line.

## 4. Technical design

### 4.1 `packages/protocol/src/capability/`

- `types.ts` — `Capability`, `CapabilityContext`, `CapabilityResult`, `CapabilityError`.
- `to-json-schema.ts` — Zod 4 → JSON Schema. Zod 4 has native JSON Schema conversion; use it rather than a conversion library, and pin the dialect the Anthropic tool API and MCP both accept.
- `errors.ts` — `E_BAD_INPUT`, `E_FORBIDDEN`, `E_NO_GRANT`, `E_NEEDS_LEASE`, `E_DEVICE_OFFLINE`, `E_DEADLINE`, `E_INTERNAL`. Every one distinguishable, because "it failed" is not an answer an agent can act on.

### 4.2 `packages/core/src/capability/registry.ts`

A frozen `Map<string, Capability>` built at boot. Two boot-time checks, both fatal, both borrowed from the one genuinely good idea in the bitorex harness:

- **Duplicate id → the process does not start.** A collision discovered on first use is discovered by a user; a collision discovered at boot is discovered by whoever caused it.
- **Dry run: every entry's `input` and `output` convert to JSON Schema successfully.** A Zod construct that will not convert is a runtime failure in an agent's tool list otherwise — visible only when a model happens to call that tool.

### 4.3 Entries, by file

| File | Capabilities |
|---|---|
| `capability/device-input.ts` | `device.tap`, `.swipe`, `.scroll`, `.fling`, `.type`, `.key` |
| `capability/device-inspect.ts` | `device.find`, `.dump`, `.waitFor`, `.screenshot` |
| `capability/device-app.ts` | `device.app.launch`, `.app.forceStop`, `.install` |
| `capability/device-files.ts` | `device.push`, `.pull` |
| `capability/device-clipboard.ts` | `device.clipboard.get`, `.set` |
| `capability/device-state.ts` | `device.list`, `.get`, `.wake`, `.sleep` |
| `capability/script.ts` | `script.list`, `.get`, `.publish` |
| `capability/job.ts` | `job.run`, `.get`, `.list`, `.cancel` |

Plan 64 adds `fs.*`; Plan 67 adds `agent.*`. Each file is one plugin-sized unit — a builder can add a capability by adding one entry and nothing else, which is the property that makes the registry survive contact with future work.

`device.tap` in full, as the shape every other entry follows:

```ts
export const deviceTap: Capability = {
  id: 'device.tap',
  input: z.object({ deviceId: z.string(), target: SelectorSchema }),
  output: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), bounds: BoundsSchema }),
    z.object({ ok: z.literal(false), reason: z.enum(['not-found', 'rejected-oversized', 'ambiguous']), matches: z.number() }),
  ]),
  permission: 'device.control',
  lease: 'control',
  deadline: 15_000,
  effect: 'write',
  description:
    'Tap a UI element on the device, located by selector. Returns the bounds ' +
    'actually tapped so you can verify the right element was hit. Fails ' +
    'without tapping if the selector matches nothing, matches a container ' +
    'filling the screen, or is ambiguous — it never taps a guess.',
  handler: (ctx, { deviceId, target }) => ctx.drivers.input(deviceId).tap(target),
}
```

The description's last sentence exists because of Plan 60: a model that does not know `find` refuses oversized containers will interpret a `rejected-oversized` result as a transient failure and retry it forever.

### 4.4 MCP — `packages/core/src/mcp/server.ts`

MCP over the existing HTTP server at `/mcp`, authenticated by the same session token as everything else. `tools/list` returns the registry filtered by the caller's permissions and grants; `tools/call` goes through `invoke` (§3.4) with no bypass. Resources and prompts are not implemented in this plan — an empty capability list is a valid MCP server, and inventing resources before anything consumes them is speculative.

### 4.5 OpenAPI — `packages/core/src/api/openapi.ts`

Generated at boot from the same map, served at `/api/openapi.json`. Paths, request bodies, and response schemas all come from the entries; the error responses come from `errors.ts` so they are documented once. It is **not** committed to the repo as a checked-in artifact — a generated file in git is a file that will disagree with its generator.

## 5. Implementation steps

**63.1 — Types and JSON Schema conversion** (§4.1), with the boot dry run's converter tested against every Zod construct the existing schemas use.

**63.2 — Registry and boot checks** (§4.2).

**63.3 — `invoke`** (§3.4): all six steps, all seven error codes, audit on every path including refusals.

**63.4 — Device capabilities** (§4.3), handlers delegating to existing drivers. **No driver logic is written in this step.** Output schemas are new; behaviour is not.

**63.5 — Script and job capabilities** (§4.3), delegating to `job-service` and `scripts/routes` and using Plan 62's `ScriptRef`.

**63.6 — REST, OpenAPI, MCP** (§3.6, §4.4, §4.5).

**63.7 — Migrate `DeviceCallSchema`** (§3.7). Last, and the existing script tests must pass **unedited**.

## 6. Acceptance criteria

1. Every capability has all eight fields; a boot-time assertion fails the process if one is missing or empty.
2. Two entries with the same id fail the boot with a message naming the id and both files.
3. Every input and output converts to JSON Schema at boot; a non-convertible schema fails the boot, not a later tool call.
4. `invoke` refuses in the §3.4 order, with a distinct code for each of: bad input, missing permission, no device grant, missing lease, offline device, deadline.
5. A `lease: 'control'` capability called without the lease is refused and **names the holder** — it never acquires the lease implicitly.
6. A capability exceeding its deadline returns `E_DEADLINE` and the underlying adb call is cancelled, not abandoned — the per-device queue depth returns to its prior value.
7. Every invocation appears in the audit log, refusals included.
8. `GET /api/v1/cap` lists only what the caller may invoke; a caller lacking `device.files` does not see `device.push` at all.
9. `POST /api/v1/cap/device.tap` performs the same tap, with the same refusals, as the WS path.
10. `GET /api/openapi.json` validates as OpenAPI 3.1 and contains one path per registry entry.
11. `tools/list` over MCP returns the same filtered list as §6.8; `tools/call` enforces every §3.4 check.
12. No capability result is a bare string; every one is a typed object, and success is never determined by matching text.
13. The pre-existing script/job test suite passes **without edits** after 63.7.
14. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** JSON Schema conversion across every construct in use (discriminated unions, `.optional()`, `.default()`, `.describe()`, unions of literal and number as in `device.key`). Duplicate-id detection. Each of the seven error codes from `invoke`, in isolation.

**Integration:** the same operation invoked through REST, MCP, and the script IPC path produces identical results and identical refusals — a table-driven test over a representative five capabilities, because "three surfaces, one behaviour" is the entire claim of this plan and is worth pinning explicitly.

**Deadline:** a capability wrapping a deliberately-slow adb call returns `E_DEADLINE` and leaves `queueDepth` unchanged afterwards, using the harness Plan 22.1 already built.

**Device-gated (`ENKAKU_TEST_DEVICE=1`):** `device.tap`, `device.find`, `device.screenshot`, `device.install` against real hardware through `/api/v1/cap`, asserting the structured outputs — in particular that `find` on a viewport-sized container returns `{ok: false, reason: 'rejected-oversized'}` and not a node (Plan 60).

**Manual smoke:**
```bash
bun run dev
curl -H "$AUTH" localhost:7700/api/v1/cap | jq '.[].id'          # the whole registry
curl -H "$AUTH" localhost:7700/api/openapi.json | jq '.paths | keys | length'
curl -H "$AUTH" -X POST localhost:7700/api/v1/cap/device.tap \
  -d '{"deviceId":"...","target":{"text":"OK"}}'                 # refused without a lease, naming the holder
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The registry becomes a second implementation and drifts from the drivers. | Handlers are one-line delegations (§4.3), 63.4 forbids writing driver logic, and §6.9/§6.13 pin behavioural identity with the existing paths and tests. |
| A generic REST entrance bypasses a check the WS handler performs. | Every entrance calls `invoke`, and `invoke` owns all six checks (§3.4). The audit assertion (§6.7) catches a path that skipped it. |
| Writing output schemas for eighteen operations uncovers that some drivers return inconsistent shapes. | Likely, and worth knowing — it is the same class of defect Plan 60 found. Where a driver's shape is genuinely wrong, this plan records it and fixes it *in the driver*, not by widening the schema to `z.unknown()`. A schema of `unknown` is a schema that has given up. |
| MCP exposes the farm more widely than intended. | Same authentication, same ACL, same grants; the tool list is filtered per caller (§6.8), and `/mcp` binds where the core binds — a loopback core stays loopback. |
| Deadlines chosen per capability are wrong. | They are declared in one file and visible as data, so they are correctable in one place. Plan 65 makes them settable per agent for the agent path. |

## 9. Open questions

1. Should capabilities declare idempotency so a caller can safely retry? `effect` approximates it; a true idempotency key would let Plan 66 retry a timed-out `device.install` without risking a double install. Deferred until an agent actually hits it.
2. Should the registry carry per-capability rate limits, or is the per-device queue enough? The queue bounds device pressure but not, say, `script.publish`.
3. Should MCP expose `resources` for artifacts and screenshots, so a client can reference them without a tool call? Natural, but nothing consumes it yet.
