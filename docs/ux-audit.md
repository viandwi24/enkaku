# UX audit — Enkaku Studio

> Audited against `docs/design.md` (the brief called it `design-system.md`; that file does not exist — `design.md` is the design system and is what this audit uses).
> Method: every route under `packages/studio/src/app`, read for what it shows and in what order, plus mechanical checks for shared-component use and duplication.

---

## 1. Screens

| Route | Lines | The question the user came to answer | Shared components |
|---|---|---|---|
| `/` | 695 | Which phones do I have, and is anything wrong? | PageHeader, states |
| `/device` | 731 | What is this phone doing, and can I drive it? | EntityTabs, SectionNav, SchemaForm, PaginatedTable, states |
| `/jobs` | 204 | What ran, what is running, what failed? | PageHeader, PaginatedTable |
| `/jobs/detail` | 816 | Did this run do what I asked, and if not, why? | EntityTabs, PageHeader, states |
| `/batches` | 121 | Which fleet-wide runs happened? | PageHeader, PaginatedTable |
| `/batches/detail` | 260 | How did this fleet-wide run go, per device? | PageHeader, PaginatedTable |
| `/scripts` | 228 | What automation exists here? | PageHeader, PaginatedTable |
| `/scripts/detail` | 381 | What does this script do, and how has it run? | EntityTabs, PageHeader, PaginatedTable |
| `/schedules` | 216 | What runs by itself, and when? | PageHeader, PaginatedTable |
| `/schedules/detail` | 360 | Is this schedule healthy, and what has it fired? | EntityTabs, PageHeader, PaginatedTable |
| `/clusters` | 144 | How is the fleet grouped? | PageHeader, PaginatedTable |
| `/nodes` | 208 | Which machines hold devices for me? | PageHeader, PaginatedTable |
| `/agents` | 373 | Which agents exist, what do they cost? | PageHeader, states |
| `/agents/detail` | 925 | Talk to this agent / configure it | EntityTabs, SectionNav, states |
| `/agents/approvals` | 96 | What is waiting on me? | PageHeader, states |
| `/agents/runs` | 118 | What has this agent done? | PageHeader, states |
| `/plugins` | 268 | What is installed, and is any of it broken? | PageHeader, states |
| `/workspace` | 426 | What files exist, and let me edit one | PageHeader, states |
| `/tools` | 392 | Is the toolchain healthy? | PageHeader, states |
| `/settings` | 1050 | Change how the farm behaves | PageHeader, SectionNav, SchemaForm, states |
| `/topology` | 22 | — (redirect kept for old links, Plan 49) | — |
| `/agents/thread` | 47 | — (redirect shim into the workbench, Plan 78) | — |
| `/dev/tools` | 94 | internal, unlinked from anywhere | PageHeader |

---

## 2. Findings

| # | Screen | Problem | Severity | Fix |
|---|---|---|---|---|
| 1 ✅ | jobs, device, scripts/detail, batches/detail | **DONE — one `JobsList`.** Four separate implementations. Not two — every one hand-rolls its own `renderRow` over `PaginatedTable`, with 9–13 cells each and different columns, ordering and affordances. A change to how a job reads has to be made four times, and has not been: only `/jobs` shows the failure error, only `/jobs` offers cancel. | broken | One `JobsList` with `filter` + `columns` + `limit` props. All four call sites converge. |
| 2 ✅ | `/jobs/detail` | **DONE.** Metadata occupied the content column and the sidebar is underused.** Left stacks outcome → started-with → returned → phases → timing; right holds only identity and lineage in a 20rem column. Phases and timing are reference material sitting where results belong, so the answer to "did it work" is below the fold on any failed job with an error. | broken | Result first in the left column; phases, timing, identity, device, priority to the right. Verdict in the header. |
| 3 ✅ | `/jobs/detail` | **DONE (opportunistic).** `returned` was raw JSON. A script that reports findings, an exit IP, or a version renders as a `<pre>` blob, so the thing the run existed to produce is the least readable thing on the page. | confusing | Render a recognised shape (`findings[]` with `severity`/`title`) as a list with LED severity tokens; keep a raw toggle. |
| 4 ❌ | `/device` | **WITHDRAWN — this was my own false positive.** The mechanical check grepped `page.tsx` files for `PageHeader` and missed that `/device` renders `<DeviceHeader>`, which uses `PageHeader` internally (`components/device/DeviceHeader.tsx:178`). Recorded rather than quietly deleted: it is exactly the failure mode this audit warns about two rows below, and I walked into it. | — | none needed |
| 5 ✅ | `/jobs/detail` | **DONE.** Failed jobs buried the error under the outcome heading rather than leading with it. | confusing | Error is the hero, top of the content column, written per `design.md`'s error rules. |
| 6 | `/dev/tools` | Reachable by URL only — linked from nothing, in no nav. Either it is a real screen or it is not. | cosmetic | Leave (internal by name), but record it so it is not mistaken for a gap. |
| 8 ✅ | every dialog | **DONE.** No dialog capped its height or scrolled, so a tall one grew past the top and bottom of the screen with its buttons out of reach. Found on the run dialog for a script with many parameters; it was every dialog in the product. | broken | `max-h-[90dvh] overflow-y-auto` on `DialogContent` and `AlertDialogContent`. |
| 9 ✅ | every jobs list | **DONE — reversed my own first pass.** A failed job's error was rendered inline in the row. For the one row in a hundred that failed it dominated the list, and an error quoting a URL with no spaces pushed every column off the right edge. It belongs on the badge. | confusing | `JobStatusBadge` takes `error` and exposes it on hover; the row stays one short line. |
| 7 | `/agents/detail`, `/settings` | 925 and 1050 lines in one file each. Not a user-visible defect, but both are past the size where a screen can be read in one sitting. | cosmetic | Extract sections as they are touched; not a standalone task. |

