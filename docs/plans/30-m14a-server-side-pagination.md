# Plan 30 — M14a : Server-side Pagination for Every List

> Status: implemented (2026-08-02) — keyset paging; legacy response keys kept for one release
> Ships: packages/core/src/api/pagination.ts
> Depends on: Plans 17–21 complete.
> Spec references: §13 (API conventions), §15 (retention), §16 (NFR).

---

## 1. Goals

- Every list endpoint answers with the same pagination shape, so a caller never has to remember which one uses what.
- No screen loads an unbounded list. A farm with 500 devices, 50 000 jobs, or a month of events opens as fast as an empty one.
- Paging happens in SQL. The client never receives rows it does not display.
- One shared Studio component owns "load more", so eleven tables cannot drift into eleven behaviours.

## 2. Non-goals

- Sorting or filtering beyond what each endpoint already supports. Pagination only.
- Virtualised rendering. Cursor paging is enough at the sizes this product targets; revisit if a screen ever holds thousands of rows at once.
- Changing the job, device, or event schemas.
- Infinite scroll everywhere. See §3.4 — the pattern is chosen per screen, and the component supports both.

## 3. Context and design decisions

### 3.1 The current state, measured

Every list endpoint invented its own answer:

| Endpoint | Today |
|---|---|
| `/api/jobs` | `limit` + `offset` |
| `/api/device-events` | `before` cursor + `limit` |
| `/api/batches` | `before` + `limit` |
| `/api/agents`, `/api/schedules` | `limit` only — no way to reach page two |
| `/api/devices`, `/api/clusters` | `before` only |
| **`/api/artifacts`, `/api/scripts`** | **nothing at all** |

And in Studio, **8 of 11 tables have no pagination whatsoever**: agents, clusters, schedules, schedules/detail, scripts, scripts/detail, settings, batches/detail. They fetch everything and render everything.

This is not a hypothetical problem. `/api/jobs?limit=200` is already the device page's default, and a farm running scheduled batches across a cluster generates jobs continuously.

### 3.2 Keyset, not offset

`OFFSET` is wrong for these tables. They are append-heavy and read newest-first: a row inserted while the operator is on page 2 shifts everything, so page 3 silently repeats or skips rows. Plan 18 already chose keyset paging for events for exactly this reason.

The rule: **order by a monotonic column plus a tiebreaker, and cursor on both.**

For every list here the ordering is `(createdAt DESC, id DESC)` — `id` breaks ties, because unix-second timestamps collide constantly (a batch stamps one `now` across all its jobs, by design; see Plan 20 §4.4).

**Reversed 2026-08-03.** `offset` was removed outright, not deprecated. See the note below.

### 3.3 One envelope

Every list endpoint returns:

```ts
{
  items: T[],
  /** Pass back as `?cursor=` for the next page. Null when this is the last one. */
  nextCursor: string | null,
  /** Total matching rows, when cheap to count. Null when the query cannot say. */
  total: number | null,
}
```

The cursor is opaque to the client: base64 of `${sortValue}:${id}`. Making it opaque means the sort key can change later without breaking a bookmarked page.

**Reversed 2026-08-03.** The legacy keys were removed outright.

The original reasoning — keep both "for one release" so Studio can migrate gradually — assumed a released product with clients in the wild. There is none: this is a pre-1.0 prototype whose only client ships in the same repository, so the compatibility window protects nothing and every endpoint carries a second name for the same array forever. The product owner's rule, and the right one, is that a change replaces the thing it changes rather than sitting beside it.

Removed: the `devices`/`jobs`/`batches`/`schedules`/`runs`/`agents` aliases and the `offset` query parameter, along with the code that implemented OFFSET paging and the test that pinned it. Every response is now `{ items, nextCursor, total }` and nothing else. The same rule applies to anything built from here: no `v2`, no `Legacy*`, no parallel old and new path.

### 3.4 Load-more, not page numbers

Keyset paging cannot jump to "page 7", and page numbers would be a lie on a list that grows while you read it. So the pattern is **load more** — a button, or automatic on scroll for log-like views.

One component, `PaginatedTable`, owns: the cursor state, the load-more control, the loading row, the empty state, and the "N loaded" count. A screen supplies a fetch function and the row renderer.

That also fixes an unrelated defect found in the same audit: `batches/detail` is the only table with no empty state at all.

### 3.5 Realtime and paging must not fight

Several screens append rows from WS events (`job.status`, `device.event`, `batch.status`). Two rules keep that coherent with paging:

- A live row is **prepended** and never counted against the cursor, which only ever moves backwards in time.
- A live row whose id is already loaded replaces in place rather than duplicating.

Without this a job that updates while you are on page 3 appears twice.

## 4. Technical design

### 4.1 Shared helper

`packages/core/src/api/pagination.ts`:

```ts
export interface PageQuery { cursor: string | null; limit: number }
export interface Page<T> { items: T[]; nextCursor: string | null; total: number | null }

/** Parse and clamp `?cursor=&limit=`; limit defaults to 50, max 200. */
export function parsePageQuery(c: Context): PageQuery

/** Encode/decode the opaque `${sortValue}:${id}` cursor. */
export function encodeCursor(sortValue: number, id: string): string
export function decodeCursor(raw: string | null): { sortValue: number; id: string } | null

/** Build the keyset predicate for `ORDER BY <col> DESC, id DESC`. */
export function keysetWhere(cursor: { sortValue: number; id: string } | null, col: SQLiteColumn, idCol: SQLiteColumn)
```

Every endpoint uses these. A list endpoint that hand-rolls its own paging is a review failure.

### 4.2 Endpoints to convert

