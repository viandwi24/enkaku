# Plan 903 — Warm-up in SMM, wave 3 : rows, dispatch and the tick

> Status: implemented — verified end to end on hardware (see §7.1).
> Ships: plugins/social-media-manager/src/warmup-runs.ts
> Depends on: plan 900 (D1, D4, D6), plans 901, 902
> Spec references: §4.7, §12

## 1. Goals

- A warm-up session has rows an operator can watch: one per phone per phase,
  carrying the activities that phone drew and what each one did.
- The router sends them, settles them, and never takes a phone out from under a
  real upload.
- `Retry failed` means on a warm-up what it means on a post session.

## 2. Non-goals

- Studio (wave 4). This wave is verified through the action, the rows and the
  logs.
- Removing `smm/warmup-rotation` (wave 5).

## 3. Design decisions

### 3.1 A row is per PHONE; a post row is per VIDEO

The row follows the question. A post session asks "where did this video get
to", so its row is a video and its columns are platforms. A warm-up session
asks "what did this phone do". Forcing one shape onto both would give the
operator a table whose rows mean different things on different pages.

### 3.2 The phase is in the KEY, not only in the row

`warmup:<groupId>:<phase>:<deviceId>`. A session with three phases gives one
phone three separate pieces of work; one key per phone would make each phase
overwrite the last. The first cut keyed the phase into the group id instead,
which silently broke the session prefix — caught by its own test.

### 3.3 There is no `unverified`

A post can be one, because pressing Upload and knowing it landed are different
things, and re-sending one that landed duplicates it on a real account.
Scrolling a feed twice is a phone using an app twice, so a warm-up retry is
always safe and the state does not exist here.

### 3.4 Posting wins a tie

The warm-up pass runs LAST in a tick and is handed the phones the post pass
already claimed. A warm-up is the lowest-value work on the farm and now behaves
like it. A busy, offline or departed phone is skipped rather than failed: a
warm-up has no deadline to miss, so the step keeps its place.

### 3.5 A dispatch that threw is never recorded as queued

A row claiming a job that does not exist would wait for an answer for ever,
which is the one failure a reconciler cannot recover from by itself.

### 3.6 Not capped by concurrency

The spread is the start jitter. A second cap on top would hold a phone past its
turn and stretch the operator's gaps into whatever the queue happened to be
doing.

## 4. Acceptance criteria

| # | criterion | where |
|---|---|---|
| 1 | One row per phone per phase, keys distinct | `warmup-runs.test.ts` |
| 2 | Steps due at session start + offset, not "now + gap" | same |
| 3 | One activity at a time, in order, on the clock | `nextStep` tests |
| 4 | A failed activity does not stop the ones after it | same |
| 5 | Every state reachable; a mid-scroll phone reads `running` | `warmupRunState` tests |
| 6 | A phone claimed by the post pass is left alone | `warmup-tick.test.ts` |
| 7 | Busy/offline/departed phones are skipped, keeping their place | same |
| 8 | Retry re-queues only failures, now, forgetting the old job | `retryFailedSteps` tests |

## 5. What the wave found

Two defects, both caught before hardware:

- the roll-up counted a phone with a job already out on it as `waiting`, which
  reads as "this phone has not started" while it is mid-scroll. The
  session-counts test saw it; the per-state tests did not.
- the run key put the phase inside the group id, which broke the session prefix
  read.

## 6. Test plan

```bash
cd plugins/social-media-manager && bun test src/            # 359 tests
bun run typecheck
```

## 7. Hardware verification

### 7.1 The round trip, on a real phone

Run against the local core (`bun run dev`) with a moto g06 power attached,
2026-09-20. `smm@0.52.0` installed through `POST /api/plugins`, verified and
activated; one warm-up row written straight into the plugin's KV so the ROUTER
was what had to work:

```
row written                       warmup:g-test-1:0:fcf03c6a…
+10s   router pass dispatched     youtube/check-profile@latest {maxRows: 5}
       job on the phone           running → success
       settle loop closed the row step=success, settledAt stamped
                                  run=done
                                  summary "youtube — all 1 activities done"
```

Dispatch, settle and roll-up all exercised against a real device and a real
job, not a fake.

### 7.2 The planner, against the real fleet

The attached phone carries `tiktok` and `youtube` and **not** `instagram`.
Planning three phases for it produced `youtube`, `tiktok`, `youtube` — never
instagram — which is plan 902's platform rule holding on real labels rather
than on a fixture. The same run showed `tiktok/keyword-videos` receiving
`keywordBoostFactor` and no `likeProbability`, which is 902's dispatch fix.

### 7.3 What is NOT verified here

The `add-warmup` member itself was not run: it is a script member and scripts
are dispatched over the WS protocol, which this check drove around by writing
the row directly. Its planning path is the same `planWarmup` verified in §7.2;
its storage writes are covered by `runsFromPlan`'s tests. Wave 4 runs it for
real from Studio.

## 8. Risks

| risk | mitigation |
|---|---|
| A warm-up starves posting on a small farm | The pass runs last and respects the post pass's claims; §3.4 |
| A phase overlaps the one before it | `add-warmup` starts each phase after the slowest plan of the one before, plus a gap and a jitter |

## 9. Open questions

None new.
