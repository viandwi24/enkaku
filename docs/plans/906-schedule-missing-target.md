# Plan 906 — A schedule whose work target has gone says so

> Status: implemented
> Ships: packages/core/src/api/schedules.ts
> Depends on: plan 95 (`resolvesTo`), plan 314 (workflow targets), plan 900 (which is about to remove a workflow)
> Spec references: §12

## 1. The gap

A SCRIPT schedule has said "this reference no longer resolves" since plan 95,
through `resolvesTo: null` on the response.

A WORKFLOW schedule said nothing. `resolvesTo` is deliberately null for it —
meaning *not applicable*, not *missing* — so a schedule pointing at a deleted
workflow was indistinguishable from a healthy one. It would have found out at
its next firing, except:

**a disabled schedule never fires.** The owner's production farm holds exactly
that: a warm-up schedule kept but disabled, pointing at a workflow plan 900 is
retiring. Under the old behaviour, the day that workflow went, nothing would
have failed and nothing would have said anything — the row would simply have
been wrong for ever.

## 2. What was already safe, and is worth recording

The brief asked that a missing workflow must not produce a fatal error. It does
not, and it did not before this plan:

- **Firing** (`schedules/runner.ts`) wraps dispatch in `try/catch`, records a
  `schedule.failed` audit entry with the code, writes `lastFireOutcome: 'error'`
  and `lastFireDetail`, and broadcasts. Nothing propagates.
- **Run now** (`POST /:id/run-now`) goes through the same `fireOnce`, then
  raises `E_NOT_DISPATCHED` carrying that detail; `app.onError` turns an
  `EnkakuError` into a JSON response. The operator gets a sentence, not a crash.
- **Listing** never resolved the workflow at all, so it could not throw.

So the defect was never a crash. It was silence.

## 3. What this adds

`ScheduleInfo.targetMissing` — computed on every read, never stored, for the
same reason `paramsCompatible` is: a schedule that WILL fail should be visible
the moment the thing it needs goes away.

`workTargetMissing` is exported and pure, so the rule is testable without a
database. A core wired with no workflow store answers `false`: marking every
workflow schedule broken because of how this core was assembled would be a
louder lie than saying nothing.

Studio renders a `missing` chip beside the schedule's name, in the same shape as
the existing `duplicate` chip, with a title that says what to do. Warned rather
than hidden or auto-removed — the schedule is the operator's, and whether to
re-point it or delete it is theirs to decide.

## 4. Acceptance criteria

| # | criterion | test |
|---|---|---|
| 1 | A workflow still present is not missing | `schedules-target.test.ts` |
| 2 | A workflow that has gone is missing | same |
| 3 | A schedule with no workflow target is never missing | same |
| 4 | A core with no workflow store answers `false` | same |
| 5 | The name matches exactly, not by prefix | same |
| 6 | `targetMissing` defaults to `false` for every existing caller | `ScheduleInfoSchema` |

## 5. Test plan

```bash
bun test packages/core/src/api/schedules-target.test.ts
bun test packages/core/src/schedules/
bun test packages/protocol/src/
bun run typecheck && bun run scripts/check-design-tokens.ts
```

## 6. Non-goals

- Disabling or deleting a schedule whose target has gone. It is the operator's.
- Extending this to script targets, which already answer through `resolvesTo`.

## 7. Open questions

None.
