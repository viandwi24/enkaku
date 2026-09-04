# Plan 84 — M49 : Spec Reconciliation

> Status: implemented — 2026-08-09. All six audit passes ran, `docs/spec-divergences.md` holds 72 rows (`DIV-001`–`DIV-072`) each carrying a decision, `docs/spec.md` was amended per §4.5 with its section numbering intact, and the loop is closed: `bun run spec:check` reports the open gap as a number in CI, and `docs/plans/00-overview.md` §7 now requires a spec update or a `DIV-` row. `DIV-068`/`DIV-069` were subsequently closed in code the same day at the owner's request.
>
> This status line itself said "not started" for several hours after the plan had fully landed — which is precisely the failure mode §3.6 describes and §4.4 exists to stop, caught here by the plan's own follow-up audit. Recorded rather than quietly corrected.
> Ships: docs/spec-divergences.md
> Depends on: nothing. It reads the whole repo and changes almost none of it.
> Spec references: all of `docs/spec.md` — that document is the subject.

---

## 1. Goals

- `docs/spec.md` again describes the product that actually exists, or says plainly where it does not.
- Every divergence between the spec and the shipped code is written down once, with a decision attached: **the spec wins** (the code is wrong and gets a defect plan) or **the code wins** (the spec is stale and gets updated).
- The rule "if a plan contradicts the spec, the spec wins" becomes true again. Today it cannot be applied, because nobody knows where the two disagree.
- Anyone — human or agent — can read the spec and trust it.

## 2. Non-goals

- Rewriting the spec into a new document. It is amended, section by section, with its structure intact.
- Building, removing, or redesigning any feature. Where a divergence needs code to change, this plan **records** it and stops; the change belongs to its own plan.
- Auditing the 86 plan documents against each other. Only spec ⇄ code.
- Deciding the product's future direction. The audit reports what is; the owner decides what should be.

## 3. Context: measurements, not impressions

Everything below was counted in the repo on 2026-08-03, not estimated.

A caution the audit must inherit, learned by getting it wrong while writing this plan: extracting table names with `grep -A1 'sqliteTable('` also catches quoted strings on the following line, which produced two phantom tables (`id`, `stable_id`) and an inflated count. Pass 1 must match the **first argument** of `sqliteTable(` specifically, and re-count rather than trust the number above — other agents commit while the audit runs.

### 3.1 The data model

| | count |
|---|---|
| tables in `packages/core/src/db/schema.ts` | **36** |
| tables named anywhere in spec §12 | **7** |
| tables the spec has never heard of | **29** |

The seven the spec knows: `devices`, `jobs`, `scripts`, `artifacts`, `audit_log`, `users`, `tool_installs`.

The twenty-nine it does not:

```
agent_approvals  agent_blobs  agent_inbox  agent_messages  agent_runs
agent_spawn_grants  agent_threads  ai_agents  batches  blocked_devices
clusters  connectors  deleted_devices  device_events  device_tags
discovered_devices  farm_settings  kv_entries  migration_markers
network_credentials  nodes  notifications  plugins  schedule_agent_targets
schedule_runs  schedules  sessions  webhook_endpoints  workspace_files
```

These are not stray columns. `clusters`, `batches`, `schedules` are a whole scheduling subsystem; `ai_agents` with seven companion tables is the in-product AI agent (chat, threads, runs, approvals) — **kept, confirmed by the owner 2026-08-03**; `connectors`, `webhook_endpoints`, `network_credentials`, `plugins`, `nodes`, `workspace_files` are each a feature the source of truth has no words for.

### 3.2 Mentions in the spec, by subsystem

| entity | times named in `spec.md` |
|---|---|
| `ai_agents` | **0** |
| `connectors` | **0** |
| `nodes` | **0** |
| `notifications` | **0** |
| `workspace_files` | **0** |
| `webhook_endpoints` | **0** |
| `plugins` | 2 |

### 3.3 Screens

Studio ships **23** routes:

```
/  /agents  /agents/approvals  /agents/detail  /agents/runs  /agents/thread
/batches  /batches/detail  /clusters  /dev/tools  /device  /jobs  /jobs/detail
/nodes  /plugins  /schedules  /schedules/detail  /scripts  /scripts/detail
/settings  /tools  /topology  /workspace
```

Spec §19 ("Studio — screen spec") describes roughly five: device, logs, scripts, settings, tools.

### 3.4 Smaller, sharper divergences

- **Job status.** Spec: `queued|running|success|failed|cancelled`. Code: the same plus **`expired`** (added by Plan 21 for queue timeouts). A reader implementing against the spec would not handle a terminal state that the queue produces.
- **Roadmap.** Spec §20 runs to roughly M8/M9. The plan series runs past M40, with 86 documents.
- **Driver layers.** Spec §7 says "five orthogonal layers" and the code still has five — this one holds.

### 3.5 What is NOT diverging

Worth stating, because an audit that only finds fault is not trustworthy:

- `adb kill-server` appears in exactly one call site — `packages/core/src/tools/adb-swap.ts`, the Toolchain Manager's version swap, which is the single use §10.4 permits. A doctor-package test even asserts the string appears nowhere else. The rule holds. (An earlier draft of this plan claimed zero occurrences anywhere; that was wrong, and is corrected here rather than quietly deleted — a plan about factual accuracy has to hold itself to it.)
- scrcpy is still pinned to `3.3.1` in `packages/scrcpy/src/version.ts`, vanilla, never forked (§7.6).
- The five driver layers are intact (§7).

The immutable decisions survived. What drifted is description, not architecture — which is exactly why this is repairable by writing rather than rebuilding.

### 3.6 Why this happened, and why it will happen again

Eighty-six plans were written by agents and executed by other agents. Each plan was internally coherent and carried its own reasoning. None of them was responsible for keeping `spec.md` true, and no step in the Definition of Done asks for it.

So the failure is structural, not anyone's carelessness. Fixing the document without fixing the loop buys a few weeks. §4.4 addresses the loop.

### 3.7 The judgement this plan must not make

It is tempting to "just update the spec to match the code". That is wrong, and it is the main risk here.

Some of the 29 undocumented tables represent deliberate product growth that the spec should absorb. Others may represent scope that grew because an agent found it convenient — features nobody asked for, carrying maintenance forever. The audit cannot tell those apart, and neither can an agent. **Every divergence goes to the owner with a recommendation, and the owner decides.**

## 4. Technical design

### 4.1 The divergence register

A new file, `docs/spec-divergences.md`, is the audit's deliverable. One row per divergence:

| field | meaning |
|---|---|
| `id` | `DIV-001`, stable, referenced from plans and commits |
| `area` | spec section (`§12`, `§19`, …) or `none` when the spec is simply silent |
| `subject` | the table, endpoint, screen, message, or rule |
| `spec says` | quoted, or `nothing` |
| `code does` | with a file and line reference |
| `severity` | see §4.2 |
| `recommendation` | `spec-wins` \| `code-wins` \| `needs-owner` |
| `decision` | filled in by the owner, blank until then |

The register is a working document, not prose. It outlives this plan: later divergences get appended rather than rediscovered.

### 4.2 Severity, defined so it is not a matter of taste

- **critical** — the code contradicts a §2 non-negotiable principle or a §4/§00-overview immutable decision. There should be none of these; if one exists it is a stop-everything finding.
- **high** — a reader implementing against the spec would write broken code. `expired` is the type case: a terminal job status that no spec reader would handle.
- **medium** — a whole subsystem exists with no spec description. All 29 start here.
- **low** — wording, counts, and roadmap staleness.

Severity drives order of work, nothing else. A `medium` that turns out to be an unwanted feature matters more than a `low`; that is what `needs-owner` is for.

### 4.3 Method — what "audit" concretely means

Six passes, each mechanical enough to be checkable:

1. **Tables.** Every `sqliteTable(` in `schema.ts` against §12. The table name, its purpose in one line, and the plan that introduced it (from the file's own comments).
2. **Endpoints.** Every route mounted in `server/http.ts` and the `api/` modules against §13 and §7.7.
3. **Protocol messages.** Every member of `ServerMessageSchema` and `ClientMessageSchema` against §13.
4. **Screens.** Every `page.tsx` under `studio/src/app` against §19.
5. **Engines.** Every registered engine id against §7 and §9 — this is where an extra driver layer would show up.
6. **Enumerations.** Job status, device status, readiness, and any other Zod enum the spec also lists.

Each pass appends to the register. No pass edits `spec.md`.

### 4.4 Closing the loop

Amending the spec once, without changing how work is done, guarantees a repeat. Two changes to the process, both small:

- **`docs/plans/00-overview.md` §7 (Definition of Done)** gains one item: *"If this plan added a table, endpoint, protocol message, screen, or engine, `docs/spec.md` is updated in the same commit — or a `DIV-` row is added saying why not."*
- A `bun run spec:check` script fails when a table, route, or `page.tsx` exists whose name appears nowhere in `spec.md` and has no `DIV-` row. It is deliberately dumb — a name-presence check, not comprehension — because a dumb check that runs is worth more than a smart one that does not.

The check belongs in CI's `check` job, as a warning first and a failure once the register is complete. Turning it to a failure while 29 rows are open would block every commit on day one.

### 4.5 Amending the spec

Only after decisions are recorded. Rules:

- Section structure and numbering are preserved. New subsystems get new subsections (`§12.8 Clusters and batches`), never a renumbering — plans reference these numbers by the hundred.
- Every amended section carries a one-line provenance note: `(added in reconciliation, 2026-08-XX, DIV-014)`.
- Where the owner chose `spec-wins`, the spec is left alone and a defect plan is filed against the code, referencing the `DIV-` id.
- Spec §20's roadmap is replaced by a pointer to `docs/plans/00-overview.md`. Two competing roadmaps is how this started.

## 5. Implementation steps

### 84.1 Register skeleton
- [ ] Create `docs/spec-divergences.md` with the §4.1 columns and a short preamble explaining what the file is for.
- Result: an empty register that a later pass can append to.

### 84.2 Passes 1–3 (data, endpoints, protocol)
- [ ] Table pass: all 36, each with purpose and originating plan.
- [ ] Endpoint pass.
- [ ] Protocol message pass.
- Result: rows exist with `recommendation` filled in, `decision` blank.

### 84.3 Passes 4–6 (screens, engines, enumerations)
- [ ] Screen pass: all 23 routes.
- [ ] Engine pass.
- [ ] Enumeration pass — `expired` is already known and must appear as a row.
- Result: the register is complete; every row has a severity and a recommendation.

### 84.4 Owner review
- [ ] Present the register grouped by severity, with the `needs-owner` rows first and a recommendation on each.
- [ ] Record decisions in the `decision` column.
- **This step is a hard stop.** No spec text changes before it. An agent must not decide on the owner's behalf.
- Result: every row has a decision.

### 84.5 Amend the spec
- [ ] Apply every `code-wins` decision to `docs/spec.md` per §4.5.
- [ ] For every `spec-wins` decision, file a defect plan referencing the `DIV-` id.
- [ ] Replace §20's roadmap with a pointer to the plan index.
- Result: the spec describes the shipped product; disagreements have plans.

### 84.6 Close the loop
- [ ] Add the Definition of Done item to `00-overview.md` §7.
- [ ] Add `scripts/spec-check.ts` and the `spec:check` script; wire into CI as a warning.
- Result: a new undocumented table makes CI say so.

## 6. Acceptance criteria

1. `docs/spec-divergences.md` exists and covers all six passes.
2. Every one of the 36 tables, 23 screens, and every registered route, protocol message and engine appears either in `spec.md` or as a register row — none is silently absent from both.
3. Every row carries a severity and an owner decision.
4. `spec.md` retains its section numbering; every amended section carries a provenance note.
5. Spec §20 no longer holds a second roadmap.
6. Every `spec-wins` decision has a corresponding defect plan.
7. `bun run spec:check` runs in CI and reports the remaining gap as a number.
8. `00-overview.md` §7 requires spec updates or a `DIV-` row.
9. `bash scripts/typecheck.sh` and `bun test` stay green — this plan changes documentation and one script, not behaviour.

## 7. Test plan

Mostly not a code plan, so the checks are mechanical:

```bash
# Every table is either in the spec or in the register.
grep -A1 'sqliteTable(' packages/core/src/db/schema.ts | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u > /tmp/tables
while read t; do
  grep -q "$t" docs/spec.md || grep -q "$t" docs/spec-divergences.md || echo "UNACCOUNTED: $t"
done < /tmp/tables

# Same shape for screens.
find packages/studio/src/app -name page.tsx | sed 's|.*/app||;s|/page.tsx||'

bun run spec:check   # exits non-zero once the register is complete and something new appears
```

**Unit**: `scripts/spec-check.ts` gets a test proving it fails on a name present in neither the spec nor the register, and passes when a `DIV-` row covers it.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| An agent "reconciles" by pasting the code's shape into the spec, laundering unwanted scope into doctrine. | §84.4 is a hard stop with the owner. `needs-owner` is a first-class recommendation, not a fallback. |
| The register becomes a graveyard nobody reads. | `spec:check` reports the open count on every CI run, so the number is visible whether or not anyone opens the file. |
| Six passes across 87 plans and 36 tables exhausts one working session. | The passes are independent and append-only; 84.2 and 84.3 may be separate sessions. The register tolerates being half-written. |
| Renumbering spec sections breaks hundreds of plan references. | Numbering is preserved; new material becomes new subsections (§4.5). |
| The audit finds a `critical` divergence and the plan has no answer for it. | By definition that stops other work and becomes its own plan immediately. §3.5 checked the three most dangerous rules up front and all three hold, so this is unlikely — but it is not assumed. |

## 9. Open questions

1. **DECIDED (2026-08-03): `ai_agents` and its seven companion tables stay.** The owner uses the feature — basic chat through Studio is working — and confirmed it is intended scope. So this is a `code-wins` row: the spec gains a section describing the in-product AI agent, and nothing is removed. Note for whoever writes that section: `agents` meant the cloud tunnel process until plan 61 renamed it to `nodes`, and `schema.ts` deliberately avoids reusing the name. The spec must make the same distinction or it will re-create the confusion this decision just resolved.
2. Same question, smaller, for `connectors`, `webhook_endpoints`, `workspace_files`, and `nodes`.
3. Should `spec.md` be split? At 842 lines describing 36 tables and 23 screens it is near the limit of what one document can hold. Proposed: keep it whole for this plan — splitting mid-audit would make the diff unreadable — and revisit afterwards.
4. Should `spec:check` ever become a hard CI failure? Proposed: yes, once the register reaches zero open rows, and not before.
5. Does the register replace §22 ("Open questions / future") or sit beside it? Proposed: beside — §22 is about the product's future, the register is about the present's accuracy.
