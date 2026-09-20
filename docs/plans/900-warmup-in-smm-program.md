# Plan 900 — Warm-up in SMM: the program — who authors a composition, the six decisions, the waves

> Status: draft
> Ships: none — a program document creates no artefact of its own.
> Depends on: plans 300–316 (the Flow programme, whose scope this freezes), 314 (warm-up rotation), 315 (plugin workflows), 316 (sequential sub-groups and phases)
> Spec references: §4.5, §4.6, §4.7, §12

## 1. What this series is

The owner's brief, 2026-09-20, after an internal review with the operators and
the client: the workflow editor is more machinery than the people using this
product ask for, and the warm-up rotation — the one shipped feature built on
it — has become the hardest thing in the plugin to change.

This programme does not delete the workflow feature. It answers a question that
was never asked when the feature was designed, and then puts each existing
piece on the correct side of the answer.

### 1.1 The question: who authors a composition?

Three layers exist, and only the middle one is in dispute:

| layer | who authors it | example | status |
|---|---|---|---|
| **Script** | plugin developer | `instagram/post-video` | settled, works |
| **Composition** | **disputed** | SMM auto-post; SMM warm-up | this programme |
| **Workflow** | the operator | anything no plugin covers | keep, freeze scope |

SMM already contains both answers to the middle row, in the same plugin, for
the same kind of job:

| | auto-post | warm-up rotation |
|---|---|---|
| how it composes | TypeScript (`planDispatch`) | authors a graph document |
| how it dispatches | `ctx.farm.call('job.run', …)` | the workflow engine interprets the graph |
| how it picks a device | plugin code, typed | a string expression |
| when it is wrong | `bun run typecheck` | at runtime, on a phone |
| operator surface | sessions, per-device rows, Retry failed | a schedule, and a run log |

`warmup-rotation.ts` writes canvas coordinates:

```ts
function shuffle(id, title, x, members): Node {
  return { id, title, ui: { x, y: 380 }, enabled: true, kind: 'shuffle', … }
}
```

…and writes its platform rotation as a string to be parsed:

```ts
const PLATFORM = `($device.number + $params.slot + $run.repeat + ${DAY}) % 3`
```

That is TypeScript, spelled as data, so it can sit in a JSON node, so it can be
drawn on a canvas that the flow's own author never opens. The `$run.index` /
`$device.number` trap that CLAUDE.md devotes a paragraph to is a hazard of
exactly this: in plugin code it would be a typed field, and the wrong one would
not compile.

### 1.2 What the evidence says

Four production sessions of 60 posts each were reviewed on 2026-09-18. The
operator used **four controls and two buttons**: platforms, one-per-phone,
shuffled, "8 at a time · 1-30s apart", then Start and Retry failed. No graph was
opened, no expression was written, no node was moved. The only workflow the
product ships is authored in code by the maintainer.

So the graph format is currently paying its cost for an author who does not yet
exist, while the feature that DOES have an author — the maintainer — would be
better served by the language the rest of the plugin is written in.

## 2. The six decisions

### D1 — Warm-up becomes a plugin feature of SMM, not a workflow

`smm/warmup-rotation` is retired as a workflow document and rebuilt the way
auto-post is built: plugin code choosing scripts, dispatching with `job.run`,
owning its own session rows.

Why this and not "make the graph nicer": the composition's author is the
maintainer. Every property the graph gives that author is one they already have
in TypeScript, and several they do not — types, tests, a stack trace, and the
ability to reuse `posts.ts`'s device model rather than re-deriving it.

**What is NOT lost.** The behaviour stays: platform rotation keyed on
`$device.number`, per-phone style draw, shuffled activities, random gaps, scaled
counts, per-phone start jitter. All of it is arithmetic; none of it needs an
interpreter.

**What IS lost, honestly.** An operator can no longer edit the rotation's
STRUCTURE without a release. In practice that meant editing a 20-node graph with
string expressions, which nobody has done. What operators actually tune —
keywords, amount, gaps, slot, like chance — becomes plugin settings, which is a
better surface for that job, not a worse one (D4).

### D2 — Direct-run workflow is NOT built

The proposal was: let a plugin run a workflow without first saving a workflow
project.

Declined, and the reason is the point of this programme. It adds a second way to
do what `trigger()` and `job.run` already do, in order to avoid the cost of a
format whose necessity is what is in question. Building it would make the graph
engine a dependency of shipped plugin features — the exact coupling D1 removes.

If a future need is "run these three scripts on these phones, now", that is an
operator feature about ad-hoc dispatch and needs no graph engine. It is out of
scope here and gets its own plan if it is ever asked for.

### D3 — The workflow feature is frozen at its current scope, and demoted

