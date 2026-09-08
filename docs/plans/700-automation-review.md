# Plan 700 — Automation : a review of the scripts-and-workflows concept, and where the next programme should go

> Status: review — a critique and a research agenda, not a milestone plan. Nothing here is decided; §7 names what the owner must decide before any of it is executed.
> Ships: none — this is a review document, not a milestone plan.
> Depends on: plans 200 (closed), 300 (waves 0–5 implemented; 308 draft), 313 (implemented)
> Spec references: §4.5, §4.6, §4.7, §4.8, §10, §11 — §4.6 is factually stale as of this document (§2, F0).

## 0. The verdict, before the evidence

The engine is not the problem. Three months of the Flow programme produced a
graph model, a checker, an expression language, an executor with pins and
simulate, and a canvas — and every one of those artefacts is sound. The
problem is that **the programme optimised the cheapest 30% of the product**.

Three sentences, each defended below with numbers read off the tree on
2026-09-08:

1. **The workflow edits the orchestration; the automation lives in the packs,
   and the packs have no product surface at all.** 15,824 lines of flow
   subsystem orchestrate 28,421 lines of plugin code that only a TypeScript
   developer with a local checkout can write or repair.
2. **The one fact a device farm is made of — *this phone is this account* —
   is not modelled anywhere**, and the only way to express it today
   (`$run.index` into an array parameter) is documented in the executor as a
   *fleet-share splitter*, is deliberately shuffled by `order: 'random'`, and
   renumbers when a phone is offline. On an account farm that is not an
   ergonomics gap; it is an account-loss bug waiting for its first offline
   phone.
3. **The failure mode that actually costs runs is readiness and selectors**,
   and it is the one layer no plan in the 300 series touched. The six most
   recent non-release commits in this repository are all the same bug.

The correction is not to finish the Flow programme faster. It is to stop it at
313 and spend the next programme on **identity, screens, and an authoring
surface for the thing that does the work**.

---

## 1. What I read

Read on `main` at `5c92266`, 2026-09-08. Every row is a file, a count, or a
commit — not a recollection.

| # | Fact | Where |
|---|---|---|
| E1 | The flow subsystem is **15,824** lines: 39 files in `components/flow` (7,386), the 8 `workflow*.ts` protocol modules, `core/src/workflows/`, the executor (969), and `@enkaku/expr` | `packages/studio/src/components/flow/`, `packages/protocol/src/workflow*.ts`, `packages/core/src/workflows/`, `packages/core/src/jobs/executors/workflow.ts`, `packages/expr/src/` |
| E2 | The automation packs are **28,421** lines of source plus **19,229** of test, across 7 plugins (4 of them app automation) | `plugins/` |
| E3 | The document has **eight** node kinds (`start script gate switch delay finish set shuffle`); the spec says six | `packages/protocol/src/workflow.ts:236`, `docs/spec.md:152` |
| E4 | The expression language has **44** functions and a bracket-index grammar | `packages/expr/src/functions.ts`, `parse.ts:218` |
| E5 | `Selector` is a **four-way union of single-key matchers** — `{id}`, `{desc}`, `{text}`, `{point}`. No conjunction, no class, no scope, no `nth`, no `any`, no `not` | `packages/protocol/src/ui-node.ts:12-17` |
| E6 | `tree.ts` — a hand-written dump-and-walk module — exists **four times**, once per pack, with four different contents; `dialogs.ts`/`modals.ts`/`screens.ts` are per-pack too | `plugins/*/src/tree.ts` |
| E7 | The six most recent non-release commits are one bug class: acting before the app was ready, or believing a screen the device was not on | `071a40f`, `558ed1d`, `f4670a2`, `a7bf56a`, `4fd6ad3`, `7fa9f0f` |
| E8 | One of them records a real outcome: **0 of 6 actions succeeded** on the owner's first two-device warm-up, every failure a tap that landed before the app could act on it | `4fd6ad3` commit body |
| E9 | A workflow batch creates one job per device and gives **every job the same `params` blob** | `packages/core/src/groups/dispatch.ts:294`, `:316` |
| E10 | `$run.index` is `job.batchSeq`, whose stated purpose is *"the fact that lets a workflow divide a fleet into EQUAL shares"* — and `createWorkflowBatch` shuffles the ordering when `order: 'random'`, and numbers only `resolved.usable` devices | `packages/core/src/jobs/executors/workflow.ts:139-155`, `dispatch.ts:283`, `:305` |
| E11 | The expression scope's roots are `$params $nodes $input $run $now $random`. There is **no `$device`** and no `$account` | `packages/expr/src/ast.ts:14` |
| E12 | The TikTok pack keeps its own account registry in device-scoped KV and its own **compare-and-swap work queue** in global KV, with claiming, staleness reclaim and no reaper | `plugins/tiktok-automation-pack/src/accounts.ts`, `queue.ts` |
| E13 | A script reaches the farm only through `enkaku publish` → `Bun.build` → a `.enkaku` bundle → a three-site version bump → operator activation. There is **no in-product way to write or amend a script** | `packages/sdk/src/cli/publish.ts`, CLAUDE.md's seeded-packs rule |
| E14 | A full AI-agent subsystem exists — harness, provider, threads, approvals, connectors, a device tree tool — and is not connected to scripts or workflows in any way | `packages/core/src/agent/`, `packages/harness/` |
| E15 | Recordings exist end to end: normalised coordinates, selector proposal, human promotion, compiled to an ordinary `ScriptDefinition` | `packages/protocol/src/recording.ts`, `packages/sdk/src/define-recording.ts`, `packages/studio/src/components/recording/` |
| E16 | Plan 305 **deleted** the list editor to make the canvas the editor of record. Plan 313, two waves later, **re-added a linear editor** because the client brief was a list of actions with a delay and a shuffle | `docs/plans/305`, `docs/plans/313` §1, §3.1 |