| File | Endpoint | Sort column |
|---|---|---|
| `api/jobs.ts` | `GET /api/jobs` | `createdAt` |
| `api/devices.ts` | `GET /api/devices` | `label` ASC, `id` — devices are browsed, not tailed |
| `api/artifacts.ts` | `GET /api/artifacts` | `createdAt` |
| `api/agents.ts` | `GET /api/agents` | `createdAt` |
| `api/clusters.ts` | `GET /api/clusters` | `createdAt` |
| `api/batches.ts` | `GET /api/batches` | `createdAt` |
| `api/schedules.ts` | `GET /api/schedules`, `GET /api/schedules/:id/runs` | `createdAt` / `dueAt` |
| `api/device-events.ts` | already keyset — convert to the shared helper and envelope |
| `scripts/routes.ts` | `GET /api/scripts` | `createdAt` |

`/api/devices` is the odd one: it is a browse list sorted by label, not a feed. It still uses the same envelope and the same cursor mechanics, just a different sort column — which is precisely why the helper takes the column as a parameter.

Indexes: verify each sort column has one. `jobs` and `batches` do. Add where missing via `db:generate`, not by hand.

### 4.3 Studio component

`packages/studio/src/components/PaginatedTable.tsx`:

```tsx
<PaginatedTable
  fetchPage={(cursor) => api<Page<JobInfo>>(`/api/jobs?limit=50${cursor ? `&cursor=${cursor}` : ''}`)}
  columns={[...]}
  rowKey={(j) => j.jobId}
  empty={{ title: 'No jobs yet', description: '…' }}
  /** 'button' (default) or 'scroll' for log-like views. */
  loadMore="button"
  /** Prepend a live row without disturbing the cursor (§3.5). */
  liveKey="jobId"
/>
```

Screens to convert: `jobs`, `scripts`, `scripts/detail` (runs), `agents`, `clusters`, `batches`, `batches/detail`, `schedules`, `schedules/detail` (runs), `device` (jobs tab), and `DeviceLog` keeps its own scroll behaviour but adopts the envelope.

## 5. Implementation steps

### 30.1 Shared helper and envelope
- [ ] `packages/core/src/api/pagination.ts` per §4.1.
- [ ] Unit tests: cursor round-trip; a limit above the cap is clamped; a malformed cursor is rejected rather than ignored; keyset predicate ordering.
- Result: helper covered before any endpoint depends on it.

### 30.2 Convert the endpoints
- [ ] One endpoint at a time, in the §4.2 order; keep the legacy key alongside `items`.
- [ ] Deprecate `offset` on `/api/jobs` with a warning log.
- [ ] Add any missing index via `bun run --cwd packages/core db:generate`.
- Result: `curl '…?limit=2'` twice with the returned cursor yields four distinct rows, no repeats.

### 30.3 PaginatedTable
- [ ] Build it per §4.3, including the empty and loading states.
- Result: one component renders a paged table with a working load-more.

### 30.4 Convert the screens
- [ ] The eleven screens in §4.3, `batches/detail` included — it gains the empty state it never had.
- [ ] Wire live-row prepending where the screen already subscribes to WS.
- Result: no screen fetches an unbounded list; `grep` finds no `limit=200` left in Studio.

### 30.5 Sweep
- [ ] Grep for remaining ad-hoc paging and unbounded fetches; remove them.
- Result: every list in the product goes through the helper and the component.

## 6. Acceptance criteria

1. Every endpoint in §4.2 accepts `?cursor=&limit=` and returns `{ items, nextCursor, total }`.
2. Paging a table while rows are being inserted never repeats or skips a row.
3. A limit above the cap is clamped, not honoured; a malformed cursor returns 400.
4. All eleven Studio tables page through the shared component, with consistent empty and loading states.
5. `batches/detail` has an empty state.
6. A live WS row appears immediately without disturbing the cursor, and updating an already-loaded row does not duplicate it.
7. `/api/jobs?offset=` still works and logs a deprecation warning.
8. `bash scripts/typecheck.sh`, `bun test`, and `bun run build:studio` are green.

## 7. Test plan

**Unit**
- `packages/core/src/api/pagination.test.ts` — cursor codec, clamping, rejection, keyset predicate.
- Per-endpoint: seed 5 rows, page with `limit=2`, assert the union is exactly the 5 with no duplicates; insert a row mid-paging and assert no skip.

**Manual smoke**

```bash
bun run dev
A=$(curl -s '127.0.0.1:7700/api/jobs?limit=2')
echo "$A" | jq '.items|length, .nextCursor'
curl -s "127.0.0.1:7700/api/jobs?limit=2&cursor=$(echo "$A" | jq -r .nextCursor)" | jq '.items[].jobId'
# open /jobs, /scripts, /agents, /clusters, /batches, /schedules — each shows Load more, none stalls
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Converting nine endpoints at once breaks Studio mid-flight. | Legacy keys stay alongside `items` for one release; screens convert independently. |
| A missing index turns keyset paging into a table scan. | §30.2 verifies an index per sort column; the manual smoke test on a seeded DB catches the slow ones. |
| `total` is expensive on large tables. | It is nullable by contract. An endpoint that cannot count cheaply returns null and the UI omits the number. |
| Live prepending double-counts against the cursor. | The cursor only moves backwards in time; live rows are tracked by key and replace in place (§3.5). |

## 9. Open questions

1. Should `total` be computed at all, given it costs a second query? Proposed: only where a cheap indexed count exists; null elsewhere.
2. Default page size — 50 everywhere, or per screen? Proposed: 50, overridable per call, capped at 200.
3. Does `/api/devices` want cursor paging at all, or is a farm always small enough to list whole? Proposed: paginate it anyway for consistency; the cost is one shared helper call.
