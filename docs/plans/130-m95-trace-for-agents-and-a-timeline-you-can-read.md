# Plan 130 — M95 : The trace an agent can read, and a timeline a human can

> Status: implemented (software) — **130.1–130.4 land; 130.5 (docs) is not started.** Opened 2026-08-26 after the job trace (plan 128) shipped in v0.1.26 and was exercised on the owner's farm for the first time; §0 is measured against a real failed job, read-only through the browser. **An agent can now read a trace** — `job.trace`, `job.trace.ui` and `job.trace.frame` are capabilities, so the built-in agent and any MCP client reach them through the one `invoke` door with no second implementation and no second permission model. Frames are read **one at a time, by hash, on purpose** (§3.2). **The Timeline's values are reachable again**: the width leak was not the `justify-between` rows this plan first blamed but `TraceFrame`'s unsized `<img>` blowing out a shared CSS Grid track, with an ancestor `overflow-hidden` swallowing the spill — which is why the values were unreachable rather than merely off-screen. **The film strip has a zoom** and a legible minimum thumbnail width. **API tokens are durable**: hashed, named, revocable, always carrying a `userId` so every existing permission check and audit row is unchanged, and wired into BOTH `/api/*` and `/mcp`. **NOT verified on the farm**: §7's re-measurement has not been run, so criteria 4 and 5 — that the 900 px layout is actually fixed, and that 96–200 px thumbnails are actually legible — are **unclaimed**; jsdom performs no layout, so the UI tests assert structure, which is weaker than measurement and is stated as such in §10 item 7. **Two of this plan's own claims were wrong and were corrected by the workers implementing it**: §0.4 named lazy loading where the real mechanism was content-addressed dedupe (and overstated the payload by ~6×), and §0.3 named the wrong cause for a symptom it had measured correctly. Both corrections, and the fourth consecutive registered-but-not-wired near-miss, are in §10.
> Depends on: plan 128 (M93, the job trace itself), plan 63 (§4.3, the capability table `job.*` lives in), plan 77 (§3.6, the `automation` agent plugin), plan 09 (§4.5, sessions and the auth middleware), plan 70 (M65, the agent blob store — why frames are not streamed into an agent's context by default).
> Spec references: §11.3 (the three surfaces and who is trusted), §12 (data model), §19 (Job detail → Timeline).
> Ships: packages/core/src/capability/job-trace.ts

---

## 0. Evidence

Measured on the owner's live farm (v0.1.27) against a real failed job, `6dbe9b47-…`, 125 events / 100 frames, read-only through the browser.

### 0.1 The API is fine — checked, and out of scope

| Endpoint | Result |
|---|---|
| `GET /api/jobs/:id/trace?limit=` | 200 · 125 events · opaque keyset cursor · `{items, nextCursor, total}` |
| `GET /api/jobs/:id/trace/frames/:hash` | 200 · `image/png` · 100 KB · `Cache-Control: private, immutable` |
| `GET /api/jobs/:id/trace/ui/:hash` | 200 · `application/json` · a real `UiNode` (`resourceId`, `bounds`, `clickable`, …) |
| a malformed `:hash` | **400** — the traversal guard holds |

Event mix: 101 `action`, 15 `log`, 8 `phase`, 1 `artifact`. Frame status: 100 `ok`, 2 `failed`, **zero `skipped-busy`** — the capture ceiling of 4 was never saturated on this run.

Worth recording because it is the first field confirmation of a plan-129 fix: the two failed captures carry `meta.captureError` reading `failed after 5ms: … socket connection was closed` and `failed after 0ms: Unable to connect`. Under the old wording both would have claimed `did not respond within 20000ms`, and anyone reading this trace would have gone hunting a timeout that never happened.

### 0.2 An agent cannot read a trace

`packages/core/src/agent/plugins/automation.ts:18` bundles `scriptList, scriptGet, scriptPublish, jobRun, jobGet, jobList, jobCancel`. There is no trace capability of any kind. So the built-in agent can start a job, watch its status, and read its result — and cannot see a single action, frame or UI tree of what actually happened.

That is backwards for the surface it matters most on. `job.get` returns a status and a return value; the trace is the part that explains a failure.

**And this is one change, not three.** `packages/core/src/mcp/server.ts` exposes the capability registry as MCP tools through the same `invoke` door — its own comment calls it *"the third surface reading the one door"*. A capability added here is therefore reachable by the built-in agent **and** by any external MCP client, with no second implementation and no second permission model.

### 0.3 The event panel pushes its own values out of reach

At a 900 px viewport, on the Timeline tab:

```
seq value  → left: 1544px, right: 1559px      (viewport is 900)
document.scrollWidth === document.clientWidth  → cannot scroll to it
```

`phase`, `attempt`, `duration` and `seq` are rendered — they are in the DOM, with correct values — and are unreachable. The rows use `justify-between` inside a panel that inherits the timeline lanes' 1750 px width, and nothing gives that panel a scroller of its own.

This was nearly reported as "the values do not render", which would have sent someone looking in the wrong component. They render; they are pushed off the edge of a container that cannot be scrolled.

The same width leak breaks the rest of the layout at that size: lanes clipped at the card edge with no scrollbar, and the FRAME panel becoming a tall empty box with the screenshot pushed off to the right.

### 0.4 The film strip is not a picture

A frame thumbnail measures **22 × 62 px**, decoded from a 1080 × 1920 PNG. At that size the strip renders as `4(4(4(4(` — the digits of an on-screen countdown, one glyph wide. It cannot be read as a screen, only as a position marker, and it costs a full-size image to be one.

**Corrected after 130.2/130.3's worker checked it — the first version of this section named the wrong mechanism and the wrong number** (§10 item 5). The measurement was 101 `<img>` elements, **15 unique URLs**, 17 requests, 1.4 MB. The coordinator read that as lazy loading. It is not: `git show HEAD` confirms no `loading="lazy"` and no IntersectionObserver anywhere on this path. What actually happens is **content-addressed dedupe** — plan 128 §3.5 names frames by the SHA-256 of their bytes, and a run whose screen barely changes collapses 101 frames onto 15 distinct images, each fetched once and reused from cache for the rest.

So the payload claim was overstated: for this job the whole strip is ~1.3 MB and is already fetched, not 8.5 MB waiting to be pulled. **The real cost scales with visual variety, not frame count** — a run that genuinely changes screen 100 times does fetch 100 full-size PNGs to draw 100 thumbnails 22 px wide.

Legibility is the problem that stands on its own regardless, and it is the one §3.3 solves. (`loading="lazy"` was added anyway during 130.3 — a genuine improvement that the earlier text had wrongly assumed was already there.)

There is no thumbnail endpoint, and this workspace deliberately ships no image codec (`agent/blob/store.ts`: *"no decoding and no image-codec dependency"*), so a server-side resize is not available without taking on that dependency. §3.3 takes the other route.

---

## 1. Goals

1. An AI agent can read a job's trace — its events, one frame, and one UI tree — through the capability registry, and therefore through MCP as well, with no new permission model.
2. A frame is never streamed into an agent's context by accident: reading images is deliberate, one at a time, and bounded.
3. Every value the Timeline renders is reachable at any viewport width, without horizontal page scroll.
4. The film strip is legible: fewer, larger frames, with a zoom the operator controls.
5. The timeline plays back in real time — play/pause with speed control, honouring the real gaps between events.
6. An external agent can authenticate with a durable credential rather than borrowing a browser session.

## 2. Non-goals

- Changing the trace REST API or its storage. §0.1 verified both; this plan reads them.
- Server-side image resizing or a thumbnail endpoint — it needs an image codec this workspace does not ship (§0.4). §3.3 solves legibility without one.
- Streaming a whole trace's frames to an agent. §3.2 is explicit about why.
- Reworking the Timeline's information architecture. The lanes, the scrubber and the detail panel are the right shape; §3.4 fixes how they size, not what they are.

## 3. Context and design decisions

### 3.1 One capability, three surfaces

`job.trace` follows `job.list` exactly — same `defineCapability` shape, same `permission: 'job.view'`, same keyset cursor helpers (`decodeCursor`/`encodeCursor` from `api/pagination`), same `effect: 'read'`. Registering it in the `automation` agent plugin gives the built-in agent a tool; the MCP server picks it up from the registry with no further work.

It is deliberately not a new REST route: one already exists and is verified.

### 3.2 Frames are read one at a time, on purpose

`job.trace` returns events carrying `frameHash`/`uiHash` — identifiers, never bytes. Two narrower capabilities read the payloads:

- **`job.trace.ui`** returns the `UiNode` tree as structured JSON. This is the high-value one for an agent: it is text, it is queryable, and it is exactly what a debugging agent needs to answer "what was on screen".
- **`job.trace.frame`** returns **one** frame, named by hash, as an image. Never a list, never a range.

A capability that returned every frame would put ~8.5 MB of base64 into a context window for a single job, which is not debugging, it is a denial of service against the agent's own attention. The one-at-a-time shape is the design, not a limitation to be relaxed later.

### 3.3 Legibility comes from fewer frames, not smaller ones

The strip renders every frame at whatever width is left over. Inverted: pick a **legible minimum thumbnail width** and let the strip be as wide as it needs, inside the `overflow-x-auto` container it already has. A zoom control (frames-per-screen, or px-per-frame) then lets the operator trade detail against span, which is the control a video editor has and this timeline was asked to resemble.

This also bounds the payload without a codec: at a legible size, fewer thumbnails fit on screen, and lazy loading already means only those are fetched.

### 3.4 The detail panel gets its own width

The panel must not inherit the lanes' intrinsic width. `min-w-0` on the flex/grid child plus its own `overflow-x-auto` where content is genuinely wide (the UI tree) confines the wide thing to the wide box. The `justify-between` rows then lay out against the panel's real width and their values stay on screen.

This is the same rule `CLAUDE.md` already states for the page as a whole — wide content scrolls inside its own container — applied one level down, where it was missed.

### 3.5 A durable credential, and what it is not

Today `Authorization: Bearer <token>` works (`auth/middleware.ts:57`) but validates a **session** token: it expires like a login and is minted by logging in. An external agent therefore has to hold a human's session.

`api_tokens` is a table of hashed, named, revocable credentials with an optional expiry, resolved by the same middleware after the session lookup fails. It carries a user id — a token is always *someone's*, so every existing permission check and every audit row keeps working unchanged. It is not a second identity system and grants nothing a user does not already have.

**The plaintext is shown once, at creation, and never again** — only a hash is stored, the same rule the enrollment token already follows.

### 3.6 What must keep working

- The trace REST routes, byte-for-byte (§0.1 is the regression baseline).
- Session-cookie auth and `Bearer <session>` — the new lookup is additive and runs only when both miss.
- The Timeline's existing behaviour: `(atMs, seq)` ordering, the capture-policy line, the empty-lane explanations, the truncation banner.

---

## 4. Technical design

### 4.1 `packages/core/src/capability/job-trace.ts` (new)

```ts
export const jobTrace = defineCapability({
  id: 'job.trace',
  input: z.object({
    jobId: z.string(),
    kind: z.array(z.enum(['phase','action','log','artifact','progress','assist','error'])).optional(),
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.string().nullable().optional(),
  }),
  output: z.object({ items: z.array(JobTraceEventSchema), nextCursor: z.string().nullable(), total: z.number().int().nonnegative() }),
  permission: 'job.view',
  lease: 'none',
  effect: 'read',
  description: "Read one job's timeline: every device action with its arguments, duration and outcome, plus log lines, phase boundaries and artifacts. Events carry `frameHash`/`uiHash` — read those with job.trace.ui and job.trace.frame.",
})

export const jobTraceUi = defineCapability({
  id: 'job.trace.ui',
  input: z.object({ jobId: z.string(), uiHash: z.string() }),
  output: UiNodeSchema,
  permission: 'job.view',
  effect: 'read',
})

export const jobTraceFrame = defineCapability({
  id: 'job.trace.frame',
  input: z.object({ jobId: z.string(), frameHash: z.string() }),
  // Shape decided during implementation — see §9 Q1. One frame, never a list.
  permission: 'job.view',
  effect: 'read',
})
```

All three read through the same store the REST routes use (`jobs/trace/frame-store.ts`), including its hash and jobId guards.

### 4.2 `api_tokens`

```ts
export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at'),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
})
```

REST: `GET/POST /api/tokens`, `DELETE /api/tokens/:id`, all `requirePermission('user.manage')`. `POST` returns the plaintext once.

---

## 5. Implementation steps

### 130.1 — The trace capabilities
- `packages/core/src/capability/job-trace.ts` per §4.1; register in `agent/plugins/automation.ts`'s `tools()` and extend that plugin's prompt so the agent knows when to reach for them.
- Tests: each capability returns what the REST route returns for the same input; `kind` filters; an unknown job is `job_not_found`; a malformed hash is refused the same way the route refuses it; the MCP server lists the three new tools (follow `mcp/server.test.ts`'s existing shape).
- **Result:** `bun test packages/core/src/capability/ packages/core/src/mcp/` green.

### 130.2 — The detail panel stops leaking width
- `packages/studio/src/components/jobs/trace/` per §3.4.
- Tests: at a narrow container the event values remain within the panel's own box; the UI tree is the thing that scrolls, not the page. Assert on layout intent (the classes/structure that guarantee it), since jsdom does not lay out.
- **Result:** `bun run --cwd packages/studio test src/components/jobs/trace/` green.

### 130.3 — A film strip you can read
- Legible minimum thumbnail width and a zoom control per §3.3.
- Tests: the strip's width scales with zoom; a thumbnail never renders below the legible minimum; the existing frame-status markers survive.
- **Result:** same scoped command green.

### 130.4 — Durable API tokens
- Schema + migration (`bun run --cwd packages/core db:generate`), middleware lookup, REST, and a Settings screen entry.
- Tests: a valid token authenticates; revoked and expired are refused; the plaintext is returned exactly once and only a hash is stored; session auth is unchanged when no token is present.
- **Result:** `bun test packages/core/src/auth/ packages/core/src/api/tokens.test.ts` green.

### 130.6 — Play/pause: the timeline runs in real time

Asked for by the owner mid-plan, 2026-08-26: *"di trace debug timeline jobs saya minta kasih fitur play/pause dong jadi kaya mensimulasikan waktu kaya asli gitu"* — play the run back, not step through it.

The playhead already resolves an instant to a frame, an event and a log window (plan 128 §4.6); this makes that instant advance by itself. Design points that are decisions, not details:

- **Real elapsed time, honouring the real gaps.** `atMs` is the axis (plan 128 §4.3), so a 4-second wait between two taps takes 4 seconds. That is what "kaya asli" means and it is the whole value — a run that *feels* slow in the right places is the finding.
- **Speed multipliers, because a 2m42s job at 1× is not a debugging tool.** 1× / 2× / 4× at least; the observed job ran 162 s.
- **A long idle gap must not look like a freeze.** A 75-second `waitFor` at 1× is 75 seconds of a still frame. Either the playhead visibly keeps moving through it, or the gap is compressed with that compression *shown* — never silently skipped, which would misrepresent the timing the feature exists to convey.
- **Stops at the end** and does not wrap. Playing past the last event is how you learn a run ended, so the final state stays on screen.
- **Scrubbing while playing pauses**, the convention every media player has; do not invent a different one.

Keyboard: space toggles play/pause, the ←/→/Home/End bindings plan 128 added keep working, and the button carries an accessible label reflecting its state.

- **Result:** `bun run --cwd packages/studio test src/components/jobs/trace/` green, including: playing advances the playhead over time; the multiplier changes the rate; pause stops it; the end stops it; a scrub during playback pauses.

### 130.5 — Docs
- `docs/spec.md`: the three capabilities in the agent/MCP surface, `api_tokens` in §12 and the auth section.
- Update this plan's status line; `bash scripts/check-plan-status.sh` passes.

---

## 6. Acceptance criteria

1. The built-in agent can list a job's trace, read one UI tree, and read one frame.
2. The same three appear as MCP tools without any MCP-specific code.
3. No capability can return more than one frame per call.
4. At a 900 px viewport every Timeline value is on screen or reachable by scrolling its own container; the page never scrolls horizontally.
5. A film-strip thumbnail is never narrower than the legible minimum, and zoom changes span.
6. A revoked or expired API token is refused; a valid one authenticates as its user with that user's permissions and nothing more.
7. The trace REST routes behave exactly as §0.1 recorded.
8. `bun run typecheck` passes; every test file touched passes; `docs/spec.md` updated; no process left running.

## 7. Test plan

Unit tests per step. **Needs the farm, and is not claimed until done:** criterion 4 re-measured at 900 px on the real job (§0.3's measurement repeated); criterion 5 judged by eye on a 100-frame trace; criterion 1 driven through the actual agent rather than a unit test.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | `job.trace.frame` becomes the way agents pull whole traces anyway, one call at a time. | Bounded by design (§3.2) and by the agent's own step budget. If it is abused in practice, the answer is a per-run cap, not a wider capability. |
| R2 | API tokens become a second identity system. | A token always carries a `userId`; every permission check and audit row is unchanged (§3.5). |
| R3 | Zoom re-introduces the illegible strip at its lowest setting. | The legible minimum is a floor, not a preference — criterion 5 asserts it. |
| R4 | The width fix moves the overflow somewhere else. | Criterion 4 is measured at a real viewport, not asserted in jsdom. |

## 9. Open questions

1. **How should `job.trace.frame` return an image?** MCP supports image content blocks; the agent runtime has its own blob store (plan 70). Whether a frame should be handed back as base64, as a blob id the agent already knows how to render, or as a URL is a decision for whoever implements 130.1, and should be made from the code rather than guessed here.
2. **Should `job.trace` collapse repeated identical actions** before returning them to an agent? 101 actions is small; a long run is not. Not decided.
3. **Should API tokens carry a scope narrower than their user?** §3.5 deliberately says no for now — the simplest thing that is not a second permission model.

## 10. Notes recorded during execution

1. **The capabilities were registered, listed to the agent, reachable over MCP — and would have refused on a real farm.** `createCapabilityContext` builds `ctx.jobTrace` only when `traceStore` is among its deps, and `daemon.ts`'s `capContextDeps` literal never had it, even though the very same `traceFrameStore` was already being passed to the REST routes and the job runner a few hundred lines away. `job.trace.frame` and `job.trace.ui` would have answered `E_NOT_SUPPORTED` on the owner's farm while every unit test passed, because every unit test builds its own context. Found by 130.1's worker, who correctly refused to reach outside `capability/` to fix it; wired by the coordinator, with a `daemon-wiring.test.ts` guard mutation-tested (removed the line → 1 failure → restored). This is the third time in three plans that the gap between "registered" and "wired" has been the last thing standing, which is why that test file exists.

2. **`job.trace.frame` returns a declared image, reusing `device.screenshot`'s mechanism.** `{ image: base64, format: 'png' }` plus `imageOutputs: [{ dataField: 'image', mediaType: 'image/png' }]` — the existing `ImageOutputDeclaration` contract, which `agent/harness/run.ts` already turns into a stored blob (plan 70) and a real image content block, with size and type checks built in and a boot-time registry check that the declared field exists on the output schema. §9 Q1 asked for a decision made from the code rather than guessed; this is the most conservative answer available — no new URL scheme, no second blob API. **One honest limit**: MCP's `tools/call` path does not perform that conversion and JSON-serialises the base64 as text, exactly as it already does for `device.screenshot`. That is a pre-existing MCP-general gap, not something this plan introduced, and it is not fixed here — an MCP client asking for a frame gets base64 text.

3. **The `job_events` keyset query now exists twice** — once inline in `api/jobs.ts`'s route handler, once in `context.ts`'s `buildJobTraceService.list`. They read the same table under the same `(seq, id)` predicate so they cannot disagree today, but nothing keeps them in step. There was nothing importable to delegate to without editing the route, which was out of 130.1's scope. Worth extracting into a shared helper.

4. **`CapabilityContext.jobTrace` is optional, not required.** Six test files across the workspace hand-build `CapabilityContext` literals and would not compile against a required field. This follows the established `notify?`/`network?` pattern in the same file; the three capabilities refuse with `E_NOT_SUPPORTED` when it is absent — which is precisely what made item 1 above invisible until someone looked at the daemon.

5. **§0.4 named the wrong mechanism, and the coordinator wrote it.** The section claimed lazy loading explained 17 requests for 101 thumbnails. There is no lazy loading in the shipped code — 130.2/130.3's worker checked `git show HEAD` and said so plainly rather than building on the premise. The real cause was in the coordinator's own measurement all along: **15 unique URLs**, because frames are content-addressed and a near-static screen dedupes. The consequence is not cosmetic — the "scrolling pulls ~8.5 MB" figure was wrong by roughly 6×, and a plan that overstates a cost invites the wrong fix. §0.4 now records the correction and what the cost actually scales with.

6. **The width leak's root cause was not where §0.3 pointed.** §0.3 blamed `justify-between` rows inheriting the lanes' width. Tracing it, 130.2's worker found `TraceFrame`'s `<img>` had no explicit width, so as a CSS Grid child its ~1080 px intrinsic size blew out the shared grid track and dragged the detail panel's column with it; an ancestor `overflow-hidden` then absorbed the spillover, which is why the page never scrolled and the values were unreachable rather than merely off-screen. `min-w-0` on both grid children is the fix. The symptom in §0.3 was measured correctly; the cause named there was a guess.

7. **Two limits on 130.2/130.3's evidence, stated by the worker rather than glossed.** jsdom performs no layout (`getBoundingClientRect` returns zeroes), so nothing here reproduces the 900 px reflow — the 130.2 tests assert the structure CSS guarantees the fix from, which is weaker than a measurement. The zoom tests are stronger (they read real inline `style.width` driven by state), but **whether 96–200 px is actually legible on a real screenshot is unverified**; the numbers are a judgment call flagged as such in the code. §7's farm re-measurement is what settles both, and neither criterion 4 nor 5 is claimed until it happens.

8. **The registered-but-not-wired gap, for the fourth plan running — but this time it was named before it bit.** 130.4's brief put `daemon.ts` off limits and told the worker to stop and report the exact wiring line rather than assume someone would notice. It did, and it went further than asked: the wiring is not in `daemon.ts` at all but in `server/http.ts`, which was not on anyone's list. Two `authMiddleware` call sites needed the dep, not one — `/api/*` **and** `/mcp`, and `/mcp` is precisely the caller a durable credential exists for. Wired by the coordinator; `daemon-wiring.test.ts` now asserts both, and the `/mcp` half was mutation-tested (removed → 1 failure → restored).

9. **Two hashing precedents exist and the worker picked the right one deliberately.** The plan said "follow the enrollment token's precedent". The enrollment token (`tunnel/node-auth.ts`) uses argon2id checked by linear scan — right for a one-time redemption against a handful of rows. A session (`auth/service.ts`) uses `sha256` on an indexed unique column, because it is checked on every request against a table that can grow. An API token has the session's shape, not enrollment's, so it takes the session's algorithm while keeping enrollment's *design* (plaintext once, hash forever). The reasoning is in the code, not just here.

10. **A token can only ever be the caller's own.** The plan did not say so. `POST /api/tokens` has no `userId` field, so `user.manage` cannot mint a credential for somebody else, and `list`/`revoke` are scoped the same way. That is the narrowest reading of §3.5's "a token is always someone's", chosen by the worker rather than left to a later argument.

11. **The plan's own §4.2 schema sketch broke a repo rule.** It omitted `{ mode: 'timestamp' }` on `expiresAt`, which `00-overview.md` §4.2 requires for every DB timestamp. The worker did not copy the sketch; it followed the rule and said so.

12. **Criteria 4 and 5 were measured, in a real browser — but not on the farm, and the difference matters.** The farm runs v0.1.27 and does not have these fixes; Studio dev cannot be pointed at it either, because localhost CORS is granted only when `authMode === 'local'` (`server/http.ts:288-297`), and the farm is not on loopback. That is a deliberate closure, not an obstacle to route around. So the measurement was taken against a **local dev core with a synthetic trace** shaped like the observed one (103 events, 15 unique frames, one deliberate 75 s idle gap).

    Squeezing the content column 1534 → 900 px: the `dd` values moved with it (right 1752 → 1118), `valuesEscapingContainer: 0`, and the page still does not scroll horizontally. The lanes measured `clientWidth 858 / scrollWidth 12617` with `overflow-x: auto` — the wide thing scrolling in its own box, which is the rule §3.4 applies. That 12617 px is **eight times** the 1750 px that used to break the layout, so the fix holds under a far more extreme condition than the original bug. Thumbnails render at **118 px**, up from 22 px.

    Play/pause verified the same way: `Home` → `aria-valuenow: 0`, two seconds of playback → `3`, pause → held at `3` through two further checks.

    **What this does NOT establish**: whether 118 px is legible on a *real* screenshot (the fixture's PNGs are headers only — they size correctly and render nothing), and whether a moving marker reads as "not frozen" to a human through a real 75 s gap. Both are perceptual and both still need the farm once these changes are deployed. Criterion 5 stays unclaimed.