---

## 2. Criticism

### F0 — The spec is already drifting from the code it governs

`docs/spec.md` §4.6 says "**Six node kinds**". The document has eight: plan 312
added `set` and plan 313 added `shuffle`, and neither amended the sentence that
enumerates them (E3). The spec was touched *today* and still says six.

Small on its own, and named first because of what it indicates: the 300 series
shipped faster than its own single source of truth could absorb, and CLAUDE.md
says the spec wins where the code disagrees. Right now the spec would lose.
Anything that claims "the spec decides" needs this fixed in the same change
that adds the next node kind, not in a later documentation plan.

### F1 — There is no identity model, and the workaround for it is unsound

This is the finding I would act on first, and it is the only one in this
document I would call a defect rather than a gap.

The product is an account farm: the client brief in plan 313 asks for account
switch delays and SIM/IP rotation; the packs are TikTok, Instagram, YouTube and
Google; the TikTok pack's largest domain module is an account registry. The
domain nouns the platform actually models are **device, group, label, job, run,
batch, workflow, schedule, agent**. There is no account. No persona. No binding
of a phone to the identities it is signed into. No proxy-to-account binding. No
cooldown, no per-account state, no "this account is resting until Thursday".

So the packs built it themselves (E12): a device-scoped `accounts` KV entry,
and a global CAS-claimed work queue with staleness reclaim — a distributed
work-assignment system, in a plugin, reviewed by nobody, invisible to the
workflow editor, unsimulatable, and re-implementable per pack.

And the workflow's own escape hatch is worse than absent, because it looks like
it works. To give twenty phones twenty different accounts today, an author
writes something equivalent to `at($params.accounts, $run.index)`. The
executor's own comment says what `$run.index` is for — dividing a fleet into
*equal shares* (E10) — and three properties make it unsafe as an identity:

- `order: 'random'` (a control the client brief explicitly asked for, shipped
  by 313) **shuffles the numbering on purpose**;
- only `resolved.usable` devices are numbered, so one offline phone shifts
  every assignment after it by one;
- the index is a batch position, so it is not stable across runs at all.

The failure is silent and the consequence is specific to this domain: account A
posts from phone 1 on Monday and phone 7 on Tuesday. That is the exact signal
the platforms these packs drive use to ban. Nothing in the product, the schema,
the checker, or the docs warns about it.

**A device farm whose unit of work is an account cannot keep modelling only
devices.**

### F2 — The graph got a canvas; the script got a compiler

E1 and E2 are the whole of this criticism: **28,421 lines of automation
orchestrated by 15,824 lines of editor** — and the 28,421 are where every hard
thing lives. Read what is actually in a pack: bilingual readiness labels,
closed allow-lists of dialog buttons that may be tapped and an argued list of
ones that may never be, ViewPager fling physics derived from a real inspector
dump, per-device RNG for human timing, CAS queue claiming. That is the product.

The workflow editor cannot touch any of it. A node is a *menu entry for
something a developer already wrote*. And writing one requires (E13) a local
checkout, Bun, `enkaku publish`, a version bump in three files, `build:packs`,
and an operator activating the staged version — a pipeline CLAUDE.md itself
documents as having silently shipped nothing twice.

So the honest description of today's product is: **a good editor for arranging
actions, sold to people who cannot create an action.** For the owner that is
survivable — the owner writes TypeScript. For a client, or for the "modular
nodes supplied by plugins" ambition in plan 300 §1, it is the ceiling.

I do not think plan 300 was wrong to build the editor. I think it was wrong to
call the result "usable" without ever asking who authors the nodes.

### F3 — The failure mode that costs runs has no first-class model

E7 and E8. Six consecutive non-release commits, all one bug: the farm acted
before the app was ready, or reasoned about a screen it was not on. One of them
records six failed actions out of six on the owner's own phones.

The platform's tools for this are (E5) a four-way single-key `Selector` and a
`waitFor(selector)`. Neither can express any of the questions a real Android
automation asks:

| The question | Expressible today |
|---|---|
| "the button whose id is X **and** whose text is Y" | no — one key per selector |
| "any of Home / Beranda / Shorts" (build and locale variance) | no |
| "the third row inside the account sheet" | no — no scope, no `nth` |
| "a clickable node, not the label inside it" | no |
| "wait until the app is ready" | no — readiness is not a selector |
| "wait until we are on *one of* these screens, and tell me which" | no |
| "there is a blocking modal; which kind?" | no |

