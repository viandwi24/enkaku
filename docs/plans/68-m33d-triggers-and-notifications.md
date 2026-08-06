# Plan 68 — M33d : Triggers and Notifications — An Agent That Runs While Nobody Is Watching

> Status: implemented — `schedules/runner.ts`'s `fireOnce` branches once, at the top, on whether a `schedule_agent_targets` row exists for the firing schedule (`db/schema.ts`); the script branch below that check is untouched, byte-for-byte, from Plan 62, and both `schedules/runner.test.ts` and `api/schedules.test.ts` keep their pre-68 test bodies unedited (acceptance #2 — verified against git history, not just by inspection). The agent branch (`fireAgentOnce`) shares the same overlap check, jitter, and `schedule_runs` bookkeeping as the script branch, then applies two additional ceilings read fresh every firing from `FarmSettings.scheduledAgents` (`protocol/settings.ts`): a farm-wide 24h output-token spend cap (off by default) and a concurrent-scheduled-runs cap (default 3), both counted ONLY over `agent_threads.origin = 'schedule'` runs (`agent/thread/store.ts`'s `countActiveScheduledRuns`/`spentOutputTokensLast24h`) — structurally incapable of blocking an interactive run, since `postMessage` never calls either function (criterion 7). A firing calls `AgentRunner.runScheduledFiring` (`agent/runner.ts`), which resolves the thread (fresh or reused per `threadMode`), appends the prompt, and starts the run through the exact `launch`/`enqueue` path `postMessage` uses — no parallel execution path. `onApprovalRequired` lives on the THREAD (`agent_threads.on_approval_required`, migration `0034_military_talkback.sql`), defaults `deny`, and is enforced in `loop/run.ts`'s `processPendingCalls`: `'deny'` appends a truthful, `isError` `tool_result` at once, audits `agent.approval.auto-denied`, calls `deps.notifyAutoDenied`, and lets the run continue; `'pause'` is byte-for-byte Plan 66's existing approval gate. Notifications: `notify/store.ts` (the `notifications` table, always written first), `notify/webhook-store.ts` (`webhook_endpoints`, secrets under a new `'webhook'` namespace in the EXISTING `secrets/store.ts` — not a third mechanism), `notify/webhook.ts` (HMAC-SHA256 over `${timestamp}.${body}`, `X-Enkaku-Signature: t=…,v1=…`), `notify/deliver.ts` (one bounded HTTP attempt), and `notify/service.ts` (`createNotifyService`: writes the in-app row before any network attempt; one synchronous, bounded first delivery attempt per requested channel so the capability's return value can truthfully name `delivered`/`failed`; a failed first attempt schedules two backoff retries fully DETACHED — never awaited by `send()` — so they cannot consume the capability's 10s deadline or the agent's step budget beyond that first bounded attempt; `createNotifyRateLimiter` enforces 10/run and 100/hour, agent-scoped, throwing `E_RATE_LIMIT` which `invoke()`'s existing generic error path turns into a failed `tool_result` without failing the run). `capability/notify.ts`'s `notify.send` is the registry entry (`permission: 'notify.send'`, already in `auth/acl.ts`), deriving `source`/`context` from the caller so every agent-run-originated notification carries `{runId}` (criterion 14). REST: `api/notifications.ts` (`GET /api/notifications`, `/unread-count`, `POST /:id/read`, `/read-all`) and `api/webhooks.ts` (farm-admin CRUD, gated by `settings.manage`), both mounted in `server/http.ts`; `api/schedules.ts` gained `workTarget` (a discriminated `{kind:'script'}` / `{kind:'agent'}` body, backward-compatible with the legacy `scriptRef` shape) to its POST/PATCH/`run-now` handlers. Studio: `ScheduleEditorDialog.tsx` gained the target-kind toggle, agent picker, prompt field, thread-mode and approval selectors (each with its consequence stated in plain words per §4.5); `NotificationBell.tsx` (unread count, live via `notification.created`, click-through to the originating thread) is wired into `AppShell.tsx`; Settings gained **Webhooks** (full CRUD, health badges) and **Spend** (schema-driven from `scheduledAgents`'s own `.meta()`) sections; the schedules list/detail pages render an agent target's prompt/thread/approval summary instead of a blank `scriptRef`. `bun run typecheck` is clean across all 11 packages; `bun test` is 2056 pass / 0 fail (baseline 1943 + 113 new, zero regressions) — every new test file uses `agent/provider/fake.ts` or a fake `fetch`, never a real Anthropic or network call. **Inherited vs. authored, recorded rather than blurred:** this plan's core mechanics — the schema, the migration, the scheduler branch, the notify/webhook modules, the capability, the REST routes, and `ScheduleEditorDialog`'s state/data-fetching scaffold — were already present, uncommitted, in the working tree when this pass began (evidently an interrupted earlier attempt at this same plan); this pass (1) found and fixed a real functional gap — `ScheduleEditorDialog.tsx` fetched agents but never rendered the target-kind toggle or agent picker, so `canSubmit`/`body()` never branched on kind and an agent-target schedule could not actually be created or correctly edited from Studio — completed per §4.5; (2) found and filled a real UX gap — Settings had no Webhooks or Spend section at all, and the schedules list/detail pages went blank for an agent target (`scriptRef` is null there) — added and fixed; (3) found that the ENTIRE `notify/` module, `capability/notify.ts`, the webhook/notification REST routes, and the scheduler's agent branch had ZERO test coverage — wrote all of it: `notify/{webhook,store,webhook-store,deliver,service}.test.ts`, `capability/notify.test.ts`, `api/{notifications,webhooks}.test.ts`, `db/migrations/schedule-target-backfill.test.ts`, `protocol/messages/schedule.test.ts` (new files), plus new, purely-appended `describe` blocks in `schedules/runner.test.ts`, `agent/runner.test.ts`, and `api/schedules.test.ts` (existing bodies in all three left byte-for-byte unedited, verified against git history). **Deviations, recorded rather than silent:** (1) §4.1's schema is illustrated as new columns (`target`/`threadMode`/`onApprovalRequired`) directly on `schedules` — implemented instead as a companion table, `schedule_agent_targets` (one row per agent-kind schedule, keyed on `scheduleId`), because `schedules/runner.test.ts` and `api/schedules.test.ts` both build a fully-typed `const row: ScheduleRow = {...}` literal that TypeScript requires to enumerate EVERY column — a new column on `schedules` itself fails both files to compile, which criterion 2 forbids; presence of the companion row is the discriminator `fireOnce` checks before ever reading `schedules.scriptRef`. (2) the `target` migration (step 68.1) converts nothing: every pre-68 row already reads as `{kind: 'script'}` by the companion-table discriminator's own construction, so `db/migrations/schedule-target-backfill.ts` is a marker-guarded report pass (matching Plan 22.0's and Plan 62's pattern) rather than a data rewrite. (3) `ScheduleRunOutcomeSchema` gained `'spend-cap'` as its own outcome, distinct from generic `'error'` — a schedule refused by a farm ceiling is doing exactly what it was configured to do, not malfunctioning. (4) criterion 13's "does not consume the capability's deadline" is met for retries #2/#3 (fully detached, proven by a test asserting `send()` returns in well under a 10s+20s backoff) but NOT for the very first delivery attempt, which is synchronous and bounded to `firstAttemptTimeoutMs` (default 5s, under the capability's 10s deadline) — a deliberate tradeoff, not an oversight: it is what lets the capability's own return value truthfully name `delivered`/`failed` per channel (criterion 9's "check it before reporting that a page went out"), which an all-detached design could not do without either lying about delivery status or making the agent poll for it. (5) Plan 69 is explicitly the fuller notification/webhook interface (filtering, a dedicated page, richer approval-reply UX) — this plan's Studio surface is deliberately the stated minimum. **Not done:** no live `bun run dev` + `bun run dev:studio` browser smoke test with a real cron firing was run (no physical clock-crossing session in this environment); the manual smoke test script in §7 was not executed end-to-end — verified instead via the automated suite above, which exercises the same code paths (scheduler dispatch, webhook signing/retry/backoff, rate limiting, in-app-first ordering) a live run would.
> Ships: packages/core/src/schedules/runner.ts
> Depends on: Plan 66 (runs), Plan 67 (trees — a scheduled run can spawn), Plan 21 (the scheduler this extends rather than replaces), Plan 62 (`ScriptRef`, for the script/agent target split).
> Spec references: §12 (queue and scheduling).

---

## 1. Goals

- A schedule can fire an **agent** as well as a script, through the scheduler that already exists.
- A scheduled agent that finds something can **reach a human** — in Studio and over a webhook.
- Unattended running has a **spend ceiling** that is farm-wide, not only per-run, so a misconfigured schedule cannot bill all night.
- An overlapping firing does something **declared**, not accidental.

## 2. Non-goals

- A new scheduler. Plan 21 already has croner syntax, IANA timezones, overlap policy, jitter, priority, and expiry, and it is tested. This plan adds a target kind to it.
- Email, SMS, or a third-party chat integration. §3.4 explains why webhook plus in-app is the right stopping point.
- Event-driven triggers (device offline, job failed). §9.1.
- The Studio interface for any of this beyond the minimum (Plan 69).

## 3. Context and design decisions

### 3.1 A schedule targets a script or an agent

Plan 62 turned `schedules.scriptId` into `scriptRef`. This plan makes the target a discriminated pair:

```ts
target: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('script'), ref: ScriptRefSchema, params: z.unknown().optional() }),
  z.object({ kind: z.literal('agent'),  agentId: z.string(), prompt: z.string() }),
])
```

Everything else on a schedule — cron, timezone, cluster or device list, concurrency, order, overlap policy, jitter, expiry — applies unchanged to both. That is the point of extending rather than building alongside: an operator learns one scheduling model, and the reaper, the priority queue, and the expiry logic have one implementation.

A schedule with an agent target and a device list passes those devices to the run as its device narrowing (Plan 67 §4.2), so "run this agent against the checkout cluster every night" resolves to an agent that can see exactly those phones and no others.

### 3.2 Each firing gets a fresh thread, by default

`threadMode`, on the schedule:

| | Behaviour | For |
|---|---|---|
| `new` (default) | a new thread per firing | a nightly check: each run is independently readable, and a bad run cannot poison tomorrow |
| `continue` | one long-lived thread | an agent that should remember what it saw yesterday |

`new` is the default because the failure mode of `continue` is silent and expensive: a thread that accumulates for months compacts repeatedly (Plan 66 §3.5), and every firing pays to re-read a summary of a summary. `continue` is genuinely wanted sometimes, so it exists — with a visible message count and a "start a fresh thread" action in Studio.

### 3.3 Overlap, concurrency, and the cost ceiling

Plan 21's overlap policy (`skip` / `queue` / `cancel-previous`) applies as-is. `skip` is the default for agent targets — an agent run has no fixed duration, so `queue` on a five-minute cron with a six-minute agent builds a backlog that never drains.

Two ceilings, because a per-run budget does not bound a schedule that fires a thousand times:

| Ceiling | Default | Behaviour on reach |
|---|---|---|
| farm-wide output tokens per rolling 24 h | unset (off) | scheduled runs are refused with `E_SPEND_CAP` and an event; **interactive runs are not** |
| concurrent scheduled agent runs, farm-wide | 3 | further firings follow their overlap policy |

The first is off by default because a ceiling somebody did not choose, silently stopping their overnight work, is its own failure. But it is offered prominently in settings with the reason attached, because the first time anyone points a five-minute cron at an agent with `maxSteps: 30` they will want it and will not have thought of it in advance.

A person at a keyboard is never blocked by the spend cap. The cap exists for the unattended case; blocking an interactive run would turn a cost control into an outage.

### 3.4 Notification: two channels, and no more

An agent running at 3 a.m. that finds a broken checkout flow needs somewhere to put that. Two channels:

- **In-app** — a row in a notifications table, a bell in Studio, unread counts. Nothing to configure, works for everyone, and is the record even when the other channel fails.
- **Webhook** — a POST to a configured URL with a signed payload. One integration point that reaches Slack, Discord, PagerDuty, or anything else through the tooling an operator already has.

Email and per-service integrations are declined deliberately. Email needs SMTP configuration, deliverability handling, and a bounce story; each chat service needs its own auth and its own message format. A webhook is the seam where the farm's responsibility should end.

`notify.send` is a capability (Plan 63), so it is in the registry, allowlistable per agent, permission-checked, and audited — an agent that should observe but never page anyone simply does not have it.

Rules that keep it from becoming a nuisance:

- Rate-limited per agent (default 10 per run, 100 per hour). Exceeding it is a `tool_result` error, not a failed run.
- Webhook deliveries are attempted three times with backoff, then recorded as failed. **The in-app notification is written first**, so a dead webhook never loses the message.
- The signature is HMAC-SHA256 over the body with a per-endpoint secret in Plan 65's secret store, in an `X-Enkaku-Signature` header, with a timestamp to make replay detectable. A webhook receiver that cannot verify who sent it is an open endpoint.

### 3.5 A scheduled run is an ordinary run

No parallel execution path: a firing creates a thread (or reuses one), appends the prompt as a user message, and starts a run through Plan 66. It has the same budgets, the same approval gate, the same cancellation, the same audit.