Kept, because it works and because an operator-authored composition is a real
use once there are operators who want one. Frozen, because nothing shipped may
depend on it:

- no new node kinds, no new expression functions, no editor work in this series;
- **plan 308 (targets and fan-out, D5 of the Flow programme) stays closed.** It
  is the cheapest decision available: not building costs nothing;
- `plugin.workflows` stays in the SDK (other plugins may still ship one), but
  SMM ships none after D1.

### D4 — SMM sessions become typed: `post` and `warmup`

Today `GroupSchema` IS a post session — `videoArtifactIds`, `hashtags`,
`excludes` are all posting concepts. A warm-up session has none of those and has
things a post session does not (keywords, activity mix, like chance).

So the session gains a `kind`, and the two kinds carry their own settings. This
is also what the owner asked for in plain terms: the operator must never wonder
which kind of session they are looking at.

### D5 — SMM's surface becomes multi-view, and the navigation says which is which

`surface.nav` currently declares one item (`Social posts`). It becomes at least
two, so the two session kinds are separate destinations rather than a mode
toggle inside one page.

This is a product decision, not a layout one: the farm is sold on scaling,
sharing and being pluggable, so a plugin's own navigation is part of what a
buyer sees.

### D6 — What carries over from the rotation, by name

These are settled behaviours, not open questions, and every one of them must
exist in the rebuilt feature:

1. **Start jitter** — a random per-phone delay before the first activity.
2. **Platform grouping** — the fleet splits into exact thirds by
   `$device.number`, never by batch position, and shifts daily.
3. **Phases** — running the session N times covers every phone on every
   platform (plan 316's `$run.repeat`, as a plain repeat count).
4. **Behaviour variation** — inside a platform, a weighted draw picks one of
   several activity styles per phone, redrawn per session.
5. **Shuffle and gaps** — activities run in random order with a random gap
   drawn per step; one failing activity does not end the phone's session.
6. **Scaled counts** — an `amount` multiplier over how many videos, reels and
   scrolls, and how long to watch.

## 3. Waves

| wave | plan | what it lands |
|---|---|---|
| 1 | 901 | The session model: `kind` on `GroupSchema`, a `WarmupSettingsSchema`, migration of existing rows, and the reader that keeps old sessions readable |
| 2 | 902 | The warm-up engine in plugin code: rotation, phases, style draw, shuffle, gaps, jitter. `warmup-rotation.ts` is marked superseded but NOT deleted — §6 Q1 is unanswered and a farm may have a schedule pointing at it, so wave 5 removes it |
| 3 | 903 | Dispatch and session rows: per-device, per-platform results; Retry failed; the notes vocabulary that auto-post already has |
| 4 | 904 | Studio surface: the second nav item, the warm-up session page, the settings form — **done**; per-style weighting deferred, see 904 §2 |
| 5 | 905 | Scheduling, docs, and the retirement notice for `smm/warmup-rotation` |

Waves 1–3 are backend and testable without a device. Wave 4 is Studio, verified
by `bun run typecheck` and an owner smoke (Studio has no tests, plan 200 §8.3).

## 4. Non-goals

- Deleting the workflow feature, its editor, or its engine (D3).
- Building direct-run workflow (D2).
- Changing how auto-post works. It is the reference implementation here, not a
  target.
- Any change to the platform packs' own scripts. Warm-up composes what they
  already expose; if a parameter is missing it is added by that pack's own plan.

## 5. Risks

| risk | mitigation |
|---|---|
| A rebuild loses a behaviour the rotation had | §2 D6 lists them by name; wave 2's acceptance is a per-item check against `warmup-rotation.ts` before it is deleted |
| Existing warm-up schedules break on upgrade | Wave 5 keeps the workflow readable and marks it retired rather than removing it from a farm that still runs it |
| Two session kinds double the UI | Wave 4 reuses the post session's components; anything that cannot be shared is stated as such in that plan |
| The programme is used as licence to simplify the wrong layer | Stated here: the batching, pacing and reliability machinery is the product. What is being removed is a way of AUTHORING, not a capability |

## 6. Open questions

1. **Do any farms run `smm/warmup-rotation` on a schedule today?** Decides
   whether wave 5 needs a migration path or only a notice. The owner answers
   from the farms they operate; production access was lost on 2026-09-19, so
   this cannot be read from a database.
2. ~~Should warm-up sessions be resumable like post sessions?~~ **Answered in
   the brief, 2026-09-20**: "pas dijalanin juga ada sesinya, bisa mantau semua
   devices, setiap platform result nya juga jadi mirip kaya auto post juga." So
   a warm-up session carries per-device, per-platform rows that survive a
   restart, exactly as a post session does. Recorded here rather than dropped,
   because it is the decision wave 1's row shape rests on.