Every pack therefore answers them by hand: `dump()` plus a bespoke tree walk,
four incompatible copies of `tree.ts` (E6), a hand-rolled
`waitForTree(predicate, budgetMs)` because `waitFor` takes a selector, and
per-pack dialog allow-lists. The most safety-critical code in the repository —
the closed list of buttons a bot may tap, with its written argument about why
"tap the only button in the modal" would tap *Setuju*, *Izinkan*, *Ikuti* and
*Beli* — is a module in one plugin, not a farm policy.

**This is the highest-leverage engineering surface in the codebase and it is on
no roadmap.** Plan 222 gave `waitFor` a push channel, which is the hard half;
what is missing is a vocabulary worth pushing.

### F4 — The parity parameter was borrowed from the wrong product

Plan 300 restated "at least as good as n8n" as fourteen interactions and did
so rigorously. My criticism is of the choice of yardstick, not the rigour.

n8n's job is joining APIs: many heterogeneous services, arbitrary fan-in and
fan-out, data reshaping as the primary activity. This product's job is driving
**one screen at a time on many identical phones**. The two share a canvas
metaphor and almost nothing else — plan 300 knew this well enough to refuse the
item model (D3, correctly) and to refuse plugin-defined control flow (D8,
correctly), and then still measured the programme against n8n's interactions.

The owner's own trajectory falsified the parameter within the programme (E16):
305 deleted the list editor on the grounds that the canvas is the editor of
record; 313, two waves later, built a linear editor back, because the client's
three screens are *a list of actions, a delay range, a shuffle, and a Run
button*. Plan 313 §3.1 is worth reading as an indictment of its own series:
nine of the brief's eleven controls already existed, and what was missing was
**a layout and two schema fields**, not an engine.

Eight node kinds, 44 expression functions, pins, simulate, a weighted switch
and an auto-arrange are now maintained for documents that are, in the actual
brief, straight lines. I would not delete any of it — it is built and it works
— but I would stop adding to it until §3 R2 says what shape real documents are.

### F5 — Five automation paradigms, no doctrine

Scripts (TypeScript, published). Recordings (record, promote selectors, replay
— E15). Workflows (a graph). Batches and schedules (fan-out and time). AI
agents (a full LLM harness with device access, approvals and connectors — E14).

Nothing in the spec or the docs says when to reach for which. Two of the five
are effectively dark:

- **Recordings** are the only path in the product from "an operator can see the
  app" to "the farm can do it", and they are not part of the workflow story at
  all — a recording cannot become a node, and the selector-promotion review is
  where a *screen definition* should have been born (§4 D-C).
- **The agent** can already read a UI tree and act on a device. F3's problem —
  "the phone is on a screen no script anticipated" — is precisely the problem a
  language model is good at and a selector is not. It is sitting one package
  away from the executor and nothing connects them.

Five paradigms with no rule is not richness; it is five surfaces to maintain
and a user who cannot choose.

---

## 3. What I want to research, before anyone builds

Six studies. Each has a parameter, because plan 200 §3.0's rule holds here: a
research question whose answer is an adjective decides nothing. Ordered by how
much a wrong answer would cost.

### R1 — The run-failure taxonomy

**Question.** When a run fails on real hardware, what actually failed?

**Method.** Label a sample of **≥200 failed steps** from `job_runs` /
`workflow_steps` and their stored artifacts (screenshots and trees are already
persisted) into: readiness (acted too early), selector miss (anchor absent),
wrong screen (anchor matched the wrong thing), unexpected interruption (modal,
permission, login, captcha), device/transport, network/proxy, script logic.

**Parameter.** The percentage in the first four buckets. **My hypothesis: over
60%**, and E8 is one uncontrolled data point at 100%.

**What it decides.** Whether the next programme is F3 (screens and selectors)
or something else. This is the cheapest study here and the only one that can
overturn my own recommendation, so it goes first.

### R2 — The document-shape census

**Question.** What shape are the workflows people actually author?

**Method.** Dump every row of `workflows` on the owner's farm and any client
farm that will share one. Measure: node count, count of `gate`/`switch` nodes,
`readLinear` pass rate (`packages/protocol/src/workflow-linear.ts` already
answers this), expression usage per document, functions used.

**Parameter.** Percentage of documents that are linear, and median node count.
**My hypothesis: >80% linear, median ≤ 8 nodes, most documents using zero
expression functions beyond arithmetic.**

**What it decides.** How much canvas is worth maintaining, whether the linear
lens should be the default view (§4 D-E), and whether 44 expression functions
are a feature or a maintenance liability.

### R3 — Selector robustness

**Question.** Which selector kinds survive a fleet?

**Method.** Take the anchors the four packs already use, replay them across K
device models × L app versions × 2 locales, and record match / miss / matched
the wrong node per selector kind (`id`, `text`, `desc`, geometry, tree walk).

**Parameter.** Match rate per kind, and — the number that matters most — the
**wrong-node rate**, because `4fd6ad3` records a geometric fallback that
matched a video row and opened a video. A wrong match is worse than a miss.

**What it decides.** The shape of Selector v2 (§4 D-C): specifically whether
`id` conjunctions are worth the schema, and whether a scoped `nth` is enough to
delete `tree.ts`.

### R4 — The account-binding audit

**Question.** What is the real relationship between phones, accounts, proxies
and content in the owner's and the client's operation?

**Method.** Not code — an interview and a census. How many accounts per phone?
Who decides which account posts what? What happens when a phone is offline on
its turn? When an account is challenged or banned, what has to change? How is a
proxy bound today (the `proxy-manager` and `mikrotik-routing` plugins are
evidence there is already an answer, in a third place)?

**Parameter.** A written table of the objects and their cardinalities, signed
off by the owner.

**What it decides.** Everything about F1 — whether the object is `account`,
`persona`, or `identity`; whether a phone holds one or many; whether the
assignment is stored or claimed.

### R5 — Agent-in-the-loop, as a rescue and not as a driver

**Question.** Can the existing harness (E14) recover a run that a script cannot?

**Method.** Wire the agent as a **bounded rescue**: when a script's anchor times
out, hand the agent the tree and a one-sentence goal, cap it at N turns, and
measure. Never in the hot path — an LLM per gesture is unaffordable in both
seconds and tokens on a farm of twenty phones.

**Parameter.** Added seconds and tokens per rescue, and rescue success rate.
**Break-even to state up front: a rescue is worth it if it converts a failed
run into a completed one for under ~30 s and a few cents.**

**What it decides.** Whether F3's answer includes a model, or is purely a better
vocabulary. Also whether agent-assisted *authoring* (§4 D-D option 3) is worth
sequencing at all.

### R6 — The detection and account-loss surface

**Question.** What does this stack look like to the applications it drives?

**Method.** A written threat table: UHID virtual input (its device name and
descriptor), the accessibility service the guest agent enables, the VPN
`vpn-helper` tunnel, the on-screen labelling, adb's presence, and the timing
distributions the packs generate. For each: is it observable by an app, and
what does the pack's own randomisation actually cover?

**Parameter.** A table with a row per signal and an observable / not / unknown
verdict, plus the count of signals with no mitigation.

**What it decides.** Whether any of the above matters. This product's dominant
business risk is losing accounts, not losing runs — and the repository has a
detailed argument about swipe curvature and zero written analysis of what a
UHID descriptor looks like from inside the app. That asymmetry is worth closing
before the fleet gets large enough to be worth someone's attention.

---

## 4. Direction — the revisions I would make

Ordered. Each names what it replaces, so it is a change of plan and not an
addition to it.

### D-A — Freeze the Flow programme at 313

Do not execute plan 308 as written; do not add a ninth node kind; do not extend
the expression language. Parity is close enough that the marginal editor feature
is worth less than anything below. 308 stays `draft` as its own §1 intends —
and its §4 recommendation ("yes to job-level fan-out, no to per-node targets")
should simply be recorded as **already true**: `createWorkflowBatch` (E9) does
job-level fan-out today. What 308 was actually holding open was never fan-out;
it was **per-member data**, which is F1 and is redirected to D-B.

### D-B — Make identity a first-class farm object (the next programme)

The correction for F1, and the one thing I would start immediately after R4.

- An object — `account` is my proposed name, pending R4 — with at minimum
  `{ id, platform, handle, deviceId, proxyRef, state, cooldownUntil, meta }`,
  in the core schema, with a Studio surface, not in a plugin's KV.
- **A target resolves to `(device, account)` pairs**, not to devices. This is
  the change that makes the rest fall out: a batch member carries its own
  resolved binding.
- **Per-member parameters.** `batches.params` (E9) stops being one blob; a
  member's params are resolved per member. This is what the item model was
  refused for in plan 300 D3 — and D3 was right to refuse *items inside a
  document*; it never considered per-member binding *outside* it, which costs
  no new document concept at all.
- **`$device` and `$account` in the expression scope** (E11). One root each,
  read-only, prototype-free like every other scope value; `@enkaku/expr` needs
  no grammar change.
- **A farm-level work-assignment primitive** — claim, lease, cooldown, retry —
  promoted out of the TikTok pack's CAS queue (E12), so that content
  distribution stops being a plugin's private invention.
- **Deprecate the footgun explicitly.** `checkWorkflow` gains a warning for any
  expression that indexes a parameter array by `$run.index`, naming the
  shuffle, the offline-device renumbering, and the correct replacement. If D-B
  is not built, this warning should ship *anyway*, on its own — it is a day of
  work against a class of silent account loss.

### D-C — Screens and selectors v2 (the highest-leverage change)

The correction for F3. Sequenced by R1 and R3, but the shape is already clear
from the packs, because the packs have written it four times:

- **`Selector` becomes a conjunction** with optional `class`, `clickable`, a
  `scope` (match within a parent selector), an `nth`, an `any: [...]`, and a
  `not`. Every one of these is a question a pack answers by hand today (F3's
  table); none needs a regular expression, so plan 95 §3.8 R2's refusal stands
  untouched.
- **A named `screen`**: an id plus the same closed `PredicateSchema` the gate
  already uses, evaluated against a UI tree. Then one primitive replaces four
  hand-rolled ones: `waitForScreen(['home', 'login', 'captcha'], budgetMs)`
  returns *which screen you are on*. That single verb subsumes `isReady`,
  `waitForTree`, the readiness label lists, and the "did the search page
  actually open" checks in every one of E7's six commits.
- **The failure message changes shape.** "Stopped on `captcha`" instead of
  "tap timed out" — which is also what makes a workflow's `onFailure` edge
  worth authoring, because a branch can finally ask *why*.
- **An interruption policy at farm level**, promoted from
  `tiktok/src/dialogs.ts` — the deny list, the acknowledge list, and above all
  its written rule that the list is closed and may never contain a word that
  grants, buys, subscribes or follows. Farm-owned, operator-visible, one
  audited place instead of one per pack.
- **The measurable outcome**, so this is not a refactor with no finish line:
  `tree.ts` is deleted from all four packs, `waitForTree` has no callers, and
  pack source drops measurably. If it does not, the vocabulary was wrong.

### D-D — Give the script an authoring surface, or stop calling it a product

The correction for F2. Three options; I recommend the second, then the first.

1. **In-Studio TypeScript editing with a server-side build.** The core already
   bundles (`scripts/build.ts`, `bundle-cache.ts`, `dev-slots.ts` exist). This
   is the *developer* path, and it removes the local-checkout requirement and
   the three-site version dance for iteration — not for release.
2. **Recordings promoted to first-class authoring.** Record on the device,
   review, promote selectors — all of which exists (E15) — and then two new
   steps: **name a screen** from what was captured (which is exactly D-C's
   object, born where the operator can see it), and publish the result as a
   pack member. This is the *operator* path, it is the shortest bridge from
   "someone looked at the app" to "the farm can do it", and it is ~80% built
   and currently disconnected from everything.
3. **Agent-assisted authoring** — the agent drives once and emits a draft
   script. Gated behind R5; do not sequence it before the other two.

### D-E — The linear lens becomes the default

R2 decides the exact rule, but my expectation is that the list, not the canvas,
should be what a new workflow opens in, with the canvas as the advanced view for
the minority that branch. Plan 313 built the list and left the canvas as the
front door; E16 says the front door is the wrong way round.

### D-F — Write the doctrine, and repair the spec

One page, in `docs/spec.md`: *when do I use a script, a recording, a workflow, an
agent, a schedule?* — with a rule per row, not a description. Fix §4.6's "six
node kinds" (F0) in the same change, and make "the spec enumerates the node
kinds" a §0 row on any future plan that adds one.

---

## 5. What I would explicitly not do

Naming these keeps them from being re-proposed in a month.

| Not this | Why |
|---|---|
| Items / per-row fan-out inside a document | Plan 300 D3 was right, and D-B gets per-device data *outside* the document, which is where it belongs |
| Per-node device targets, cross-run merge, a Merge node | 308's expensive half; no named use case, and a coordination model nobody needs yet |
| More node kinds, or more expression functions, before R2 | Eight kinds and 44 functions for documents that are probably straight lines |
| An LLM in the hot path of every gesture | Unaffordable per action on twenty phones; R5 scopes it to rescue only |
| A second document schema for Sequential Mode | Plan 313 §3.2 already refused this correctly; the lens is the right shape |
| Rewriting the executor, the queue, or crash containment | Plan 211's model is not implicated by anything in this document |

---

## 6. Risks in my own recommendation

| Risk | How it would show |
|---|---|
| R1 comes back saying failures are mostly device/transport, not readiness | Then D-C is over-prioritised and F3 is my hypothesis, not a finding. R1 is first precisely so this is cheap to discover |
| `account` is the wrong object for the client's operation | R4 is an interview before a schema for exactly this reason. Building D-B before R4 would be the same mistake this document accuses the 300 series of |
| Selector v2 grows into a query language | The same falsification test plan 300 D4 set for `@enkaku/expr`: a bounded grammar with a written line count, and no regular expressions, ever |
| Promoting the dialog allow-list to farm level makes it editable, and someone adds "Izinkan" | The list must stay closed *and* the UI must refuse the granting verbs by name, or it is a downgrade from a plugin constant |
| Freezing Flow reads as "the last three months were wasted" | They were not. 301–313 are the substrate D-B and D-E build on. The criticism is of sequencing and of the yardstick, not of the work |

---

## 7. What the owner must decide

| # | Decision | Blocks |
|---|---|---|
| Q1 | Is the product an **account farm** (identities are the unit of work) or a **device farm** (phones are)? | All of D-B. If the answer is "devices", F1 collapses to a doc warning and this document's priority order changes completely |
| Q2 | Freeze the Flow programme at 313? | D-A, and everything sequenced after it |
| Q3 | Who authors an action, in the product the client buys — a developer, or an operator? | D-D's option order. If the honest answer is "a developer, always", then F2 is not a defect and D-D drops to option 1 alone |
| Q4 | Fund R1 and R2 now? They are days, not weeks, and R1 can overturn D-C | The sequencing of the whole next programme |
| Q5 | Is account loss a business risk worth a written threat model (R6)? | R6 only |

---

## 8. Addendum — bulk power and the cost of leaving (owner report, 2026-09-08)

The owner's report, in the owner's words: power on / off / wake on 73 devices is
slow, a competitor does the same in 1–2 seconds, and `Ctrl+C` "gila lama sekali"
because the core releases everything first.

Plan 226 already fixed the biggest multiplier — the serial dispatch — and this
addendum does not re-litigate it. What follows is what is **still** there,
read off the tree at `5c92266`. It is a separate finding set from F1–F5, and on
present evidence it outranks all of them for a farm this size: an operator meets
it every single day, and F1's failure mode is rare and quiet by comparison.

### P1 — Nobody has measured this farm