### Verified NOT problems

- **Loading / empty / error on the list screens.** Seven screens have no `ErrorState` import; all seven render through `PaginatedTable`, which handles all three internally. A mechanical grep alone would have reported seven false defects.
- **Colour tokens.** `design-rules.test.ts` already fails the build on the v4 bracket form, internal `<a href>`, and viewport `calc()`, across all of `packages/studio/src`.
- **`/topology` and `/agents/thread`** are deliberate redirects (Plans 49 and 78), not dead screens.
- **`/device`'s `PageHeader`** — see finding 4. It has one, through `DeviceHeader`.

---

## 3. Backend follow-ups

Noted rather than worked around in the client:

- **Structured job results (finding 3).** Rendering `findings[]` well needs the shape to be a convention the SDK documents, not a guess the UI makes. Today `result` is `unknown` by design (a script may return anything). The client can recognise a shape opportunistically; making it reliable is an SDK decision.

---

## 4. Order of work

1. **Job detail** — findings 2, 3, 5. The worst, and the screen a failed run sends you to.
2. **`JobsList`** — finding 1. Four implementations to one.
3. ~~Device detail~~ — finding 4 withdrawn (false positive); it adopted `JobsList` with finding 1.
4. **Dashboard**, then the rest by severity.

---

## 5. Per-screen rationale

Written before each change, per the brief.

### 5.1 Job detail

**The user's question:** *did this run do what I asked, and if not, why?* They arrive from a failed row in a list, or from a script they just published, and they want the verdict in under a second and the evidence in under five.

**Why the current layout answers it slowly:** the verdict is a heading two-thirds of the way down a card, under a summary line; the result — the thing the run produced — sits below "started with", which is input, not output; and phases and timing, which nobody reads until the verdict is understood, occupy the content column ahead of the logs. The 20rem sidebar holds identity, which is the least-asked-for thing on the page.

**The new shape:** the header answers the verdict — script, status, run time, and `queued → started → finished` as one line — so it is readable without scrolling. The content column then runs result, then error (hero, when failed), then params collapsed. Everything that is reference — identity, device, priority, phases, timing, lineage — moves right, which is what earns that column its width.

### 5.2 The shared `JobsList`

**The user's question, wherever a job is listed:** *what ran, how did it go, and if it failed, why?*

**Why four implementations was a behaviour problem, not a tidiness one:** only the Jobs page rendered a failed job's error, and only the Jobs page offered cancel. The same failure therefore read differently depending on which screen you opened it from — a batch member showed a status badge and nothing else, and three of the four used a `line-clamp-1` that could not work under the old `whitespace-nowrap` cell.

**What converged:** all four call sites now render `components/JobsList.tsx`. Columns are opt-in (`seq`, `script`, `device`, `time`, `actions`), because a device page already knows its device and repeating it per row is noise. A batch keeps its own source through a `fetchPage` override — its members arrive with the batch itself, not from a jobs query — but shares the row, which is where the drift was. The Jobs page's cancel also stopped using `JobResponseSchema`, the wrong schema for that route (plan 72 found it: cancel returns a bare `JobInfo`).

### 5.3 Where a failure explains itself

**The user's question in a list:** *what ran, and how did it go?* — not *what exactly went wrong with row 43*. That second question is asked about one row at a time, after the first is answered.

The shared `JobsList` initially rendered the error inline, because that is what the Jobs page did and it was the most complete of the four. Reversed after being used: for the one row in a hundred that failed, a multi-line error dominated the whole table, and one quoting a URL with no spaces in it pushed every column off the right edge — the same overflow the `wrap-anywhere` work had just fixed, arriving from a different direction. `JobStatusBadge` now takes the error and exposes it on hover, with the full text a click away on the job itself. The row stays one line; the badge is where the eye already is when a row reads "failed".
