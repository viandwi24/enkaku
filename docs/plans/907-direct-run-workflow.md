# Plan 907 — Direct-run workflow: a composition its author hands over, not saves

> Status: implemented — the core half. No plugin uses it yet.
> Ships: packages/protocol/src/actions.ts
> Depends on: plan 900 (which declined this, D2), plan 207 (`actions.run`), plan 314 (workflow batches)
> Spec references: §4.8, §12

## 1. Why this exists, having been declined

Plan 900 D2 declined direct-run workflow, and the reasoning was: it adds a
second way to do what `job.run` already does, and it would make the graph engine
a dependency of shipped plugin features — the coupling D1 had just removed.

The owner asked for it anyway, with a use the decline did not consider:

> *"minimal untuk sequence, jadi misalnya warmup dinyalakan itu bisa inject
> direct workflow langsung dijalankan"*

That is not "compose in a graph instead of in code". It is: **a phone's
sequence should be one job with the waits inside it**, rather than N jobs paced
by a router that polls every fifteen seconds. Warm-up today gives a phone four
activities as four jobs; the gaps are `notBeforeAt` stamps the router honours on
its own tick. One workflow job per phone would hold the whole sequence, with its
delays where they belong.

So D2's reasoning was right about AUTHORSHIP and wrong about scope. This plan
takes the narrow thing asked for and nothing else.

## 2. What it is

`run-workflow` may carry the DOCUMENT instead of naming one:

```ts
{ verb: 'run-workflow', target: { deviceIds }, workflowName: 'warmup-sequence', workflowDoc: { … } }
```

`workflowName` stays required and becomes the label — the batch, the jobs and
the run view all show it, and an unnamed thing running on eighty phones is not
something an operator should identify by its node ids.

## 3. What it deliberately is NOT

- **No new capability.** `actions.run` already takes a free `params` record and
  validates it through the full `ActionRequestSchema`. A plugin declaring
  `actions.run` reaches this with the targeting, pacing, batching and audit
  every other workflow run already has. A `workflow.run` capability would have
  been a second door to the same room.
- **No new storage.** The document is not written to the `workflows` table. A
  composition an operator authors is a saved project with a name, a version and
  an editor; one a plugin draws per run is none of those, and saving eighty a
  day would fill the operator's list with rows nobody wrote.
- **No relaxed validation.** The inline document goes through the SAME
  `WorkflowDocSchema` a stored one does — 50 nodes, the structural refinements,
  all of it. A direct run must not be a way round the checks the editor's own
  save goes through.

## 4. Acceptance criteria

| # | criterion | test |
|---|---|---|
| 1 | An inline document runs without the store being consulted | `actions/run.test.ts` — the `workflows` stub is never touched |
| 2 | A named run still reads the store, unchanged | same file |
| 3 | An oversized or empty document is refused at parse | same file |
| 4 | `workflowName` stays required as the label | same file |
| 5 | A plugin reaches it through `actions.run` with no new capability | `capability/actions.test.ts` |
| 6 | A malformed document never reaches `ctx.actions.run` | same file |

The witness for #1 and #2 is the harness's own stubs: `workflows` and
`batchesFor` both throw when touched, so WHICH one throws says whether the store
was consulted.

## 5. Non-goals

- Rewiring SMM's warm-up onto it. The per-activity path is verified on hardware
  (plan 903 §7, plan 904 §6) and works; moving it is a separate decision with
  its own evidence, not a side effect of the mechanism existing.
- A Studio surface for running an unsaved document. Nothing asks for one.

## 6. Risks

| risk | mitigation |
|---|---|
| Plugins start authoring graphs instead of code, reversing plan 900 D1 | D1 is about who AUTHORS; this is about how a sequence is DISPATCHED. The document is still written in TypeScript by the plugin |
| An inline document bloats storage — it is copied onto every member job | Bounded by `WORKFLOW_LIMITS.maxNodes` (50), the same bound a saved one has |

## 7. Open questions

Whether warm-up should actually use it — §5. It needs a measurement (one
workflow job per phone versus four script jobs) that nobody has taken yet.