Plan 226's own status line says it: G8 is still an open **owner** row, and every
number the plan reasons from — 1422 ms for `svc power stayon` above all — is
plan 96 §22's single measurement plus upstream scrcpy's source. `bun run
bench:wake` exists (`scripts/bench-wake.ts`) and has never been run here.

Everything below is structure I can prove by reading. How much each part costs
in seconds is not, and I will not guess it. **Run the bench first** — it is
hours of work and it decides which of P2–P5 is actually the dominant term.

### P2 — The fan-out widths are compiled-in constants that do not scale, and they bind hard at 73

| Constant | Value | Applies to | Waves at 73 devices |
|---|---|---|---|
| `ACTION_FANOUT_CONCURRENCY` (`actions/verbs.ts:59`) | **4** | every `async` verb: `install`, `push`, `pull`, `adb` shell, `screenshot`, `clear-cache`, `set-network`, `prepare`, `install-agent`, `uninstall-agent` | **19** |
| `ACTION_SYNC_FANOUT_CONCURRENCY` (`actions/verbs.ts:86`) | **16** | `wake`, `sleep`, and every other `sync` verb | 5 |
| `RELEASE_SWEEP_WORKERS` (`config/constants.ts:284`) | **8** | the shutdown release sweep | 10 |
| `computeAutoConcurrency(73)` (`device/adb-scaling.ts:15`) | **24** | adb's own global semaphore | — |

Three observations, in order of how much they cost:

1. **The adb lane is not the constraint; these three numbers are.** The
   semaphore is at 24 for a farm this size and every one of the three sits
   below it. A bulk screenshot or a bulk `adb` command across 73 phones runs
   **four at a time**.
2. **`ACTION_SYNC_FANOUT_CONCURRENCY`'s own written justification is false at
   this farm size.** Its comment reads: *"the real floor is still adb's own
   farm-wide semaphore (`adb.maxConcurrent`, 6 by default and pinnable to 2):
   past that width this number stops buying anything"*. At 73 devices that
   floor is 24, not 6. The number was chosen against a 10–20 device farm and
   the premise was never revisited.
3. **Two of the three are not knobs.** `ACTION_FANOUT_CONCURRENCY` and
   `ACTION_SYNC_FANOUT_CONCURRENCY` are bare `export const`s in `verbs.ts`,
   with no `ENKAKU_*` override — a direct breach of CLAUDE.md's own rule that a
   value expected to keep being tuned belongs in `constants.ts` with an
   override. This is the `WALL_RAMP_CONCURRENCY` failure that same file already
   records, repeated: a farm operator cannot widen these without a rebuild.

**All three should be derived from the farm's own device count, the way
`computeAutoConcurrency` and `computeAutoStreams` already are, and all three
should carry an `ENKAKU_*` override.** A fixed 4 is not a farm-independent
constant; it is a farm-size assumption compiled in.

### P3 — The exit cost is a revert ledger, and part of it is paid twice

`ScrcpySession.close()` (`packages/session/src/session.ts:1056-1136`) is a
strictly sequential chain of awaits, most of them a separate adb round trip:

| Step | Command | Round trips |
|---|---|---|
| `uhidEngine.destroy()` | control socket | 0 (socket) |
| `session.display.stop()` | scrcpy teardown + forward removal | ≥1 |
| `applyStayOn(off)` | `settings put global …; settings get …` | 1 |
| `revertRotation()` | `settings put system <key> <value>` (`orientation.ts:224`) | 1 |
| `revertTextInput()` | `ime set <previous>` (`text-input.ts:214`) | 1 — see P4 |
| `revertFarmTag()` | `setprop …` (`farm-tag.ts:98`) | 1 |
| `inspectorHandle.release()` | inspector teardown | ≥1 |

