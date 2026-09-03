# Plan 218 (MVP wave 3): Jobs — the list, the detail, the replay timeline, artifacts, and the run picker

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 213 (the shell: `components/shell/AppShell.tsx`, `PagePanel.tsx`, `nav.ts`'s `/jobs` entry, `lib/overlays.ts`'s `useOverlay`, `scripts/check-routes.ts` with its `PENDING_REMOVAL` list), plan 211 (`job_runs` and `workflow_steps`; `JobInfo.kind`/`runId`/`runSeq`/`runCount`/`trigger`/`parentWorkflowJobId`/`stepSeq`; `JobDetail.runs`; `JobRunInfo`/`JobRunDetail`; `GET /api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/runs`, `/api/jobs/:id/runs/:runId` and its `/logs`, `/trace`, `/trace/frames/:hash`, `/trace/ui/:hash`, `/artifacts`; `GET /api/workflow-jobs/:id/runs/:runId/steps`; `POST /api/workflow-jobs/:id/resume`; `run-script`/`run-workflow` with `jobId`; `schedule_runs` and `POST /api/jobs/:id/resume` deleted). Through 213 it also depends on plan 204 (tokens, `@enkaku/ui` primitives, `packages/ui/src/icons.ts`) and through 211 on plan 207 (`packages/studio/src/lib/actions.ts`'s `runAction`, `ActionRefusedError`; `batches.group_id`).
> Spec references: `docs/mvp/design_handoff_enkaku_openpf/README.md` section "Screen: Jobs" (lines 324 to 389, quoted verbatim and in full in §4.1) plus "Interactions & Behavior" (line 459, "Click timeline track / tick / frame | Move the playhead to that event"), "Design Tokens" (486 to 511) and "Fidelity" (29 to 33); `docs/mvp/14-jobs-and-runs.md` §2 (what the user sees) and §5 (retention per run); `docs/mvp/05-jobs-model.md` §1.2 and §1.5 as amended by MVP 14 and MVP 15; `docs/mvp/15-ui-migration.md` §0 (the Jobs bullet), §0.1.1 (Schedules moves to Scripts & Workflows), §1 rows "Job kinds", "Schedules", "Runs of one job", §2 (the run picker "is to be drawn"), §3 step 5; `docs/mvp/13-removal-register.md` A.6 (`/batches` and `/schedules` as top-level routes); `docs/mvp/16-consolidated-plan.md` §1 (Surfaces), §2 (the Jobs row), §3 wave 3. Where `docs/spec.md` §19's rows "Job / run detail" and "Clusters, batches, schedules" still describe a Summary tab, a node timeline or a schedule run table, `docs/mvp/16` wins (plan 200 header) and §5 step 218.14 rewrites them.
> Ships: packages/studio/src/components/jobs/RunPicker.tsx

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_218` and `GREP_218_COLOUR` are defined once in §10.3 and copied verbatim wherever they are cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Jobs is one screen with two tabs and no second route | `app/jobs/page.tsx` exists; `app/jobs/detail/`, `app/batches/` and `app/schedules/` do not | `test -f packages/studio/src/app/jobs/page.tsx && test ! -e packages/studio/src/app/jobs/detail && test ! -e packages/studio/src/app/batches && test ! -e packages/studio/src/app/schedules` exits 0 | [ ] |
| G2 | The run picker exists as its own component and is mounted only from the detail header | one file; exactly one importer | `test -f packages/studio/src/components/jobs/RunPicker.tsx`; `grep -rn "jobs/RunPicker" packages/studio/src` prints exactly one line, in `packages/studio/src/components/jobs/DetailHeader.tsx` | [ ] |
| G3 | Nothing in Studio addresses the deleted routes any more | 0 matches | `grep -rnE "/jobs/detail\|/batches\|/schedules" packages/studio/src scripts/check-routes.ts` prints nothing | [ ] |
| G4 | `check-routes.ts` passes with both rows pruned | exit 0 and no stale exemption | `grep -nE "'/batches'\|'/schedules'" scripts/check-routes.ts` prints nothing; `bun run scripts/check-routes.ts` exits 0 | [ ] |
| G5 | The five timeline logic modules survive and the five prototype trace components are gone | `timeline/useTracePlayback.ts` and `timeline/lanes.ts` exist; `components/jobs/trace/` does not | `test -f packages/studio/src/components/jobs/timeline/useTracePlayback.ts && test -f packages/studio/src/components/jobs/timeline/lanes.ts && test ! -e packages/studio/src/components/jobs/trace` exits 0 | [ ] |
| G6 | The four surfaces the old detail page owned are gone as separate panels | 0 matches | `grep -rnE "JobResultSection\|JobFailureDetail\|JobLogsPanel\|JobArtifactsPanel" packages/studio/src` prints nothing | [ ] |
| G7 | The workflow-node vocabulary is gone from this area | 0 matches | `GREP_218` (§10.3) prints nothing | [ ] |
| G8 | No file this plan writes names a colour in the v3 bracket form, a `dark:` variant, or a hex literal | 0 matches | `GREP_218_COLOUR` (§10.3) prints nothing | [ ] |
| G9 | Every handoff measurement in §4.1 is written as a plan 204 token utility, character for character | the class strings of §4.5 to §4.12 | owner smoke §7.3 step 2, with `README.md` lines 324 to 389 open beside the browser | owner |
| G10 | Re-running keeps both results and the list does not grow a row | 1 row before, 1 row after; `run 2 of 2` in the picker; run 1 and run 2 hold different `finishedAt` and their own Output | owner smoke §7.3 step 5 | owner |
| G11 | A workflow job shows its steps and each script step opens a real script job | N step rows; clicking step 2 loads a job whose meta line reads `step 2 of workflow job <id>` | owner smoke §7.3 step 6 | owner |
| G12 | The timeline scrubs and the frame strip moves the playhead | clicking the track snaps to the nearest event; clicking a frame selects that event; the readout and "event N of M" both change | owner smoke §7.3 step 7 | owner |
| G13 | The Jobs screen makes no request on a timer | 0 `setInterval` and 0 `setTimeout` that schedules a fetch, outside `coalesce` in `lib/use-job-counts.ts` | `grep -rnE "setInterval\|setTimeout" packages/studio/src/app/jobs packages/studio/src/components/jobs` prints nothing | [ ] |
| G14 | The workspace typechecks | 0 errors | `bun run typecheck` exits 0, every package `OK` | [ ] |
| G15 | Plan 204's token script still passes after the icon additions | prints `design tokens ok` | `bun run scripts/check-design-tokens.ts` exits 0 | [ ] |
| G16 | The shared jobs table has no importer left, and is deleted | file gone | `test ! -e packages/studio/src/components/JobsList.tsx`; `grep -rn "components/JobsList" packages/studio/src` prints nothing. If step 218.12's precondition grep names a surviving importer, this row stays open and §11 records the importer instead | [ ] |
| G17 | Two runs can be compared side by side | `?compare=<runId>` renders two columns; a run with a `resultSchema` renders a per-path diff table | owner smoke §7.3 step 8 | owner |

## 1. Goals

1. Rebuild Jobs as the handoff draws it: one page panel whose tab strip **is** the header, a 268 px left list, and a right detail with five sub-tabs (`docs/mvp/design_handoff_enkaku_openpf/README.md` lines 324 to 389). Not a restyle of `app/jobs/page.tsx` plus `app/jobs/detail/page.tsx`; both are replaced, and the second route is deleted (MVP 15 §3: "the shell and every control-touching screen are rebuilt on the handoff, not restyled").
2. **One Jobs list, kind visible per row** (MVP 15 §1 row "Job kinds"), with Batches as the second tab. No Script-jobs / Workflow-jobs split, no Schedules tab here.
3. **Draw the run picker** MVP 15 §2 lists as undrawn: the detail header's meta line opens with `run 3 of 3`, and the popover behind it lists every run newest first with status, duration, trigger and who started it (MVP 14 §2).
4. **Re-run adds a run, never a row.** The header's Re-run posts `run-script` / `run-workflow` with `jobId` (plan 211 §4.8), so the left list keeps exactly one row for the job and the picker gains a run.
5. **A workflow job shows its steps, and each script step is a real job** (MVP 05 §1.2, §1.5): the Timeline sub-tab of a workflow job renders `workflow_steps`, each script step linking to its own script job; a script job with a parent says `step 3 of workflow job <id>` in its meta line and links back.
6. **The replay debugger becomes the handoff's four cards**: Transport, Lanes, Frames, Frame + Event. The pure logic that already exists (playback, phase bands, nearest-event resolution, capture policy) is kept; the five prototype components that drew it are deleted.
7. **Two runs can be compared** (MVP 14 §2): results side by side, a field-by-field diff when the run declared a `resultSchema`, a plain split view for logs.
8. **`/batches` and `/schedules` stop being top-level routes** (MVP 13 A.6). Batches becomes this page's second tab; Schedules moves to plan 217's Scripts & Workflows page, which this plan does not build.

## 2. Non-goals

| Not done here | Done by |
|---|---|
| The Schedules tab, the Scripts table, the Workflows cards, the workflow editor | plan 217 (MVP 15 §0.1.1). This plan deletes `app/schedules/` and nothing else about schedules |
| The action dialogs behind the generic action set, including the Run script dialog that changes parameters and therefore creates a new job (MVP 14 §2) | plan 216 |
| The Device Control window, the Devices table and the Screens grid | plans 214 and 215. This plan's only edit to `app/page.tsx` is the six-line `?device=` effect in §4.14 |
| The Plugins and Settings screens | plan 219 |
| Any core route, schema, table or migration | plan 211. This plan is Studio only, plus `packages/ui/src/icons.ts` (§4.13) and `scripts/check-routes.ts` (§4.15) |
| The retention policy that expires runs (MVP 14 §5, MVP 09 §6) | plan 224. This screen never claims a missing run was deleted; it renders what `GET /api/jobs/:id` returns |
| Deleting `components/bulk/`, `components/result-view/`, `components/schema-form/`, `components/PaginatedTable.tsx`, `components/ScheduleEditorDialog.tsx`, `components/RunScriptDialog.tsx` | plans 216 and 217 own their surviving importers; §3.8 has the count |
| Any Studio or `@enkaku/ui` test | nobody. Plan 200 §8.3: zero tests in both packages, and no MVP plan adds one back |

## 3. Context and design decisions

### 3.1 What the Jobs area is today (read 2026-09-03, before plans 211 and 213 land)

| File | Lines | What it is |
|---|---|---|
| `packages/studio/src/app/jobs/page.tsx` | 260 | `PageHeader` "Jobs" + a Clear history `AlertDialog` + a search box + a status `Select` + `<JobsList>`. `:8` `import { PageHeader } from '@/components/layout/PageHeader'`, `:9` `import { JobsList } from '@/components/JobsList'`, `:213` `<JobsList`, `:216` `resetKey={\`${status}\|${query}\`}` |
| `packages/studio/src/app/jobs/detail/page.tsx` | 1211 | Six tabs (`summary`, `trace`, `logs`, `artifacts`, `script`) through `EntityTabs` at `:867` `hrefFor={(k) => \`/jobs/detail?id=${jobId}${k === 'summary' ? '' : \`&tab=${k}\`}\`}`. The workflow node timeline is `:249` `function NodeTimeline({` through `:373`, with `:269` `const lastSeqForNodeId = new Map<string, number>()` and `:270` `for (const n of nodes) lastSeqForNodeId.set(n.nodeId, n.seq)` attributing a looped node's artifacts to its last execution. The gate verdict copy is `:182` `function gateVerdictSentence(row: JobNodeInfo, docNode: WorkflowNode \| null): string \| null` with `:196-197` `function docNodeById(doc: WorkflowDoc \| null, nodeId: string)`. The resume confirmation is `:385` `function ResumeDialog({`, and its `workflowDoc` branch is `:409` `if (workflowDoc) {` (the document's own node order decides what will be skipped, with a seq-ordered fallback). `:516` destructures fifteen fields off `useJobDetail` |
| `packages/studio/src/app/batches/page.tsx` | 123 | A `PaginatedTable` of `BatchInfo` with a local `BatchStatusBadge` and a `ProgressSummary` |
| `packages/studio/src/app/batches/detail/page.tsx` | 628 | Batch header, `BatchResults`, `OutcomeSummary`, `SkippedGroups`, a members `<JobsList>` (`:44`), an artifacts sheet, rerun and rerun-failed |
| `packages/studio/src/components/JobsList.tsx` | 417 | The one jobs table, shared by four screens (its own header says so). Importers today: `app/jobs/page.tsx:9`, `app/batches/detail/page.tsx:44`, `app/device/page.tsx:53`, `app/scripts/detail/page.tsx:42`, `components/device-popup/ReadPopups.tsx:7`. `:261` and `:407` are its two `next/link`s to `/jobs/detail?id=` |
| `packages/studio/src/components/jobs/` | 4 panels | `JobResultSection.tsx` (outcome + `ResultView` + params), `JobFailureDetail.tsx`, `JobLogsPanel.tsx`, `JobArtifactsPanel.tsx` |
| `packages/studio/src/components/jobs/trace/` | 5 components + 1 hook | `TracePanel.tsx` (composition), `TraceScrubber.tsx`, `TraceTimeline.tsx` (lanes and film strip; `:58` `export function phaseBands(events, endMs): PhaseBand[]`, `:85` `export function formatOffset(atMs, originMs): string`, `:92` `export const FRAME_STATUS_WORD`), `TraceFrame.tsx`, `TraceEventDetail.tsx`, `useTracePlayback.ts` (`:51` `export type PlaybackSpeed = 1 \| 2 \| 4`, `:60` `export function advancePlayheadMs(...)`, `:87` `export function useTracePlayback(`) |
| `packages/studio/src/lib/use-job-detail.ts` | 269 | Fetch-then-subscribe for job, script source, workflow document, device ref, artifacts and the three-source log merge (`savedLogs` from the `job.log` artifact, `backfillLogs` from `GET /api/jobs/:id/logs`, `liveLogs` from `job.log`) |
| `packages/studio/src/lib/useJobTrace.ts` | 260 | `GET /api/jobs/:id/trace` + the `job.trace` push, plus the pure helpers `compareTraceEvents`, `sortTraceEvents`, `capturePolicyAt`, `describeCapturePolicy`, `explainEmptyActionLane`, `nearestEventIndex`, `frameEventAt`, `previousFrameEventAt`, `failingEventIndex`, `frameStatusCounts` |
| `packages/studio/src/lib/jobs.ts` | 77 | `JobWithPhase`, `isRunnerLog`, `producedArtifacts`, `outcomeLine`, `formatResult` |

Plan 211 §5 step 211.13 has already made the smallest edits that compile against runs: the node timeline, the `/nodes` fetch and the resume dialog are deleted from `app/jobs/detail/page.tsx`, a placeholder `<select>` over `job.runs` is added, `use-job-detail.ts` takes a `runId`, `JobsList`'s sub-line reads `run ${job.runSeq} of ${job.runCount}`, and `schedules/detail/page.tsx`'s run table is replaced by a `JobsList`. That step's own "Do not" reads: "do not rebuild any of these pages to the handoff. Plan 218 does that." This plan is that rebuild.

### 3.2 What the design of record decides, and where a document corrects it

The handoff is high fidelity: "Colors, typography, spacing, radii, and interaction states are final and should be matched closely" (`README.md:30`). §4.1 quotes the whole Jobs section verbatim; §4.5 to §4.12 translate every number in it into a plan 204 token utility.

Three corrections come from the documents and win over the drawing:

1. **The run picker** does not exist in the handoff. MVP 15 §1 row "Runs of one job": "Documents win; a small design addition. The detail header's meta line gains a run picker ('run 3 of 3 ·') and Re-run adds a run. To be drawn into the prototype." This plan draws it (§4.8).
2. **Schedules is not a tab here.** MVP 15 §0.1.1 moves it to Scripts & Workflows. The handoff never drew one; MVP 05 §1.5 did, and is amended.
3. **`--cluster` vocabulary is gone.** `BatchInfo.clusterId` is `groupId` after plan 207 (`docs/plans/207-mvp-actions-api-and-groups.md:555`, "`:678` `clusterId: text('cluster_id'),` on `batches` -> `groupId: text('group_id')`"). No copy on this screen says cluster.

### 3.3 One screen, one route, one address shape

The handoff draws the list and the detail side by side inside a single page panel, so `/jobs/detail` stops being a place. Studio is a static export, so the selection travels as query parameters exactly the way `/device?id=` established (plan 108 §3.5):

| Parameter | Values | Reset by |
|---|---|---|
| `tab` | `jobs` (default) or `batches` | never; it is the address |
| `job` | a job id, or a batch id when `tab=batches` | switching `tab` |
| `view` | `inputs` (default), `output`, `logs`, `timeline`, `artifacts`; on `tab=batches`, `inputs` (default) or `members` | switching `job` to a job of the other kind |
| `run` | a `job_runs.id`; absent means the latest run | switching `job` |
| `compare` | a second `job_runs.id`; absent means no comparison | switching `job` or `run` |

The filter chip and the page number are **not** in the address. They are component state, because the handoff resets both on a tab change ("changing tab or filter resets to page 1") and nobody links to page 4 of a filtered queue. This matches the prototype's own state list (`jpKind`, `jpFilter`, `jpPage`, `jpJob`, `jpTab`, `README.md:481`) with the three things other screens link to promoted to the URL.

Every link into a job goes through one helper, `jobHref` (§4.4), so the address shape has a single definition and a future change is one edit.

### 3.4 The list is server-paged in windows of twelve, and never reflows under the reader

`GET /api/jobs` is cursor-paginated and returns a `total` (`packages/core/src/api/jobs.ts:320` `total: result.total,`). The handoff wants numbered pages ("1-12 of 63", 12 rows per page, 26x26 prev/next). The bridge is a cursor stack: `cursors[0] = null`, and each fetch stores its `nextCursor` at `cursors[page + 1]`. Prev and next move `page`; nothing recomputes a random page.

A `job.status` push **merges in place** into the loaded window and never prepends. The old page did prepend (`app/jobs/page.tsx:78` `tableRef.current?.pushLive(m.payload as Job)`), which is right for an infinite list and wrong for a fixed twelve-row window: a row appearing at the top pushes the row the reader is about to click off the bottom. A job that is not in the window enters the list on the next fetch, and the next fetch happens only while the reader is on page 0 (§4.6), which is where a new job belongs and where a reader watching for one is looking.

### 3.5 The counts are seeded once and coalesced, never polled

Six numbers are on screen at all times: the two tab counts and the five filter chip counts. Each is a `total` from a `limit=1` read, so the whole set is six cheap requests. They are seeded at mount and recomputed on a **coalesced** trigger: a `job.status` or `batch.status` push arms a 5000 ms trailing timer, and the timer fires one refresh. No message means no request, so an idle farm makes none, and a farm running forty batches makes one every five seconds instead of one per push. This is the only timer on the screen and G13 exempts it by file name.

### 3.6 The replay logic is kept; only the drawing is replaced

`useTracePlayback` already implements exactly what the Transport card needs: a continuous `playheadMs` on the `atMs` axis, 1x/2x/4x speeds, "scrubbing pauses", "stops at the end, never wraps" (`components/jobs/trace/useTracePlayback.ts:7-49`). `nearestEventIndex` already implements "Clicking the track snaps to the nearest event" (`lib/useJobTrace.ts:113`, and `README.md:459`). `phaseBands` already builds the Phase lane's blocks (`TraceTimeline.tsx:58`). Rewriting them to draw four cards would be rewriting the one part of this area that is correct.

So: the hook moves (`components/jobs/trace/useTracePlayback.ts` to `components/jobs/timeline/useTracePlayback.ts`, content unchanged but for its `@/lib/useJobTrace` import, which does not change), `phaseBands` and `formatOffset` are lifted into `components/jobs/timeline/lanes.ts` with the handoff's phase colours, and the five components that drew the prototype's timeline are deleted.

Two facts the handoff does not draw, that the existing timeline states and this plan must keep, because losing them turns an omission into a lie:

- **A truncated trace.** `useJobTrace` reports `truncated` when the fetch hit the page ceiling (`lib/useJobTrace.ts:186-194`). It renders as a banner above the four cards.
- **The capture policy and an empty action lane.** `describeCapturePolicy` and `explainEmptyActionLane` (`lib/useJobTrace.ts:84`, `:99`). The policy sentence goes into the Frames card's own heading line, which the handoff already reserves for exactly this kind of sentence ("Frames · 18 events · frames captured per action"); the empty-lane sentence renders inside the Lanes card.

### 3.7 The Timeline sub-tab is the replay for a script job and the step list for a workflow job

A workflow job runs no child process of its own after plan 211: it enqueues one script job per script step and waits (`docs/plans/211-mvp-jobs-and-runs.md` §1 goal 4). It therefore has no device trace and no frames; its steps do, one job each. MVP 05 §1.5 asks for "the step timeline with each script step linking to its own script job detail", and the handoff's fifth sub-tab is already called Timeline. So Timeline renders `WorkflowSteps` when `job.kind === 'workflow'` and the four replay cards otherwise, and the step list says in one line where the replay lives. The tab strip keeps all five entries for both kinds: a workflow run's Inputs, Output, Logs and Artifacts are all real reads, and an empty one is an honest empty one.

### 3.8 What survives, and who owns the last importer

Verified 2026-09-03 with `grep -rl` from `packages/studio/src`.

| Kept | Importers after this plan | Owner of the last one |
|---|---|---|
| `components/PaginatedTable.tsx` | `app/recordings/`, `app/nodes/`, `app/plugins/`, `app/groups/`, `app/workflows/`, `app/scripts/detail/`, `components/DeviceLog.tsx` | plans 217 and 219; not this plan's to delete |
| `components/bulk/` (`BatchResults`, `OutcomeSummary`, `SkippedGroups`, `use-batch-report`) | the six bulk dialogs, `lib/labelling.ts` | plan 216, exactly as plan 214 §3.6 states |
| `components/result-view/`, `components/schema-form/` | `components/bulk/BatchResults.tsx`, `components/plugin-view/` | plans 216 and 219 |
| `components/ScheduleEditorDialog.tsx` | none after this plan deletes `app/schedules/`; plan 217's Schedules tab is its next importer | plan 217. Do not delete it here |
| `components/StatusBadge.tsx` | `DeviceStatusBadge`, `ReadinessBadge`, `PluginStatusBadge` keep their callers; `JobStatusBadge` loses its last one here | plan 214 or 219. Delete only the `JobStatusBadge` export if it has no importer after step 218.12; see §10.2 |

`components/JobsList.tsx` is the one case where this plan is the last hand on the file. Plan 215 deletes `app/device/` and `components/device-popup/`; plan 217 rebuilds `app/scripts/detail/`; this plan deletes `app/jobs/page.tsx`'s and `app/batches/detail/`'s use. Plans merge in number order inside stage 6 (plan 200 §8.1), so plan 217 lands first and this plan should find zero importers. Step 218.12 checks rather than assumes.

### 3.9 `/schedules` is deleted here, and plan 213's table names plan 217 for it

`scripts/check-routes.ts`'s `PENDING_REMOVAL` (plan 213 §4.10) reads `'/schedules': 'plan 217: third tab of Scripts & workflows (MVP 15 §0.1.1)'`. This plan's brief assigns the deletion to plan 218. Both cannot delete the same row: check 2 of the script fails on a stale exemption, and a second deletion of a gone directory is a no-op. Step 218.13 is therefore written to be idempotent, deletes whatever is still there, prunes whatever row is still there, and records in §11 which of the two plans actually did it. §9 Q1 asks the CTO to settle the ownership on paper; nothing in this plan blocks on the answer.

### 3.10 The Batches detail is this plan's design, and it is small on purpose

The handoff says "Jobs and batches share one page - same shape, different scope" and then draws only the job detail. Rather than invent five batch-shaped sub-tabs, the Batches tab reuses the same chrome (the tab strip, the 268 px list, the `min-height: 58px` header, the sub-tab strip) with **two** sub-tabs: **Inputs** (`ph-sign-in`, the batch's own `params`, the same `JsonSnapshot` component) and **Members** (`ph-list-dashes`, the batch's member jobs, each row switching the address to `?tab=jobs&job=<id>`). The header's buttons become Re-run, Re-run failed and Export. `GET /api/batches/:id` already returns the batch and every member job in one read (`packages/protocol/src/api/batches.ts:18` `export const BatchWithJobsResponseSchema = z.object({ batch: BatchInfoSchema, jobs: z.array(JobInfoSchema) })`), so Members needs no pagination. §9 Q2 puts the two sub-tabs in front of the CEO.

### 3.11 The failure line is this plan's addition, and it is not optional

The handoff draws no failure surface: a failed run reads as a red badge and a duration. The screen it replaces had `JobFailureDetail` and `outcomeLine` ("Failed during prepare", `lib/jobs.ts`), and `docs/spec.md` §19 requires the plan 97 result banners (`invalid`, `partial`, `oversize`). Deleting both would be a regression dressed as a redesign. So one line renders directly under the sub-tab strip whenever the shown run failed, on every sub-tab, and the Output tab keeps the three banners. §4.9 has the exact copy.

## 4. Technical design

### 4.1 The handoff, verbatim

`docs/mvp/design_handoff_enkaku_openpf/README.md` lines 324 to 389, quoted in full. This is the specification; every measurement below is a translation of a number in this quote.

> ## Screen: Jobs
>
> Jobs and batches share one page — same shape, different scope. The tab strip **is** the page header
> (no separate "Jobs / N total" title above it): `padding: 10px 14px`,
> `border-bottom: 1px solid var(--line)`, tabs **Jobs** (63) and **Batches** (21) with counts.
>
> Below, two columns.
>
> **Left list** — `width: 268px`, `border-right: 1px solid var(--line)`.
> - Filter chips, **wrapping** (never a clipped scroll row): All · Running · Queued · Success · Failed,
>   each with a count; `padding: 5px 10px`, `border-radius: 8px`, active `var(--accent-soft)`.
> - Rows: state dot + name (`Geist Mono` 12px) on the first line, with the sub-line indented 14px beneath
>   ("step 4 of 12 · 34%", "position 1 · est 4m", "19:58 · 12m 41s", "element not found · 17:32").
>   Selected row = `background: var(--accent-soft)`.
> - Footer: "1–12 of 63" + prev/next (26×26). **12 rows per page**; changing tab or filter resets to page 1.
>
> **Right detail** —
> - Header (`min-height: 58px`, wraps): the script name (`Geist Mono` 15px/500) with the **state badge
>   beside it on the same line** (never a badge to the left of a multi-line block), the meta line beneath
>   ("job_8f21c4 · dev-011 · schedule · 20:40 · running 3m 08s", single line, ellipsized), and a
>   `flex: none` button group pushed right by `margin-left: auto`: **Re-run** (accent tint),
>   **Open device**, **Export**.
> - Sub-tabs (`padding: 6px 11px`, `border-radius: 9px`, 12.5px + icon):
>   **Inputs** `ph-sign-in` · **Output** `ph-sign-out` · **Logs** `ph-list-dashes` ·
>   **Timeline** `ph-film-strip` · **Artifacts** `ph-images`.
>
> **Inputs / Output** — a JSON snapshot rendered as a node tree, not raw text: header
> ("Input snapshot" / "Output snapshot"), size + capture moment ("1.4 KB · captured at start"), and a
> **Copy JSON** action. Body on `var(--panel-2)`, `border: 1px solid var(--line-2)`,
> `border-radius: 12px`; each node indents 16px per depth with a `ph-caret-down` (object/array) or
> `ph-dot-outline` (leaf), the key in `Geist Mono` `var(--text)`, the value colored by type
> (string `var(--accent)`, number `var(--warn)`, boolean `var(--warn-2)`, null/collection `var(--faint)`),
> and the type name at the right edge in 10px `var(--faint-2)`.
>
> **Logs** — level chips (All/info/debug/warn/error with counts) then a bordered table,
> `border-radius: 12px`, alternating `var(--panel-2)` rows: time (74px, `Geist Mono` 11px), level
> (52px, 11px/600, colored), scope (92px, `var(--dim)`), message (`Geist Mono` 11.5px `var(--text-3)`).
>
> **Timeline** — the replay debugger, four stacked cards (`border: 1px solid var(--line-2)`,
> `border-radius: 12px`):
> 1. *Transport*: 30×30 accent play/pause button, a 1×/2×/4× segmented control on `var(--muted)`,
>    a centered readout ("+3.181s · prepare · app.forceStop"), a right-aligned "event 10 of 18", and a
>    6px scrub track (`border-radius: 99px`, `var(--muted-2)`) with an accent fill and a 14px knob
>    (`background: var(--panel)`, `border: 2px solid var(--accent)`). Clicking the track snaps to the
>    nearest event.
> 2. *Lanes*: "+0ms" / "+12.922s" bounds, then three 18px lanes on `var(--muted-2)` with 58px uppercase
>    labels — **Phase** (proportional blocks: reset `var(--warn-2)`, prepare `var(--faint)`,
>    run `var(--accent)`, label inset in `var(--panel)` text), **Actions** (4px ticks per event; current
>    = `var(--text)`, retry = `var(--warn)`, else accent; clickable, tooltip "name · +3.181s"),
>    **Logs** (grey `var(--border-3)` clusters).
> 3. *Frames*: "Frames · 18 events · frames captured per action" and a horizontal strip of 76px 9:19.5
>    thumbnails, each with its timestamp and action name; the current frame gets a
>    `2px solid var(--accent)` border. Clicking a frame moves the playhead.
> 4. *Frame + Event*: a 168px column showing the current frame large, beside an event panel — action name
>    (`Geist Mono` 13px), an `ok`/`retry` badge, the timestamp, then phase / attempt / duration / seq /
>    ui nodes rows, and an **Arguments** note: *"Recorded already redacted — typed text and clipboard
>    writes store only a length."*
>
> **Artifacts** — "Artifacts" + "5 files · 44.1 MB", then a
> `repeat(auto-fill, minmax(164px, 1fr))` grid of cards (`border-radius: 12px`): a 92px thumbnail area
> (stripe pattern, 22px `ph-image` / `ph-film-slate` / `ph-file-code`) over the file name and
> "screenshot · 1.2 MB". Artifacts are the *file* outputs (frames, ui dumps, replay video, metric copies)
> as distinct from the JSON **Output** snapshot.

Four values the README leaves to the prototype file, read from `Enkaku Device List.dc.html` on 2026-09-03 and used below:

| Value | Source |
|---|---|
| Tab strip gap `3px`; each tab `padding: 7px 12px`, `border-radius: 9px`, `13px`, active `600` + `accent-soft` + `accent`, idle `500` + `faint`; the count `11px`, weight `400`, `opacity: .65` | `:300-303`, `:1370-1380` |
| Left list body `padding: 0 8px 10px`; a row `padding: 9px 8px`, `border-radius: 10px`, `gap: 10px`, hover `var(--muted)`; the dot `7px`; the sub-line `11px var(--faint)`, `margin-top: 4px`, `padding-left: 14px`; the footer `padding: 8px 10px`, `border-top: 1px solid var(--line)`, note `11px var(--faint)`, buttons `border: 1px solid var(--border-2)`, `border-radius: 8px`, `background: var(--panel-2)`, enabled `var(--text-3)`, disabled `var(--faint-2)` | `:307-327`, `:1355-1394` |
| Header `padding: 10px 14px`, `gap: 10px 12px`; the name block `flex: 1 1 240px`; the title row `gap: 9px`; the badge `10.5px/600`, `padding: 4px 10px`, `border-radius: 999px`; the meta `11.5px var(--faint)`, `margin-top: 3px`; the buttons `padding: 8px 12px`, `border-radius: 10px`, `12.5px/500`, first `accent-soft`/`accent`, rest `muted`/`text-3`, hover `muted-2`, `gap: 6px` | `:334-348`, `:1398-1412` |
| Sub-tab strip `padding: 8px 12px 6px`, `gap: 3px`; the timeline body `padding: 12px 14px 16px`, `gap: 10px`; a timeline card `padding: 10px 12px 12px`; the speed control `padding: 2px`, each `padding: 4px 9px`, `border-radius: 6px`, `11.5px`, active `var(--panel)` + `600`; the phase block label `9.5px`, `letter-spacing: .5px`, uppercase; the lane label `10px`, `letter-spacing: .4px`; the action tick `width: 4px`, `top/bottom: 3px`; the log cluster `top/bottom: 6px`, `border-radius: 4px`; the frame caption `10px`; the big frame `border-radius: 10px`, `border: 1px solid var(--line-2)`; the event rows `padding: 5px 0`, `border-bottom: 1px solid var(--muted-2)`; the stripe `repeating-linear-gradient(135deg, var(--muted) 0 6px, var(--muted-2) 6px 12px)` | `:350-488`, `:1414-1560` |

### 4.2 File structure after this plan

```
packages/studio/src/
  app/jobs/page.tsx                                REWRITTEN  Suspense shell over JobsScreen
  app/jobs/detail/                                 DELETED
  app/batches/                                     DELETED
  app/schedules/                                   DELETED     (§3.9; idempotent)
  app/page.tsx                                     CHANGED     one effect, §4.14
  components/jobs/JobsScreen.tsx                   NEW         the panel: tab strip + two columns
  components/jobs/JobsTabStrip.tsx                 NEW         §4.5
  components/jobs/JobsSidebar.tsx                  NEW         §4.6
  components/jobs/DetailHeader.tsx                 NEW         §4.7
  components/jobs/RunPicker.tsx                    NEW         §4.8   (the shipped artefact)
  components/jobs/SubTabs.tsx                      NEW         §4.9
  components/jobs/JobDetail.tsx                    NEW         §4.9   body switch for a job
  components/jobs/BatchDetail.tsx                  NEW         §4.12  body switch for a batch
  components/jobs/JsonSnapshot.tsx                 NEW         §4.10
  components/jobs/json-nodes.ts                    NEW         §4.10  pure
  components/jobs/json-diff.ts                     NEW         §4.11  pure
  components/jobs/LogsTab.tsx                      NEW         §4.10
  components/jobs/ArtifactsTab.tsx                 NEW         §4.10
  components/jobs/WorkflowSteps.tsx                NEW         §4.12
  components/jobs/RunCompare.tsx                   NEW         §4.11
  components/jobs/job-view.ts                      NEW         §4.4   pure: words, dots, hrefs, STRIPE
  components/jobs/timeline/Timeline.tsx            NEW         §4.10
  components/jobs/timeline/Transport.tsx           NEW         §4.10  card 1
  components/jobs/timeline/Lanes.tsx               NEW         §4.10  card 2
  components/jobs/timeline/FrameStrip.tsx          NEW         §4.10  card 3
  components/jobs/timeline/FrameAndEvent.tsx       NEW         §4.10  card 4
  components/jobs/timeline/lanes.ts                NEW         §4.10  pure: phaseBands, formatOffset
  components/jobs/timeline/useTracePlayback.ts     MOVED       from components/jobs/trace/
  components/jobs/trace/                           DELETED     after the move
  components/jobs/JobArtifactsPanel.tsx            DELETED
  components/jobs/JobFailureDetail.tsx             DELETED
  components/jobs/JobLogsPanel.tsx                 DELETED
  components/jobs/JobResultSection.tsx             DELETED
  components/JobsList.tsx                          DELETED     (step 218.12, precondition-checked)
  lib/use-job-detail.ts                            REWRITTEN   §4.3
  lib/use-job-counts.ts                            NEW         §4.3
  lib/useJobTrace.ts                               CHANGED     run-scoped paths, §4.3
  lib/jobs.ts                                      CHANGED     §4.4
  lib/api.ts                                       CHANGED     drop the `JobNodeInfo` re-export if plan 211 left it
packages/ui/src/icons.ts                           CHANGED     §4.13
scripts/check-routes.ts                            CHANGED     §4.15
docs/spec.md                                       CHANGED     §5 step 218.14
```

### 4.3 The data layer

#### 4.3.1 `packages/studio/src/lib/use-job-detail.ts` (rewritten, signature complete)

```ts
import type { ArtifactInfo, JobDetail, JobRunDetail, JobRunInfo, WorkflowStepInfo } from '@enkaku/protocol'
import type { DeviceRef } from './api'

export interface LogLine {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  source: 'script' | 'stdout' | 'stderr' | 'runner'
  msg: string
}

export type LogsPhase = 'loading' | 'live' | 'saved'

export interface JobDetailState {
  /** `GET /api/jobs/:id`. Null while loading and when the read failed. */
  job: JobDetail | null
  /** `job.runs`, newest first, exactly as the route returns them (plan 211 §4.2.1). */
  runs: JobRunInfo[]
  /** The run named by `runId`, or the latest when `runId` is null. `GET /api/jobs/:id/runs/:runId`. */
  run: JobRunDetail | null
  /** Resolved for the meta line and the Open device button. `deleted` marks a forgotten device (plan 47 §3.4). */
  deviceRef: DeviceRef | undefined
  /** `GET /api/jobs/:id/runs/:runId/artifacts`, minus the runner's own `job.log` (`isRunnerLog`). */
  artifacts: ArtifactInfo[]
  /** The three-source merge, unchanged in algorithm from the file this replaces. */
  logs: LogLine[]
  logsTruncated: boolean
  logsPhase: LogsPhase
  /** `GET /api/workflow-jobs/:id/runs/:runId/steps`; always empty for `kind === 'script'`. */
  steps: WorkflowStepInfo[]
  stepsFinalized: boolean
  error: string | null
  reload: () => void
}

/** `runId` null means "the job's latest run" (`job.runId`). */
export function useJobDetail(jobId: string | null, runId: string | null): JobDetailState
```

Rules the executor implements against, each carried over from the file being replaced unless marked new:

1. **Fetch, then subscribe.** `/ws` has no snapshot replay (`CLAUDE.md`), so every source is read once and then kept live by `ws.on`. Unchanged.
2. **The log merge is three sources, merged, never chosen between**: `savedLogs` (the `job.log` artifact's content, fetched from `${coreBase()}/api/artifacts/${logArtifact.id}/content` and parsed line by line), `backfillLogs` (`GET /api/jobs/:id/runs/:runId/logs`), and `liveLogs` (the `job.log` push filtered on `m.payload.runId === effectiveRunId`, the field plan 211 §4.2.1 adds). De-duplicated on `` `${ts}|${level}|${msg}` `` and sorted by `ts`. Unchanged in algorithm; the path and the push filter are new.
3. **The run is a separate read.** `GET /api/jobs/:id` returns `JobDetail` with `runs`; `result`, `resultBytes`, `resultIssues` and `resultSchema` live on `JobRunDetail` and come from `GET /api/jobs/:id/runs/:runId`. When `runId` is null the effective run is `job.runId`; when `job.runId` is null too (every run swept, MVP 14 §5) `run` stays null and the body renders the empty state of §4.9.
4. **Artifacts are a plain list, not a page** (`RunArtifactsResponseSchema` is `{ items }`, plan 211 §4.2.2). The `job.artifact` push replaces a row by id when `m.payload.runId` matches.
5. **`job.status` merges into `job` in place**, and a terminal status triggers one `reload()` so the run list and the artifacts settle. Unchanged.
6. **Steps** are read only when `job.kind === 'workflow'`, and re-read on every `job.status` for this job id, because a step transition is what a reader of that tab is watching. `finalized` comes from the response.
7. **The script source, the workflow document, `scriptRuntime` and the farm settings are not fetched.** The Script tab, the gate verdict sentence and the "peak memory / N limit" row are all gone with the old page (§10.2). Nothing on the new screen reads them.

#### 4.3.2 `packages/studio/src/lib/useJobTrace.ts` (changed)

Three edits, nothing else:

| Was | Becomes |
|---|---|
| `export function useJobTrace(jobId: string \| null): JobTraceState` | `export function useJobTrace(jobId: string \| null, runId: string \| null): JobTraceState` |
| `fetchPagesDetailed(\`/api/jobs/${jobId}/trace\`, undefined, JobTraceEventSchema)` | `fetchPagesDetailed(\`/api/jobs/${jobId}/runs/${runId}/trace\`, undefined, JobTraceEventSchema)`; the effect returns early when either id is null |
| `if (m.type === 'job.trace' && m.payload.jobId === jobId)` | `if (m.type === 'job.trace' && m.payload.runId === runId)` (plan 211 §4.2.1 adds `runId` to that payload) |

Every pure helper in the file keeps its name, its signature and its body.

#### 4.3.3 `packages/studio/src/lib/use-job-counts.ts` (new, complete)

```ts
'use client'

import { useEffect, useRef, useState } from 'react'
import { BatchesPageResponseSchema, JobsPageResponseSchema, type JobStatus } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { ws } from './ws'

/** The five chips the handoff draws, in its order. `all` is a filter, not a status. */
export type JobFilter = 'all' | 'running' | 'queued' | 'success' | 'failed'
export const JOB_FILTERS: readonly JobFilter[] = ['all', 'running', 'queued', 'success', 'failed']

export interface JobCounts {
  /** The tab strip's two numbers. */
  jobs: number | null
  batches: number | null
  /** The five filter chips, keyed by filter. Null until the first read settles. */
  byFilter: Record<JobFilter, number | null>
}

/**
 * Six `limit=1` reads, seeded at mount and recomputed on a COALESCED push
 * (plan 218 §3.5). `GET /api/jobs` and `GET /api/batches` both answer with a
 * `total` (`packages/core/src/api/jobs.ts:320` `total: result.total,`), so a
 * count costs one row, not a page.
 *
 * The 5000 ms timer is trailing-edge and armed only by a `job.status` or
 * `batch.status` message: an idle farm makes no request at all, and a farm
 * running forty batches makes one refresh every five seconds rather than one
 * per push. This is deliberately NOT a poll, and it is the only timer on the
 * Jobs screen (plan 218 G13 exempts this file by name).
 */
export function useJobCounts(): JobCounts & { refresh: () => void }
```

Implementation: one `load()` that issues the six requests with `Promise.allSettled` and writes whatever settled (a failed read leaves its number `null`, and a `null` count renders as no number at all rather than a zero the farm does not have); a `useEffect` that calls `load()` once; a second `useEffect` registering `ws.on` whose handler sets `pending.current = true` and, if no timer is armed, arms `setTimeout(() => { pending.current = false; load() }, 5000)`, clearing it on unmount. Query for a status count: `` `/api/jobs?limit=1&status=${status}` `` with `status` in `running | queued | success | failed`; for `all`, `/api/jobs?limit=1`.

### 4.4 `packages/studio/src/components/jobs/job-view.ts` (new, complete)

```ts
import type { BatchInfo, JobInfo, JobRunInfo, JobStatus } from '@enkaku/protocol'
import { duration, relativeTime } from '@enkaku/ui'

/**
 * The words, the colours and the addresses of the Jobs screen, in one pure
 * module so the sidebar, the header, the run picker and the compare view all
 * say the same thing (plan 218 §3.3, §4.1).
 */

/** The state dot and the state badge, from the prototype's own `jobColor`/`jobSoft`
 *  (`Enkaku Device List.dc.html:2040-2041`): running accent, queued faint, failed
 *  danger, everything settled ok. `cancelled` and `expired` are this plan's
 *  extension: the handoff draws four states and the wire has six. */
export const STATE_DOT: Record<JobStatus, string> = {
  running: 'bg-accent',
  queued: 'bg-faint',
  success: 'bg-ok',
  failed: 'bg-danger',
  cancelled: 'bg-warn',
  expired: 'bg-warn-2',
}

export const STATE_BADGE: Record<JobStatus, string> = {
  running: 'bg-accent-soft text-accent',
  queued: 'bg-muted-2 text-dim',
  success: 'bg-accent-soft text-accent',
  failed: 'bg-danger-soft text-danger',
  cancelled: 'bg-warn-soft text-warn',
  expired: 'bg-warn-soft text-warn',
}

/** The handoff capitalises its state words ("Running", "Queued"); the wire does not. */
export const STATE_WORD: Record<JobStatus, string> = {
  running: 'Running',
  queued: 'Queued',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

/** A batch's status projected onto the five job states the chips filter by.
 *  `stopping` reads as Running: members are still being aborted. */
export function batchState(status: BatchInfo['status']): JobStatus {
  return status === 'stopping' ? 'running' : (status as JobStatus)
}

/**
 * The one address shape for a job (plan 218 §3.3). `/jobs/detail` no longer
 * exists; every link into a job goes through this.
 */
export function jobHref(jobId: string, opts?: { view?: string; run?: string }): string {
  const q = new URLSearchParams({ job: jobId })
  if (opts?.view) q.set('view', opts.view)
  if (opts?.run) q.set('run', opts.run)
  return `/jobs?${q.toString()}`
}

export function batchHref(batchId: string): string {
  return `/jobs?tab=batches&job=${encodeURIComponent(batchId)}`
}

/** `20:40` — the wall clock the handoff's meta line shows, from unix seconds. */
export function clockTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The four sub-line wordings the handoff names, in its own order
 * (`README.md:337-338`): "step 4 of 12 · 34%", "position 1 · est 4m",
 * "19:58 · 12m 41s", "element not found · 17:32". `queuePosition` is not on
 * the wire, so a queued run reads "queued 4m ago" instead of "position 1";
 * inventing a position would be inventing a number (plan 218 §9 Q3).
 */
export function jobSubLine(job: JobInfo, now: number): string {
  if (job.status === 'running' && job.kind === 'workflow' && job.stepSeq !== null) {
    return `step ${job.stepSeq + 1} · ${relativeTime(job.startedAt ?? job.createdAt, now)}`
  }
  if (job.status === 'running') return `running ${duration(job.startedAt, null, now)}`
  if (job.status === 'queued') return `queued ${relativeTime(job.createdAt, now)}`
  if (job.status === 'failed' && job.error) {
    return `${job.error.split('\n')[0]?.slice(0, 60) ?? 'failed'} · ${clockTime(job.finishedAt ?? job.createdAt)}`
  }
  return `${clockTime(job.finishedAt ?? job.createdAt)} · ${duration(job.startedAt, job.finishedAt, now)}`
}

/** The stripe the handoff paints behind every placeholder screen
 *  (`Enkaku Device List.dc.html:1524`). An inline style, not a Tailwind
 *  arbitrary value: it names two tokens, so it follows the theme, and it can
 *  never be mistaken for the v3 `bg-[--color-x]` bracket form that compiles to
 *  nothing under Tailwind v4 (`CLAUDE.md`). */
export const STRIPE = {
  background: 'repeating-linear-gradient(135deg, var(--muted) 0 6px, var(--muted-2) 6px 12px)',
} as const
```

`packages/studio/src/lib/jobs.ts` keeps `isRunnerLog`, `producedArtifacts` and `formatResult`; `JobWithPhase` and `outcomeLine` are deleted (§10.2) because `phase` is gone with the old summary tab and the failure line of §4.9 replaces the sentence.

### 4.5 `components/jobs/JobsTabStrip.tsx` (new, complete)

```tsx
'use client'

import Link from 'next/link'
import { cn } from '@enkaku/ui'

/**
 * The tab strip IS the page header (design handoff, "Screen: Jobs": "The tab
 * strip **is** the page header (no separate 'Jobs / N total' title above
 * it): `padding: 10px 14px`, `border-bottom: 1px solid var(--line)`, tabs
 * **Jobs** (63) and **Batches** (21) with counts"). There is deliberately no
 * <h1> here and none in the page panel above it.
 *
 * A `next/link` per tab, not a button: the tab is the address (plan 218
 * §3.3), and a plain <a> would remount React (`CLAUDE.md`).
 */
export type JobsTab = 'jobs' | 'batches'

export function JobsTabStrip({ tab, jobCount, batchCount }: { tab: JobsTab; jobCount: number | null; batchCount: number | null }) {
  const tabs: ReadonlyArray<{ key: JobsTab; label: string; count: number | null; href: string }> = [
    { key: 'jobs', label: 'Jobs', count: jobCount, href: '/jobs' },
    { key: 'batches', label: 'Batches', count: batchCount, href: '/jobs?tab=batches' },
  ]
  return (
    <div className="flex flex-none items-center gap-[3px] border-b border-line px-[14px] py-[10px]">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === tab ? 'page' : undefined}
          className={cn(
            'flex flex-none items-center gap-[7px] rounded-input px-3 py-[7px] text-row transition-colors',
            t.key === tab ? 'bg-accent-soft font-semibold text-accent' : 'font-medium text-faint hover:text-text',
          )}
        >
          {t.label}
          {/* Null, not zero, while the count has not settled or its read failed:
              a farm with no jobs and a farm whose count could not be read must
              not look the same (plan 218 §4.3.3). */}
          {t.count !== null && <span className="text-label font-normal opacity-65">{t.count}</span>}
        </Link>
      ))}
    </div>
  )
}
```

### 4.6 `components/jobs/JobsSidebar.tsx` (new, complete)

```tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { BatchesPageResponseSchema, JobsPageResponseSchema, type BatchInfo, type JobInfo } from '@enkaku/protocol'
import { CaretLeftIcon, CaretRightIcon, api, cn } from '@enkaku/ui'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'
import { JOB_FILTERS, type JobCounts, type JobFilter } from '@/lib/use-job-counts'
import { STATE_DOT, batchHref, batchState, jobHref, jobSubLine } from './job-view'
import type { JobsTab } from './JobsTabStrip'

/**
 * The 268px left column (design handoff, "Screen: Jobs", "Left list"):
 * `width: 268px`, `border-right: 1px solid var(--line)`; wrapping filter
 * chips at `padding: 5px 10px`, `border-radius: 8px`, active
 * `var(--accent-soft)`; rows of a state dot plus a `Geist Mono` 12px name
 * with the sub-line indented 14px beneath; a footer of "1-12 of 63" and
 * 26x26 prev/next, twelve rows per page, resetting to page 1 when the tab or
 * the filter changes.
 *
 * `flex-wrap` on the chip row is not decoration: the handoff says
 * "**wrapping** (never a clipped scroll row)", because five chips with counts
 * do not fit 268px minus padding and a horizontal scroller hides the last
 * two behind a gesture nobody discovers.
 *
 * The window never reflows under the reader (plan 218 §3.4): a `job.status`
 * or `batch.status` push MERGES into a loaded row and never prepends, and a
 * refetch happens only while `page === 0`, which is where a new row belongs
 * and where a reader watching for one is looking.
 */
const PER_PAGE = 12

type Row = { id: string; name: string; state: ReturnType<typeof batchState>; sub: string; href: string }

export function JobsSidebar({
  tab,
  selectedId,
  counts,
}: {
  tab: JobsTab
  selectedId: string | null
  counts: JobCounts
}) {
  const [filter, setFilter] = useState<JobFilter>('all')
  const [page, setPage] = useState(0)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [batches, setBatches] = useState<BatchInfo[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [hasNext, setHasNext] = useState(false)
  const cursors = useRef<Array<string | null>>([null])
  const now = useNow()

  // The handoff: "changing tab or filter resets to page 1".
  useEffect(() => {
    cursors.current = [null]
    setPage(0)
  }, [tab, filter])

  useEffect(() => {
    let disposed = false
    const cursor = cursors.current[page] ?? null
    const q = new URLSearchParams({ limit: String(PER_PAGE) })
    if (filter !== 'all') q.set('status', filter)
    if (cursor) q.set('cursor', cursor)
    void (async () => {
      try {
        if (tab === 'jobs') {
          const p = await api(`/api/jobs?${q.toString()}`, JobsPageResponseSchema)
          if (disposed) return
          cursors.current[page + 1] = p.nextCursor
          setJobs(p.items)
          setTotal(p.total)
          setHasNext(p.nextCursor !== null)
        } else {
          const p = await api(`/api/batches?${q.toString()}`, BatchesPageResponseSchema)
          if (disposed) return
          cursors.current[page + 1] = p.nextCursor
          setBatches(p.items)
          setTotal(p.total)
          setHasNext(p.nextCursor !== null)
        }
      } catch {
        if (!disposed) {
          setJobs([])
          setBatches([])
          setTotal(null)
          setHasNext(false)
        }
      }
    })()
    return () => {
      disposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filter, page, counts.jobs, counts.batches])

  // Merge in place only. `counts` above is the page-0 refetch trigger: the
  // coalescer that moves the tab and chip numbers is the same signal that a
  // row entered or left the list, so the window follows it without a second
  // timer of its own.
  useEffect(() => {
    const off = ws.on((m) => {
      if (m.type === 'job.status') {
        setJobs((p) => (p.some((j) => j.jobId === m.payload.jobId) ? p.map((j) => (j.jobId === m.payload.jobId ? { ...j, ...m.payload } : j)) : p))
      } else if (m.type === 'batch.status') {
        setBatches((p) =>
          p.map((b) => (b.id === m.payload.batchId ? { ...b, status: m.payload.status, counts: m.payload.counts } : b)),
        )
      }
    })
    return off
  }, [])

  const rows: Row[] = useMemo(() => {
    if (tab === 'jobs') {
      return jobs.map((j) => ({
        id: j.jobId,
        // `scriptName` for a script job, `scriptName` denormalised from the
        // workflow name for a workflow job (plan 211 §4.1.2), the id as the
        // last resort for a job whose script row is gone.
        name: j.scriptName ?? j.jobId.slice(0, 12),
        state: j.status,
        sub: jobSubLine(j, now),
        href: jobHref(j.jobId),
      }))
    }
    return batches.map((b) => {
      const done = b.counts.success + b.counts.failed + b.counts.cancelled
      return {
        id: b.id,
        name: b.scriptName ?? b.id.slice(0, 12),
        state: batchState(b.status),
        sub: `${b.counts.total} device${b.counts.total === 1 ? '' : 's'} · ${done}/${b.counts.total}${b.counts.failed > 0 ? ` · ${b.counts.failed} failed` : ''}`,
        href: batchHref(b.id),
      }
    })
  }, [tab, jobs, batches, now])

  const first = page * PER_PAGE + 1
  const last = page * PER_PAGE + rows.length
  const pageNote = rows.length === 0 ? 'none' : `${first}–${last} of ${total ?? last}`

  return (
    <div className="flex min-h-0 w-[268px] flex-none flex-col border-r border-line">
      <div className="flex flex-none flex-wrap gap-1 p-[10px]">
        {JOB_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'flex-none rounded-small px-[10px] py-[5px] text-meta transition-colors',
              f === filter ? 'bg-accent-soft font-semibold text-accent' : 'bg-muted font-medium text-dim hover:text-text',
            )}
          >
            {f === 'all' ? 'All' : f[0]?.toUpperCase() + f.slice(1)}
            {counts.byFilter[f] !== null && <span className="ml-[6px] opacity-65">{counts.byFilter[f]}</span>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-[10px]">
        {rows.map((r) => (
          <Link
            key={r.id}
            href={r.href}
            className={cn(
              'flex items-center gap-[10px] rounded-button px-2 py-[9px] transition-colors',
              r.id === selectedId ? 'bg-accent-soft' : 'hover:bg-muted',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-[7px]">
                <span className={cn('size-[7px] flex-none rounded-pill', STATE_DOT[r.state])} aria-hidden />
                <span className="truncate font-mono text-[12px]">{r.name}</span>
              </div>
              <div className="mt-1 truncate pl-[14px] text-label text-faint">{r.sub}</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="flex flex-none items-center gap-[6px] border-t border-line px-[10px] py-2">
        <span className="min-w-0 flex-1 truncate text-label text-faint">{pageNote}</span>
        <button
          type="button"
          aria-label="Previous page"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="grid size-[26px] flex-none place-items-center rounded-small border border-border-2 bg-panel-2 text-text-3 disabled:cursor-default disabled:text-faint-2"
        >
          <CaretLeftIcon className="size-[13px]" />
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={!hasNext}
          onClick={() => setPage((p) => p + 1)}
          className="grid size-[26px] flex-none place-items-center rounded-small border border-border-2 bg-panel-2 text-text-3 disabled:cursor-default disabled:text-faint-2"
        >
          <CaretRightIcon className="size-[13px]" />
        </button>
      </div>
    </div>
  )
}
```

### 4.7 `components/jobs/DetailHeader.tsx` (new, complete)

```tsx
'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@enkaku/ui'
import { STATE_BADGE, STATE_WORD } from './job-view'
import type { JobStatus } from '@enkaku/protocol'

/**
 * The right detail's header (design handoff, "Screen: Jobs", "Right
 * detail"): "`min-height: 58px`, wraps: the script name (`Geist Mono`
 * 15px/500) with the **state badge beside it on the same line** (never a
 * badge to the left of a multi-line block), the meta line beneath
 * ("job_8f21c4 · dev-011 · schedule · 20:40 · running 3m 08s", single line,
 * ellipsized), and a `flex: none` button group pushed right by
 * `margin-left: auto`: **Re-run** (accent tint), **Open device**, **Export**."
 *
 * `min-h-[58px]` and not `h-[58px]`: the handoff says the header wraps, and
 * with three buttons and a long script name it does at 1280px.
 *
 * `meta` is a node, not a string, because its first segment is the run picker
 * (`RunPicker`, plan 218 §4.8) and its second may be a link to a parent
 * workflow job. It is still ONE line: the caller composes segments joined by
 * " · " inside a `truncate` row, so the ellipsis lands where the handoff
 * draws it.
 */
export interface HeaderAction {
  key: string
  label: string
  icon: ReactNode
  /** The first action is the accent-tinted one (Re-run). */
  primary?: boolean
  disabled?: boolean
  /** A stated reason, rendered as `title`, never a control that silently does nothing. */
  disabledReason?: string
  onClick?: () => void
  href?: string
}

export function DetailHeader({
  name,
  state,
  meta,
  actions,
}: {
  name: string
  state: JobStatus
  meta: ReactNode
  actions: readonly HeaderAction[]
}) {
  return (
    <div className="flex min-h-[58px] flex-none flex-wrap items-center gap-x-3 gap-y-[10px] border-b border-line px-[14px] py-[10px]">
      <div className="min-w-0 flex-[1_1_240px]">
        <div className="flex min-w-0 items-center gap-[9px]">
          <span className="truncate font-mono text-title font-medium">{name}</span>
          <span className={cn('flex-none rounded-pill px-[10px] py-1 text-badge font-semibold', STATE_BADGE[state])}>
            {STATE_WORD[state]}
          </span>
        </div>
        <div className="mt-[3px] flex min-w-0 items-center gap-[5px] truncate text-meta text-faint">{meta}</div>
      </div>
      <div className="ml-auto flex flex-none items-center gap-[6px]">
        {actions.map((a) => {
          const cls = cn(
            'flex flex-none items-center gap-[7px] rounded-button px-3 py-2 text-body font-medium transition-colors',
            a.primary ? 'bg-accent-soft text-accent' : 'bg-muted text-text-3',
            a.disabled ? 'cursor-default opacity-50' : 'hover:bg-muted-2',
          )
          if (a.href && !a.disabled) {
            return (
              <Link key={a.key} href={a.href} className={cls}>
                {a.icon}
                {a.label}
              </Link>
            )
          }
          return (
            <button key={a.key} type="button" className={cls} disabled={a.disabled} title={a.disabledReason} onClick={a.onClick}>
              {a.icon}
              {a.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

### 4.8 `components/jobs/RunPicker.tsx` (new, complete) — the shipped artefact

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { JobRunInfo } from '@enkaku/protocol'
import { ArrowsLeftRightIcon, CaretDownIcon, cn, duration, relativeTime } from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'
import { useNow } from '@/lib/useNow'
import { STATE_DOT, STATE_WORD, clockTime, jobHref } from './job-view'

/**
 * The run picker (MVP 15 §2, "The run picker on the Jobs detail (MVP 14)" —
 * one of the four things the design handoff leaves undesigned, and MVP 15 §1
 * row "Runs of one job" is its whole brief: "The detail header's meta line
 * gains a run picker ('run 3 of 3 ·') and Re-run adds a run. To be drawn into
 * the prototype.").
 *
 * So it is drawn as the FIRST SEGMENT of the meta line and nowhere else: a
 * job's runs are not a tab, not a sidebar and not a second list. The meta
 * line already reads "job_8f21c4 · dev-011 · schedule · 20:40 · running 3m
 * 08s"; this puts "run 3 of 3" in front of it, in the same 11.5px
 * `var(--faint)` as its neighbours, underlined on hover so it reads as the
 * one clickable segment.
 *
 * The popover lists every run NEWEST FIRST with the four facts MVP 14 §2
 * names: "status, duration, trigger, and who or what started it". Selecting
 * one sets `?run=`; the compare control beside it sets `?compare=` and is
 * what `RunCompare` (plan 218 §4.11) renders from.
 *
 * `data-menu-root` and `useOverlay('menu', ...)` are plan 213's shell
 * contract (§4.9): the outside-click listener and the Escape tier are
 * installed once by `AppShell`, and a screen registers rather than adding its
 * own `document` listener.
 */
export function RunPicker({
  jobId,
  runs,
  currentRunId,
  compareRunId,
}: {
  jobId: string
  runs: readonly JobRunInfo[]
  currentRunId: string | null
  compareRunId: string | null
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const now = useNow()
  useOverlay('menu', open, () => setOpen(false))

  const index = runs.findIndex((r) => r.runId === currentRunId)
  const shown = index >= 0 ? runs[index] : runs[0]
  // Runs arrive newest first (plan 211 §4.2.1), so `seq` is the human number
  // and `runs.length` is the total. A job whose older runs were swept
  // (MVP 14 §5) shows "run 4 of 1", which is the honest reading: this is run
  // four, and one run is still kept.
  const label = shown ? `run ${shown.seq} of ${runs.length}` : 'no runs'

  if (runs.length === 0) return <span className="flex-none">{label}</span>

  return (
    <span className="relative flex-none" data-menu-root="1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-[3px] text-meta text-faint hover:text-text hover:underline"
      >
        {label}
        <CaretDownIcon className="size-[11px]" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-[320px] overflow-hidden rounded-card border border-border-2 bg-panel p-1 shadow-popover"
        >
          {runs.map((r) => (
            <div key={r.runId} className="flex items-center gap-2 rounded-button px-[10px] py-[9px] hover:bg-muted">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  router.push(jobHref(jobId, { run: r.runId }))
                }}
                className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
              >
                <span className={cn('size-[7px] flex-none rounded-pill', STATE_DOT[r.status])} aria-hidden />
                <span className="flex-none font-mono text-meta text-text">run {r.seq}</span>
                <span className="min-w-0 flex-1 truncate text-label text-faint">
                  {STATE_WORD[r.status]} · {duration(r.startedAt, r.finishedAt, now)} · {r.trigger} · {clockTime(r.createdAt)}
                </span>
              </button>
              {/* MVP 14 §2: "Selecting two runs shows their results side by
                  side". The second run is a toggle on the row, not a second
                  list: comparing is a property of a pair, and a pair is one
                  chosen run plus the one already on screen. */}
              <button
                type="button"
                aria-label={compareRunId === r.runId ? `Stop comparing run ${r.seq}` : `Compare with run ${r.seq}`}
                disabled={r.runId === (currentRunId ?? runs[0]?.runId)}
                onClick={() => {
                  setOpen(false)
                  const q = new URLSearchParams({ job: jobId })
                  if (currentRunId) q.set('run', currentRunId)
                  if (compareRunId !== r.runId) q.set('compare', r.runId)
                  router.push(`/jobs?${q.toString()}`)
                }}
                className={cn(
                  'grid size-[26px] flex-none place-items-center rounded-small transition-colors disabled:opacity-30',
                  compareRunId === r.runId ? 'bg-accent-soft text-accent' : 'text-faint hover:bg-muted-2 hover:text-text',
                )}
              >
                <ArrowsLeftRightIcon className="size-[13px]" />
              </button>
            </div>
          ))}
          <p className="px-[10px] py-2 text-tip text-faint">
            {/* MVP 14 §2 and §6 item 2, stated where the decision bites. */}
            Re-run adds a run to this job. Changing parameters creates a new job, because the intent changed.
          </p>
        </div>
      )}
    </span>
  )
}
```

Started-by: `JobRunInfo` carries no `createdBy` (plan 211 §4.2.1). MVP 14 §2 asks for "who or what started it", and `trigger` (`manual`, `rerun`, `schedule`, `batch`, `resume`, `workflow-step`) answers the "what" half. The "who" half is `jobs.createdBy`, which is the same for every run of a job and therefore belongs on the job, not in this list; it renders once, in the meta line's own trigger segment, as `` `${run.trigger}${job.createdBy ? ` · ${job.createdBy}` : ''}` ``. §9 Q4 records that a per-run actor would need a protocol field plan 211 did not add.

### 4.9 `components/jobs/SubTabs.tsx` and `JobDetail.tsx`

`SubTabs.tsx` (new, complete):

```tsx
'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@enkaku/ui'

/**
 * The five sub-tabs (design handoff, "Screen: Jobs"): "Sub-tabs
 * (`padding: 6px 11px`, `border-radius: 9px`, 12.5px + icon): **Inputs**
 * `ph-sign-in` · **Output** `ph-sign-out` · **Logs** `ph-list-dashes` ·
 * **Timeline** `ph-film-strip` · **Artifacts** `ph-images`."
 *
 * Links, not buttons: the sub-tab is `?view=` (plan 218 §3.3).
 */
export interface SubTab {
  key: string
  label: string
  icon: ReactNode
  href: string
}

export function SubTabs({ tabs, active }: { tabs: readonly SubTab[]; active: string }) {
  return (
    <div className="flex flex-none items-center gap-[3px] border-b border-line px-3 pt-2 pb-[6px]">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? 'page' : undefined}
          className={cn(
            'flex flex-none items-center gap-[7px] rounded-input px-[11px] py-[6px] text-body transition-colors',
            t.key === active ? 'bg-accent-soft font-semibold text-accent' : 'font-medium text-faint hover:text-text',
          )}
        >
          {t.icon}
          {t.label}
        </Link>
      ))}
    </div>
  )
}
```

The five entries, built in `JobDetail.tsx`, with the icon barrel from plan 204 §4.5 and `className="size-[14px]"` on each:

| key | label | icon | body |
|---|---|---|---|
| `inputs` | Inputs | `SignInIcon` | `<JsonSnapshot title="Input snapshot" moment="captured at start" value={job.params} />` |
| `output` | Output | `SignOutIcon` | `<JsonSnapshot title="Output snapshot" moment="captured at exit" value={run.result} bytes={run.resultBytes} status={run.resultStatus} issues={run.resultIssues} />` |
| `logs` | Logs | `ListDashesIcon` | `<LogsTab logs={logs} truncated={logsTruncated} phase={logsPhase} />` |
| `timeline` | Timeline | `FilmStripIcon` | `job.kind === 'workflow' ? <WorkflowSteps ... /> : <Timeline jobId={job.jobId} runId={run.runId} runStatus={run.status} />` |
| `artifacts` | Artifacts | `ImagesIcon` | `<ArtifactsTab artifacts={artifacts} />` |

`JobDetail.tsx` composes, in this order inside a `flex min-h-0 flex-1 flex-col`:

1. `<DetailHeader …>` with:
   - `name` = `job.scriptName ?? job.jobId`
   - `state` = `run?.status ?? 'queued'`
   - `meta` = the segments below, each `flex-none`, joined by a `·` separator span, inside the header's own `truncate` row:
     1. `<RunPicker jobId={job.jobId} runs={runs} currentRunId={run?.runId ?? null} compareRunId={compare} />`
     2. when `job.parentWorkflowJobId !== null`: `<Link href={jobHref(job.parentWorkflowJobId)} className="hover:underline">step {job.stepSeq! + 1} of workflow job {job.parentWorkflowJobId.slice(0, 8)}</Link>` (MVP 05 §1.5: "A script job detail shows 'Step 3 of workflow job #91' when it has a parent")
     3. `job.jobId.slice(0, 12)` in `font-mono`
     4. `deviceRefLabel(deviceRef, job.deviceId)`
     5. `` `${run.trigger}${job.createdBy ? ` · ${job.createdBy}` : ''}` ``
     6. `clockTime(run.createdAt)`
     7. `run.status === 'running' ? \`running ${duration(run.startedAt, null, now)}\` : duration(run.startedAt, run.finishedAt, now)`
   - `actions` = the three of §4.9.1
2. `<SubTabs …>`
3. The failure line of §4.9.2, when `run.status === 'failed'`
4. `<div className="min-h-0 flex-1 overflow-auto">` holding the body for `view`, or `<RunCompare …>` when `?compare=` is set

Empty and error states, each replacing item 4 only:
- no `?job=`: `<EmptyState title="Select a job" description="Pick a job from the list to read its inputs, output, logs, timeline and artifacts." />`
- the job read failed: `<ErrorState message={error} onRetry={reload} />`
- the job loaded with `runCount === 0`: `<EmptyState title="This job has no runs" description="Every run of this job has been swept by the retention window. The job itself is kept because a schedule owns it or because it is a step of a workflow job." />`

#### 4.9.1 The three header actions

| Action | Icon | Behaviour |
|---|---|---|
| **Re-run** (`primary`) | `PlayIcon` | `job.kind === 'script'` posts `runAction('run-script', { deviceIds: [job.deviceId] }, { scriptId: job.scriptId!, params: job.params, jobId: job.jobId })`; `kind === 'workflow'` posts `runAction('run-workflow', { deviceIds: [job.deviceId] }, { workflowName: job.workflowName!, params: job.params, jobId: job.jobId })` (plan 211 §4.8, the `jobId?` addition to plan 207's body). On success, `toast.success('Run added')` with the description `` `${job.scriptName ?? 'This job'} is queued as run ${runs.length + 1}. The job list does not gain a row.` ``, then `reload()`. On `ActionRefusedError`, `toast.error(err.message)`. Disabled with the reason `Cancel the running run first` while `run.status === 'running' \|\| run.status === 'queued'` |
| **Open device** | `DeviceMobileIcon` | `href={\`/?device=${encodeURIComponent(job.deviceId)}\`}` (§4.14). Disabled with the reason `This device was forgotten` when `deviceRef?.deleted` |
| **Export** | `ExportIcon` | Builds one JSON document `{ job, run, runs, logs, artifacts }` client-side, `JSON.stringify(doc, null, 2)`, wraps it in a `Blob`, and clicks a temporary `<a download={\`${job.scriptName ?? 'job'}-${job.jobId.slice(0, 8)}-run${run.seq}.json\`}>` built with `URL.createObjectURL`, revoking the URL in the same tick. No server route: everything in the document is already on the client |

#### 4.9.2 The failure line (this plan's addition, §3.11)

```tsx
{run.status === 'failed' && (
  <div className="flex flex-none flex-wrap items-baseline gap-x-2 border-b border-line bg-danger-soft px-[14px] py-2 text-meta text-danger">
    <span className="font-semibold">
      {run.errorPhase ? `Failed during ${run.errorPhase}` : 'Failed'}
      {run.failureClass ? ` · ${run.failureClass}` : ''}
    </span>
    <span className="min-w-0 flex-1 truncate font-mono">{run.error ?? 'no message was recorded'}</span>
  </div>
)}
```

### 4.10 The five bodies

#### `components/jobs/json-nodes.ts` (new, pure)

```ts
export type JsonNodeType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

export interface JsonNodeRow {
  /** Dot/bracket path, unique per row; the collapse key and the diff key. */
  path: string
  depth: number
  key: string
  /** Already display-formatted: `"warm_a"`, `143`, `true`, `null`, `12 items`, `''` for an object. */
  value: string
  type: JsonNodeType
  /** Object and array rows carry a caret; leaves carry a dot. */
  collapsible: boolean
}

/** The handoff's own value wording (`Enkaku Device List.dc.html:1304-1318`): a
 *  string is JSON-quoted, an array reads "N items", an object's value column is
 *  empty, and everything else is its JSON literal. */
export function formatNodeValue(value: unknown): { value: string; type: JsonNodeType }

/**
 * Depth-first rows for a JSON value, honouring `collapsed` (a set of paths
 * whose descendants are omitted). Capped at `MAX_JSON_NODES`; when the cap is
 * hit the last row is a synthetic `{ type: 'null', key: '…', value: '<n> more
 * not shown' }` at depth 0, because a 40 000-row tree is not a reading
 * surface and silently stopping would be the omission this screen is not
 * allowed to make. Copy JSON always copies the whole value.
 */
export const MAX_JSON_NODES = 2000
export function jsonNodes(value: unknown, collapsed: ReadonlySet<string>): JsonNodeRow[]
```

#### `components/jobs/JsonSnapshot.tsx` (new)

Props `{ title: string; moment: string; value: unknown; bytes?: number | null; status?: ResultStatus | null; issues?: ParamIssue[] | null }`. Structure and classes, each number from §4.1:

- root `p-[14px]`
- head `flex items-center justify-between gap-[10px] pb-[10px]`; title `text-[12px] font-semibold`; right `flex items-center gap-3 text-meta`; size `text-faint` reading `` `${fileSize(bytes ?? byteLength(value))} · ${moment}` ``; the action `<button className="font-medium text-accent">Copy JSON</button>` writing `JSON.stringify(value, null, 2)` through `navigator.clipboard.writeText`, then `toast.success('Copied')`
- the three result banners, above the body, only on the Output snapshot and only when `status` is `invalid`, `partial` or `oversize` (`docs/spec.md` §19, plan 97 §4.8): one `rounded-inner px-3 py-2 text-meta` line, `bg-danger-soft text-danger` for `invalid` (listing `issues.map((i) => i.path).join(', ')`), `bg-warn-soft text-warn` for `partial` (`This run failed. These are the values it had reached.`) and for `oversize` (`` `The result was ${fileSize(bytes)}, over the limit. Save large output with ctx.artifact.file instead.` ``)
- body `rounded-inner border border-line-2 bg-panel-2 px-1 pt-[10px] pb-3`
- each row `flex items-center gap-[9px] py-1 pr-3` with `style={{ paddingLeft: 12 + row.depth * 16 }}`
- icon: `collapsible ? <CaretDownIcon /> or <CaretRightIcon /> : <DotOutlineIcon />`, all `className="w-[13px] flex-none text-[11px] text-faint-2"`; a collapsible row is a `<button>` that toggles its path in the `collapsed` set
- key `flex-none font-mono text-meta text-text`
- value `min-w-0 flex-1 truncate font-mono text-meta` plus the type colour: `string` `text-accent`, `number` `text-warn`, `boolean` `text-warn-2`, `null`/`object`/`array` `text-faint`
- type `flex-none text-tip text-faint-2`
- an empty value renders `<EmptyState title={\`No ${title.toLowerCase()}\`} description="This run recorded nothing here." />` instead of an empty box

#### `components/jobs/LogsTab.tsx` (new)

- root `px-[14px] pt-3 pb-4`
- chips `flex items-center gap-[3px] pb-[10px]`, each chip the exact class string of the sidebar filter chip (§4.6), levels `All`, `info`, `debug`, `warn`, `error` with their counts
- table `overflow-hidden rounded-inner border border-line-2`
- row `flex items-center gap-3 px-3 py-[7px]` plus `border-b border-muted-2` except the last, plus `bg-panel-2` on odd indices
- time `w-[74px] flex-none font-mono text-label text-faint` = `new Date(l.ts).toLocaleTimeString()`
- level `w-[52px] flex-none text-label font-semibold` plus `error` `text-danger`, `warn` `text-warn`, `debug` `text-faint`, `info` `text-accent`
- scope `w-[92px] flex-none truncate text-label text-dim` = `l.source`
- message `min-w-0 flex-1 font-mono text-meta text-text-3 wrap-anywhere`
- when `truncated`, one line above the table, `text-meta text-warn`: `Earlier lines were dropped. The full log is kept as the job.log artifact.`
- when `phase === 'loading'`, `<LoadingRows rows={6} />`; when there are no lines, `<EmptyState title="No log lines" description="This run produced none." />`

#### `components/jobs/ArtifactsTab.tsx` (new)

- root `p-[14px]`
- head `flex items-center justify-between pb-[10px]`; `Artifacts` in `text-[12px] font-semibold`; the note `text-meta text-faint` reading `` `${n} file${n === 1 ? '' : 's'} · ${fileSize(total)}` ``
- grid `grid grid-cols-[repeat(auto-fill,minmax(164px,1fr))] gap-[10px]`
- card `<a href={\`${coreBase()}/api/artifacts/${a.id}/content\`} target="_blank" rel="noreferrer" className="overflow-hidden rounded-inner border border-line-2 transition-colors hover:bg-muted">`
- thumb `flex h-[92px] items-center justify-center border-b border-line-2` with `style={STRIPE}`; a `screenshot` renders `<img className="size-full object-cover" />` of the same URL, everything else the icon at `size-[22px] text-faint`: `video` `FilmSlateIcon`, otherwise `FileCodeIcon`, and `ImageIcon` when a screenshot's image fails to load (`onError` swaps to the icon)
- body `px-[10px] pt-2 pb-[10px]`; name `truncate text-[12px]` = the last path segment with a leading `\d+-` stripped, falling back to `label ?? kind`; sub `mt-[3px] text-label text-faint` = `` `${a.kind} · ${fileSize(a.sizeBytes)}` ``
- one line under the grid, `mt-3 text-tip text-faint`, stating the distinction the handoff itself draws: `Artifacts are the files a run produced. The JSON it returned is on the Output tab.`
- empty: `<EmptyState title="No artifacts" description="Screenshots and files a script saves with ctx.artifact appear here. The run's own log is on the Logs tab." />`

#### `components/jobs/timeline/lanes.ts` (new, pure)

`phaseBands(events, endMs): PhaseBand[]` and `formatOffset(atMs, originMs): string` moved verbatim from `components/jobs/trace/TraceTimeline.tsx:58` and `:85`, plus:

```ts
/** The handoff's Phase lane colours ("reset `var(--warn-2)`, prepare
 *  `var(--faint)`, run `var(--accent)`"). `finish` and `unknown` are this
 *  plan's extension: the handoff's sample trace has three phases and the
 *  runner has four (`reset`, `prepare`, `run`, `finish`). */
export const PHASE_FILL: Record<string, string> = {
  reset: 'bg-warn-2',
  prepare: 'bg-faint',
  run: 'bg-accent',
  finish: 'bg-ok',
  unknown: 'bg-border-3',
}
```

#### `components/jobs/timeline/Timeline.tsx` (new, complete)

```tsx
'use client'

import { useMemo } from 'react'
import type { JobStatus } from '@enkaku/protocol'
import { EmptyState, ErrorState, LoadingRows } from '@enkaku/ui'
import {
  capturePolicyAt,
  describeCapturePolicy,
  explainEmptyActionLane,
  failingEventIndex,
  frameEventAt,
  nearestEventIndex,
  previousFrameEventAt,
  useJobTrace,
} from '@/lib/useJobTrace'
import { FrameAndEvent } from './FrameAndEvent'
import { FrameStrip } from './FrameStrip'
import { Lanes } from './Lanes'
import { Transport } from './Transport'
import { useTracePlayback } from './useTracePlayback'

/**
 * The replay debugger (design handoff, "Screen: Jobs", **Timeline**): "four
 * stacked cards (`border: 1px solid var(--line-2)`, `border-radius: 12px`)"
 * — Transport, Lanes, Frames, Frame + Event.
 *
 * The playback axis is the ACTION events, not every recorded event: the
 * handoff's own readout is "event 10 of 18" beside a Frames card that says
 * "18 events · frames captured per action", and a trace of the same run holds
 * several times that many phase, log and artifact rows. The full list is
 * still what the Lanes card draws (its Logs lane is log density) and what the
 * capture policy is read from; only the thing the playhead STEPS through is
 * narrowed.
 *
 * Two sentences the handoff does not draw are kept, because dropping them
 * turns a gap into a lie (plan 218 §3.6): a truncated fetch says so above the
 * cards, and the capture policy is folded into the Frames card's own heading,
 * which is where the handoff already puts a sentence of exactly that shape.
 */
export function Timeline({ jobId, runId, runStatus }: { jobId: string; runId: string; runStatus: JobStatus }) {
  const { events, loading, error, truncated, reload } = useJobTrace(jobId, runId)
  const actions = useMemo(() => events.filter((e) => e.kind === 'action'), [events])

  const defaultIndex = useMemo(() => {
    if (actions.length === 0) return 0
    if (runStatus !== 'failed') return 0
    return failingEventIndex(actions) ?? actions.length - 1
  }, [actions, runStatus])

  const { selected, playheadMs, playing, speed, select, toggle, setSpeed } = useTracePlayback(actions, defaultIndex)
  const originMs = events[0]?.atMs ?? 0
  const endMs = events[events.length - 1]?.atMs ?? originMs
  const policy = useMemo(() => capturePolicyAt(events, nearestEventIndex(events, playheadMs)), [events, playheadMs])
  const emptyLane = useMemo(() => explainEmptyActionLane(events, policy), [events, policy])

  if (loading) return <div className="p-[14px]"><LoadingRows rows={4} /></div>
  if (error) return <div className="p-[14px]"><ErrorState message={error} onRetry={reload} /></div>
  if (events.length === 0) {
    return (
      <div className="p-[14px]">
        <EmptyState
          title="Nothing recorded for this run"
          description="A trace is written while a run executes: every device action, log line, phase boundary and artifact on one time axis. A run from before job tracing existed, or one whose trace has been swept by the retention window, has none."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-[10px] px-[14px] pt-3 pb-4">
      {truncated && (
        <p className="rounded-inner border border-line-2 bg-warn-soft px-3 py-2 text-meta text-warn">
          This timeline is incomplete. Only the first {events.length.toLocaleString()} events were loaded; the run recorded more
          than one page can fetch. What you see below ends early, and it is not where the run stopped.
        </p>
      )}
      <Transport
        actions={actions}
        selected={selected}
        onSelect={select}
        playheadMs={playheadMs}
        originMs={originMs}
        endMs={endMs}
        playing={playing}
        speed={speed}
        onToggle={toggle}
        onSpeedChange={setSpeed}
      />
      <Lanes
        events={events}
        actions={actions}
        selected={selected}
        onSelect={select}
        originMs={originMs}
        endMs={endMs}
        emptyLane={emptyLane}
      />
      <FrameStrip
        jobId={jobId}
        runId={runId}
        actions={actions}
        selected={selected}
        onSelect={select}
        originMs={originMs}
        note={describeCapturePolicy(policy)}
      />
      <FrameAndEvent
        jobId={jobId}
        runId={runId}
        originMs={originMs}
        event={actions[selected] ?? null}
        frameEvent={frameEventAt(actions, selected)}
        previousFrameEvent={previousFrameEventAt(actions, selected)}
      />
    </div>
  )
}
```

#### `components/jobs/timeline/Transport.tsx` (new, complete)

```tsx
'use client'

import { useRef } from 'react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { PauseIcon, PlayIcon, cn } from '@enkaku/ui'
import { nearestEventIndex } from '@/lib/useJobTrace'
import { formatOffset } from './lanes'
import type { PlaybackSpeed } from './useTracePlayback'

/**
 * Card 1 (design handoff): "*Transport*: 30×30 accent play/pause button, a
 * 1×/2×/4× segmented control on `var(--muted)`, a centered readout
 * ("+3.181s · prepare · app.forceStop"), a right-aligned "event 10 of 18",
 * and a 6px scrub track (`border-radius: 99px`, `var(--muted-2)`) with an
 * accent fill and a 14px knob (`background: var(--panel)`, `border: 2px solid
 * var(--accent)`). Clicking the track snaps to the nearest event."
 *
 * The fill and the knob position from `playheadMs`, never from the selected
 * event's own `atMs`: while paused the two are the same value, but during
 * playback the playhead keeps sliding across a long idle gap where the
 * nearest event does not change, and a marker that freezes reads as broken
 * (`useTracePlayback.ts`'s own doc).
 */
const SPEEDS: readonly PlaybackSpeed[] = [1, 2, 4]

export function Transport({
  actions,
  selected,
  onSelect,
  playheadMs,
  originMs,
  endMs,
  playing,
  speed,
  onToggle,
  onSpeedChange,
}: {
  actions: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
  playheadMs: number
  originMs: number
  endMs: number
  playing: boolean
  speed: PlaybackSpeed
  onToggle: () => void
  onSpeedChange: (speed: PlaybackSpeed) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const span = Math.max(1, endMs - originMs)
  const pct = Math.min(100, Math.max(0, ((playheadMs - originMs) / span) * 100))
  const current = actions[selected] ?? null

  function scrub(clientX: number): void {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const at = nearestEventIndex(actions, originMs + fraction * span)
    if (at >= 0) onSelect(at)
  }

  return (
    <div className="rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
      <div className="flex items-center gap-[10px]">
        <button
          type="button"
          onClick={onToggle}
          aria-label={playing ? 'Pause' : 'Play'}
          className="grid size-[30px] flex-none place-items-center rounded-input bg-accent text-on-accent"
        >
          {playing ? <PauseIcon className="size-[15px]" /> : <PlayIcon className="size-[15px]" />}
        </button>
        <div className="flex flex-none gap-[2px] rounded-small bg-muted p-[2px]">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSpeedChange(s)}
              className={cn(
                'rounded-[6px] px-[9px] py-1 text-meta transition-colors',
                s === speed ? 'bg-panel font-semibold text-text' : 'font-medium text-faint hover:text-text',
              )}
            >
              {s}&times;
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 truncate text-center text-meta text-dim">
          <span className="font-mono text-text">{formatOffset(playheadMs, originMs)}</span>
          {current ? ` · ${current.phase ?? 'unknown'} · ${current.name}` : ''}
        </div>
        <span className="flex-none text-meta text-faint">
          event {actions.length === 0 ? 0 : selected + 1} of {actions.length}
        </span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, actions.length)}
        aria-valuenow={selected + 1}
        onClick={(e) => scrub(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            onSelect(Math.max(0, selected - 1))
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            onSelect(Math.min(actions.length - 1, selected + 1))
          } else if (e.key === 'Home') {
            e.preventDefault()
            onSelect(0)
          } else if (e.key === 'End') {
            e.preventDefault()
            onSelect(Math.max(0, actions.length - 1))
          }
        }}
        className="relative mt-[10px] h-[6px] cursor-pointer rounded-pill bg-muted-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <div className="absolute inset-y-0 left-0 rounded-pill bg-accent" style={{ width: `${pct}%` }} />
        <div
          className="absolute -top-1 size-[14px] rounded-pill border-2 border-accent bg-panel"
          style={{ left: `calc(${pct}% - 7px)` }}
        />
      </div>
    </div>
  )
}
```

#### `components/jobs/timeline/Lanes.tsx` (new, complete)

```tsx
'use client'

import { useMemo } from 'react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { PHASE_FILL, formatOffset, phaseBands } from './lanes'

/**
 * Card 2 (design handoff): "*Lanes*: "+0ms" / "+12.922s" bounds, then three
 * 18px lanes on `var(--muted-2)` with 58px uppercase labels — **Phase**
 * (proportional blocks: reset `var(--warn-2)`, prepare `var(--faint)`, run
 * `var(--accent)`, label inset in `var(--panel)` text), **Actions** (4px
 * ticks per event; current = `var(--text)`, retry = `var(--warn)`, else
 * accent; clickable, tooltip "name · +3.181s"), **Logs** (grey
 * `var(--border-3)` clusters)."
 *
 * Everything positions on `atMs`, never on `seq` or on array index: `seq` is
 * arrival order at the recorder, not event order, so a lane laid out by index
 * draws a captured action slightly after its own log lines
 * (`lib/useJobTrace.ts`'s own doc).
 *
 * "retry" is `attempt > 1` on the trace event, the runner's own retry counter
 * that the handoff draws by name. It is not a run (plan 200 §2.4's reserved
 * word) and §10.3 exempts it.
 */
const LOG_BUCKETS = 40

export function Lanes({
  events,
  actions,
  selected,
  onSelect,
  originMs,
  endMs,
  emptyLane,
}: {
  events: JobTraceEvent[]
  actions: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
  originMs: number
  endMs: number
  emptyLane: string | null
}) {
  const span = Math.max(1, endMs - originMs)
  const pct = (at: number) => ((at - originMs) / span) * 100
  const bands = useMemo(() => phaseBands(events, endMs), [events, endMs])
  // One block per bucket that holds at least one log line: the handoff draws
  // "clusters", not a tick per line, and a run with 4 000 log lines would
  // otherwise put 4 000 absolutely positioned divs on the page.
  const logClusters = useMemo(() => {
    const hit = new Set<number>()
    for (const e of events) if (e.kind === 'log') hit.add(Math.floor(((e.atMs - originMs) / span) * LOG_BUCKETS))
    return [...hit].sort((a, b) => a - b)
  }, [events, originMs, span])

  return (
    <div className="rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
      <div className="flex items-center justify-between pb-2 font-mono text-[10.5px] text-faint">
        <span>{formatOffset(originMs, originMs)}</span>
        <span>{formatOffset(endMs, originMs)}</span>
      </div>

      <Lane label="Phase">
        {bands.map((b, i) => (
          <div
            key={`${b.phase}-${i}`}
            title={b.phase}
            className={cn(
              'absolute inset-y-0 flex items-center overflow-hidden rounded-[6px] pl-2 text-[9.5px] uppercase tracking-[.5px] text-panel',
              PHASE_FILL[b.phase] ?? PHASE_FILL.unknown,
            )}
            style={{ left: `${pct(b.startMs)}%`, width: `${Math.max(pct(b.endMs) - pct(b.startMs), 4)}%` }}
          >
            {b.phase}
          </div>
        ))}
      </Lane>

      <Lane label="Actions">
        {actions.map((e, i) => (
          <button
            key={e.id}
            type="button"
            title={`${e.name} · ${formatOffset(e.atMs, originMs)}`}
            aria-label={`${e.name} at ${formatOffset(e.atMs, originMs)}`}
            onClick={() => onSelect(i)}
            className={cn(
              'absolute inset-y-[3px] w-[4px] rounded-pill',
              i === selected ? 'bg-text' : e.attempt > 1 ? 'bg-warn' : 'bg-accent',
            )}
            style={{ left: `calc(${pct(e.atMs)}% - 2px)` }}
          />
        ))}
      </Lane>

      <Lane label="Logs">
        {logClusters.map((b) => (
          <div
            key={b}
            className="absolute inset-y-[6px] rounded-[4px] bg-border-3"
            style={{ left: `${(b / LOG_BUCKETS) * 100}%`, width: `${100 / LOG_BUCKETS}%` }}
          />
        ))}
      </Lane>

      {/* Goal: an empty action lane is stated in words, never left as a blank
          box the reader has to interpret (`lib/useJobTrace.ts`'s
          `explainEmptyActionLane`). */}
      {emptyLane && <p className="pt-2 text-meta text-faint">{emptyLane}</p>}
    </div>
  )
}

function Lane({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[10px] py-[3px]">
      <span className="w-[58px] flex-none text-tip uppercase tracking-[.4px] text-faint">{label}</span>
      <div className="relative h-[18px] flex-1 rounded-[6px] bg-muted-2">{children}</div>
    </div>
  )
}
```

#### `components/jobs/timeline/FrameStrip.tsx` (new, complete)

```tsx
'use client'

import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { STRIPE } from '../job-view'
import { formatOffset } from './lanes'

/**
 * Card 3 (design handoff): "*Frames*: "Frames · 18 events · frames captured
 * per action" and a horizontal strip of 76px 9:19.5 thumbnails, each with its
 * timestamp and action name; the current frame gets a `2px solid
 * var(--accent)` border. Clicking a frame moves the playhead."
 *
 * The heading's third clause is the live capture-policy sentence
 * (`describeCapturePolicy`, e.g. "Frames: per action (ui-server)") rather
 * than the handoff's fixed words: a run whose inspector fell back mid-flight,
 * or one that ran on a cloud node and captured nothing, must say so where the
 * reader is looking for frames (plan 218 §3.6).
 *
 * An action with no `frameHash` still gets a card, striped and captioned:
 * a gap in the strip would read as "nothing happened here", which is the one
 * thing a debugger must not be told.
 */
export function FrameStrip({
  jobId,
  runId,
  actions,
  selected,
  onSelect,
  originMs,
  note,
}: {
  jobId: string
  runId: string
  actions: JobTraceEvent[]
  selected: number
  onSelect: (index: number) => void
  originMs: number
  note: string
}) {
  return (
    <div className="rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
      <div className="pb-2 text-label text-faint">
        Frames · {actions.length} event{actions.length === 1 ? '' : 's'} · {note}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {actions.map((e, i) => (
          <button key={e.id} type="button" onClick={() => onSelect(i)} className="w-[76px] flex-none text-left">
            <div
              className={cn(
                'flex aspect-[9/19.5] w-[76px] items-end justify-center overflow-hidden rounded-small border-2 pb-[5px]',
                i === selected ? 'border-accent' : 'border-line-2',
              )}
              style={e.frameHash ? undefined : STRIPE}
            >
              {e.frameHash ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/frames/${e.frameHash}`}
                  alt={`Screen at ${formatOffset(e.atMs, originMs)}`}
                  className="size-full object-cover"
                />
              ) : (
                <span className="font-mono text-[9px] text-faint">{formatOffset(e.atMs, originMs)}</span>
              )}
            </div>
            <div className={cn('mt-[5px] truncate text-center text-tip', i === selected ? 'text-accent' : 'text-faint')}>
              {e.name}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
```

#### `components/jobs/timeline/FrameAndEvent.tsx` (new, complete)

```tsx
'use client'

import type { JobTraceEvent } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { STRIPE } from '../job-view'
import { formatOffset } from './lanes'

/**
 * Card 4 (design handoff): "*Frame + Event*: a 168px column showing the
 * current frame large, beside an event panel — action name (`Geist Mono`
 * 13px), an `ok`/`retry` badge, the timestamp, then phase / attempt /
 * duration / seq / ui nodes rows, and an **Arguments** note: *"Recorded
 * already redacted — typed text and clipboard writes store only a length."*"
 *
 * The Arguments note is quoted from the design of record and carries its own
 * em dash; it is copy, not prose written here.
 *
 * A sixth row, `error code`, renders only when the event carries one. The
 * handoff's sample trace has no failing action; a real one does, and the code
 * is the shortest true answer to "why did this action fail".
 */
export function FrameAndEvent({
  jobId,
  runId,
  originMs,
  event,
  frameEvent,
  previousFrameEvent,
}: {
  jobId: string
  runId: string
  originMs: number
  event: JobTraceEvent | null
  frameEvent: JobTraceEvent | null
  previousFrameEvent: JobTraceEvent | null
}) {
  const shown = frameEvent ?? previousFrameEvent
  const retry = (event?.attempt ?? 1) > 1
  return (
    <div className="flex items-stretch gap-[10px]">
      <div className="w-[168px] flex-none rounded-inner border border-line-2 p-[10px]">
        <div className="pb-2 text-label text-faint">Frame</div>
        <div
          className="flex aspect-[9/19.5] w-full items-end justify-center overflow-hidden rounded-button border border-line-2 pb-2"
          style={shown?.frameHash ? undefined : STRIPE}
        >
          {shown?.frameHash ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/frames/${shown.frameHash}`}
              alt={`Screen at ${formatOffset(shown.atMs, originMs)}`}
              className="size-full object-contain"
            />
          ) : (
            <span className="font-mono text-tip text-faint">no frame stored at or before this point</span>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
        {event === null ? (
          <p className="text-meta text-faint">Nothing selected.</p>
        ) : (
          <>
            <div className="flex items-center gap-[9px] pb-2">
              <span className="truncate font-mono text-[13px] font-medium">{event.name}</span>
              <span
                className={cn(
                  'flex-none rounded-pill px-2 py-[3px] text-tip font-semibold',
                  event.ok === false ? 'bg-danger-soft text-danger' : retry ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent',
                )}
              >
                {event.ok === false ? 'failed' : retry ? 'retry' : 'ok'}
              </span>
              <span className="flex-none font-mono text-meta text-faint">{formatOffset(event.atMs, originMs)}</span>
            </div>
            <Row label="phase" value={event.phase ?? '—'} />
            <Row label="attempt" value={String(event.attempt)} />
            <Row label="duration" value={event.durationMs === null ? '—' : `${event.durationMs} ms`} />
            <Row label="seq" value={String(event.seq)} />
            <Row
              label="ui nodes"
              value={event.uiHash ? 'captured' : 'not captured'}
              href={event.uiHash ? `${coreBase()}/api/jobs/${jobId}/runs/${runId}/trace/ui/${event.uiHash}` : undefined}
            />
            {event.errorCode && <Row label="error code" value={event.errorCode} />}
            <div className="pt-[10px] pb-[6px] text-label text-faint">Arguments</div>
            <p className="font-mono text-meta leading-[1.7] text-text-3">
              Recorded already redacted &mdash; typed text and clipboard writes store only a length.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-muted-2 py-[5px]">
      <span className="flex-none text-meta text-faint">{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="truncate font-mono text-meta text-accent hover:underline">
          {value}
        </a>
      ) : (
        <span className="truncate font-mono text-meta text-text">{value}</span>
      )}
    </div>
  )
}
```

### 4.11 `components/jobs/json-diff.ts` and `RunCompare.tsx`

```ts
export type DiffState = 'same' | 'changed' | 'only-left' | 'only-right'

export interface DiffRow {
  /** The same path shape `jsonNodes` emits, so the two views agree on what a field is called. */
  path: string
  left: string
  right: string
  state: DiffState
}

/**
 * A field-by-field comparison of two JSON values (MVP 14 §2: "structured
 * results (`resultSchema`, plan 97) get a field-by-field diff"). Leaves only:
 * a container's identity is its leaves, and reporting "interactions changed"
 * above three rows that already say which one changed is noise. Sorted by
 * path, so the two runs' rows line up.
 */
export function diffJson(left: unknown, right: unknown): DiffRow[]
```

`RunCompare.tsx` renders when `?compare=` is set, in place of the sub-tab body, and honours the sub-tab:

| view | Rendering |
|---|---|
| `output` | `run.resultSchema !== null` on either run: one table of `diffJson(a.result, b.result)` with columns path / run A / run B, rows tinted `bg-warn-soft` for `changed`, `bg-muted` for `only-left`/`only-right`, untinted for `same`, and a header line `` `run ${a.seq} compared with run ${b.seq} · ${changed} of ${rows.length} fields differ` ``. Neither run declared a schema: two `JsonSnapshot` panels in a `grid grid-cols-2 gap-[10px]` |
| `logs` | Two `LogsTab` panels in a `grid grid-cols-2 gap-[10px]`, the plain split view MVP 14 §2 asks for |
| `inputs` | Two `JsonSnapshot` panels, with one line above them: `Both runs share the job's parameters. A run with different parameters is a different job.` |
| `timeline`, `artifacts` | Not compared. The sub-tab entry is rendered with `aria-disabled` and the body says `Two runs cannot be compared here. Pick Output or Logs, or close the comparison.` with a link that drops `?compare=` |

The second run's data comes from a second `useJobDetail(jobId, compareRunId)` call. Two hook instances rather than one hook taking two ids: the hook already keys every effect on `(jobId, runId)`, and a second parameter would fork every one of them.

### 4.12 `components/jobs/WorkflowSteps.tsx` and `BatchDetail.tsx`

`WorkflowSteps.tsx` props `{ steps: WorkflowStepInfo[]; finalized: boolean; jobId: string; runId: string; onResume: (fromStep: number) => void }`. Structure:

- root `px-[14px] pt-3 pb-4`
- heading `pb-2 text-label text-faint` reading `` `Steps · ${steps.length} · each script step is a job of its own` ``, then a second line `text-tip text-faint`: `A workflow job runs no device actions itself. The replay of each step is on that step's own job.`
- one card per step, `rounded-inner border border-line-2 px-3 py-[10px] mb-[10px]`
  - row 1 `flex items-center gap-[9px]`: `<span className="flex-none font-mono text-meta text-faint">#{step.seq + 1}</span>`, the step id in `truncate font-mono text-[13px] font-medium`, a state badge (the §4.4 badge classes, with `running`, `success`, `failed`, `skipped` `bg-muted-2 text-dim`, `carried-over` `bg-accent-soft text-accent`, `cancelled` `bg-warn-soft text-warn`), `<span className="ml-auto flex-none font-mono text-meta text-faint">{duration(step.startedAt, step.finishedAt, now)}</span>`
  - row 2, for `kind === 'script'` with a `jobId`: `<Link href={jobHref(step.jobId, { run: step.jobRunId ?? undefined })} className="text-meta text-accent hover:underline">Open this step's job</Link>` (MVP 05 §1.5). A script step with no job yet says `not enqueued yet`
  - row 2, for `kind === 'gate'`: `<span className="text-meta text-faint">gate</span>` and, when `step.verdict` is present, `<JsonSnapshot title="Verdict" moment="recorded at the gate" value={step.verdict} />` collapsed behind a `<details>` summary reading `verdict`. The prose gate sentence the old page built from the workflow document (`app/jobs/detail/page.tsx:182` `gateVerdictSentence`) is not rebuilt: it needed the document, which this screen no longer fetches, and rendering the recorded trace is the honest floor. §9 Q5 records the loss
  - row 3, when `step.error`: `<p className="text-meta text-danger">{step.error}{step.errorCode ? ` · ${step.errorCode}` : ''}</p>`
  - row 4, when `finalized && step.status !== 'skipped'`: a `Resume from here` ghost button posting `POST /api/workflow-jobs/${jobId}/resume` with `{ fromStep: step.seq }` (plan 211 §4.8), showing `toast.success('Resumed as a new run')` and navigating to `jobHref(jobId, { run: body.runId })`. No confirmation dialog: resume adds a run to this job and changes nothing that already ran, which is exactly what the old `ResumeDialog` (`app/jobs/detail/page.tsx:385`) had to spend a paragraph explaining when resume created a new job

`BatchDetail.tsx` (§3.10): the same `DetailHeader` with `name` = `batch.scriptName ?? batch.id`, `state` = `batchState(batch.status)`, `meta` = `` `${batch.id.slice(0, 12)} · ${batch.counts.total} devices · ${done}/${batch.counts.total}${batch.counts.failed ? ` · ${batch.counts.failed} failed` : ''} · ${clockTime(batch.createdAt)} · ${duration(batch.createdAt, batch.finishedAt, now)}` ``, and three actions:

| Action | Behaviour |
|---|---|
| **Re-run** (`primary`, `PlayIcon`) | `POST /api/batches/${id}/rerun`, `BatchResponseSchema`; toast `Added a run to every member job` |
| **Re-run failed** (`ArrowsClockwiseIcon`) | `POST /api/batches/${id}/rerun-failed`; toast `Added a run to every member whose latest run failed`; disabled with the reason `No member failed` when `counts.failed === 0` |
| **Export** (`ExportIcon`) | the same client-side JSON download, of `{ batch, jobs }` |

Two sub-tabs: `inputs` (`SignInIcon`, `<JsonSnapshot title="Input snapshot" moment="captured at dispatch" value={batch.params} />`) and `members` (`ListDashesIcon`), where Members is a plain list, one row per member job, `flex items-center gap-[10px] rounded-button px-2 py-[9px] hover:bg-muted` with the state dot, the device name through `deviceRefLabel`, the sub-line `jobSubLine(job, now)`, and the whole row a `next/link` to `jobHref(job.jobId)`. `GET /api/batches/:id` returns both in one read.

### 4.13 `packages/ui/src/icons.ts` (changed, additive)

Five names this screen draws that plan 204's two groups do not carry, added as a third group after group 2, alphabetically inside the block:

```ts
/**
 * Group 3: named by a SCREEN rather than by the handoff README or a
 * primitive. Plan 218 §4.13: the Jobs screen's transport pause, its three
 * header buttons and its Copy JSON / compare controls. The prototype file
 * draws them (`Enkaku Device List.dc.html:1400-1401`, `:1541`); only the
 * README's prose, which plan 204's group 1 is derived from, does not name
 * them.
 */
export {
  ArrowsLeftRightIcon,
  CopyIcon,
  DeviceMobileIcon,
  ExportIcon,
  PauseIcon,
} from '@phosphor-icons/react'
```

Plan 204 §4.5 says its `icons.test.ts` derives group 1 from the README, so a name outside group 1 cannot fail it. If that file does not exist (plan 200 §8.3 forbids tests in `packages/ui`), there is nothing to check either way. Do not touch group 1 or group 2.

### 4.14 `packages/studio/src/app/page.tsx` (changed, one effect)

The handoff's **Open device** button has to reach Device Control, which plan 215 makes a window over the Devices screen rather than an address (`docs/plans/215-mvp-device-control.md:744`, "`<DeviceControl deviceId={focusId} selectedIds={selectedIds} onClose={clearFocus} onAction={runBulkAction} />`"). So the link carries the device in a query parameter and the Devices screen consumes it once:

```tsx
// Plan 218 §4.14 — `Open device` on the Jobs screen links here with
// `?device=<id>`. Consumed once and stripped, so a reload or a Back does not
// reopen a window the operator has closed, and so the address never becomes a
// second, competing source of truth for which device is focused.
useEffect(() => {
  const id = searchParams.get('device')
  if (!id) return
  setFocusId(id)
  router.replace('/')
}, [searchParams, router])
```

Match on the `<DeviceControl` element to find the setter that feeds its `deviceId` prop; plan 215 quotes it as `focusId` with `clearFocus` as its clearer. If plan 214 named it differently, use whatever name is there. Change nothing else in that file.

### 4.15 `scripts/check-routes.ts` (changed)

Delete two rows from `PENDING_REMOVAL` (plan 213 §4.10):

```ts
  '/batches': 'plan 218: second tab of Jobs (MVP 15 §1)',
  '/schedules': 'plan 217: third tab of Scripts & workflows (MVP 15 §0.1.1)',
```

Check 2 of the script ("every entry in those lists still exists on disk") makes this mandatory rather than tidy: leaving either row after deleting its directory fails the script. If plan 217 has already removed the `/schedules` row, remove only `/batches` and say so in §11. The exempt count in the script's success line drops by one for each row actually removed; G4 asserts the exit code and the absence of the two strings rather than a number, because two plans in this stage each remove rows from the same list.

## 5. Implementation steps

Read plan 200 §2, plan 213 §4.4 to §4.9 and `CLAUDE.md` before the first edit. Every `path:line` was read on 2026-09-03; match on the quoted content when a line has moved. Commit per step as `feat(mvp-218): …`, `chore(mvp-218): …` or `fix(mvp-218): …`.

### 218.1 Icons and the pure modules

- Files created: `packages/studio/src/components/jobs/job-view.ts` (§4.4), `components/jobs/json-nodes.ts` (§4.10), `components/jobs/json-diff.ts` (§4.11), `components/jobs/timeline/lanes.ts` (§4.10).
- Files changed: `packages/ui/src/icons.ts` (§4.13), `packages/studio/src/lib/jobs.ts` (keep `isRunnerLog`, `producedArtifacts`, `formatResult`; delete `JobWithPhase` and `outcomeLine`).
- Files deleted: none.
- Test file: none. Plan 200 §8.3: zero tests in `packages/studio` and `packages/ui`. `jsonNodes` and `diffJson` are not on §8.3's critical list, so they are not tested anywhere; §8 carries the risk.
- Verifiable result: `bun run typecheck` exits 0; `bun run scripts/check-design-tokens.ts` prints `design tokens ok`.
- Do not: put `jsonNodes` or `diffJson` in `packages/protocol` to make them testable. They format for one screen and belong to it; §8.3 draws the line at the wire contract, and moving UI formatting across a package boundary to buy a test is exactly the churn that policy exists to stop.

### 218.2 Move the playback hook and delete the prototype timeline components

- Files created: none.
- Files changed: `packages/studio/src/components/jobs/timeline/useTracePlayback.ts` (moved with `git mv` from `components/jobs/trace/useTracePlayback.ts`; the body is unchanged, and its one import, `import { nearestEventIndex } from '@/lib/useJobTrace'`, is path-independent).
- Files deleted: `components/jobs/trace/TracePanel.tsx`, `TraceScrubber.tsx`, `TraceTimeline.tsx`, `TraceFrame.tsx`, `TraceEventDetail.tsx`, and any `*.test.ts(x)` still in that directory. The directory itself is then empty and goes.
- Test file: none.
- Verifiable result: `test -f packages/studio/src/components/jobs/timeline/useTracePlayback.ts && test ! -e packages/studio/src/components/jobs/trace` exits 0. `bun run typecheck` will fail at this point because `app/jobs/detail/page.tsx` still imports `TracePanel`; that is expected and step 218.7 closes it.
- Do not: rewrite `useTracePlayback` while moving it. Its doc comment records a design decision (a continuous playhead so a long idle gap does not read as a freeze) that the new Transport card depends on.

### 218.3 The data layer

- Files created: `packages/studio/src/lib/use-job-counts.ts` (§4.3.3).
- Files changed: `packages/studio/src/lib/use-job-detail.ts` (rewritten to §4.3.1), `packages/studio/src/lib/useJobTrace.ts` (the three edits of §4.3.2), `packages/studio/src/lib/api.ts` (delete the `JobNodeInfo` import at `:6` and its re-export at `:805` if plan 211 left them).
- Files deleted: none.
- Test file: none.
- Verifiable result: `grep -rn "JobNodeInfo" packages/studio/src` prints nothing.
- Do not: keep a `jobId`-only overload of `useJobTrace` "for the popup". The popup is gone (plan 215) and a second signature would let a caller read the wrong run's trace silently.

### 218.4 The chrome: tab strip, sidebar, header, run picker, sub-tabs

- Files created: `components/jobs/JobsTabStrip.tsx` (§4.5), `components/jobs/JobsSidebar.tsx` (§4.6), `components/jobs/DetailHeader.tsx` (§4.7), `components/jobs/RunPicker.tsx` (§4.8), `components/jobs/SubTabs.tsx` (§4.9).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `GREP_218_COLOUR` (§10.3) prints nothing.
- Do not: give the page a title. The handoff is explicit: "The tab strip **is** the page header (no separate 'Jobs / N total' title above it)", and plan 213's `PagePanel` deliberately renders none.
- Do not: install a `document` click or `keydown` listener in `RunPicker`. Use `data-menu-root="1"` and `useOverlay('menu', open, close)` from `packages/studio/src/lib/overlays.ts`; plan 213 §4.9 installs both listeners once, in `AppShell`.

### 218.5 The five bodies

- Files created: `components/jobs/JsonSnapshot.tsx`, `components/jobs/LogsTab.tsx`, `components/jobs/ArtifactsTab.tsx`, `components/jobs/timeline/Timeline.tsx`, `Transport.tsx`, `Lanes.tsx`, `FrameStrip.tsx`, `FrameAndEvent.tsx` (all §4.10).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` (still failing only on `app/jobs/detail/page.tsx` until step 218.7).
- Do not: reuse `components/result-view/ResultView.tsx` for the Output tab. It renders a result through the script's declared `x-enkaku` vocabulary, which is a different surface from the handoff's typed JSON node tree, and it would silently drop every key the schema does not declare. The three result banners are kept explicitly instead (§4.10).
- Do not: draw the log lane as one element per log line. §4.10's `LOG_BUCKETS` is a bucket count for a reason: a run with thousands of lines would otherwise put thousands of absolutely positioned nodes in one 18 px strip.

### 218.6 Steps, batches and compare

- Files created: `components/jobs/WorkflowSteps.tsx`, `components/jobs/BatchDetail.tsx` (both §4.12), `components/jobs/RunCompare.tsx` (§4.11).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck`.
- Do not: rebuild `gateVerdictSentence` (`app/jobs/detail/page.tsx:182`) or `docNodeById` (`:197`). Both read the workflow document, which this screen no longer fetches; the recorded `verdict` is rendered instead and §9 Q5 records what is lost.
- Do not: give the Batches tab five sub-tabs to look like the Jobs tab. A batch has no logs, no trace and no artifacts of its own; every one of those belongs to a member job, one click away.

### 218.7 The screen itself, and the second route deleted

- Files created: `packages/studio/src/components/jobs/JobsScreen.tsx`, `components/jobs/JobDetail.tsx` (§4.9).
- Files changed: `packages/studio/src/app/jobs/page.tsx`, rewritten to:

```tsx
'use client'

import { Suspense } from 'react'
import { LoadingRows } from '@enkaku/ui'
import { JobsScreen } from '@/components/jobs/JobsScreen'

/**
 * Jobs (design handoff, "Screen: Jobs"). One page, two tabs, two columns; the
 * detail is not a second route (plan 218 §3.3). `Suspense` is what a static
 * export needs before it will prerender a `useSearchParams()` caller at all.
 */
export default function JobsPage() {
  return (
    <Suspense fallback={<div className="p-[14px]"><LoadingRows rows={6} /></div>}>
      <JobsScreen />
    </Suspense>
  )
}
```

- Files deleted: `packages/studio/src/app/jobs/detail/` (the whole directory, `page.tsx` and any surviving `page.test.tsx`), `components/jobs/JobResultSection.tsx`, `JobFailureDetail.tsx`, `JobLogsPanel.tsx`, `JobArtifactsPanel.tsx`.
- Test file: none.
- Verifiable result: `test ! -e packages/studio/src/app/jobs/detail` exits 0; G6's grep prints nothing.
- Do not: keep `/jobs/detail` as a redirect. Plan 200 §2.1: no compatibility shims. Step 218.8 rewrites every link.

### 218.8 Every link into a job goes through `jobHref`

- Files created: none.
- Files changed: every file `grep -rn "/jobs/detail" packages/studio/src` still names after step 218.7. As of 2026-09-03 the list, minus the files plans 201, 205, 211 and 215 delete before this plan runs, is:

| File | Line today | Becomes |
|---|---|---|
| `components/DeviceCard.tsx` | `:350` `href={\`/jobs/detail?id=${runningJob.jobId}\`}` | `href={jobHref(runningJob.jobId)}` |
| `components/CrashesPanel.tsx` | `:67` `href={\`/jobs/detail?id=${encodeURIComponent(meta.jobId)}\`}` | `href={jobHref(meta.jobId)}` |
| `components/RunScriptDialog.tsx` | `:886` `if (result.jobId) router.push(\`/jobs/detail?id=${result.jobId}\`)` and `:887` `else router.push(\`/batches/detail?id=${result.batchId}\`)` | `router.push(jobHref(result.jobId))` and `router.push(batchHref(result.batchId))` |
| `lib/operations.ts` | `:365` `href: \`/batches/detail?id=${b.id}\`,` and `:383` `href: \`/jobs/detail?id=${j.jobId}\`,` | `batchHref(b.id)` and `jobHref(j.jobId)` |

- Files deleted: none.
- Test file: none.
- Verifiable result: G3's grep prints nothing.
- Do not: edit a file that no longer exists, and do not resurrect one. If the grep names a file this table does not, edit it the same way and record it in §11.

### 218.9 Batches becomes a tab

- Files created: none.
- Files changed: none beyond step 218.8's.
- Files deleted: `packages/studio/src/app/batches/` (the whole directory: `page.tsx`, `detail/page.tsx` and any surviving tests).
- Test file: none.
- Verifiable result: `test ! -e packages/studio/src/app/batches` exits 0.
- Do not: delete `components/bulk/`. Six dialogs and `lib/labelling.ts` still import it; plan 216 owns them (§3.8, and plan 214 §3.6 says the same).

### 218.10 The Open device link

- Files created: none.
- Files changed: `packages/studio/src/app/page.tsx` (the effect of §4.14, and nothing else).
- Files deleted: none.
- Test file: none.
- Verifiable result: `grep -n "device'" packages/studio/src/app/page.tsx` names the new effect; `bun run typecheck` exits 0.
- Do not: rebuild any part of the Devices screen. Plan 214 owns that file; this is one effect, added beside what is there.

### 218.11 The route script

- Files created: none.
- Files changed: `scripts/check-routes.ts` (§4.15).
- Files deleted: none.
- Test file: none.
- Verifiable result: G4: `grep -nE "'/batches'\|'/schedules'" scripts/check-routes.ts` prints nothing and `bun run scripts/check-routes.ts` exits 0.
- Do not: add a row for `/jobs`. It is in the rail, and check 3 fails a route that is both in the rail and in a list.

### 218.12 The shared jobs table

- Precondition, run first and recorded in §11: `grep -rn "components/JobsList" packages/studio/src`.
- If it prints nothing: delete `packages/studio/src/components/JobsList.tsx` and any surviving `JobsList.test.tsx`, then check `grep -rn "JobStatusBadge" packages/studio/src`; if that also prints nothing, delete the `JobStatusBadge` export from `components/StatusBadge.tsx` (leaving `DeviceStatusBadge`, `ReadinessBadge` and `PluginStatusBadge`, which have other callers). G16 is then closed.
- If it prints a line: leave both files alone, leave G16 open, and record the surviving importer and its owning plan in §11. The only importer this plan expects to see is `app/scripts/detail/page.tsx`, which plan 217 owns.
- Files created: none. Test file: none.
- Verifiable result: whichever of the two branches ran, stated in §11 with the grep output.
- Do not: rewrite the surviving importer to keep the file alive, and do not delete the file while an importer names it.

### 218.13 Schedules stops being a top-level route

- Files created: none.
- Files changed: `scripts/check-routes.ts` (already done in step 218.11 if the row was still there).
- Files deleted: `packages/studio/src/app/schedules/` (`page.tsx`, `detail/page.tsx` and any surviving tests), if the directory still exists. Plan 213 §4.10's `PENDING_REMOVAL` names plan 217 as its owner and this plan's brief names plan 218; §3.9 has the reasoning and §9 Q1 asks for the ruling. The step is idempotent: delete what is there, prune what is there, report which plan actually did it.
- Test file: none.
- Verifiable result: `test ! -e packages/studio/src/app/schedules` exits 0; G3 and G4.
- Do not: delete `components/ScheduleEditorDialog.tsx`. Plan 217's Schedules tab is its next importer (§3.8).
- Do not: build a Schedules tab anywhere. MVP 15 §0.1.1 puts it on Scripts & Workflows, and plan 217 builds it.

### 218.14 The spec

- Files created: none.
- Files changed: `docs/spec.md`. If plan 202's MVP spec is live, put its Jobs screen paragraphs in the present tense there. Otherwise edit §19's two rows and append a `DIV-` row to `docs/spec-divergences.md` naming plan 202 as the rewriter:
  - **Job / run detail**: replace the row's body with the handoff's shape: one Jobs page with a Jobs and a Batches tab, a 268 px filtered list, and a detail whose header carries the run picker, Re-run, Open device and Export, over Inputs, Output, Logs, Timeline and Artifacts. Keep the plan 97 banner sentence (`invalid` / `partial` / `oversize`) and the trace sentence, both of which this plan implements; delete the Summary tab, the node timeline, the `EntityTabs` tab list and the "Delete job" / "Clear history" sentence (both controls are gone with the old page; §10.2).
  - **Clusters, batches, schedules**: retitle to **Batches** and reduce it to the second tab of Jobs. Clusters is Groups on the Devices tab strip (MVP 15 §0.1.3, plan 214); schedules is the third tab of Scripts & Workflows (MVP 15 §0.1.1, plan 217). Both cross-references name the owning plan.
- Test file: none.
- Verifiable result: `grep -nE "Clusters, batches, schedules\|node timeline\|/jobs/detail" docs/spec.md` prints nothing.
- Do not: rewrite any other §19 row. Plans 214 to 219 each own their own.

### 218.15 Vocabulary and the removal greps

- Files changed: anything `GREP_218` (§10.3) still names, comments and copy included.
- Verifiable result: G3, G6, G7, G8 all print nothing; `bun run typecheck` exits 0; `bun run scripts/check-routes.ts` and `bun run scripts/check-design-tokens.ts` both exit 0.
- Do not: rename `JobTraceEvent.attempt` or `JobRunInfo.infraAttempts`. Plan 200 §2.4 exempts `infraAttempts` by name, and `attempt` on a trace event is the runner's retry counter that the handoff draws by name (§10.3 exempts it with the same reasoning).

## 6. Acceptance criteria

1. `/jobs` renders the handoff's shape at 1280 px: a tab strip with two counted tabs and no separate title, a 268 px bordered left column with wrapping chips and a 12-row page, and a right detail whose header is at least 58 px with the state badge beside the name on one line and three buttons pushed right.
2. Selecting a row changes `?job=`; switching to Batches changes `?tab=batches`, resets the filter and the page, and shows batch rows.
3. The detail's meta line opens with `run N of M`, and clicking it lists every run newest first with status, duration, trigger and who started it.
4. Re-run adds a run: the picker reads `run N+1 of M+1`, both results are readable by switching runs, and the left list still holds exactly one row for that job.
5. A workflow job's Timeline sub-tab lists its steps; each script step's link opens a job whose meta line reads `step K of workflow job …` and whose own Timeline is the four replay cards.
6. The Timeline scrubs: clicking the track snaps the playhead to the nearest action, clicking a frame or an Actions tick selects that action, and the centred readout and `event N of M` both follow. Play advances in real time at 1x, 2x and 4x, and stops at the end without wrapping.
7. Inputs and Output render as node trees with per-type colours and a type name at the right edge; Copy JSON puts the whole value on the clipboard even when the tree was capped.
8. Logs shows level chips with counts and the four-column alternating table; Artifacts shows the auto-fill card grid with a 92 px thumbnail area.
9. Comparing two runs shows them side by side, with a per-path diff table when the run declared a `resultSchema` and a split view for logs.
10. `/jobs/detail`, `/batches` and `/schedules` are gone from the tree, from every Studio link, and from `check-routes.ts`, which exits 0.
11. `bun run typecheck` exits 0 and every §10 grep prints nothing.

## 7. Test plan

**No test is written or run for `packages/studio` or `packages/ui`** (plan 200 §8.3, `CLAUDE.md`). Nothing in this plan is on §8.3's critical list, so **no `bun test` invocation belongs to this plan at all**. If a Studio test file that plan 201 has not yet deleted fails to compile against these shapes, delete that file and list it in §11.

### 7.1 Static checks, one at a time

```bash
bun run typecheck                          # expected: every package OK, exit 0
bun run scripts/check-routes.ts            # expected: routes ok: <n> in nav, <m> exempt, exit 0
bun run scripts/check-design-tokens.ts     # expected: design tokens ok, exit 0
```

### 7.2 The removal and vocabulary greps

Run §10.1's `test ! -e` lines and §10.3's `GREP_218` and `GREP_218_COLOUR`. Every one must print nothing (or exit 0). Paste the output into §11.

### 7.3 Owner smoke, on the farm, with `README.md` lines 324 to 389 open beside the browser

Start the core (`bun run dev`) and Studio (`bun run dev:studio`), then, in order:

1. Open `http://localhost:3001/jobs`. The panel shows a tab strip with `Jobs <n>` and `Batches <m>` and **no** title above it. Confirm the left column is 268 px with a right border, that the five chips wrap onto two lines rather than scrolling, and that the footer reads `1-12 of <n>` with two 26 px buttons, Previous disabled.
2. **G9.** With the handoff open, check each measurement in §4.1 against the browser's element inspector: the strip's `10px 14px` padding and bottom border, a chip's `5px 10px` and 8 px radius, a row's dot, 12 px mono name and 14 px-indented sub-line, the header's 58 px minimum and the badge on the name's line, a sub-tab's `6px 11px` and 9 px radius, a timeline card's 12 px radius and `var(--line-2)` border, the scrub track's 6 px height and 14 px knob, a frame thumbnail's 76 px width and 9:19.5 ratio, and the artifact grid's 164 px minimum column. Note any mismatch in §11 rather than adjusting the handoff.
3. Click Next, then a chip, then the Batches tab: the page resets to 1 each time, and the Batches rows show device counts.
4. Toggle the theme in the rail. Every surface on this screen follows; nothing keeps a light background under the dark palette.
5. **G10.** Pick a settled job. Note the row count of the list and the picker's `run 1 of 1`. Press Re-run. The toast says a run was added; the list still holds one row for that job; the picker reads `run 2 of 2`; switching to run 1 shows the earlier Output and run 2 the new one, with different timestamps.
6. **G11.** Run a two-step workflow from Scripts & Workflows. Open the resulting workflow job, open Timeline: two step cards. Click step 2's link: a script job opens whose meta line reads `step 2 of workflow job <id>` and whose Timeline is the four replay cards. Click that segment: it goes back to the workflow job.
7. **G12.** On a script job's Timeline: press play, watch the knob slide and `event N of M` climb, press pause, click the middle of the track (the readout snaps to the nearest action), click a frame near the end (the playhead and the Frame + Event card follow), click an Actions tick, then press 4x and play to the end (it stops, it does not wrap).
8. **G17.** Open the run picker on the re-run job, press the compare control on run 1, and switch to Output: two columns, and for a script with a declared result, a per-path table naming how many fields differ. Switch to Logs: a split view. Switch to Timeline: the stated "cannot be compared here" line with a link that closes the comparison.
9. Open Artifacts on a job that produced screenshots: cards in an auto-fill grid, screenshots showing their image, other files showing a striped thumbnail with the right icon, and the line distinguishing artifacts from the Output snapshot.
10. Press Export: a JSON file downloads and opens with the job, the run, the runs, the logs and the artifact list in it.
11. Press Open device: the Devices screen opens with Device Control focused on that job's device, and the address is back to `/`.
12. With the Jobs page idle for 120 s and the network tab open, confirm no request except the coalesced count refresh, and none at all while nothing changes on the farm.

### 7.4 Device tests

None. Nothing in this plan touches a phone; steps 5, 6 and 7 of §7.3 need the owner's farm only because they need real runs. No `ENKAKU_TEST_DEVICE=1` test is added.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | `jsonNodes` and `diffJson` are real logic with no test anywhere, and a wrong path key would make the diff line the wrong fields up | Both are pure and small, both key on the same path shape, and the compare header states how many fields differ so a nonsense diff is visible at a glance. §7.3 step 8 is the check. Plan 200 §8.3 forbids the test; moving the functions into `packages/protocol` to buy one would be worse (§5 step 218.1's "Do not") |
| R2 | The cursor stack breaks if the underlying list changes between pages, so page 3 could repeat or skip a row | Cursor pagination is keyset-based on `(created_at, id)` (`packages/core/src/api/jobs.ts`), so an insert shifts the window rather than corrupting it, and the reader is on page 0 whenever new rows are arriving (§3.4). A stale cursor answers an empty page, which renders as `none` and a disabled Next, not as an error |
| R3 | The coalescer refetches the window on page 0 through the `counts` dependency, which on a very busy farm is one fetch every 5 s per open tab | The window is 12 rows and the counts are six `limit=1` reads: about seven small requests per five seconds per open Jobs tab, only while something is changing. The alternative, a list that never updates, is worse; the alternative of per-push refetching is what plan 126 §0.4 already found to be the most expensive request in Studio |
| R4 | A run with a very large result renders 2 000 rows and still feels slow | `MAX_JSON_NODES` caps the tree, the cap says how many rows were not shown, and Copy JSON always copies the whole value. `resultBytes` and the `oversize` banner already tell the reader when a result is too big for a screen at all |
| R5 | A trace with thousands of actions puts thousands of ticks in the Actions lane and thousands of thumbnails in the strip | The Logs lane is bucketed (`LOG_BUCKETS`), which is the lane that grows fastest. The Actions lane and the strip are one element per action by design, which the handoff draws; if the owner's farm shows this hurting, it is a follow-up, recorded in §11 under "Observed, not done", not a silently different design |
| R6 | Plan 217 and this plan both try to delete `/schedules` | Step 218.13 is idempotent and §3.9 says so; §9 Q1 asks for the ruling on paper |
| R7 | Plan 211's Studio placeholder (`<select>` over `job.runs`) and this plan's `RunPicker` could both survive a sloppy merge | Step 218.7 deletes the whole `app/jobs/detail/` directory, which is the only place the placeholder lives, and G2 asserts `RunPicker` has exactly one importer |
| R8 | The gate verdict sentence is lost (§9 Q5), so a workflow reader sees raw trace JSON instead of "scroll1.videos (12) >= 10 -> continue" | The verdict is still shown, in full, and the loss is stated in §9 rather than hidden. Rebuilding the sentence needs the workflow document on the client, which is a fetch this screen otherwise has no reason to make |

## 9. Open questions

1. **Who deletes `/schedules`?** Plan 213 §4.10's `PENDING_REMOVAL` names plan 217; this plan's brief names plan 218. Step 218.13 is idempotent either way, but the CTO should settle the row so the wave-3 removal gate has one owner. Nothing here blocks on it.
2. **Are two sub-tabs the right Batches detail?** §3.10 chose Inputs and Members because a batch has no logs, trace or artifacts of its own. The handoff says "same shape, different scope" and drew only the job detail. CEO to confirm, or to draw a batch detail.
3. **Should a queued run show a queue position?** The handoff's sub-line example is "position 1 · est 4m". Neither `JobInfo` nor `JobRunInfo` carries a position or an estimate, and both would need the claim order the queue holds. `jobSubLine` shows `queued <relative time>` instead. Adding the field is a core change, so it belongs to plan 211's successor, not here.
4. **Should a run record who started it?** MVP 14 §2 says the run list shows "who or what started it". `JobRunInfo` carries `trigger` but no actor, so the picker shows `trigger` per run and `jobs.createdBy` once. A per-run actor needs a `job_runs.created_by` column and a protocol field.
5. **Is the gate verdict sentence worth the workflow document fetch?** The old page built "scroll1.videos (12) >= 10 -> continue" from the document plus the recorded trace (`app/jobs/detail/page.tsx:182`). This screen shows the recorded verdict only. Restoring the sentence means fetching `jobs.workflow_doc` on the Timeline tab of every workflow job. CEO or CTO to decide whether that reading is worth the request.
6. **Does Export need a server route?** The client-side JSON is everything this screen already holds. A run with 200 000 log lines would be assembled in the browser. If the owner's farm hits that, a `GET /api/jobs/:id/runs/:runId/export` belongs to a core plan.

## 10. Removed

### 10.1 Files and directories

| What | Where it was | Proof |
|---|---|---|
| The job detail route and its 1211-line page | `packages/studio/src/app/jobs/detail/page.tsx` (`:867` `hrefFor={(k) => \`/jobs/detail?id=${jobId}…\`}`) | `test ! -e packages/studio/src/app/jobs/detail` |
| The batches list and detail routes | `packages/studio/src/app/batches/page.tsx`, `app/batches/detail/page.tsx:44` `import { JobsList } from '@/components/JobsList'` | `test ! -e packages/studio/src/app/batches` |
| The schedules list and detail routes (MVP 15 §0.1.1; §3.9 names the ownership question) | `packages/studio/src/app/schedules/page.tsx:16`, `app/schedules/detail/page.tsx:23`, both `import { ScheduleEditorDialog, type ScheduleRow } from '@/components/ScheduleEditorDialog'` | `test ! -e packages/studio/src/app/schedules` |
| The five prototype trace components | `packages/studio/src/components/jobs/trace/TracePanel.tsx`, `TraceScrubber.tsx`, `TraceTimeline.tsx`, `TraceFrame.tsx`, `TraceEventDetail.tsx` | `test ! -e packages/studio/src/components/jobs/trace` |
| The four job detail panels | `components/jobs/JobResultSection.tsx`, `JobFailureDetail.tsx`, `JobLogsPanel.tsx`, `JobArtifactsPanel.tsx` | `grep -rnE "JobResultSection\|JobFailureDetail\|JobLogsPanel\|JobArtifactsPanel" packages/studio/src` prints nothing |
| The one shared jobs table (step 218.12's precondition permitting) | `packages/studio/src/components/JobsList.tsx:261` and `:407`, its two `next/link`s to `/jobs/detail?id=` | `test ! -e packages/studio/src/components/JobsList.tsx` |

### 10.2 Exports, routes, props and copy inside files that survive

| What | Where it was | Proof |
|---|---|---|
| The `/jobs/detail?id=` address, everywhere | `components/DeviceCard.tsx:350`, `components/CrashesPanel.tsx:67`, `components/RunScriptDialog.tsx:886`, `lib/operations.ts:383` | `grep -rn "/jobs/detail" packages/studio/src` prints nothing |
| The `/batches/detail?id=` and `/batches` addresses | `components/RunScriptDialog.tsx:887`, `lib/operations.ts:365`, `app/batches/detail/page.tsx:295` | `grep -rn "/batches" packages/studio/src` prints nothing |
| The `'/batches'` and `'/schedules'` exemptions in the route script | `scripts/check-routes.ts`'s `PENDING_REMOVAL` (plan 213 §4.10) | `grep -nE "'/batches'\|'/schedules'" scripts/check-routes.ts` prints nothing; `bun run scripts/check-routes.ts` exits 0 |
| `JobWithPhase` and `outcomeLine` | `packages/studio/src/lib/jobs.ts:13`, `:41` | `grep -rnE "JobWithPhase\|outcomeLine" packages/studio/src` prints nothing |
| `JobNodeInfo`'s Studio re-export | `packages/studio/src/lib/api.ts:6` and `:805` `export type { JobNodeInfo }` | `grep -rn "JobNodeInfo" packages/studio/src` prints nothing |
| `JobStatusBadge` (step 218.12's second branch permitting) | `packages/studio/src/components/StatusBadge.tsx:61` `export function JobStatusBadge({` | `grep -rn "JobStatusBadge" packages/studio/src` prints nothing |
| The Summary tab, the phases strip, the timing card, the identity card, the lineage card, the Script tab and the "Peak memory / N limit" row | `app/jobs/detail/page.tsx:894-1146`, `:1163-1186` | covered by §10.1 row 1; `grep -rnE "rack-label mb-3\">phases\|Peak memory\|chain size" packages/studio/src` prints nothing |
| "Delete job" and "Clear history" as controls on this screen | `app/jobs/detail/page.tsx:1084` `{isPending('delete') ? 'Deleting…' : 'Delete job'}`, `app/jobs/page.tsx:118` `{isPending('clear-history') ? 'Clearing…' : 'Clear history'}` | `grep -rnE "Clear history\|Delete job" packages/studio/src` prints nothing. Both routes stay on the core (plan 211 §4.8); the handoff draws neither control, and MVP 09 §6 makes retention the sweeper's job, not a button's. Recorded in §11 under "Observed, not done" so plan 224 can decide whether Settings gets one |
| The node timeline, the gate verdict sentence, the resume dialog | `app/jobs/detail/page.tsx:249` `function NodeTimeline({`, `:269-270` `lastSeqForNodeId`, `:182` `gateVerdictSentence`, `:197` `docNodeById`, `:385` `function ResumeDialog({`, `:409` `if (workflowDoc) {` | `grep -rnE "NodeTimeline\|lastSeqForNodeId\|gateVerdictSentence\|docNodeById\|ResumeDialog" packages/studio/src` prints nothing |

### 10.3 Forbidden vocabulary and colour form for this area (plan 200 §2.4, plan 213 G3)

```bash
GREP_218() {
  rg -n -i \
    -e "\blease" -e "\bholder\b" -e "\bassist" -e "co-control" -e "\bgrant\b" \
    -e "\bcluster" -e "job kind" -e "workflow node" -e "\bnodeId\b" -e "JobNodeInfo" \
    -e "script jobs tab" -e "workflow jobs tab" -e "schedules tab" \
    packages/studio/src/app/jobs packages/studio/src/components/jobs \
    packages/studio/src/lib/use-job-detail.ts packages/studio/src/lib/useJobTrace.ts \
    packages/studio/src/lib/use-job-counts.ts packages/studio/src/lib/jobs.ts
}

GREP_218_COLOUR() {
  rg -n \
    -e "bg-\[--" -e "text-\[--" -e "border-\[--" -e "\bdark:" -e "#[0-9a-fA-F]{6}\b" \
    packages/studio/src/app/jobs packages/studio/src/components/jobs
}
```

Two words are deliberately **not** in `GREP_218`, each with its reason:

- `attempt`. Plan 200 §2.4 reserves it against "attempt" meaning a run, and exempts `infraAttempts` by name. `JobTraceEvent.attempt` is the runner's retry counter inside one run, and the design handoff draws it by name ("phase / attempt / duration / seq / ui nodes rows"). Renaming a field the design names would break the design.
- `kind`. `JobInfo.kind` and `WorkflowStepInfo.kind` are plan 211's shipped protocol names. §2.4 forbids the phrase "job kind" in copy, which `GREP_218` does check; it does not forbid the field.

**MVP 13 A.6 rows this plan closes**: `/batches` and `/schedules` as top-level routes. **Rows this plan does not own** (named so the wave-3 removal gate knows who closes them): `/workflows` as a top-level route (plan 217), `/tools` (plan 219), `/workspace` (plan 220), `/recordings` (deferred, MVP 15 §0.1.5).

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:
