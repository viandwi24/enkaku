# Plan 18 — M11b : Device Event Log (main and input streams)

> Status: not started
> Depends on: Plans 01–16 complete. Independent of Plan 17 — the two may be built in either order.
> Spec references: §10.1 (device states), §13 (protocol), §14 (auth and audit), §15 (retention).

---

## 1. Goals

- A device detail page has a **Logs** tab with two streams: **Main** (lifecycle) and **Input** (every injected action).
- Both streams live-tail over the existing WebSocket and page backwards through history from SQLite.
- The input stream is safe to leave on: it never stores typed text in the clear by default, and it cannot grow without bound.
- Retention is configurable per stream, because their volumes differ by two orders of magnitude.
- Nothing about this makes the hot path slower: writing an event must not sit in front of an input being delivered to the device.

## 2. Non-goals

- Replacing `audit_log`. That table answers "who did what to the farm" for security review (Plan 09); this one answers "what happened to this device". They stay separate — see §3.2.
- Exporting logs to a file or an external sink. Recorded as an open question.
- Job logs. Those already exist as the `job.log` artifact (Plan 05) and keep their own home on the job detail page.
- Cross-device search. The Logs tab is scoped to one device; a farm-wide view can come later.

## 3. Context and design decisions

### 3.1 One table, two streams

The obvious reading of "two logs" is two tables. That would duplicate the schema, the API, the retention job, and the UI, in exchange for nothing — the rows have the same shape. What actually differs between main and input events is **volume** and therefore **retention**, not structure.

So: one `device_events` table with a `stream` discriminator, one index that leads with `(device_id, stream, at)`, and two retention budgets. A merged timeline later becomes a query change rather than a migration.

### 3.2 Why not extend `audit_log`

`audit_log` (Plan 09) is user-centric and security-facing: `userId`, `action`, `target`, indexed by time across the whole farm, retained for a long period. Device events are device-centric, high-volume, and mostly not attributable to a user (a device going offline has no actor). Mixing them would make the security log unreadable and the retention policy impossible to state.

Where an event is *also* security-relevant — someone taking manual control of a device — it is written to both. That duplication is deliberate and cheap.

### 3.3 Input volume is the whole design problem

A person driving a phone produces on the order of 30 taps a minute. A script can produce far more. At 40 000 rows per device per day, an unbounded table becomes the largest thing in the database within a week, and the Logs tab becomes the slowest page in the product.

Three decisions follow:

1. **One gesture, one row.** A swipe is a single event with its start and end point, not the 60 pointer reports that implement it. The UHID and scrcpy input engines already receive whole gestures; log at that level, never at the report level.
2. **Coalescing for text.** Studio already debounces typing into a single `input.text` message; the log inherits that grouping and stores the length, not the keystrokes.
3. **A hard ceiling per device**, enforced by the retention GC: keep the newer of *N days* or *M rows*, whichever bites first.

### 3.4 Typed text is a credential hazard

`input.text` carries whatever the operator typed, which routinely includes passwords and one-time codes. Storing that in a log that any farm user can open is a liability that is very hard to walk back once it is on disk.

Default: store `{ length, sha256Prefix }` and render it as `text (12 chars)`. A per-device setting `logInputText` (default off) opts in to storing the literal text, and turning it on writes an `audit_log` entry naming the user who did it.

### 3.5 Writing must not block input

The `input.tap` handler awaits the device. If it also awaited a SQLite insert, every tap would pay for it. Events go through a small in-process buffer that flushes on a timer or when it fills, using one transaction per flush. A dropped event on a hard crash is an acceptable loss for a log of this kind; a slower tap is not.

### 3.6 Live tail must not spam every client

Broadcasting every input event to every connected client would put a device's log traffic on the WS of people looking at an unrelated page. Clients subscribe explicitly: `log.subscribe { deviceId, streams }`, and the core sends events only to subscribed connections. The subscription dies with the connection.

## 4. Technical design

### 4.1 Schema

`packages/core/src/db/schema.ts`:

```ts
export const deviceEvents = sqliteTable(
  'device_events',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id').notNull(),
    /** 'main' | 'input' — the retention budget follows this (Plan 18 §3.3). */
    stream: text('stream').notNull(),
    /** Dotted kind, e.g. 'device.online', 'input.tap'. */
    kind: text('kind').notNull(),
    /** userId, 'job:<id>', or null when the core itself is the actor. */
    actor: text('actor'),
    /** Kind-specific detail; always an object, never a bare value. */
    meta: text('meta', { mode: 'json' }),
    at: integer('at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('idx_device_events_tail').on(t.deviceId, t.stream, t.at),
    // The GC deletes by age across all devices; give it its own index.
    index('idx_device_events_at').on(t.at),
  ],
)
```

Migration: `bun run --cwd packages/core db:generate` after editing the schema. Do not hand-write the SQL.

### 4.2 Event kinds

`packages/protocol/src/messages/device-event.ts` — the single source of truth for kinds, mirroring the rule that no message strings live outside the protocol package.

**Main stream**

| kind | meta | emitted from |
|---|---|---|
| `device.online` | `{ serial, transport }` | `registry/device-registry.ts` |
| `device.offline` | `{ reason }` | `registry/device-registry.ts` |
| `device.unauthorized` | `{}` | `registry/device-registry.ts` |
| `control.acquired` | `{ clientId }` | `server/ws-handlers.ts` |
| `control.released` | `{ clientId }` | `server/ws-handlers.ts` |
| `control.revoked` | `{ reason }` | `lease/lease-manager.ts` |
| `session.opened` | `{ display, input, inspection }` | `session/manager.ts` |
| `session.closed` | `{ reason }` | `session/manager.ts` |
| `session.degraded` | `{ from, to, reason }` | `session/inspector-factory.ts`, `session.ts` |
| `job.started` | `{ jobId, scriptId }` | `queue/scheduler.ts` |
| `job.finished` | `{ jobId, status, durationMs }` | `jobs/executor-host.ts` |
| `settings.changed` | `{ keys: string[] }` | `api/devices.ts` |
| `battery.warning` | `{ level, temperatureC }` | `device/battery.ts` |

**Input stream**

| kind | meta |
|---|---|
| `input.tap` | `{ x, y, w, h }` (device pixels plus the frame they were mapped against) |
| `input.swipe` | `{ from: {x,y}, to: {x,y}, durationMs }` |
| `input.key` | `{ keycode, name? }` — `name` from `KEYCODES` when it maps |
| `input.text` | `{ length, sha256Prefix }`, or `{ length, text }` when `logInputText` is on |

### 4.3 The recorder

New file `packages/core/src/events/recorder.ts`:

```ts
export interface EventRecorder {
  /** Fire-and-forget. Buffered; never awaited by a request path (§3.5). */
  record(e: {
    deviceId: string
    stream: 'main' | 'input'
    kind: string
    actor?: string | null
    meta?: Record<string, unknown>
  }): void
  /** Flush and stop — called on daemon shutdown. */
  stop(): Promise<void>
}

export function createEventRecorder(deps: {
  db: Db
  /** Fan an event out to subscribed WS clients. */
  publish: (deviceId: string, ev: DeviceEvent) => void
  flushIntervalMs?: number   // default 250
  maxBufferedRows?: number   // default 200
}): EventRecorder
```

Behaviour: `record()` pushes to an array, publishes immediately to subscribers (the UI must feel instant), and schedules a flush. The flush writes the batch in one transaction. On `stop()`, flush synchronously.

### 4.4 Retention

`packages/core/src/maintenance/retention.ts` already runs a GC (Plan 09). Extend it with two budgets read from `FarmSettings.retention`:

```ts
retention: z.object({
  artifactDays: z.number().int().min(1).default(14),      // existing
  eventMainDays: z.number().int().min(1).default(30),
  eventInputDays: z.number().int().min(1).default(3),
  /** Hard ceiling per device per stream; the older rows go first. */
  eventMaxRowsPerDevice: z.number().int().min(1000).default(50_000),
})
```

The GC deletes by age first, then trims any `(device, stream)` pair still over the row ceiling. Log one summary line per run — never one per deleted row.

### 4.5 API

`packages/core/src/api/device-events.ts`, mounted at `/api/devices/:id/events`:

```
GET /api/devices/:id/events
  ?stream=main|input          (required)
  &before=<unix seconds>      (optional cursor; returns rows strictly older)
  &limit=<1..200>             (default 100)
  &kind=<dotted prefix>       (optional filter, e.g. 'input.' or 'job.')
  → { events: DeviceEvent[], nextBefore: number | null }
```

Keyset pagination on `at`, not `OFFSET` — the table is append-heavy and offsets drift while you page.

### 4.6 WS messages

`packages/protocol/src/messages/device-event.ts`:

```ts
export const LogSubscribeMessage = z.object({
  type: z.literal('log.subscribe'),
  id: z.string().optional(),
  payload: z.object({
    deviceId: z.string(),
    streams: z.array(z.enum(['main', 'input'])).min(1),
  }),
})

export const LogUnsubscribeMessage = z.object({
  type: z.literal('log.unsubscribe'),
  payload: z.object({ deviceId: z.string() }),
})

export const DeviceEventMessage = z.object({
  type: z.literal('device.event'),
  payload: DeviceEventSchema,
})
```

`ConnState` in `packages/core/src/server/ws-handlers.ts` gains `logSubs: Map<string, Set<'main'|'input'>>`, cleared on disconnect alongside the stream bindings.

### 4.7 Studio

`packages/studio/src/app/device/page.tsx` gains a `logs` tab in the existing `EntityTabs` (`?tab=logs`), and a new component `packages/studio/src/components/DeviceLog.tsx`:

- A segmented control switches between **Main** and **Input**. Both subscribe; only the selected one renders, so switching is instant and neither misses events.
- Newest at the top. New rows arrive live; a **Pause** toggle freezes the view so a row can be read without it scrolling away, and shows `N new events` while paused.
- Infinite scroll upward through history via the `before` cursor.
- Each row: relative time (ticking, via `useNow` from Plan 17 when present — otherwise a local interval), a kind chip, and a one-line summary rendered per kind. Raw `meta` is available behind a disclosure, not in the row.
- Empty state names the reason: a device with no events yet is different from a stream turned off.

## 5. Implementation steps

### 18.1 Protocol
- [ ] Create `packages/protocol/src/messages/device-event.ts` with `DeviceEventSchema`, the kind constants from §4.2, and the three WS messages.
- [ ] Export from `index.ts`; add `DeviceEventMessage` to `ServerMessageSchema` and the two subscribe messages to `ClientMessageSchema`.
- [ ] Add the retention fields from §4.4 to `FarmSettingsSchema`.
- Result: typecheck passes; `GET /api/settings` exposes the new retention fields.

### 18.2 Schema and migration
- [ ] Add `deviceEvents` to `packages/core/src/db/schema.ts`.
- [ ] `bun run --cwd packages/core db:generate`; commit the generated SQL.
- Result: a fresh `bun run dev` applies the migration; `sqlite3 .dev-data/enkaku.db '.schema device_events'` shows both indexes.

### 18.3 Recorder
- [ ] `packages/core/src/events/recorder.ts` per §4.3.
- [ ] Unit test: 500 `record()` calls produce one flush per batch, not 500 transactions; `stop()` loses nothing.
- Result: the test asserts the buffered write count.

### 18.4 Emit main-stream events
- [ ] Wire `recorder.record` at each site in the §4.2 main table.
- [ ] For `control.acquired` and `control.revoked`, also write the existing `audit_log` entry (§3.2).
- Result: plugging a device in and taking control produces `device.online` then `control.acquired`.

### 18.5 Emit input events
- [ ] Record in the `input.*` branch of `packages/core/src/server/ws-handlers.ts`, after the lease check passes and before awaiting the device, so a rejected input is not logged as if it happened.
- [ ] Implement the text redaction from §3.4, plus the `logInputText` device setting and its `audit_log` entry when enabled.
- Result: a tap in Studio appears in the input stream within ~250 ms; typing shows `text (N chars)`.

### 18.6 API and retention
- [ ] `packages/core/src/api/device-events.ts` per §4.5; mount in `server/http.ts`.
- [ ] Extend the retention GC per §4.4.
- Result: `curl '127.0.0.1:7700/api/devices/<id>/events?stream=main&limit=5'` returns rows; the GC summary appears in the log.

### 18.7 WS subscriptions
- [ ] Handle `log.subscribe` / `log.unsubscribe`; publish only to subscribers; clean up on disconnect.
- Result: two WS clients, only one subscribed — only that one receives `device.event`.

### 18.8 Studio Logs tab
- [ ] `packages/studio/src/components/DeviceLog.tsx` per §4.7.
- [ ] Add the tab to the device page.
- Result: the tab live-tails, pauses, and scrolls back through history.

## 6. Acceptance criteria

1. The device page has a Logs tab with Main and Input streams, each live-tailing without a refresh.
2. Connecting a device, taking control, releasing it, and running a job all appear in Main, in order, with correct actors.
3. A tap, a swipe, a key and typed text all appear in Input; one swipe is one row.
4. Typed text is stored as length plus hash by default; enabling `logInputText` is recorded in `audit_log`.
5. Scrolling up loads older pages via the `before` cursor with no duplicated or skipped rows.
6. A client that has not subscribed receives no `device.event` messages.
7. 10 000 recorded input events do not measurably slow input delivery (see the test plan's timing check).
8. The retention GC brings a device over its row ceiling back under it, and says so in one log line.
9. `bash scripts/typecheck.sh` and `bun test` are green.

## 7. Test plan

**Unit**
- `packages/core/src/events/recorder.test.ts` — batching, flush-on-full, flush-on-stop, no loss.
- `packages/core/src/api/device-events.test.ts` — keyset pagination returns each row exactly once across pages.
- `packages/core/src/maintenance/retention.test.ts` — age budget and row ceiling, per stream.
- Redaction: `input.text` with `logInputText` off never stores the literal string.

**Manual smoke** (`ENKAKU_TEST_DEVICE=1`)

```bash
bun run dev
# open http://127.0.0.1:7700/device?id=<id>&tab=logs
#   take control, tap a few times, type into a field, release control
#   expect Main: control.acquired … control.released
#   expect Input: input.tap ×N, input.text (N chars)
# unplug the device → Main gains device.offline within ~2 s

# input-path timing check: 200 taps with logging on, then compare
# the median round trip against the same run with the recorder disabled.
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The input stream fills the disk on a busy farm. | Two budgets (days and rows per device) enforced by the existing GC, with conservative defaults (3 days / 50k rows). |
| Buffered writes lose events when the core is killed. | Accepted and documented for this log class; `stop()` flushes on a clean shutdown. Security-relevant events also go to `audit_log`, which is written synchronously. |
| Passwords end up in the log anyway via `logInputText`. | Off by default, per device, and enabling it is itself audited. The setting's help text says plainly what it stores. |
| Live tail floods a client that leaves the tab open for hours. | The client renders a bounded window (the newest 500 rows) and drops older ones from memory; history is a query away. |
| Recording inside the WS input handler slows taps. | The recorder never awaits; the timing check in the test plan is an acceptance criterion, not a hope. |

## 9. Open questions

1. Should Main events be farm-wide viewable (an "Activity" page) as well as per-device? Proposed: not in this plan; the table supports it when wanted.
2. Export — JSON-lines download per device and stream, or nothing? Proposed: defer until someone asks; the API already paginates.
3. Should script-driven input be logged to the Input stream at all, or only manual input? Proposed: log both, with `actor = 'job:<id>'`, since "what did the script actually press" is the most common debugging question. This roughly doubles input volume on an automation-heavy farm, which the row ceiling already bounds.
