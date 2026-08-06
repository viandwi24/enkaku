# Plan 73 — M38 : The Workbench Earns Its Name

> Status: implemented — `AppShell.tsx`'s shell height lock (§4.1: `flex h-dvh overflow-hidden` / `main` as `min-h-0 flex-1 overflow-y-auto`); `components/agent/Composer.tsx` (auto-grow to 10 lines, paste/drop/button attachments through `POST /api/v1/blobs`, inline model/effort selects that `PATCH /api/agents/:id` and say so, Stop-replaces-Send with Esc, a real context-usage readout against the model's window with the compaction threshold marked, per-thread `sessionStorage` drafts); the agents list's row overflow menu (Open/Duplicate/Delete, `DeleteCounts` naming threads and runs before deleting); `SectionNav`'s optional `group`, additive and byte-identical for ungrouped sections; `app/settings/page.tsx` regrouped into Devices/Jobs/AI Agents/Farm with a new **AI Agents → Defaults** section rendering `FarmSettings.agentDefaults` through the existing schema-driven form; `components/AskAnAgentDialog.tsx` (§4.6, criterion 15) wired into `components/device/DeviceHeader.tsx`'s header ("Ask an agent…") — an agent picker that computes reachability per plan 65 §3.5 (`deviceGrants.length === 0` ⇒ unrestricted, so it is selectable, not filtered out — inverting this was the documented trap) and disables/labels-with-reason anything that would refuse, an opening-prompt textarea, and on start `POST /api/v1/threads` with `deviceScope: [deviceId]` (schema.ts's `agentThreads.deviceScope`, migration `0036_chunky_boomerang.sql`) so every run in the thread is narrowed via plan 67 §4.2's existing `deviceGrantsOverride`, then routes to `/agents/detail?id=…&thread=…`; `design-rules.test.ts` (moved to `packages/studio/src/`, root walking all of `src`, three patterns each proven against a throwaway fixture) rejecting the Tailwind v3 bracket form, internal `<a href>`, and `calc(100vh`/`calc(100dvh` — `grep -rn "calc(100vh\|calc(100dvh" packages/studio/src` returns nothing. Every one of `packages/studio/src/app/*/page.tsx`'s 21 routes has a colocated render test; walking them for criterion 2 found exactly two that opt into `h-full` (`agents/detail/page.tsx` — the workbench, the one page meant to own its own scroll region — and `workspace/page.tsx`, whose file-tree column needs the same fill-and-internally-scroll shape); every other route (`agents/{approvals,page,runs,thread}`, `batches{,/detail}`, `clusters`, `dev/tools`, `device`, `jobs{,/detail}`, `nodes`, the dashboard `page.tsx`, `schedules{,/detail}`, `scripts{,/detail}`, `settings`, `tools`, `topology`) renders into `main`'s new `overflow-y-auto` container with no height opt-in at all, so it scrolls exactly where it always did — confirmed structurally (AppShell's diff is the only place `overflow`/`min-h-0` semantics changed) and behaviourally (all 21 routes' render tests pass unedited). **This work was found essentially complete in the working tree when this pass began** — 73.1–73.7 (Composer, agent-list actions, `SectionNav` grouping, settings regrouping, `AskAnAgentDialog`, and the widened design-rule test with its own fixture proofs) were all already written and covered by render tests using plan 72's `renderWithApi`; nothing in §4 needed to be authored from scratch. This pass's own contribution: verifying that inherited work end to end, walking all 21 routes for criterion 2 (not assumed), and fixing one real bug it uncovered — **`packages/core/drizzle/meta/_journal.json` entries `0023_rename_agents_to_nodes`/`0024_rename_schedules_script_ref` carried synthetic future `when` timestamps (`1786000000000`/`1786100000000`) instead of real generation times**, out of chronological order against every neighboring entry (`0022`'s real `1785949834566` and `0025`'s real `1785961739977`). `runMigrationsUpTo`'s catch-up contract (`db/index.ts`) applies, on a later plain `runMigrations` call, every journal entry whose `when` exceeds the highest `when` actually applied — with `0023` recorded as that high-water mark, migrations `0025`–`0035` (real timestamps all below it, including the one creating `agent_threads`) were silently skipped while `0036` (this plan's own `agent_threads.device_scope` column, §4.6) was not, so it failed `no such table: agent_threads`. Reproduced deterministically by the pre-existing `backfillScheduleScriptRefs` suite (plan 62, `db/migrations/backfill-schedule-refs.test.ts`), which cuts exactly at tag `0024` and is the only caller whose cut point sits inside the corrupted range (`daemon.ts`'s real boot path cuts at `0014`; `rename-agents-to-nodes.test.ts` cuts at `0023`, before the anomaly). Fixed by setting `0023`/`0024`'s `when` to `1785953000000`/`1785957000000`, restoring monotonic order; the cut-index logic (`findIndex` on `tag`, not `when`) is untouched, so nothing about `runMigrationsUpTo`'s existing contract changed. `bun run typecheck` is green across all 11 packages; root `bun test` is 2053 pass / 0 fail (baseline 2040 stated at the start of this pass, plus files already present); `bun run --cwd packages/studio test` is 326 pass / 0 fail; `bun run build:studio` succeeds, producing a static export of all 25 routes (`next build` + `next export`, `○ (Static)` for every one, including `/agents/detail` and `/device`). **Not done in this pass:** no live `bun run dev`/`dev:studio` manual smoke test (§7) was performed in a browser — criterion 2 and the render-test evidence above are the verification actually run.
> Ships: packages/studio/src/components/AskAnAgentDialog.tsx
> Note (plan 78): `Composer.tsx` (this line's original artefact) was superseded by the ported `ai-elements/prompt-input` inside `components/agent/Chat.tsx` — "replace, never version" (`CLAUDE.md` §4.3). `AskAnAgentDialog.tsx` (also built by this plan, §4.6) is untouched by that change, so this line now points at it instead.
> Depends on: Plan 70 (image blocks — the composer's attachments need them), Plan 71 (`heldBy` — the device page's agent affordances need it), Plan 72 (parsed responses and a DOM renderer — without it none of this is verifiable).
> Spec references: `docs/design.md` (the design system and its quality floor).

---

## 1. Goals

- The workbench fills the window. **One** scroll region, and it is the conversation.
- The composer is at least as good as the reference the user set: auto-growing input, attachments, model and effort visible and changeable, a stop button that appears while the agent works, and a context indicator.
- An agent can be **deleted from the list**, where a person looks for it.
- Everything about AI lives under **one settings section**, and the farm defaults Plan 65 built are actually editable.
- A device page can **hand the phone to an agent**.

## 2. Non-goals

- Changing the three-column structure. It is right; it is the execution that is not.
- Markdown rendering, syntax highlighting, or a rich-text editor in the composer.
- Voice input, or any capability the backend does not have.
- Re-designing non-agent screens. The shell change in §3.1 touches all of them and must therefore leave them looking identical.

## 3. Context and design decisions

### 3.1 Two scrollbars, and a magic number

`AppShell.tsx:102` opens `<div className="flex min-h-dvh">` and `:124` renders `<main className="min-w-0 flex-1">`. Nothing locks the viewport height, so the document body scrolls whenever content is tall.

The agent page then compensates with `h-[calc(100vh-91px)]` — **91 is a hard-coded guess at the header's height**. It is wrong the moment the header changes, and it does not stop the body scrolling anyway. So the page scrolls, and the transcript inside it scrolls, and the two fight.

The fix is at the shell, once:

```tsx
<div className="flex h-dvh overflow-hidden">      {/* was: min-h-dvh, no overflow */}
  …
  <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
</div>
```

`main` becomes the scroll container; the body never scrolls. A page wanting full height then asks for `h-full` and gets it, with no arithmetic — and `min-h-0` is what makes a flex child actually shrinkable, which is the detail that makes every naive attempt at this fail.

**This changes every screen**, so §6.2 requires the others to be verified unchanged rather than assumed so. A page that was relying on body scroll now scrolls in `main` — visually identical, structurally correct. The workbench opts into `h-full overflow-hidden` and owns its own regions.

Every `calc(100vh-…)` in Studio is removed in this plan. Each one is the same guess.

### 3.2 The composer, against the bar that was set

Today it is a fixed-height `<Textarea>` and a send button (`Transcript.tsx:369-385`). The user named the reference and said the minimum is parity. Measured against it, and against what the backend can now do:

| | Today | After |
|---|---|---|
| input | fixed height, scrolls internally | auto-grows to ~10 lines, then scrolls |
| attachments | none | paste, drag-drop, and a button (Plan 70) |
| model | only in Settings, two clicks away | shown in the composer, changeable inline |
| effort | only in Settings | same |
| while running | send button disabled | **Stop** replaces Send |
| context use | invisible | "12k / 200k" with the compaction threshold marked |
| drafts | lost on navigation | kept per thread |
| keyboard | Enter sends, Shift+Enter newline | unchanged, plus Esc to stop |

Two of these are more than polish:

**Stop belongs in the composer.** Cancel exists today, elsewhere on the page. The moment a person wants to stop an agent driving a real phone, their hands are at the input and their eyes are on the transcript. Making them find a button in a header is a design failure with a physical consequence.

**The model selector changes the agent's setting, and says so.** A per-message model override sounds attractive and is a trap: it would make a thread's history a mixture of models with nothing recording which answered what. Changing it here changes the agent's configured model — the same field the Settings tab edits — and the control says so in a tooltip. One source of truth, reachable from two places.

The context indicator reads real numbers from `AgentRun.usage` (Plan 66) and the model's window (Plan 65's `listModels`), not an estimate. Where an estimate is unavoidable it is labelled as one.

### 3.3 Delete belongs where a person looks for it

`DELETE /api/agents/:id` exists, and the button exists — on the **detail** page, at line 294. The list has none. So the action is reachable only by first opening the agent you want to remove, which is why it reads as missing.

The list gets a row overflow menu — Open, Duplicate, Delete. Delete asks for confirmation and states what goes with it: threads, runs, and the transcript history. A person deleting an agent after a bad night should know they are also deleting the evidence.

**Duplicate** is included because it is the natural way to make a variant — same tools, same grants, different model or prompt — and without it, the fifth agent is configured by hand for the fifth time.

### 3.4 One settings section for AI, and the defaults finally exposed

Settings currently lists `Connectors`, `Webhooks`, and `Spend` as three flat siblings among `adb`, `Storage`, and `Blocked devices`. Three AI concerns scattered through a device-farm settings page.

Worse: **`FarmSettings.agentDefaults` is not rendered anywhere.** Plan 65 built the whole farm-default-then-override mechanism, the schema carries `.describe()` and `.meta({title})` on every field, and there is no screen on which a farm default can be changed. Half of that plan is inert.

So `SectionNav` gains optional grouping — a section may declare `group`, and the nav renders group headings with their sections nested. This is additive: an ungrouped section renders exactly as it does today, so no existing screen changes. It also tidies the device-side sections, which have wanted it since Plan 46.

```
Devices        Defaults · Battery · adb · Sessions & Wall
Jobs           Jobs · Storage
AI Agents      Defaults · Connectors · Webhooks · Spend
Farm           Blocked devices · Users · Audit log
```

**AI Agents → Defaults** renders `agentDefaults` through the same schema-driven form the device settings already use, so a field added to the schema appears automatically and can never again exist with nowhere to set it.

### 3.5 A device page can hand the phone to an agent

Plan 69 gave the device page a read-only badge. Nothing lets an operator use an agent from the place they are already looking at the phone.

An **Ask an agent** action in the device header opens a thread with the agent picked and the device pre-scoped — the run's device narrowing (Plan 67 §4.2) is set to that phone, so the agent it starts can touch that one and no other. That is a safer default than a general thread, and it is what someone means when they ask from a device page.

The picker lists only agents that may reach this device (Plan 65 §3.5's grants, including the empty-means-all rule), with the reason shown for any that cannot. Offering an agent that will then refuse is the "precondition presented as an error" failure Plan 59 was written to remove.

### 3.6 The design floor is checked, not hoped for

Plan 69's `design-rules.test.ts` greps for the Tailwind v4 bracket form and internal `<a href>`. Both rules have shipped broken here before. This plan **widens its roots to all of `packages/studio/src`** rather than the agent subtree, and adds `calc(100vh` and `calc(100dvh` to what it rejects (§3.1) — because the next person reaching for a magic viewport number should be stopped by a test, not by a review.

With Plan 72's renderer available, the components this plan touches get real render tests. That is the difference between this plan's claims and the last one's.

## 4. Technical design

### 4.1 Shell

`AppShell.tsx` per §3.1. Every `calc(100vh-` and `calc(100dvh-` in Studio removed; the pages that used them take `h-full`.

### 4.2 `components/agent/Composer.tsx`

Extracted from `Transcript.tsx`, which should render a conversation and not own an input. Props: `threadId`, `agent`, `runState`, `onSend`, `onStop`.

- auto-grow via a hidden measuring element, capped at ten lines;
- attachments: paste, drop, and a button, uploading through Plan 70's `POST /api/v1/blobs`, thumbnails with size and a remove control, and refusals shown inline by name;
- model and effort as inline selects writing to the agent via `PATCH /api/agents/:id`, with an inline confirmation that this changes the agent's setting;
- **Stop** replaces **Send** while a run is active, calling the existing cancel route; Esc does the same;
- context indicator from `AgentRun.usage` and the model's window, with the compaction threshold marked;
- drafts in `sessionStorage`, keyed by thread.

### 4.3 Agent list

Row overflow menu with Open, Duplicate, Delete. Delete confirms and names what is removed. Duplicate copies everything except `id`, `slug`, and `name`, opening the new record's detail page.

### 4.4 `SectionNav` grouping

`SettingsSection` gains `group?: string`. Sections without one render flat, exactly as now. The nav renders headings in declaration order; keyboard navigation (Plan 46 §4.1) traverses the flattened visible list, so arrow keys behave as they do today and skip nothing.

### 4.5 Settings page

Regrouped per §3.4, plus the **AI Agents → Defaults** section rendering `agentDefaults` through the existing schema-driven form.

### 4.6 Device page

`AskAnAgentDialog` — agent picker filtered by reachability with reasons, an opening prompt, and a link into the created thread with the device pre-scoped.

## 5. Implementation steps

**73.1 — Shell height** (§4.1), then walk every page and confirm it looks the same.

**73.2 — `Composer`** extracted and complete (§4.2).

**73.3 — Agent list actions** (§4.3).

**73.4 — `SectionNav` grouping** (§4.4), with Plan 46's tests passing unedited.

**73.5 — Settings regrouped and `agentDefaults` exposed** (§4.5).

**73.6 — Ask an agent from a device** (§4.6).

**73.7 — Widen the design-rule test and add render tests** (§3.6).

## 6. Acceptance criteria

1. The workbench fills the window with **no page-level scrollbar**; the only scrolling region is the conversation.
2. Every other screen looks and behaves as it did before the shell change — checked screen by screen, not assumed.
3. `grep -rn "calc(100vh\|calc(100dvh" packages/studio/src` returns nothing, and the design-rule test rejects reintroduction.
4. The composer grows with its content to ten lines, then scrolls internally.
5. An image can be attached by paste, drop, or button; a rejected file states why; a sent attachment reaches the agent as an image (Plan 70).
6. Model and effort are visible and changeable in the composer, and changing either updates the agent's stored setting — with the control saying so.
7. **Stop** replaces **Send** while a run is active, and stops it; Esc does the same.
8. The context indicator shows real usage against the model's real window, with the compaction threshold marked; any estimate is labelled.
9. A draft survives navigating away and back, per thread.
10. An agent can be deleted **from the list**; the confirmation names the threads and runs that go with it.
11. An agent can be duplicated, producing an editable copy with everything but id, slug, and name.
12. Settings groups AI Agents into one section with Defaults, Connectors, Webhooks, and Spend as sub-sections.
13. **`agentDefaults` is editable**, rendered from its schema, and a new schema field appears without a UI change.
14. Plan 46's `SectionNav` tests pass **unedited**; ungrouped sections render exactly as before; arrow-key navigation traverses the flattened list.
15. A device page can start an agent thread scoped to that device; the picker shows only agents that may reach it and gives the reason for any that cannot.
16. The design-rule test covers all of `packages/studio/src` and rejects the bracket colour form, internal `<a href>`, and viewport `calc()`.
17. The composer, the agent list menu, and the settings grouping each have a **render** test (Plan 72's infrastructure).
18. `bun run typecheck` passes; `bun test` is green; `bun run build:studio` produces a working static export.

## 7. Test plan

**Render:** composer — auto-grow at the cap, Stop while running, attachment accepted and rejected, draft restored. Agent list — menu present, delete confirmation naming threads and runs. Settings — groups render, `agentDefaults` fields present, ungrouped sections unchanged. Device — the picker filters and gives reasons.

**Static:** the widened design-rule test, including a deliberate fixture proving each pattern is actually caught (a test that passes over zero matches proves nothing — Plan 69's own guard, kept).

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. Agents → detail → no page scrollbar; only the transcript scrolls
# 2. type ten lines → the composer grows then scrolls; the transcript does not move
# 3. paste a screenshot → thumbnail → send → the agent describes it
# 4. start a long run → Stop appears; press it → it stops
# 5. change the model in the composer → Settings shows the same value
# 6. Agents list → ⋯ → Delete → the confirmation names the threads
# 7. Settings → AI Agents → Defaults → change maxSteps → a new agent inherits it
# 8. a device page → Ask an agent → the thread opens scoped to that device
# 9. walk every other page → unchanged
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The shell height change breaks a screen that relied on body scroll. | `main` becomes the scroll container, so scrolling still happens — only its owner moves. Criterion 2 requires screen-by-screen verification and 73.1 makes that the step's own definition of done. |
| A composer model selector edits the agent unexpectedly. | The control states that it changes the agent's setting (§3.2), and per-message override was rejected precisely because it would make a thread's history ambiguous. |
| Duplicate produces agents with confusing names. | The copy opens its detail page immediately with the name focused, so it is named before it is used. |
| Regrouping settings hides something an operator knew where to find. | Grouping is additive and ungrouped sections are untouched; the section ids stay stable, so deep links still land. |
| Attachments become a file-upload surface. | Plan 70 owns the limits, sniffing, and allowlist; this plan only calls it. |
| Render tests are slow or flaky. | They mount single components with mocked responses, not the whole app; Plan 72's `renderWithApi` keeps them declarative. |

## 9. Open questions

1. Should the composer support `@` to mention a device, inserting its id? Natural once the device picker exists, and it needs a decision about whether a mention narrows the run's grants or is merely text.
2. Should a draft be stored server-side so it survives a browser change? `sessionStorage` covers the common case; anything more needs a per-user store nothing else wants yet.
3. Should the wall offer "ask an agent about these devices" for a multi-selection? Plan 67's fan-out makes it cheap, and it needs a prompt UX that does not exist yet.