The approval gate is the interesting one at 3 a.m., and its behaviour must be chosen rather than inherited by accident. A scheduled run that pauses for approval with nobody watching would sit until it expires (Plan 66 §3.6) and then continue with a denial — an hour of a held thread to reach a conclusion available immediately. So a schedule declares `onApprovalRequired`:

| | Behaviour |
|---|---|
| `deny` (default) | the tool call is denied at once with a truthful `tool_result`; the run continues and can report that it was blocked |
| `pause` | ordinary approval, waits for a human, expires as usual |

`deny` is the default because an unattended run should degrade into a report rather than into a long wait. It also means an injected instruction that reaches a destructive capability at 3 a.m. is refused immediately, with the attempt recorded in a notification — which is a better outcome than either waiting or proceeding.

## 4. Technical design

### 4.1 Storage

```ts
// schedules — replacing plan 62's scriptRef column with a target
target: text('target', { mode: 'json' }).notNull(),      // §3.1, Zod on read
threadMode: text('thread_mode').notNull().default('new'),
threadId: text('thread_id'),                              // set when threadMode = 'continue'
onApprovalRequired: text('on_approval_required').notNull().default('deny'),

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  level: text('level').notNull(),                         // info|warn|error
  title: text('title').notNull(),
  body: text('body'),
  /** { runId?, threadId?, agentId?, deviceId?, jobId? } — makes it clickable. */
  context: text('context', { mode: 'json' }),
  source: text('source').notNull(),                       // 'agent:<id>' | 'system'
  readAt: integer('read_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('idx_notifications_created').on(t.createdAt, t.id)])

export const webhookEndpoints = sqliteTable('webhook_endpoints', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  url: text('url').notNull(),
  /** Secret-store reference, never the secret (plan 65 §4.4). */
  secretRef: text('secret_ref'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Rolling delivery health, so a dead endpoint is visible before someone needs it. */
  lastStatus: text('last_status'),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp' }),
  failureCount: integer('failure_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
```

Migrating Plan 62's `scriptRef` into `target` is mechanical: every existing row becomes `{kind: 'script', ref, params}`. Guarded by a `migration_markers` row, as in Plan 22.0 §4.1.

### 4.2 Scheduler

`packages/core/src/schedule/dispatch.ts` branches once on `target.kind`. The script branch is unchanged, including Plan 62 §3.4's resolve-once-per-firing. The agent branch resolves the thread, appends the prompt, and starts a run.

Both branches share the overlap check, the concurrency ceiling, the spend cap, and the jitter — so a change to any of those cannot apply to one kind and not the other.

### 4.3 `notify.send`

```ts
{
  id: 'notify.send',
  input: z.object({
    level: z.enum(['info', 'warn', 'error']),
    title: z.string().max(200),
    body: z.string().max(4000).optional(),
    /** Endpoint names; omitted ⇒ in-app only. */
    channels: z.array(z.string()).optional(),
  }),
  output: z.object({ notificationId: z.string(), delivered: z.array(z.string()), failed: z.array(z.string()) }),
  permission: 'notify.send',
  lease: 'none',
  deadline: 10_000,
  effect: 'write',
}
```

The output distinguishes delivered from failed channels, so an agent knows whether its page actually went out and can say so in its final report. A notification tool that returns `ok` regardless of delivery is how an on-call rotation discovers a broken webhook during an incident.

### 4.4 Delivery — `packages/core/src/notify/`

Write the in-app row, then attempt webhooks: three attempts, exponential backoff, 10 s per attempt, signed per §3.4. Failures increment `failureCount`; an endpoint over a threshold is surfaced in settings as unhealthy rather than only in a log.

Deliveries run outside the capability deadline — the capability returns as soon as the row is written and the attempts are queued, because a slow webhook should not consume an agent's budget.

### 4.5 Studio (minimum)

The schedule editor gains a target kind toggle, an agent picker with a prompt field, `threadMode`, and `onApprovalRequired` with its consequence in plain words. Settings gains **Webhooks** and a **Spend** section. A bell in the app shell shows unread notifications and links to the run that produced each. The fuller interface is Plan 69.

## 5. Implementation steps

**68.1 — `target` migration** (§4.1), existing schedules converted to `{kind: 'script'}` under a marker.

**68.2 — Scheduler branch** (§4.2), the script path unchanged and its tests unedited.

**68.3 — Thread modes** (§3.2).