Six-ish serialised round trips per device, × 73, through a semaphore of 24 —
and then `readiness.releaseAll()` writes `stay_on_while_plugged_in = 0`
**again**. `session.ts:1095`'s own comment admits the overlap in the other
direction ("a farm shutdown paid it once per device before the release sweep
had even begun"); plan 226 made that write cheap but did not remove the
duplicate.

Two things follow.

- **The per-device revert chain should be ONE batched shell command, not six.**
  `putStayOn` (`power.ts:309`) already proves the technique in this repo —
  `settings put …; settings get …` in a single exec, because `adb shell` runs a
  real shell. Rotation, IME, farm tag and stay-on are mutually independent;
  there is no ordering constraint between them, only between the stay-on drop
  and the sleep key, which is a different pair. Six round trips → one. The cost
  is failure attribution: a batched command tells you less about which part
  failed, which is worth stating in the change, not worth six round trips.
- **The competitor's 1–2 seconds is not a faster adb. It is not having a revert
  ledger at all.** Enkaku's exit is proportional to how much per-device state it
  mutated and is honour-bound to restore. That honour is correct — plan 125 §0.2
  exists for good reasons — but the price is currently paid serially, per
  device, at exit, on the operator's clock. P5 is how you keep the honour and
  stop paying for it.

### P4 — `ime set` is the JVM plan 226 did not remove

Plan 226 §3.2's whole insight is that `/system/bin/svc`, `/system/bin/input`
and friends are shell wrappers around `app_process`, so each call starts an ART
runtime on the phone — that is what the 1422 ms is. The plan took `svc` off the
wake/sleep path and left `revertTextInput`'s `ime set` on the **close** path,
where it runs once per device on every shutdown.

On AOSP, `cmds/ime/ime` has historically been exactly that shape of
`app_process` wrapper. **I have not verified it on this farm's hardware and it
is build-dependent** — newer builds route it through `cmd input_method`. It is
the second thing the bench should time, right after `settings put`, and if it
measures like `svc` did, it is the single largest term in the shutdown.

### P5 — Plan 226 Q1 is the real fix, and it is still open

`packages/scrcpy/src/session.ts:229-235` passes `control=true` and
`cleanup=true`, and does **not** pass `stay_awake`. The pinned v3.3.1 server
accepts `stay_awake` and `screen_off_timeout` as options, applies them itself,
and spawns an independent on-device process that restores both when the
server's stdin closes — for any reason, this core being `SIGKILL`ed included.

Adopting it does not make the release sweep faster. It **deletes** it. And it
closes a real hole plan 226 named and did not fix: today a `kill -9` leaves
every phone the farm touched pinned lit for ever, with nothing left running to
notice.

The two objections plan 226 recorded are both answerable rather than blocking:
ownership of a persisted setting moves out of this codebase (true, and it moves
to the upstream project this repo already pins and already trusts with
`cleanup=true`), and `screen_off_timeout`'s unit must be read off v3.3.1's own
`Server.java` before anything is sent (an afternoon).

**This is the owner decision with the largest performance payoff in the
repository, and it has been sitting as an open question since 2026-09-07.**

### P6 — With P5, a farm-wide Sleep becomes socket-only

`pressSleep` already prefers the session's control socket and only falls back to
`input keyevent` when there is no session (`readiness.ts:544`). On an always-on
farm every online device has a session, so the keycode already costs no adb.
What still costs adb on a Sleep is the stay-on write — the one thing P5 removes.
After P5, a farm-wide Sleep is 73 socket writes with no adb round trip at all,
which is the shape that produces the competitor's 1–2 seconds.

### P7 — `SET_DISPLAY_POWER` was refused for a reason P5 also dissolves

Plan 226 §3.4 refused `SET_DISPLAY_POWER` (two bytes over the open socket, every
panel black in the same frame) because a core killed with `SIGKILL` would leave
66 dark panels with nothing left to restore them. scrcpy's own on-device
`CleanUp` — the exact mechanism P5 adopts — is what makes that objection
survivable. The refusal should be re-read after P5, not treated as settled.

### Recommended order

| # | Action | Size | Why here |
|---|---|---|---|
| **N1** | Run `bun run bench:wake` on one device and record it (plan 226 G8) | hours | Every number below is currently reasoned, not measured. This is also what decides whether P4 is real |
| **N2** | Instrument the exit: log the three phases separately (drain / release sweep / `closeAll`) with per-phase wall clock | hours | Today the shutdown is one log line, so "gila lama sekali" cannot be attributed to a phase. Nothing else should be tuned before this exists |
| **N3** | Scale the three fan-out widths from device count and give each an `ENKAKU_*` override | small | P2. The cheapest real speed-up, and it fixes a CLAUDE.md rule breach at the same time |
| **N4** | Batch the per-device revert chain into one shell command; drop the duplicate stay-on write | small | P3. Six round trips → one, on every device, on every close |
| **N5** | Decide plan 226 Q1 — hand `stay_awake` (and `screen_off_timeout`) to the scrcpy server | medium, owner | P5. Deletes the release sweep instead of speeding it up, and fixes the `kill -9` leak |
| **N6** | Re-read the `SET_DISPLAY_POWER` refusal | small | P7, only after N5 |

N1 and N2 are diagnostics and should land before any of N3–N5, for the reason
this whole document keeps repeating: this repository has a strong habit of
reasoning carefully from numbers it has not taken.

### What this changes about §0 and §3

The verdict in §0 stands for the *automation* concept. It is now explicitly
subordinate to this: **a farm of 73 phones whose every bulk operation is slow is
a worse product than a farm that cannot express which account is on which
phone.** If the owner funds one thing next, it is N1–N4, not D-B.

R1's failure taxonomy (§3) should therefore be widened by one question: how much
of a run's wall clock is spent in the farm's own dispatch and teardown, rather
than on the phone. Nobody has that number either.

---

## 9. Addendum 2 — the competitor's quick-action menu, read as a spec (owner reference, 2026-09-08)

The owner supplied a screenshot of PandaClassic 5.0.0.0's Quick actions menu and
described the ritual it serves: before unplugging the phones, select the farm and
press **Power off** to darken every screen. They also noted that Panda's
**Screen off** appears to darken the real phone while the mirror keeps working.

That menu is a competitive specification, and reading it against `VERBS`
(`packages/core/src/actions/verbs.ts:17-50`) changes one of §8's conclusions.

### P8 — Panda separates two operations this repo merges, and ships both

| Panda quick action | What it must be | Enkaku |
|---|---|---|
| Screenshot | screencap | `screenshot` |
| **Screen on / Screen off** | display power mode — panel dark, mirror alive | **no verb**; the mechanism exists, see P9 |
| **Power on / Power off** | wake / sleep the device itself | `wake` / `sleep` |
| Open / Close wireless adb | `tcpip` and disconnect | `cutover` / `disconnect` (not one click) |
| **Open / Close airplane** | radio toggle | **none** — see P11 |
| **Shutdown** | `reboot -p` | **none** |
| **Reboot** | `reboot` | **none** |

Enkaku has **one** pair where Panda has **two**, and the pair it kept is the
expensive one. `sleep` writes `stay_on_while_plugged_in` over adb and then sends
`KEYCODE_SLEEP`; the device genuinely sleeps and, per `docs/spec.md` line 199,
"its tile shows a dark screen". Panda's Screen off leaves the tile live.

They are not two speeds of one feature. They are two features:

- **"screens dark, and they stay dark after I unplug"** — the owner's ritual.
  Android must own the state, because the farm is about to stop existing. That
  is `KEYCODE_SLEEP`, and `sleep` is semantically correct today.
- **"screens dark while the farm keeps watching"** — a rack of phones nobody
  should see lit, still being cast. That is display power mode, and Enkaku has
  no action for it.

### P9 — The mechanism for the second one is already in the tree, wired to the wrong thing

`packages/session/src/session.ts:852` calls `scrcpy.control.setDisplayPower(false)`
— two bytes on a control socket that is already open, no adb, instant. Its own
declaration comment (`session.ts:361`) reads:

> `DeviceSettings.prep.standbyScreenOff` — **dark panel, mirroring stays alive**

which is, word for word, what the owner describes Panda doing.

But it is gated on `prep.standbyScreenOff`, a **per-device provisioning setting**
that defaults to `false` (`settings.ts:597`), is applied **once at session build**
and reverted at close. It is a flag on a device, not an action an operator can
take on a selection. Turning it on for the farm today means editing 73 device
settings and rebuilding 73 sessions — to reach a capability that costs two bytes.

**Recommendation: add `screen-off` / `screen-on` as ordinary `sync` verbs over
`setDisplayPower`.** No adb, no new mechanism, no new control message —
`encodeSetDisplayPower` is already in `packages/scrcpy/src/control/messages.ts`.
This is the smallest item in this document and it closes a visible feature gap.

### P10 — Plan 226 §3.4 answered a question nobody asked

That section refused `SET_DISPLAY_POWER` **as the sleep mechanism**, because a
core killed with `SIGKILL` would leave 66 panels dark with nothing left to
restore them. As an answer to *"should `sleep` become `setDisplayPower`"* it is
correct, and P8 now gives the reason in product terms rather than safety terms:
sleep must survive the farm's death, and display power mode does not.

It is not an answer to *"should screen-off exist as its own action"*, which is
the question Panda's menu poses and which plan 226 never asked.

The refusal is also internally inconsistent as written: `prep.standbyScreenOff`
**ships that exact risk today** as an opt-in. A farm with it enabled and a core
`kill -9`ed has the same 66 dark panels the section refuses to allow. The
argument was applied to a new action and not to the setting already carrying it.

What settles it is one fact nobody in this repo has checked: **does v3.3.1's
`CleanUp` restore display power when the server's stdin closes?** It restores
stay-awake and screen-off-timeout (plan 226 Q1). If it restores display power
too, P10's objection is already handled by the `cleanup=true` this repo passes
at `packages/scrcpy/src/session.ts:235`, and the ladder P9 asks for needs no
restore logic of its own. It is the same file plan 226 Q1 already sends someone
to read for `screen_off_timeout`'s unit — read both in one sitting.

*(Note for whoever adds P9: if `CleanUp` DOES restore display power, then
`screen-off` is the wrong verb for the owner's pre-unplug ritual — unplugging
kills the session, CleanUp fires, and every panel lights back up. That is
precisely why P8 insists these are two features and `sleep` must stay
`KEYCODE_SLEEP`.)*

### P11 — Airplane mode is the client brief's own request, shipped by the competitor

Panda has **Open airplane / Close airplane** as one-click farm actions. Plan 313
§3.6 met the same requirement — the client brief's *"Use SIM 4G (change IP)"* —
and routed it to "plugin script parameters, never core workflow schema".

That routing is defensible for a workflow *node*. It is not an answer for a
*quick action*: an operator rotating IPs across 73 phones before a run should not
have to author a workflow to do it. The same holds for **Shutdown** and
**Reboot**, which have no expression anywhere in this codebase — not a verb, not
a script, not a plugin.

### What this changes about §8

§8's ordering stands, with one correction and one addition.

**The correction.** §8 P6 said a farm-wide Sleep becomes socket-only after N5,
and that is still the fix for the owner's actual ritual — `pressSleep` already
rides the control socket, so once N5 removes the stay-on write, `sleep` is 73
socket writes and no adb at all. **N5 is the answer to the reported complaint.**
P9 is a different feature and must not be sold as the fix for it.

**The addition**, as a new first row:

| # | Action | Size | Why first |
|---|---|---|---|
| **N0** | Add `screen-off` / `screen-on` verbs over `setDisplayPower`; while there, read v3.3.1's `CleanUp.java` and record whether it restores display power | small | P9. Existing mechanism, existing encoder, no adb. Also produces the fact N5 and N6 both need |

N0 does not displace N1/N2 as the diagnostics that decide N3–N5. It is simply
small enough, and visible enough, to land beside them.

## 11. Handoff report

_Not applicable: this document is a review, not an executed plan._