**68.4 — Ceilings** (§3.3): spend cap and scheduled concurrency, both applying to scheduled runs only.

**68.5 — `onApprovalRequired`** (§3.5).

**68.6 — Notifications: table, in-app, bell** (§4.4).

**68.7 — Webhooks**: endpoints, signing, retries, health (§3.4).

**68.8 — `notify.send`** (§4.3) with its rate limits.

**68.9 — Studio minimum** (§4.5).

## 6. Acceptance criteria

1. A schedule with an agent target fires a run at the cron time in the schedule's timezone, across a DST boundary.
2. Existing script schedules behave identically after the migration, with their tests unedited.
3. A schedule targeting a cluster narrows the run's devices to that cluster; the agent cannot reach others.
4. `threadMode: 'new'` produces one thread per firing; `'continue'` reuses one and keeps its history.
5. Overlap policy applies to agent targets, defaulting to `skip`; a `skip` is recorded as an event, not silent.
6. The scheduled-concurrency ceiling holds farm-wide; further firings follow their overlap policy.
7. With the spend cap reached, a scheduled run is refused with `E_SPEND_CAP` and a notification — and an **interactive** run started at the same moment still succeeds.
8. `onApprovalRequired: 'deny'` denies immediately with a truthful `tool_result` and lets the run continue; `'pause'` waits and expires as Plan 66 defines.
9. `notify.send` writes an in-app notification even when every webhook fails, and its output names which channels delivered and which did not.
10. A webhook is signed with HMAC-SHA256 and a timestamp; a receiver can verify it; the secret is never returned by any API.
11. A failing webhook is retried three times with backoff and then recorded, with the endpoint marked unhealthy in settings.
12. `notify.send` beyond its rate limit returns an error `tool_result`; the run continues.
13. Webhook delivery does not consume the capability's deadline or the agent's budget.
14. Every notification links to the run that produced it.
15. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** target discriminated union parsing and the migration mapping; thread resolution for both modes; the spend cap distinguishing scheduled from interactive; rate limiting per run and per hour.

**Unit — signing:** a known body and secret produce a known signature; a tampered body fails verification; the timestamp is present and outside a window is rejectable by a receiver.

**Integration:** a schedule firing an agent end to end against a fake provider; overlap `skip` while the previous run is still going; spend cap tripping mid-schedule while an interactive run proceeds; `onApprovalRequired: 'deny'` producing a run that reports being blocked rather than hanging.

**Webhook:** a local receiver asserting signature, retry count, backoff spacing, and the in-app row existing regardless of delivery.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. schedule an agent every minute against one device
# 2. it fires; each firing is its own thread
# 3. give it notify.send with a webhook to a local listener → signed POST arrives
# 4. kill the listener → in-app notification still appears; the endpoint goes unhealthy
# 5. set a low spend cap → scheduled runs refuse, a chat run still works
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A misconfigured schedule bills all night. | The spend cap and scheduled-concurrency ceiling (§3.3), `skip` as the default overlap, and per-run budgets from Plan 65 underneath all of it. The cap is off by default but offered prominently with its reason. |
| A cost control causes an outage. | The cap applies only to scheduled runs; an interactive run is never blocked (§3.3, criterion 7). |
| An unattended run stalls on an approval nobody will answer. | `onApprovalRequired: 'deny'` is the default (§3.5), so the run degrades into a report rather than a wait — and a destructive call reached by injection at 3 a.m. is refused immediately and recorded. |
| A webhook leaks farm information to a wrong URL. | Endpoints are farm-level and admin-managed, agents choose only among configured names, deliveries are signed, and every send is audited through the capability path. |
| Notifications become noise nobody reads. | Rate limits, levels, and links to the originating run. If it still becomes noise the answer is fewer notifications, not a filter — noted rather than pre-solved. |
| `threadMode: 'continue'` grows a thread until every firing is expensive. | `new` is the default, the message count is visible, and Studio offers a fresh thread (§3.2). |

## 9. Open questions

1. Event triggers — "when a device goes offline", "when a job fails twice". Plan 18's device event log is the obvious source and this is clearly wanted eventually. Left out because a trigger vocabulary designed before anyone has used scheduled agents would be a guess.
2. Should the spend cap be per agent as well as farm-wide? One runaway agent currently consumes the whole farm's ceiling.
3. Should a notification be able to *reply* — a human answering an agent's question through the bell, resuming the run? It is the natural join between this plan and Plan 66's approval gate, and it would make an unattended agent genuinely conversational. Deferred: it needs an authentication story for the reply path.
