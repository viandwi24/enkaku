# Plan 220 (MVP wave 3) — Agents: Roster, Runs, Approvals, Files, and Settings on one page

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 213 (the shell, `nav.ts`'s `AGENTS_IN_RAIL` constant and the `/agents` rail entry it already ships, `scripts/check-routes.ts` and its `PENDING_REMOVAL` row for `/workspace`), plan 212 (`AgentSettingsSchema` and `GET/PATCH /api/agents/settings`, §4.7). Plan 204 (tokens, `packages/ui/src/icons.ts`, the re-skinned primitives) is a transitive dependency through 213. This plan does **not** depend on plans 214-219, but it is scheduled in the same stage as 219 (`docs/plans/200-mvp-program.md` §8.1 stage 7: "219, 223, 220 (once its design exists)") and merges after it (higher plan number within a stage merges later per §8.1) — see §3.6 for why that ordering matters to this plan specifically.
> Spec references: `docs/mvp/06-feature-scope.md` §3 (the AI agents row) and §4.2 (decided: keep in core, compacted); `docs/mvp/15-ui-migration.md` §0.1 item 2 (Workspace renamed Files, lives under Agents), §1 (the "Agents in the rail" row, Icons row, Fonts row), §2 (Agents listed as UNDESIGNED), §4.1; `docs/mvp/03-navigation-and-pages.md` §1 (the Agents row: Roster, Runs, Approvals, Files); `docs/mvp/13-removal-register.md` A.6 (routes `/agents/approvals`, `/agents/runs`, `/agents/thread`, `/workspace` fold into this page) and B.2 (the `ai-elements` trim; the `@enkaku/host` note is unrelated to this plan); `docs/mvp/16-consolidated-plan.md` §1 (Surfaces: "Agents is either the fifth icon or the first plugin entry (open)"), §3 (wave 3), §4.1; `docs/mvp/design_handoff_enkaku_openpf/README.md` (the Jobs, Plugins, and Settings screen sections, quoted in §3 below — the handoff draws no Agents screen).
> Ships: `packages/studio/src/components/agents/AgentsPage.tsx`

---

## 0. Goal checklist

Every command runs from the repo root.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | One route, `/agents`, renders a five-tab page | tabs `roster`, `runs`, `approvals`, `files`, `settings`, in that order, `roster` is the default with no `?tab=` | `rg -n "id: '(roster\|runs\|approvals\|files\|settings)'" packages/studio/src/components/agents/AgentsPage.tsx` → 5 lines in that order | [ ] |
| G2 | `/workspace` and the three `/agents/*` sub-routes are gone | 4 directories | `test ! -d packages/studio/src/app/workspace && test ! -d packages/studio/src/app/agents/approvals && test ! -d packages/studio/src/app/agents/runs && test ! -d packages/studio/src/app/agents/thread` → exit 0 | [ ] |
| G3 | `check-routes.ts` no longer exempts `/workspace` | 0 matches | `rg -n "workspace" scripts/check-routes.ts` → empty; `bun run scripts/check-routes.ts` → exit 0, prints `routes ok: …` | [ ] |
| G4 | The Settings tab is schema-generated for `defaults`/`scheduled`; no hardcoded field UI for either | 0 hand-written `<Label>`/`<Input>` pairs for a field `AgentSettingsSchema` declares | `rg -n "AgentDefaultsSchema\|maxOutputTokens\|spendCapOutputTokensPer24h" packages/studio/src/components/agents/SettingsTab.tsx` → empty (the component never names a field, only `narrowSchema`/`SchemaForm` calls) | [ ] |
| G5 | The `ai-elements` trim leaves only what `Chat.tsx` imports, a derived count | `conversation.tsx` 4 value exports (was 6), `message.tsx` 3 (was 12), `prompt-input.tsx` 19 (was 40), `reasoning.tsx` 3 exported + 1 module-private (was 4 exported), `shimmer.tsx` unchanged (1) | §10.3 `GREP_220_AI_ELEMENTS` → the counts below match | [ ] |
| G6 | `motion` still resolves for `shimmer.tsx` | `shimmer.tsx` untouched, `motion` stays a `packages/studio/package.json` dependency | `bun run typecheck` clean; `rg -n "\"motion\"" packages/studio/package.json` → 1 line | [ ] |
| G7 | `lucide-react` has zero importers in `packages/studio/src` and is removed from `package.json` | 0 matches | `rg -l "from 'lucide-react'" packages/studio/src` → empty; `rg -n "lucide-react" packages/studio/package.json` → empty | [ ] |
| G8 | The `spawn-grants` routes are deleted, decision recorded | 0 matches | `rg -n "spawn-grants" packages/core/src packages/studio/src` → empty | [ ] |
| G9 | Every internal link that pointed at a route this plan deletes now points at the merged page | 0 matches for the old paths outside this plan's own new files | `rg -n "'/workspace\|/agents/approvals'\|/agents/runs\?agent" packages/studio/src --glob '!**/agents/**'` → empty | [ ] |
| G10 | The workspace typechecks | 0 errors | `bun run typecheck` → every package `OK` | [ ] |
| G11 | No forbidden word from plan 200 §2.4 appears in a file this plan creates or rewrites | 0 matches | `rg -n -i "\blease\b\|\bcluster\b\|co-control\|\bassist\b\|\bgrant\b" packages/studio/src/components/agents packages/studio/src/components/ai-elements` → empty (`deviceGrants`/`deviceGrantsOverride` are existing protocol field names, not new copy this plan writes — excluded by the word-boundary grep, which does not match inside `deviceGrants`) | [ ] |
| G12 | Owner smoke passes | 5 tabs load, an agent can be created/duplicated/deleted, an approval can be decided, a file can be opened and saved, a settings field can be changed and saved | §7.3, run by the owner | owner |

## 1. Goals

1. One page at `/agents` with a tab strip — Roster, Runs, Approvals, Files, Settings — replacing four separate routes (`/agents/approvals`, `/agents/runs`, `/agents/thread`, `/workspace`) plus the existing `/agents` list, while leaving `/agents/detail?id=` exactly where it is (MVP 13 A.6 lists `/agents/approvals`, `/agents/runs`, `/agents/thread`, `/workspace` as folding into this page; it does not list `/agents/detail`).
2. Files is the renamed Workspace (MVP 15 §0.1.2), moved wholesale with no functional change: the same tree, presenters, upload, rename, and compare-and-swap saves.
3. Settings renders `AgentSettingsSchema` (plan 212 §4.7) through the same schema-driven form renderer plan 219's Settings page uses (`SchemaForm` + `narrowSchema` + `SectionNav`), plus the two bespoke, non-schema sections — Connectors, Webhooks — that plan 212 §4.7 explicitly leaves for this plan to place.
4. Decide the `spawn-grants` routes (MVP 13 B.1): delete them. §3.5 states why.
5. Trim `components/ai-elements/*` to exactly what `Chat.tsx` imports (MVP 13 B.2), derived by reading `Chat.tsx`'s own import list, not guessed.
6. Finish the `lucide-react` removal plan 213 assigns to this plan (`docs/plans/213-mvp-studio-shell.md`'s own non-goals table: "Deleting `lucide-react` from `packages/studio/package.json` | plan 220 (plan 204 §10.2)") — this plan converts every icon in the agent subsystem (the one area of Studio no other 21x plan touches) to `@enkaku/ui`'s Phosphor set, then deletes the dependency.
7. Every place elsewhere in Studio that linked to a route this plan deletes is repointed at the merged page (§4.9).

## 2. Non-goals

| Not done here | Done by |
|---|---|
| The shell, the rail, `AGENTS_IN_RAIL`, `/agents`'s place in `nav.ts` | plan 213 (already shipped by the time this plan runs) |
| `AgentSettingsSchema`, `GET`/`PATCH /api/agents/settings`, the farm settings schema shrink | plan 212 (already shipped) |
| The agent runtime: run execution, approvals machinery, the capability broker, the tree/spawn state machine | already exists (`packages/core/src/agent/*`); untouched except the one `daemon.ts` wiring edit in §5.9 |
| `AskAnAgentDialog.tsx` | plan 216 deletes it outright (`docs/plans/216-mvp-action-dialogs.md:734`, `:937`) — this plan does not touch the file |
| The `/agents/detail` page's own Workbench/Settings feature set (identity, model, tools, access, limits) | already exists; this plan only fixes the three call sites in §4.8 that break once plan 212 lands |
| Rebuilding `EntityTabs`, `SectionNav`, or `SchemaForm` to match the handoff's literal pixel values | plan 204/213/219 own those primitives; this plan reuses them exactly as they exist today (§3.7) |
| A design for the workflow editor, Nodes, or any other MVP 15 §2 "undesigned" item that is not Agents | later plans, or the CEO (MVP 16 §4) |
| Deciding whether Agents is a fifth rail icon or a plugin-menu entry | plan 213 already shipped `AGENTS_IN_RAIL = true`; recorded as still-open in §9 per the brief's instruction, since plan 213's own header calls it open even though it shipped a default |

## 3. Context and design decisions

### 3.1 The honest design position

The design handoff (`docs/mvp/design_handoff_enkaku_openpf/README.md`) draws Devices, Device Control, Scripts & workflows, Jobs, Plugins, and Settings. It draws **no Agents screen** — confirmed by MVP 15 §2's own list of undesigned items ("Agents (Roster, Runs, Approvals, Files), if it stays a rail item") and by reading the README's own section headings (`## Screen: Devices` … `## Screen: Settings`, lines 78-446 — six screens, no seventh). This plan therefore does not invent a new visual language for Agents. Every layout decision below is a named borrowing from an existing handoff screen, cited by section and quoted line, or it is left as a question in §9. Nothing here is original composition.

| Agents element | Borrowed from | Handoff citation |
|---|---|---|
| The tab strip **is** the page header (no separate "Agents" title above it) | Jobs screen | README:326-328, "Jobs and batches share one page — same shape, different scope. The tab strip **is** the page header (no separate 'Jobs / N total' title above it)" |
| Roster table shape: a title cell with a chip-row sub-line, a status pill, a right-aligned action plus a `⋯` overflow so a row never clips | Plugins table | README:397-410, the Plugin/Status/Scripts/Verified/Actions columns and the `⋯` overflow "so the row never clips" |
| Runs tab: 268px left list with wrapping filter chips and a state-dot + name + indented sub-line row shape, paired with a right detail panel that has a header meta line and a button group pushed right | Jobs screen, left list and right detail | README:332-345, the exact `width: 268px` list and the header "meta line beneath ('job_8f21c4 · dev-011 · schedule · 20:40 · running 3m 08s', single line, ellipsized)" |
| Settings tab: two columns, a fixed-width left nav, a `max-width: 720px` right pane, section titles with a bottom border | Settings screen | README:414-429 |
| The in-tab header row (an intro paragraph plus a right-aligned "Add"/"New" button, no separate page title) used by Roster and by the Connectors/Webhooks settings sections | the pattern already live in `packages/studio/src/app/settings/page.tsx`'s `ConnectorsSection`/`WebhooksSection` (verified 2026-09-03, quoted in §4.6) | not a handoff screen — an existing Studio pattern this plan relocates verbatim, not a new invention |

What this plan does **not** borrow, because no handoff screen offers it and inventing one is out of scope: an icon for the Agents rail entry (plan 213 already shipped one, `RobotIcon`, §3.4 below), a colour or shape for an agent's own identity beyond what `AgentAvatar` already draws, and any layout for the per-agent Workbench/Settings screens (`/agents/detail`, unchanged by this plan).

### 3.2 What exists today, verified 2026-09-03

| File | Lines | What it is |
|---|---|---|
| `packages/studio/src/app/agents/page.tsx` | 389 | The roster list: table (Name, Model, Enabled, Devices, 14-day spend, Updated, row menu), New agent dialog, Delete confirmation with thread/run counts. `AgentsPage` at line 106. |
| `packages/studio/src/app/agents/detail/page.tsx` | 1015 | The per-agent Workbench (thread list + `Chat`) and Settings (Identity/Model/Instructions/Tools/Access/Limits/Connectors) tabs, `tab` read at line 172. **The brief that opened this task said 925 lines; the file on disk is 1015 — the file wins for facts (plan 200 §2.2).** Survives this plan almost unchanged (§4.8). |
| `packages/studio/src/app/agents/approvals/page.tsx` | 94 | The farm-wide pending-approvals inbox, `ApprovalsInboxPage` at line 29, polling `fetchPendingApprovals` every 20s. |
| `packages/studio/src/app/agents/runs/page.tsx` | 129 | Run history for **one** agent (`?agent=`), a flat table, `RunHistory` at line 36. |
| `packages/studio/src/app/agents/thread/page.tsx` | 47 | A pure redirect to `/agents/detail?id=&thread=`, kept only for old bookmarks (plan 66/67 vintage). |
| `packages/studio/src/app/workspace/page.tsx` | 692 | The virtual filesystem: tree/breadcrumbs, presenter-resolved viewer/editor, upload, rename, delete, publish-as-script, compare-and-swap saves. `WorkspaceView` at line 83. |
| `packages/studio/src/components/agent/Chat.tsx` | 618 | The workbench composer/transcript, `Chat` at line 145. Imports from `ai-elements` (§3.3) and reads farm agent defaults at line 245-249 (a call site this plan must fix, §4.8). |
| `packages/core/src/api/agents.ts` | 107 | `GET/POST/PATCH/DELETE /api/agents` plus `GET/POST /:id/spawn-grants` and `DELETE /:id/spawn-grants/:childId` (lines 66-89) — the routes §3.5 deletes. |
| `packages/core/src/api/workspace.ts` | 343 | The backend for Files — untouched by this plan; the move is Studio-only. |

### 3.3 `ai-elements` — the derived keep-list

`docs/mvp/13-removal-register.md` B.2 states the shape of the problem ("`Chat.tsx` imports about 30 of about 90 exports") without naming them. This plan names them, read directly off `Chat.tsx`'s own import block (lines 19-49, quoted below) and cross-checked against each source file's export list (verified 2026-09-03):

```ts
// Chat.tsx:19-27
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
// Chat.tsx:28-49
import {
  PromptInput, PromptInputButton, PromptInputCommand, PromptInputCommandEmpty, PromptInputCommandGroup,
  PromptInputCommandItem, PromptInputCommandList, PromptInputFooter, PromptInputProvider, PromptInputSelect,
  PromptInputSelectContent, PromptInputSelectItem, PromptInputSelectTrigger, PromptInputSelectValue,
  PromptInputSubmit, PromptInputTextarea, PromptInputTools, usePromptInputAttachments, usePromptInputController,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
```

| File | Total value exports today | Kept (in `Chat.tsx`'s import list) | Deleted |
|---|---|---|---|
| `conversation.tsx` | 6: `Conversation`, `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton`, `messagesToMarkdown`, `ConversationDownload` | 4 | `messagesToMarkdown`, `ConversationDownload` (and the private `getMessageText`/`defaultFormatMessage` helpers only they used) |
| `message.tsx` | 12: `Message`, `MessageContent`, `MessageActions`, `MessageAction`, `MessageBranch`, `MessageBranchContent`, `MessageBranchSelector`, `MessageBranchPrevious`, `MessageBranchNext`, `MessageBranchPage`, `MessageResponse`, `MessageToolbar` | 3: `Message`, `MessageContent`, `MessageResponse` | the other 9 (every `MessageAction*`/`MessageBranch*`/`MessageToolbar` export) |
| `prompt-input.tsx` | 40 (enumerated in §4.1) | 19 (the import list above, minus the type) | 21 |
| `reasoning.tsx` | 4: `useReasoning`, `Reasoning`, `ReasoningTrigger`, `ReasoningContent` | 3 exported (`Reasoning`, `ReasoningTrigger`, `ReasoningContent`) + `useReasoning` kept but made module-private (it is used internally by `ReasoningTrigger` at `reasoning.tsx:169`, just not imported by `Chat.tsx`) | nothing deleted; one export downgraded to private, per MVP 13 B.2's own rule for symbols "used only inside their own file" |
| `shimmer.tsx` | 1: `Shimmer` | 1 | nothing — the whole file is already exactly what `Chat.tsx` needs |

Total: `Chat.tsx` imports **29** named values plus 1 type (`PromptInputMessage`) across five files that together export **63** values before this plan and **30** after (29 kept + `useReasoning` downgraded, not deleted). This is the "about 30 of about 90" the removal register estimated, now exact — the register's "about 90" also counted every `*Props` type export, which this plan trims alongside its paired component (a `Props` type for a deleted component has no remaining caller).

### 3.4 `RobotIcon`, and the icon gap this plan closes

Plan 213 already writes, in `nav.ts` (`docs/plans/213-mvp-studio-shell.md:358`, `:393`):

```ts
import { CodeIcon, DevicesIcon, LightningIcon, PuzzlePieceIcon, RobotIcon, type Icon } from '@enkaku/ui'
```

`RobotIcon` is not in plan 204's `icons.ts` (verified 2026-09-03 against the plan's own complete Group 1/Group 2 export lists, `docs/plans/204-mvp-design-tokens-and-primitives.md:570-637`) — it is not a name the handoff's README uses, so Group 1 (derived from the README) correctly excludes it, and Group 2 ("drawn by the primitives") is not the right place for a nav icon either. Plan 213 references a name that does not yet exist anywhere in the workspace. This plan needs a robot/agent glyph regardless (the Roster empty state, `AgentAvatar`'s fallback), so it adds `RobotIcon` in §4.1's icon block — closing plan 213's dangling reference as a side effect, stated here so it reads as deliberate rather than accidental. This plan does not otherwise touch `nav.ts` or any other plan 213 file.

### 3.5 Deciding `spawn-grants`: deleted, not surfaced

`docs/mvp/13-removal-register.md` B.1: "`GET/POST/DELETE /api/agents/:id/spawn-grants` — API-only by plan 67; either gets a Studio surface on the compacted Agents page or is deleted." This plan deletes them (`packages/core/src/api/agents.ts:66-89`). Reasoning:

1. No MVP document — not MVP 06 §3's Roster/Runs/Approvals/Files/Settings list, not MVP 15 §2's undesigned-items list — names sub-agent spawn permissioning as part of the compacted page. Building a UI for it would be exactly the "invent a visual language the handoff does not have" mistake §3.1 rules out.
2. The routes have exactly one caller-shaped consumer today: nothing. `rg -n "spawn-grants" packages/studio/src` (verified 2026-09-03) returns zero matches — no Studio file has ever called them.
3. Deleting the routes does not touch runtime enforcement. `packages/core/src/agent/tree/store.ts:105`'s `canSpawn` (default: an agent may spawn none) is what the `agent.spawn` capability actually checks at `packages/core/src/agent/runner.ts:779`; `grantSpawn`/`revokeSpawn` are the only way to move a pair out of that default, and today they are reachable **only** through the routes this plan deletes. After this plan, `agent.spawn` stays exactly as usable as it is today (nobody could grant it from Studio before this plan either) — this is a routing simplification, not a capability regression.
4. `packages/core/src/daemon.ts:3248-3249` wires `tree: agentTreeStore` into `createAgentRoutes` **only** for these three routes (verified: `agentTreeStore` has a second, independent consumer at `daemon.ts:2609` that feeds the runner, unaffected by this deletion). Removing the routes lets `createAgentRoutes`' `tree` parameter, and the `mustGetTree()` helper that exists only to null-check it, go with them.

If a future plan wants this UI, `canSpawn`/`grantSpawn`/`revokeSpawn` are untouched and ready to be wired to a new route the moment a screen exists for it.

### 3.6 Why this plan is careful about `app/settings/page.tsx`

Plan 212 §4.7 (verified against the plan document, not yet executed against this tree): "connectors and webhooks already have their own REST endpoints (`/api/connectors`, `/api/webhooks`) and move only as Studio sections (plan 220)." Plan 219 rewrites `packages/studio/src/app/settings/page.tsx` wholesale (its own §4.5 "rewritten, complete outline" has no `ConnectorsSection`/`WebhooksSection` import at all) and does not mention connectors or webhooks anywhere in its document. Between the two, the only plan that ever names where this functionality ends up is this one.

Today (verified 2026-09-03), `ConnectorsSection` (`app/settings/page.tsx:594-764`) and `WebhooksSection` (`:774-947`) are the live implementation — full CRUD tables, add dialogs, test/toggle/remove actions. Plan 200 §8.1's merge order ("merge order within a stage follows the plan number") means plan 219 merges into `mvp` before plan 220 within stage 7, so by the time this plan's own commits land, `app/settings/page.tsx` will already be plan 219's rewrite and these two functions will already be gone from it. This plan therefore does not depend on finding them in the live file — §4.6 gives their complete relocated source, transcribed from today's verified content, as two new standalone files. If an executor runs this plan against a tree where plan 219 has not yet merged, the source is identical either way (this plan's own file, quoted from today's reading, is authoritative) and `app/settings/page.tsx`'s copy is simply deleted as dead weight once plan 219's rewrite supersedes it (not this plan's job to verify — plan 219 owns that file).

### 3.7 Reused primitives, not rebuilt

This plan reuses three existing Studio primitives exactly as they are, per its own non-goals (§2):

- **`EntityTabs`** (`packages/studio/src/components/layout/EntityTabs.tsx`, unedited) for the five-tab strip — the same `?tab=` URL-driven pattern already used by `/agents/detail`'s Workbench/Settings tabs (verified: `detail/page.tsx:405-412`). No action button lives in this strip (§3.1's Jobs citation: the tab strip has no trailing content in the handoff either); a tab-specific action (Roster's "New agent") lives inside that tab's own content, exactly where `ConnectorsSection`/`WebhooksSection` already put their own "Add" button (§4.6) — an existing Studio pattern, not a new one.
- **`SectionNav`** (`packages/studio/src/components/settings/SectionNav.tsx`, unedited) for the Settings tab's two-column layout, driven the same way plan 219's rewritten `app/settings/page.tsx` drives it (§4.5, mirroring `docs/plans/219-mvp-plugins-and-settings.md:748-757`'s outer-grid-plus-`SectionNav` pattern exactly, including its own stated reason for not widening `SectionNav`'s built-in grid).
- **`SchemaForm`** + **`narrowSchema`** (`packages/studio/src/components/schema-form/`, unedited) for the `defaults`/`scheduled` sections of `AgentSettingsSchema`.

## 4. Technical design

### 4.1 `packages/ui/src/icons.ts` (changed — additive)

Plan 204 owns this file; this plan touches it only because compiling requires icons neither Group 1 (derived from the handoff README, which draws no Agents screen) nor Group 2 (existing primitives) contains — the exception plan 200 §2.1 allows ("do not touch a file the plan does not name unless the plan's own step requires it to compile"). Appended after Group 2's closing `}` (verified against `docs/plans/204-mvp-design-tokens-and-primitives.md:637` — the file's last line before `packages/ui/src/index.ts`'s own edits):

```ts
/**
 * Group 3: Agents (plan 220). The design handoff draws no Agents screen
 * (MVP 15 §2), so these names are not derived from the README's `ph-*`
 * inventory the way Group 1 is, and `icons.test.ts`'s README-derived check
 * (plan 204 §3.7) only asserts Group 1 is a superset of the README's list —
 * it does not forbid a further export elsewhere in this file, so this block
 * does not fail it. Names are chosen for their literal Phosphor meaning and
 * verified against the installed `@phosphor-icons/react` package by
 * `bun run typecheck`: a name that does not exist in the package fails to
 * compile on this exact line, which is the check.
 */
export {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowSquareOutIcon,
  BrainIcon,
  CopyIcon,
  EyeSlashIcon,
  FloppyDiskIcon,
  ImageBrokenIcon,
  PaperPlaneRightIcon,
  PaperclipIcon,
  RobotIcon,
  RocketIcon,
} from '@phosphor-icons/react'
```

`PaperPlaneRightIcon` is the one name in this list not independently cross-checked against an installed copy of `@phosphor-icons/react` (none is installed in this tree as of 2026-09-03, since plan 204 has not run) — see §9 Q1.

### 4.2 Icon substitution table (complete — every `lucide-react` import this plan touches)

| File | Today (`lucide-react`) | Becomes (`@enkaku/ui`, from `icons.ts`) |
|---|---|---|
| `components/agents/RosterTab.tsx` (from `agents/page.tsx`) | `Bot, Copy, Inbox, MoreVertical, Plus, Trash2` | `RobotIcon, CopyIcon, TrayIcon, DotsThreeIcon, PlusIcon, TrashIcon` |
| `components/agents/ApprovalsTab.tsx` (from `agents/approvals/page.tsx`) | `Inbox` (`ArrowLeft` dropped — no back-link needed inside a tab) | `TrayIcon` |
| `components/agents/RunsTab.tsx` (new) | — | none needed beyond `Badge`'s own styling |
| `components/agents/FilesTab.tsx` (from `workspace/page.tsx`) | `Check, Download, FileCode2, Folder, FolderOpen, Loader2, Pencil, Plus, Rocket, Save, Trash2, Upload, X` | `CheckIcon, DownloadSimpleIcon, FileCodeIcon, FolderSimpleIcon, FolderSimpleIcon, CircleNotchIcon, PencilSimpleIcon, PlusIcon, RocketIcon, FloppyDiskIcon, TrashIcon, UploadSimpleIcon, XIcon` |
| `app/agents/detail/page.tsx` | `ArrowLeft, RotateCcw, Search` | `CaretLeftIcon, ArrowCounterClockwiseIcon, MagnifyingGlassIcon` |
| `components/agent/AgentAvatar.tsx` | `Bot` | `RobotIcon` |
| `components/agent/ToolCallCard.tsx` | `ChevronRight, EyeOff, ImageOff` | `CaretRightIcon, EyeSlashIcon, ImageBrokenIcon` |
| `components/agent/ChildRunCard.tsx` | `ChevronRight, SquareArrowOutUpRight` | `CaretRightIcon, ArrowSquareOutIcon` |
| `components/agent/ThreadList.tsx` | `MoreHorizontal, Trash2` | `DotsThreeIcon, TrashIcon` |
| `components/agent/ModelCombobox.tsx` | `Check, ChevronsUpDown` | `CheckIcon, CaretUpDownIcon` |
| `components/agent/Chat.tsx` | `Paperclip, X` | `PaperclipIcon, XIcon` |
| `components/ai-elements/conversation.tsx` | `ArrowDownIcon, DownloadIcon` (the second is deleted with `ConversationDownload`, §3.3) | `ArrowDownIcon` only |
| `components/ai-elements/reasoning.tsx` | `BrainIcon, ChevronDownIcon` | `BrainIcon, CaretDownIcon` |
| `components/ai-elements/prompt-input.tsx` | `CornerDownLeftIcon, ImageIcon, Monitor, PlusIcon, SquareIcon, XIcon` (only the first, `SquareIcon`, and `XIcon` survive the trim, §3.3 — the other three are used exclusively by deleted exports, verified at `prompt-input.tsx:423,468,1189`) | `PaperPlaneRightIcon, SquareIcon, XIcon` |

`MoreVertical` and `MoreHorizontal` both become `DotsThreeIcon` (Phosphor's horizontal three-dot glyph, matching the Plugins table's own `⋯` overflow, §3.1) — this plan does not add a vertical-dots variant.

`FolderSimpleIcon` is used for both the directory-row icon and the "no file open" empty-state icon in Files (today's `Folder`/`FolderOpen` distinction, §5.6 step 4) — one icon, two call sites, no new name added for the second.

### 4.3 `packages/studio/src/components/agents/AgentsPage.tsx` (new — the `Ships:` file, complete)

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ListAgentsResponseSchema } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { EntityTabs, type EntityTab } from '@/components/layout/EntityTabs'
import type { Agent } from '@/lib/agents'
import { fetchPendingApprovals, type ApprovalWithContext } from '@/lib/agent-approvals'
import { RosterTab } from './RosterTab'
import { RunsTab } from './RunsTab'
import { ApprovalsTab } from './ApprovalsTab'
import { FilesTab } from './FilesTab'
import { SettingsTab } from './SettingsTab'

const TABS: EntityTab[] = [
  { key: 'roster', label: 'Roster' },
  { key: 'runs', label: 'Runs' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'files', label: 'Files' },
  { key: 'settings', label: 'Settings' },
]

/**
 * `/agents` (plan 220) — Roster, Runs, Approvals, Files, and Settings on one
 * page, replacing `/agents` (roster only), `/agents/approvals`,
 * `/agents/runs`, `/agents/thread` (a redirect), and `/workspace`
 * (MVP 13 A.6). `/agents/detail?id=` is a SEPARATE, unaffected route — this
 * page is the roster and the farm-wide surfaces around it, not the per-agent
 * workbench.
 *
 * The tab strip is the page header (§3.1 — borrowed from the Jobs screen,
 * README:326-328): no `PageHeader`, no "Agents / N total" title. Roster and
 * Approvals carry a live count (agents on the farm; approvals pending right
 * now) fetched ONCE here and passed down, so the badge and the tab body never
 * disagree and never double the O(agents) / O(agents × threads) query cost
 * `lib/agents.ts` and `lib/agent-approvals.ts` already document.
 */
function AgentsScreen() {
  const router = useRouter()
  const tab = TABS.some((t) => t.key === useSearchParams().get('tab')) ? (useSearchParams().get('tab') as string) : 'roster'

  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const loadAgents = useCallback(() => {
    setAgentsError(null)
    api('/api/agents', ListAgentsResponseSchema)
      .then((b) => setAgents(b.agents))
      .catch((e) => setAgentsError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(loadAgents, [loadAgents])

  const [approvals, setApprovals] = useState<ApprovalWithContext[] | null>(null)
  const [approvalsError, setApprovalsError] = useState<string | null>(null)
  const loadApprovals = useCallback(() => {
    setApprovalsError(null)
    fetchPendingApprovals()
      .then(setApprovals)
      .catch((e) => setApprovalsError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(() => {
    loadApprovals()
    // Same 20s cadence as today's `/agents/approvals` (no farm-wide event exists — see
    // `lib/agent-approvals.ts`'s own doc comment for the backend gap this works around).
    const id = setInterval(loadApprovals, 20_000)
    return () => clearInterval(id)
  }, [loadApprovals])

  const tabs: EntityTab[] = TABS.map((t) =>
    t.key === 'roster' ? { ...t, count: agents?.length ?? null } : t.key === 'approvals' ? { ...t, count: approvals?.length ?? null } : t,
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EntityTabs tabs={tabs} active={tab} hrefFor={(k) => (k === 'roster' ? '/agents' : `/agents?tab=${k}`)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'roster' && <RosterTab agents={agents} error={agentsError} reload={loadAgents} onNavigate={(href) => router.push(href)} />}
        {tab === 'runs' && <RunsTab />}
        {tab === 'approvals' && <ApprovalsTab approvals={approvals} error={approvalsError} reload={loadApprovals} />}
        {tab === 'files' && <FilesTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  )
}

export default function AgentsPage() {
  return <AgentsScreen />
}
```

`AgentsScreen` does not wrap itself in `<Suspense>` the way `agents/runs/page.tsx` and `workspace/page.tsx` did individually, because the `app/agents/page.tsx` wrapper (§4.9) provides the one `Suspense` boundary `useSearchParams` needs for the whole page, matching `agents/detail/page.tsx`'s own top-level pattern (`AgentDetailPage` wraps `AgentDetail` once, not per-section).

### 4.4 `packages/studio/src/components/agents/RosterTab.tsx` (new, derived from `app/agents/page.tsx`)

Copy `app/agents/page.tsx:1-389` verbatim into this file, then apply exactly these edits:

1. **Delete** the `'use client'` directive is not needed here (the parent page already establishes the client boundary; keep it anyway — `RosterTab` still uses hooks directly and Next requires the directive on any file that does) — no change; keep `'use client'` at the top.
2. **Delete** lines corresponding to today's `PageHeader` import and the whole `<PageHeader title="Agents" ... />` block (today's lines 8, 195-221) — replace with the in-tab header row below.
3. **Change** the icon import (today's line 6) from `import { Bot, Copy, Inbox, MoreVertical, Plus, Trash2 } from 'lucide-react'` to `import { CopyIcon, DotsThreeIcon, PlusIcon, RobotIcon, TrashIcon } from '@enkaku/ui'` — `Inbox`/`TrayIcon` is dropped entirely: the Approvals link this component used to render (today's lines 200-207, `<Link href="/agents/approvals">`) is deleted outright, because Approvals is now a sibling tab in the SAME strip `AgentsPage` already renders, not a link this tab needs to draw.
4. **Change** the function signature from `export default function AgentsPage()` to `export function RosterTab({ agents, error, reload, onNavigate }: { agents: Agent[] | null; error: string | null; reload(): void; onNavigate(href: string): void })` — `agents`/`error`/`load` (renamed `reload`) are now props from `AgentsPage`, not local state; **delete** the local `const [agents, setAgents] = useState<Agent[] | null>(null)` and `const [error, setError] = useState<string | null>(null)` declarations and the local `load`/`useEffect(load, [])` pair (today's lines 108-109, 122-128) — every place the old code called `load()` after a mutation now calls `reload()` (the prop).
5. **Change** every `router.push(...)` call (today's lines 134, 166) to `onNavigate(...)` — this component takes no `next/navigation` import at all now; **delete** `import { useRouter } from 'next/navigation'` (today's line 5) and the local `const router = useRouter()` (today's line 107).
6. **Add**, replacing the deleted `PageHeader` block, this in-tab header — the same shape `ConnectorsSection` already uses (§4.6), not a new pattern:
   ```tsx
   <div className="mb-3 flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
     <p className="max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
       Stored, editable AI agents — model, tools, and what they may touch.
     </p>
     <Button
       onClick={() => {
         setName('')
         setSlug('')
         setSlugEdited(false)
         setOpen(true)
       }}
     >
       <PlusIcon className="size-3.5" aria-hidden />
       New agent
     </Button>
   </div>
   ```
   and remove the `px-5 py-4` wrapper's own top padding from the table/empty-state `<div>` immediately below it (today's line 223, `<div className="px-5 py-4">`) — becomes `<div className="px-5 pb-4">`, since the header row above now owns the top padding.
7. **Change** every `Bot` JSX usage (today's line 230, the empty-state icon) to `RobotIcon`; every `MoreVertical` (line 276) to `DotsThreeIcon`; every `Copy` (line 284) to `CopyIcon`; every `Trash2` (line 288) to `TrashIcon`.
8. **Do not** change any of the create/duplicate/delete logic, the table columns, the row menu, the New agent dialog, or the Delete confirmation dialog — every field, every label, every `run()`/`isPending()` call stays byte-identical. This step is a relocation plus a data-flow change (props instead of local state) plus an icon swap, nothing else.

### 4.5 `packages/studio/src/components/agents/ApprovalsTab.tsx` (new, derived from `app/agents/approvals/page.tsx`)

Copy `app/agents/approvals/page.tsx:1-94` verbatim, then:

1. **Delete** the `PageHeader` import and block (today's lines 7, 60-71) — including the "back to Agents" `meta` button, which has no purpose inside a tab.
2. **Delete** `import Link from 'next/link'` (today's line 4) and `ArrowLeft` from the icon import (today's line 5) — neither is used once the back-link is gone.
3. **Change** the icon import from `import { ArrowLeft, Inbox } from 'lucide-react'` to `import { TrayIcon } from '@enkaku/ui'`.
4. **Change** the function signature from `export default function ApprovalsInboxPage()` to `export function ApprovalsTab({ approvals: items, error, reload }: { approvals: ApprovalWithContext[] | null; error: string | null; reload(): void })` — **delete** the local `items`/`error` state and the local `load`/polling `useEffect` (today's lines 30-31, 34-48); every `load()` call becomes `reload()`.
5. **Change** the outer wrapper from a `<>...</>` fragment (today wrapped `PageHeader` + the content `div`) to just the content `div` (today's line 73's `<div className="mx-auto max-w-2xl space-y-3 px-5 py-4">`), now the top-level return.
6. **Change** the empty-state icon (today's line 79) from `<Inbox className="size-4" aria-hidden />` to `<TrayIcon className="size-4" aria-hidden />`.
7. **Do not** change `decide()`, the `useAction` usage, or `ApprovalCard`'s props — unchanged.

### 4.6 `packages/studio/src/components/agents/ConnectorsSettingsSection.tsx` and `WebhooksSettingsSection.tsx` (new, relocated verbatim from `app/settings/page.tsx`)

Transcribed from `app/settings/page.tsx:594-764` (`ConnectorsSection`) and `:774-947` (`WebhooksSection`), verified 2026-09-03. Each becomes its own file, function renamed to match the file (`ConnectorsSettingsSection`, `WebhooksSettingsSection`), with its own import block gathering only what it uses:

`ConnectorsSettingsSection.tsx`:
```tsx
'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { ConnectorResponseSchema, ConnectorTestResultSchema, ListConnectorsResponseSchema } from '@enkaku/protocol'
import {
  Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
  EmptyState, ErrorState, Input, Label, LoadingRows, Select, SelectContent, SelectItem, SelectTrigger,
  SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, api, useAction,
} from '@enkaku/ui'
import { PlusIcon } from '@enkaku/ui'
import type { Connector, ConnectorKind } from '@/lib/agents'

/**
 * Farm-level connectors (plan 65 §4.5). Relocated verbatim from
 * `app/settings/page.tsx`'s `ConnectorsSection` (plan 212 §4.7: "connectors
 * … move only as Studio sections (plan 220)") — logic and copy unchanged,
 * only the file and the exported name moved.
 */
export function ConnectorsSettingsSection() {
  // ... body identical to today's ConnectorsSection (app/settings/page.tsx:594-764)
}
```

`WebhooksSettingsSection.tsx` follows the identical pattern, importing `WebhookEndpointSchema`, `WebhooksResponseSchema`, `type WebhookEndpoint` from `@enkaku/protocol`, `relativeTime` alongside the other `@enkaku/ui` imports already listed above, plus a local `const WebhookEndpointResponseSchema = z.object({ endpoint: WebhookEndpointSchema })` (today's `app/settings/page.tsx:94`, which this file also needs since it is not exported from `@enkaku/protocol` itself).

Both files' JSX bodies are copied character-for-character from the ranges cited above — no field, label, dialog copy, or request shape changes. The only edits are: the function name (matching the file), the import block (pruned to what each file alone uses, since the two sections no longer share a module scope), and — for both — `Plus` (lucide) becomes `PlusIcon` (`@enkaku/ui`, §4.2's table does not list these because they were not previously counted against the agent subsystem's own icon set, but the same substitution applies since both files import from `lucide-react` today).

### 4.7 `packages/studio/src/components/agents/SettingsTab.tsx` (new, complete)

```tsx
'use client'

import { useEffect, useState } from 'react'
import { AgentSettingsResponseSchema, UpdateAgentSettingsResponseSchema } from '@enkaku/protocol'
import { ErrorState, LoadingRows, api, useAction } from '@enkaku/ui'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { ConnectorsSettingsSection } from './ConnectorsSettingsSection'
import { WebhooksSettingsSection } from './WebhooksSettingsSection'

/**
 * The Agents page's Settings tab (plan 212 §4.7, plan 220 §1 goal 3):
 * `AgentSettingsSchema`'s two schema-backed sections (`defaults`,
 * `scheduled`) through the same `SchemaForm`/`narrowSchema` pipeline plan
 * 219's farm Settings page uses, plus the two bespoke, non-schema sections
 * (Connectors, Webhooks) plan 212 leaves for this plan to place. The
 * two-column outer grid mirrors `docs/plans/219-mvp-plugins-and-settings.md`
 * §4.5's own outline exactly, including its stated reason for not widening
 * `SectionNav`'s built-in grid (the handoff's Settings screen has no
 * responsive collapse — plan 213 §2's non-goal).
 */
export function SettingsTab() {
  const [tab, setTab] = useState('defaults')
  const [data, setData] = useState<{ settings: unknown; schema: unknown } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<unknown>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/agents/settings', AgentSettingsResponseSchema)
      .then((b) => {
        setData(b)
        setDraft(b.settings)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const save = () =>
    run('save', () => api('/api/agents/settings', UpdateAgentSettingsResponseSchema, { method: 'PATCH', json: draft }), {
      success: 'Agent settings saved',
      failure: 'Could not save agent settings',
      onSuccess: (b) => {
        setData((d) => (d ? { ...d, settings: b.settings } : d))
        setDraft(b.settings)
        setServerErrors({})
      },
    })

  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (data === null || draft === null) return <div className="px-5 py-4"><LoadingRows rows={4} /></div>

  const sections: SettingsSection[] = [
    {
      id: 'defaults',
      title: 'Defaults',
      render: () => (
        <SchemaForm
          schema={narrowSchema(data.schema as never, ['defaults'])}
          value={draft}
          onChange={setDraft}
          serverErrors={serverErrors}
          onSubmit={save}
          onReset={() => setDraft(data.settings)}
          busy={isPending('save')}
          dirty={JSON.stringify(draft) !== JSON.stringify(data.settings)}
        />
      ),
    },
    {
      id: 'scheduled',
      title: 'Scheduled agents',
      render: () => (
        <SchemaForm
          schema={narrowSchema(data.schema as never, ['scheduled'])}
          value={draft}
          onChange={setDraft}
          serverErrors={serverErrors}
          onSubmit={save}
          onReset={() => setDraft(data.settings)}
          busy={isPending('save')}
          dirty={JSON.stringify(draft) !== JSON.stringify(data.settings)}
        />
      ),
    },
    { id: 'connectors', title: 'Connectors', render: () => <ConnectorsSettingsSection /> },
    { id: 'webhooks', title: 'Webhooks', render: () => <WebhooksSettingsSection /> },
  ]

  return (
    <div className="grid grid-cols-[236px_1fr] gap-0 border-t border-line">
      <div className="border-r border-line px-2.5 py-3 pb-4">
        <SectionNav sections={sections} active={tab} onChange={setTab} />
      </div>
      <div className="max-w-[720px] px-[22px] pt-[18px] pb-7">{sections.find((s) => s.id === tab)?.render() ?? sections[0]?.render()}</div>
    </div>
  )
}
```

`workspaceScope`/agent-record-level Workspace settings (MVP 12 §5's "workspace" item) are **not** rendered here: MVP 12 §5 itself says workspace "become[s] constants" — nothing of it stays a stored, editable field, so there is nothing for this tab to render for it. `Spend` and `scheduled-run limits` (MVP 12 §5's other two named items) are the `scheduled` section above (`AgentSettingsSchema.scheduled`, plan 212 §4.7: `spendCapOutputTokensPer24h`, `maxConcurrentScheduledRuns`).

### 4.8 `app/agents/detail/page.tsx` — three call-site fixes plus the icon swap (changed, not rewritten)

Verified against the file read 2026-09-03 (1015 lines total):

1. **`:196-199`**, today:
   ```ts
   api('/api/settings', SettingsResponseSchema)
     .then((b) => setFarmDefaults(b.settings.agentDefaults))
     .catch(() => undefined)
   ```
   becomes:
   ```ts
   api('/api/agents/settings', AgentSettingsResponseSchema)
     .then((b) => setFarmDefaults(b.settings.defaults))
     .catch(() => undefined)
   ```
   — `agentDefaults` moved off `FarmSettingsSchema` onto `AgentSettingsSchema.defaults` (plan 212 §4.7). Import `AgentSettingsResponseSchema` from `@enkaku/protocol` alongside the existing imports (line 17's `SettingsResponseSchema` import is otherwise still needed elsewhere on this page — **do not** delete it wholesale; only add the new import beside it).
2. **`:342`**, today: `<Link href={`/agents/runs?agent=${id}`}>Runs</Link>` becomes `<Link href={`/agents?tab=runs&agent=${id}`}>Runs</Link>` — `RunsTab` reads an optional `?agent=` to pre-filter to one agent (§4.10 step 6).
3. **`:1002-1004`**, today (inside `ConnectorsSection`, the per-agent Settings tab's read-only connector list):
   ```tsx
   <Button asChild variant="outline" size="sm">
     <Link href="/settings?tab=connectors">Manage connectors in Settings</Link>
   </Button>
   ```
   becomes:
   ```tsx
   <Button asChild variant="outline" size="sm">
     <Link href="/agents?tab=settings">Manage connectors in Settings</Link>
   </Button>
   ```
   — connectors are no longer on the farm Settings page at all (§3.6); the Agents page's own Settings tab is where they live now. (This file's own `ConnectorsSection` at line 980, the read-only per-agent view, is a **different** component from the new `ConnectorsSettingsSection.tsx` §4.6 creates — same name coincidence, two different files, **do not** merge them; this one stays exactly as it is apart from the one link.)
4. **`:6`**, icon import: `import { ArrowLeft, RotateCcw, Search } from 'lucide-react'` becomes `import { ArrowCounterClockwiseIcon, CaretLeftIcon, MagnifyingGlassIcon } from '@enkaku/ui'`; the three JSX usages (`:100`, `:337`, `:845`) are renamed to match, with no other change.

### 4.9 `app/agents/page.tsx` (rewritten — thin wrapper) and route deletions

```tsx
'use client'

import { Suspense } from 'react'
import { LoadingRows } from '@enkaku/ui'
import AgentsPage from '@/components/agents/AgentsPage'

export default function Page() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <AgentsPage />
    </Suspense>
  )
}
```

Delete, as directories: `app/agents/approvals/`, `app/agents/runs/`, `app/agents/thread/`, `app/workspace/` (four `page.tsx` files and their already-vestigial `page.test.tsx` siblings, if plan 201 has not already removed the latter — check with `test -e` before deleting; do not error if already gone).

### 4.10 `packages/studio/src/components/agents/RunsTab.tsx` (new, complete)

Farm-wide, not per-agent (today's `/agents/runs?agent=` was scoped to one agent; §3.1 borrows the Jobs screen's left-list/right-detail shape, which is inherently farm-wide). Composed client-side for the same reason `lib/agent-approvals.ts` is (verified: no `GET /api/v1/runs?…` farm-wide list endpoint exists today) — bounded and stated plainly, not silently worked around, matching that file's own comment style.

`packages/studio/src/lib/agent-runs.ts` gains one new export (the file's existing `latestRunId`/`runIdsForThread`/`fetchRecentRuns` are unchanged):

```ts
export interface RunWithAgent {
  run: AgentRun
  agentId: string
  agentName: string
}

/**
 * Every run across every agent, most recently started first, bounded the
 * same way `fetchRecentRuns` already is (plan 69) — `maxThreadsPerAgent`
 * threads per agent, `maxTotal` runs returned overall. THE GAP, RECORDED
 * RATHER THAN WORKED AROUND SILENTLY (matching `agent-approvals.ts`'s own
 * documented gap): no farm-wide "list runs" endpoint exists, so this is
 * O(agents) list-threads calls plus O(threads) message-history calls plus
 * O(runs) individual run reads. A `pendingApprovals()`-shaped fix belongs in
 * a future plan (a real query on the run store plus a REST route), not here.
 */
export async function fetchAllRuns(opts?: { maxThreadsPerAgent?: number; maxTotal?: number }): Promise<{ runs: RunWithAgent[]; truncated: boolean }> {
  const maxTotal = opts?.maxTotal ?? 200
  const { agents } = await api('/api/agents', ListAgentsResponseSchema)
  const perAgent = await Promise.all(
    agents.map(async (a) => {
      const { runs } = await fetchRecentRuns(a.id, { maxThreads: opts?.maxThreadsPerAgent ?? 10 }).catch(() => ({ runs: [] as AgentRun[] }))
      return runs.map((run) => ({ run, agentId: a.id, agentName: a.name }))
    }),
  )
  const all = perAgent.flat().sort((a, b) => (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0))
  return { runs: all.slice(0, maxTotal), truncated: all.length > maxTotal }
}
```

(`ListAgentsResponseSchema` and `api` join this file's existing imports; `AgentRun` is already imported.)

`RunsTab.tsx`:

```tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { AgentRunStatus } from '@enkaku/protocol'
import { Badge, Button, EmptyState, ErrorState, LoadingRows, cn, duration, formatUsd, relativeTime } from '@enkaku/ui'
import { UsageBadge } from '@/components/agent/UsageBadge'
import { fetchAllRuns, type RunWithAgent } from '@/lib/agent-runs'

const CHIPS: { key: 'all' | AgentRunStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'succeeded', label: 'Succeeded' },
  { key: 'failed', label: 'Failed' },
]

const DOT: Record<AgentRunStatus, string> = {
  queued: 'bg-fg-subtle',
  running: 'bg-led-warn animate-enkaku-pulse',
  paused: 'bg-led-warn',
  succeeded: 'bg-led-ok',
  failed: 'bg-led-danger',
  cancelled: 'bg-fg-subtle',
}

/**
 * Runs, farm-wide (plan 220 §4.10). Layout borrowed from the Jobs screen
 * (§3.1): a 268px left list with wrapping filter chips and a state-dot +
 * name + indented sub-line row, a right detail panel with a header meta
 * line and a right-pushed button group. `?agent=` (from `/agents/detail`'s
 * own Runs link) pre-filters the list to one agent without changing the
 * tab's own farm-wide default.
 */
export function RunsTab() {
  const agentFilter = useSearchParams().get('agent')
  const [data, setData] = useState<{ runs: RunWithAgent[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<(typeof CHIPS)[number]['key']>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = () => {
    setError(null)
    fetchAllRuns()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const scoped = useMemo(() => {
    const base = data?.runs ?? []
    const byAgent = agentFilter ? base.filter((r) => r.agentId === agentFilter) : base
    return filter === 'all' ? byAgent : byAgent.filter((r) => r.run.status === filter)
  }, [data, agentFilter, filter])

  const counts = useMemo(() => {
    const base = agentFilter ? (data?.runs ?? []).filter((r) => r.agentId === agentFilter) : data?.runs ?? []
    return CHIPS.map((c) => ({ ...c, n: c.key === 'all' ? base.length : base.filter((r) => r.run.status === c.key).length }))
  }, [data, agentFilter])

  const selected = scoped.find((r) => r.run.id === selectedId) ?? scoped[0] ?? null

  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (data === null) return <div className="px-5 py-4"><LoadingRows rows={4} /></div>

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[268px] shrink-0 flex-col border-r border-line">
        <div className="flex flex-wrap gap-1.5 border-b border-line p-2.5">
          {counts.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={cn('rounded-lg px-2.5 py-1 text-[11.5px]', filter === c.key ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2')}
            >
              {c.label} <span className="readout">{c.n}</span>
            </button>
          ))}
        </div>
        {scoped.length === 0 ? (
          <div className="p-4"><EmptyState title="No runs" description="A run appears here once an agent has been sent a message, or a schedule has fired it." /></div>
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {scoped.map((r) => (
              <li key={r.run.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.run.id)}
                  className={cn('flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left', selected?.run.id === r.run.id ? 'bg-accent-soft' : 'hover:bg-surface-2')}
                >
                  <span className="flex items-center gap-1.5">
                    <span className={cn('size-1.5 shrink-0 rounded-full', DOT[r.run.status])} aria-hidden />
                    <span className="readout text-[12px]">{r.agentName}</span>
                  </span>
                  <span className="pl-3 text-[11px] text-fg-subtle">
                    {r.run.status}
                    {r.run.stopReason ? ` · ${r.run.stopReason}` : ''} · {relativeTime(r.run.startedAt ?? 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {selected === null ? (
          <EmptyState title="No run selected" description="Pick one from the list." />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[15px] font-medium">{selected.agentName}</h2>
                  <Badge variant={selected.run.status === 'failed' ? 'destructive' : ['succeeded', 'cancelled'].includes(selected.run.status) ? 'secondary' : 'default'}>{selected.run.status}</Badge>
                </div>
                <p className="readout mt-0.5 text-[12px] text-fg-muted">
                  {selected.run.id} · {selected.run.steps} step{selected.run.steps === 1 ? '' : 's'} · {duration(selected.run.startedAt, selected.run.finishedAt)}
                </p>
              </div>
              <Button asChild size="sm">
                <Link href={`/agents/detail?id=${selected.agentId}&thread=${selected.run.threadId}`}>Open thread</Link>
              </Button>
            </div>
            {selected.run.stopReason && <p className="text-[12.5px] text-fg-muted">stop reason: {selected.run.stopReason}</p>}
            {selected.run.errorClass && <p className="text-[12.5px] text-led-danger">error: {selected.run.errorClass}</p>}
            {selected.run.usage && <UsageBadge usage={selected.run.usage} />}
            {selected.run.usage && <p className="text-[11.5px] text-fg-subtle">total {formatUsd(selected.run.usage.costUsd)}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
```

### 4.11 `packages/studio/src/components/agents/FilesTab.tsx` (new, derived from `app/workspace/page.tsx`)

Copy `app/workspace/page.tsx:1-692` verbatim, then:

1. **Delete** the `PageHeader` import and the `<PageHeader title="Workspace" description="..." />` block (today's lines 6, 373-376) — the tab strip is the header (§3.1).
2. **Change** the icon import (today's line 5) from `import { Check, Download, FileCode2, Folder, FolderOpen, Loader2, Pencil, Plus, Rocket, Save, Trash2, Upload, X } from 'lucide-react'` to `import { CheckIcon, DownloadSimpleIcon, FileCodeIcon, FolderSimpleIcon, CircleNotchIcon, PencilSimpleIcon, PlusIcon, RocketIcon, FloppyDiskIcon, TrashIcon, UploadSimpleIcon, XIcon } from '@enkaku/ui'` and rename every JSX usage to match (`Check→CheckIcon`, `Download→DownloadSimpleIcon`, `FileCode2→FileCodeIcon`, `Folder→FolderSimpleIcon`, `FolderOpen→FolderSimpleIcon`, `Loader2→CircleNotchIcon` with its `animate-spin` class becoming `animate-enkaku-spin`, `Pencil→PencilSimpleIcon`, `Plus→PlusIcon`, `Rocket→RocketIcon`, `Save→FloppyDiskIcon`, `Trash2→TrashIcon`, `Upload→UploadSimpleIcon`, `X→XIcon`).
3. **Change** the function signature from `function WorkspaceView()` to `export function FilesTab()`, and **delete** the bottom `export default function WorkspacePage() { return <Suspense>...<WorkspaceView /></Suspense> }` wrapper (today's lines 686-692) entirely — `AgentsPage`'s single `Suspense` boundary (via `app/agents/page.tsx`, §4.9) already covers it, and `useSearchParams`/`useRouter` (both still used, for the `?path=` deep link) resolve inside that shared boundary the same way every other tab's own `useSearchParams` call does.
4. **Change** every `router.push('/workspace...')` / `router.push(\`/workspace?path=...\`)` (today's lines 183, 279, 298) to carry `tab=files` alongside `path`: `router.push(\`/agents?tab=files&path=${encodeURIComponent(path)}\`)` (and the bare case, line 298, becomes `router.push('/agents?tab=files')`).
5. **Change** the deep-link read (today's line 170, `const initial = params.get('path')`) — unchanged, `params` still comes from `useSearchParams()` on the same page, `path` still resolves the same way.
6. **Do not** change `resolvePresenter`, any `lib/workspace.ts` call, the publish-as-script flow, or the compare-and-swap save logic — the backend (`packages/core/src/api/workspace.ts`) is untouched by this plan (§3.2), so none of it needs to change.

### 4.12 `packages/studio/src/components/agent/ContextPanel.tsx` (changed)

`:96-110` today (verified):

```tsx
<Section title="Workspace" hint={`/agents/${agent.slug}/`}>
  ...
  <Link href={`/workspace?path=${encodeURIComponent(`/agents/${agent.slug}/`)}`} className="mt-1.5 inline-block text-[11.5px] text-accent hover:underline">
    Open in Workspace
  </Link>
</Section>
```

becomes:

```tsx
<Section title="Files" hint={`/agents/${agent.slug}/`}>
  ...
  <Link href={`/agents?tab=files&path=${encodeURIComponent(`/agents/${agent.slug}/`)}`} className="mt-1.5 inline-block text-[11.5px] text-accent hover:underline">
    Open in Files
  </Link>
</Section>
```

(`Section title="Workspace"` → `"Files"`, the link's `href`, and its label text — three edits, nothing else in this file changes; the body between them, read-only/write scope lists, is untouched.)

### 4.13 Small icon-only edits (changed, no logic change)

| File | Edit |
|---|---|
| `components/agent/AgentAvatar.tsx` | `:1` `import { Bot } from 'lucide-react'` → `import { RobotIcon } from '@enkaku/ui'`; `:19` `<Bot className="size-3" />` → `<RobotIcon className="size-3" />` |
| `components/agent/ToolCallCard.tsx` | `:4` `import { ChevronRight, EyeOff, ImageOff } from 'lucide-react'` → `import { CaretRightIcon, EyeSlashIcon, ImageBrokenIcon } from '@enkaku/ui'`; `:45,77,84` rename to match |
| `components/agent/ChildRunCard.tsx` | `:2` `import { ChevronRight, SquareArrowOutUpRight } from 'lucide-react'` → `import { CaretRightIcon, ArrowSquareOutIcon } from '@enkaku/ui'`; `:38,55` rename to match |
| `components/agent/ThreadList.tsx` | `:5` `import { MoreHorizontal, Trash2 } from 'lucide-react'` → `import { DotsThreeIcon, TrashIcon } from '@enkaku/ui'`; `:115,126` rename to match |
| `components/agent/ModelCombobox.tsx` | `:4` `import { Check, ChevronsUpDown } from 'lucide-react'` → `import { CheckIcon, CaretUpDownIcon } from '@enkaku/ui'`; `:67,92` rename to match |
| `components/agent/Chat.tsx` | `:4` `import { Paperclip, X } from 'lucide-react'` → `import { PaperclipIcon, XIcon } from '@enkaku/ui'`; JSX at `:516` (`<Paperclip>`) and `:536` (`<X>`) rename to match |

### 4.14 `packages/studio/src/components/agent/Chat.tsx` — the second `agentDefaults` call site

`:245-249` today:

```ts
useEffect(() => {
  void api('/api/settings', SettingsResponseSchema)
    .then((b) => setFarmDefaults(b.settings.agentDefaults))
    .catch((e) => setBackgroundError(`Farm defaults failed to load — ${e instanceof Error ? e.message : String(e)}`))
}, [])
```

becomes:

```ts
useEffect(() => {
  void api('/api/agents/settings', AgentSettingsResponseSchema)
    .then((b) => setFarmDefaults(b.settings.defaults))
    .catch((e) => setBackgroundError(`Farm defaults failed to load — ${e instanceof Error ? e.message : String(e)}`))
}, [])
```

Add `AgentSettingsResponseSchema` to the existing `@enkaku/protocol` import block (`:8-18`); `SettingsResponseSchema` is otherwise unused in this file after this edit — **delete** it from that same import list (verified: `rg -n "SettingsResponseSchema" packages/studio/src/components/agent/Chat.tsx` today shows exactly this one use).

### 4.15 `packages/core/src/api/agents.ts` (changed — deletion)

Delete lines 66-89 (the three `spawn-grants` routes) and the `mustGetTree` helper (`:28-31`) it alone served. The function signature (`:24`) drops `tree`:

```ts
export function createAgentRoutes(deps: { store: AgentStore; audit: AuditLogger }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { store, audit } = deps
  // mustGetTree() and every /spawn-grants route deleted (plan 220 §3.5) — the
  // capability's own runtime gate (packages/core/src/agent/tree/store.ts's
  // canSpawn) is untouched; only this HTTP surface, which had no caller, goes.
  ...
```

Delete the now-unused `import type { TreeStore } from '../agent/tree/store'` (`:8`) and the `import { z } from 'zod'` (`:2`) if nothing else in the file uses `z` after the deletion (verified: the file's only other `z` reference was the spawn-grants body schema at `:75`, so this import goes too). Delete the doc comment paragraph about `/:id/spawn-grants` (`:19-22`).

### 4.16 `packages/core/src/daemon.ts` (changed — one wiring line)

`:3248-3249` today:

```ts
// `tree: agentTreeStore` (plan 67 §4.1) backs `/:id/spawn-grants`.
agentRoutes: createAgentRoutes({ store: agentStore, tree: agentTreeStore, audit }),
```

becomes:

```ts
agentRoutes: createAgentRoutes({ store: agentStore, audit }),
```

`agentTreeStore` itself (`:2582`) and its other wiring into the runner (`:2609`, unrelated to this route) are untouched.

### 4.17 `scripts/check-routes.ts` (changed — one row pruned)

Plan 213 creates this file with a `PENDING_REMOVAL` map including `'/workspace': 'plan 220: Workspace is renamed Files and lives under Agents (MVP 15 §0.1.2)'`. This plan deletes exactly that one entry:

```ts
const PENDING_REMOVAL: Record<string, string> = {
  '/device': 'plan 215: Device Control is the device surface; the device page and its route go (MVP 15 §1)',
  '/groups': 'plan 214: groups are managed from the Devices tab strip; no dedicated page (MVP 15 §0.1.3)',
  '/nodes': 'plan 214: Nodes becomes a Devices tab, shown only in orchestrator mode (MVP 03 §1.1)',
  '/workflows': 'plan 217: second tab of Scripts & workflows (MVP 03 §1)',
  '/schedules': 'plan 217: third tab of Scripts & workflows (MVP 15 §0.1.1)',
  '/batches': 'plan 218: second tab of Jobs (MVP 15 §1)',
  '/tools': 'plan 219: Toolchain section of Settings (MVP 03 §1.1)',
  // '/workspace' row deleted (plan 220) — the route it excused no longer exists.
}
```

**Do not** touch any other row — `/device`, `/groups`, `/nodes`, `/workflows`, `/schedules`, `/batches`, `/tools` belong to plans 214/215/217/218/219 and are pruned by them, not this plan, per plan 200 §2.1 ("do not touch a file the plan does not name unless required to compile"). If this plan executes before one of those other plans has landed, its own row stays and `check-routes.ts` continues to pass for it — this plan's own step only ever removes the one row it owns.

## 5. Implementation steps

### 220.1 — Icons: extend `packages/ui/src/icons.ts`

- Files changed: `packages/ui/src/icons.ts`.
- Test file: none (Studio/`@enkaku/ui` has zero tests, plan 200 §8.3).
- Verifiable result: `bun run typecheck` clean after this step alone (the new names are unused until later steps import them, which is not an error).
- Do not: add these names to Group 1 (they are not in the handoff README) or rename an existing Group 1/2 export.

### 220.2 — `ai-elements`: trim `conversation.tsx`

- Files changed: `packages/studio/src/components/ai-elements/conversation.tsx` — delete lines 102-167 (`getMessageText`, `ConversationDownloadProps`, `defaultFormatMessage`, `messagesToMarkdown`, `ConversationDownload`); change the icon import (`:5`) from `import { ArrowDownIcon, DownloadIcon } from "lucide-react"` to `import { ArrowDownIcon } from '@enkaku/ui'`; delete the now-unused `import type { UIMessage } from "ai"` (`:4`, verified: only `getMessageText`/`ConversationDownloadProps` used it).
- Test file: none.
- Verifiable result: `rg -n "^export " packages/studio/src/components/ai-elements/conversation.tsx` → exactly 4 value-export lines (`Conversation`, `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton`) plus their 4 `*Props` type exports, 8 lines total.
- Do not: touch `ConversationContent`, `ConversationEmptyState`, or their `Props` types.

### 220.3 — `ai-elements`: trim `message.tsx`

- Files changed: `packages/studio/src/components/ai-elements/message.tsx` — delete every `MessageAction*`, `MessageBranch*`, and `MessageToolbar` export and its `Props` type (today's lines 66-318 except the kept `MessageContentProps`/`MessageContent` at 46-64 and `MessageResponseProps`/`MessageResponse` at 320-347 — keep `Message`/`MessageProps` at 31-44 too); no icon import exists in this file to remove (verified: `message.tsx`'s only icons, `ChevronLeftIcon`/`ChevronRightIcon`, are used exclusively inside the deleted `MessageBranchPrevious`/`MessageBranchNext`, so the whole `from "lucide-react"` import line goes with them).
- Test file: none.
- Verifiable result: `rg -n "^export " packages/studio/src/components/ai-elements/message.tsx` → 3 value exports (`Message`, `MessageContent`, `MessageResponse`) plus their 3 `Props` types, 6 lines; `rg -n "lucide-react" packages/studio/src/components/ai-elements/message.tsx` → empty.
- Do not: keep `MessageActions`/`MessageAction` "just in case" — nothing imports them.

### 220.4 — `ai-elements`: trim `prompt-input.tsx`

- Files changed: `packages/studio/src/components/ai-elements/prompt-input.tsx` — delete every export not in §3.3's 19-item keep-list (and its `Props` type): `useProviderAttachments`, `LocalReferencedSourcesContext`, `usePromptInputReferencedSources`, `PromptInputActionAddAttachments(+Props)`, `PromptInputActionAddScreenshot(+Props)`, `PromptInputBody(+Props)`, `PromptInputHeader(+Props)`, `PromptInputActionMenu(+Props)`, `PromptInputActionMenuTrigger(+Props)`, `PromptInputActionMenuContent(+Props)`, `PromptInputActionMenuItem(+Props)`, `PromptInputHoverCard(+Props)`, `PromptInputHoverCardTrigger(+Props)`, `PromptInputHoverCardContent(+Props)`, `PromptInputTabsList(+Props)`, `PromptInputTab(+Props)`, `PromptInputTabLabel(+Props)`, `PromptInputTabBody(+Props)`, `PromptInputTabItem(+Props)`, `PromptInputCommandInput(+Props)`, `PromptInputCommandSeparator(+Props)`; also delete `AttachmentsContext`, `TextInputContext`, `PromptInputControllerProps`, `ReferencedSourcesContext`, `PromptInputProviderProps`, `PromptInputProps`, `PromptInputToolsProps`, `PromptInputButtonTooltip`, `PromptInputButtonProps`'s unused half if any type-only export has no remaining referrer once its component is gone (verify with `bun run typecheck`, which fails loudly on an orphaned type reference, not silently). Change the icon import (`:34-41`) from `CornerDownLeftIcon, ImageIcon, Monitor, PlusIcon, SquareIcon, XIcon` (lucide) to `PaperPlaneRightIcon, SquareIcon, XIcon` (`@enkaku/ui`) and rename the three surviving JSX usages inside `PromptInputSubmit` (today's `:1234-1241`).
- Test file: none.
- Verifiable result: `rg -c "^export " packages/studio/src/components/ai-elements/prompt-input.tsx` → 38 (19 value exports + 19 paired `Props`/interface types — `PromptInputMessage` itself is one of the 19 already, so this is 18 components × 2 plus the bare `PromptInputMessage` interface plus `usePromptInputController`/`usePromptInputAttachments`, which have no separate `Props` type — recompute exactly against the kept list rather than trust this number blindly, and record the actual count in §11); `bun run typecheck` clean.
- Do not: delete `usePromptInputController` or `usePromptInputAttachments` — both are directly imported by `Chat.tsx`.

### 220.5 — `ai-elements`: `reasoning.tsx` icon swap, `useReasoning` made private

- Files changed: `packages/studio/src/components/ai-elements/reasoning.tsx` — change `:9` `import { BrainIcon, ChevronDownIcon } from "lucide-react"` to `import { BrainIcon, CaretDownIcon } from '@enkaku/ui'` and rename the JSX usage; remove the `export` keyword from `:34`'s `useReasoning` (`export const useReasoning` → `const useReasoning`) — it is used only within this file (`:169`), per MVP 13 B.2's rule for such symbols.
- Test file: none.
- Verifiable result: `rg -n "^export const useReasoning" packages/studio/src/components/ai-elements/reasoning.tsx` → empty; `rg -n "^const useReasoning" ...` → 1 line; `bun run typecheck` clean.
- Do not: delete `useReasoning` — `ReasoningTrigger` calls it.

### 220.6 — Agent-subsystem icon swaps (six small files)

- Files changed: `components/agent/AgentAvatar.tsx`, `ToolCallCard.tsx`, `ChildRunCard.tsx`, `ThreadList.tsx`, `ModelCombobox.tsx`, `Chat.tsx` — exactly the edits in §4.13.
- Test file: none.
- Verifiable result: `rg -l "from 'lucide-react'" packages/studio/src/components/agent` → empty.
- Do not: change any non-icon logic in these six files in this step.

### 220.7 — `Chat.tsx` and `agents/detail/page.tsx`: the `agentDefaults` call-site fixes

- Files changed: `components/agent/Chat.tsx` (§4.14), `app/agents/detail/page.tsx` (§4.8 items 1 and 4).
- Test file: none.
- Verifiable result: `rg -n "settings.agentDefaults" packages/studio/src` → empty; `rg -n "'/api/settings'" packages/studio/src/components/agent/Chat.tsx packages/studio/src/app/agents/detail/page.tsx` → empty (both now call `/api/agents/settings` for the agent-defaults read; `agents/detail/page.tsx` may still call plain `/api/settings` for something unrelated — verify none remains for `agentDefaults` specifically, not that the route string never appears at all).
- Do not: touch any of the seven `SectionCard` components in `agents/detail/page.tsx` beyond the two named edits.

### 220.8 — `agents/detail/page.tsx`: the Runs link and the Connectors link

- Files changed: `app/agents/detail/page.tsx` (§4.8 items 2 and 3).
- Test file: none.
- Verifiable result: `rg -n "agents/runs\|settings\?tab=connectors" packages/studio/src/app/agents/detail/page.tsx` → empty.
- Do not: change the per-agent `ConnectorsSection` component itself (line 980) beyond its one link.

### 220.9 — `ContextPanel.tsx`: Files rename

- Files changed: `components/agent/ContextPanel.tsx` (§4.12).
- Test file: none.
- Verifiable result: `rg -n "Workspace\|/workspace" packages/studio/src/components/agent/ContextPanel.tsx` → empty.
- Do not: change the read/write scope list rendering above it.

### 220.10 — Relocate Connectors/Webhooks settings sections

- Files created: `components/agents/ConnectorsSettingsSection.tsx`, `components/agents/WebhooksSettingsSection.tsx` (§4.6, transcribed from `app/settings/page.tsx:594-947` verified today).
- Test file: none.
- Verifiable result: `bun run typecheck` clean; both files export exactly one component each, no `lucide-react` import in either.
- Do not: leave the old `ConnectorsSection`/`WebhooksSection` in `app/settings/page.tsx` if that file still has today's shape when this step runs (check with `rg -n "function ConnectorsSection" packages/studio/src/app/settings/page.tsx` first — if plan 219 has already rewritten the file, as expected per §3.6, there is nothing there to delete and this check is a no-op).

### 220.11 — `SettingsTab.tsx`

- Files created: `components/agents/SettingsTab.tsx` (§4.7).
- Test file: none.
- Verifiable result: G4's grep; `bun run typecheck` clean.
- Do not: hardcode any field from `AgentDefaultsSchema` or the `scheduled` block — every field comes from the schema `GET /api/agents/settings` returns.

### 220.12 — `RosterTab.tsx`, `ApprovalsTab.tsx`

- Files created: `components/agents/RosterTab.tsx` (§4.4), `components/agents/ApprovalsTab.tsx` (§4.5).
- Files deleted: none yet (the old `app/agents/page.tsx`/`app/agents/approvals/page.tsx` are replaced in step 220.15).
- Test file: none.
- Verifiable result: `bun run typecheck` clean (both new files compile standalone even before `AgentsPage.tsx` wires them in, since their props are self-contained interfaces).
- Do not: change the New agent dialog's validation, the Delete confirmation's counts logic, or the row menu's items.

### 220.13 — `lib/agent-runs.ts`: `fetchAllRuns`

- Files changed: `packages/studio/src/lib/agent-runs.ts` (§4.10's addition).
- Test file: none (this is a client-only composition helper, not on plan 200 §8.3's critical list — the same reasoning `fetchRecentRuns`/`fetchPendingApprovals` already went unversioned by).
- Verifiable result: `bun run typecheck` clean.
- Do not: add a new backend endpoint to make this cheaper — recorded as a future-plan gap (§4.10's doc comment), not solved here.

### 220.14 — `RunsTab.tsx`

- Files created: `components/agents/RunsTab.tsx` (§4.10).
- Test file: none.
- Verifiable result: `bun run typecheck` clean.
- Do not: build a replay/timeline view — that is the Jobs screen's Timeline sub-tab (README:362-380), not anything an agent run has; an agent run's "detail" here is status/usage/steps only, plus a link into the real transcript at `/agents/detail`.

### 220.15 — `FilesTab.tsx`, delete `app/workspace/`

- Files created: `components/agents/FilesTab.tsx` (§4.11).
- Files deleted: `app/workspace/page.tsx`, `app/workspace/page.test.tsx` (if present).
- Test file: none.
- Verifiable result: `test ! -d packages/studio/src/app/workspace`; `bun run typecheck` clean.
- Do not: change `lib/workspace.ts` or any presenter under `components/workspace/presenters/` — this step moves the page, not the data layer.

### 220.16 — `AgentsPage.tsx`, rewrite `app/agents/page.tsx`, delete the three sub-routes

- Files created: `components/agents/AgentsPage.tsx` (§4.3, the `Ships:` file).
- Files changed: `app/agents/page.tsx` (§4.9, rewritten to the thin wrapper).
- Files deleted: `app/agents/approvals/page.tsx` (+ `.test.tsx` if present), `app/agents/runs/page.tsx` (+ `.test.tsx`), `app/agents/thread/page.tsx` (+ `.test.tsx`).
- Test file: none.
- Verifiable result: G1, G2.
- Do not: delete `app/agents/detail/`.

### 220.17 — `scripts/check-routes.ts`: prune `/workspace`

- Files changed: `scripts/check-routes.ts` (§4.17).
- Test file: none (this script has no `bun test` file of its own — it is invoked directly, per plan 213 §4.10).
- Verifiable result: G3.
- Do not: touch any other `PENDING_REMOVAL` row.

### 220.18 — `api/agents.ts`, `daemon.ts`: delete `spawn-grants`

- Files changed: `packages/core/src/api/agents.ts` (§4.15), `packages/core/src/daemon.ts` (§4.16).
- Test file: check whether `packages/core/src/api/agents.test.ts` exists and asserts a `spawn-grants` route; if so, delete that one `describe`/`it` block (not the whole file) and list it in §10.
- Verifiable result: G8; `bun test packages/core/src/api/agents.test.ts` (if the file exists) passes with the spawn-grants cases removed.
- Do not: touch `packages/core/src/agent/tree/store.ts`, `store.test.ts`, or `runner.ts` — the runtime capability is untouched (§3.5).

### 220.19 — `lucide-react` sweep and package removal

- Files changed: whatever `rg -l "from 'lucide-react'" packages/studio/src` still returns at this point in execution (expected: empty, since steps 220.2-220.9 covered every file this plan's own reading found on 2026-09-03 — see §3.6's note on why some files' fate depends on plans 213-219 having already landed). If the sweep finds anything, convert it the same way (find the nearest semantic match in `packages/ui/src/icons.ts`'s three groups, adding a Group 3 entry per §4.1's pattern if genuinely nothing fits) and record every extra file touched in §11's "Discrepancies" line — this is the one step whose blast radius is not fully knowable until execution time, by design (§3's honest-position principle: a file this plan cannot see today because an earlier-stage plan has not yet run is not a file this plan can enumerate in advance).
- Files changed: `packages/studio/package.json` — delete the `lucide-react` dependency line.
- Test file: none.
- Verifiable result: G7.
- Do not: leave `lucide-react` in `package.json` "just in case" — if the sweep is not empty, fix the imports first, in the same step, then delete the dependency; do not delete the dependency while an importer remains (that is a `bun run typecheck`/build break, not a style issue).

## 6. Acceptance criteria

1. `/agents` renders five tabs (Roster default, then Runs, Approvals, Files, Settings) with no separate page title above the strip.
2. `/agents/detail?id=` is unchanged in every way this plan does not name (§4.8, §4.14).
3. `/workspace`, `/agents/approvals`, `/agents/runs`, `/agents/thread` are gone as routes; every internal Studio link that pointed at them now points at `/agents?tab=…`.
4. The Settings tab renders `AgentSettingsSchema`'s `defaults` and `scheduled` sections with zero hardcoded field UI, plus the relocated Connectors and Webhooks sections.
5. `ai-elements` exports exactly what `Chat.tsx` imports, per §3.3's table; `motion`/`shimmer.tsx` untouched.
6. `lucide-react` is not a dependency of `packages/studio` and is not imported anywhere under `packages/studio/src`.
7. The `spawn-grants` routes are gone; `canSpawn`'s runtime default (deny) is unaffected.
8. `bun run typecheck` is clean.
9. `bash scripts/check-plan-status.sh` passes once this plan's status line is updated.

## 7. Test plan

No Studio or `@enkaku/ui` test is written or run (plan 200 §8.3 — this area has zero tests by decision). This plan's own verification is typecheck plus the scripts named below plus the owner smoke.

### 7.1 Scoped commands

```bash
bun run typecheck
bun run scripts/check-routes.ts
bun run scripts/check-design-tokens.ts   # plan 204's own script — confirms the new icons.ts block did not break it
```

If step 220.18 finds and edits a `spawn-grants` test case in `packages/core/src/api/agents.test.ts`:

```bash
bun test packages/core/src/api/agents.test.ts
```

Never run a bare `bun test`.

### 7.2 Removal greps

```bash
test ! -d packages/studio/src/app/workspace && echo ok
test ! -d packages/studio/src/app/agents/approvals && echo ok
test ! -d packages/studio/src/app/agents/runs && echo ok
test ! -d packages/studio/src/app/agents/thread && echo ok
rg -n "spawn-grants" packages/core/src packages/studio/src            # expect: empty
rg -l "from 'lucide-react'" packages/studio/src                       # expect: empty
rg -n "lucide-react" packages/studio/package.json                     # expect: empty
rg -n "'/workspace'" scripts/check-routes.ts                          # expect: empty
```

### 7.3 Owner smoke (manual, exact steps)

1. `bun run dev` (core) and `bun run dev:studio`, open `http://localhost:3001/agents`.
2. Confirm the tab strip shows Roster (with a count), Runs, Approvals (with a count), Files, Settings — and no title text above it.
3. On Roster: click "New agent", create one, confirm it lands on `/agents/detail?id=…`. Go back to `/agents`, duplicate it from the row menu, confirm the duplicate opens with its name field selected. Delete the duplicate, confirm the counts dialog shows 0 threads/0 runs and the delete succeeds.
4. On Approvals: with no pending approval, confirm the empty state. (A live approval needs a running agent turn — skip if none is available; note as `owner` in §11.)
5. On Files: navigate into a folder, open a file, edit it, save it, confirm the "written by/last edited by" line updates. Rename a file. Confirm `?tab=files&path=` round-trips on reload.
6. On Settings: open Defaults, change a field, Save, reload, confirm it persisted. Open Connectors, add one (a fake key is fine), confirm it lists and Test/Remove work. Open Webhooks, same.
7. On Runs: with at least one thread that has run, confirm a row appears, click it, confirm the right panel shows status/usage, click "Open thread", confirm it lands on the correct `/agents/detail?id=…&thread=…`.
8. From `/agents/detail?id=…`, click "Runs" in the header, confirm it lands on `/agents?tab=runs&agent=…` filtered to that agent.
9. From `/agents/detail?id=…`'s Settings → Connectors section, click "Manage connectors in Settings", confirm it lands on `/agents?tab=settings`.
10. Confirm dark/light theme both render every tab without a raw hex colour or unstyled element (spot check, not pixel-exact — no handoff screen exists to compare against, §3.1).

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `PaperPlaneRightIcon` does not exist in the installed `@phosphor-icons/react` package | `bun run typecheck` fails on that exact import line; substitute `PaperPlaneTiltIcon` (§9 Q1) |
| The `lucide-react` sweep (step 220.19) finds files this plan's 2026-09-03 reading could not have known about, because an earlier-stage plan (213-219) has not yet landed in the tree this plan executes against | the step is explicitly designed to absorb that (§5's own text); record every extra file in §11, do not silently expand scope beyond icon-only edits in those files |
| `packages/core/src/api/agents.test.ts` asserts a `spawn-grants` route this plan deletes | step 220.18 checks for and removes only that test case, not the whole file; if the whole file's only content was spawn-grants tests, delete the file and say so in §11 |
| `fetchAllRuns`'s O(agents × threads) composition is slow on a farm with many agents | bounded (`maxThreadsPerAgent`, `maxTotal`) the same way `fetchRecentRuns`/`fetchPendingApprovals` already are; a real fix is a future plan's job (§4.10's own comment) |
| Plan 219 has not merged by the time this plan executes, so `app/settings/page.tsx` still has today's `ConnectorsSection`/`WebhooksSection` | step 220.10 checks with `rg` before deleting; either way this plan's own two new files are correct, since they were transcribed from today's verified source, not from whatever state the file happens to be in |

## 9. Open questions

1. **`PaperPlaneRightIcon`'s exact name in `@phosphor-icons/react`** — not verifiable locally (the package is not installed in this tree as of 2026-09-03, since plan 204 has not run). If it does not compile, substitute `PaperPlaneTiltIcon`. A human with the package installed (or plan 204's own executor) should confirm the real name and this plan's §4.1 block updated to match, rather than the executor guessing a third name.
2. **Agents in the rail versus the plugin menu** (MVP 15 §4.1 item 1, MVP 16 §4.1 item 1): plan 213 shipped `AGENTS_IN_RAIL = true` as its default, but its own header still lists the question as open, and this plan's brief explicitly asks it be recorded here rather than re-decided. Unchanged by this plan either way — `AgentsPage.tsx` does not read `AGENTS_IN_RAIL` and does not care how `/agents` is reached.
3. **A live approval was not available to smoke-test** in §7.3 step 4 if no agent run happened to pause during the owner's session — the owner should either trigger one deliberately (an agent with a `requiresApproval` capability, given a prompt that calls it) or accept the empty-state check alone as sufficient for this wave.
4. **`fetchAllRuns`'s real fix** (a farm-wide runs query plus a REST route, matching `agent-approvals.ts`'s own recorded gap) is not this plan's job; a future plan should pick it up, the same way MVP 13 B.1 flagged `spawn-grants` for this one.

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| `/workspace` route | `packages/studio/src/app/workspace/` | `test ! -d packages/studio/src/app/workspace` |
| `/agents/approvals` route | `packages/studio/src/app/agents/approvals/` | `test ! -d packages/studio/src/app/agents/approvals` |
| `/agents/runs` route | `packages/studio/src/app/agents/runs/` | `test ! -d packages/studio/src/app/agents/runs` |
| `/agents/thread` route (a redirect) | `packages/studio/src/app/agents/thread/` | `test ! -d packages/studio/src/app/agents/thread` |
| `GET/POST /:id/spawn-grants`, `DELETE /:id/spawn-grants/:childId` | `packages/core/src/api/agents.ts:66-89` | `rg -n "spawn-grants" packages/core/src` → empty |
| `mustGetTree` helper | `packages/core/src/api/agents.ts:28-31` | `rg -n "mustGetTree" packages/core/src` → empty |
| `tree: agentTreeStore` argument to `createAgentRoutes` | `packages/core/src/daemon.ts:3249` | `rg -n "createAgentRoutes\(\{ store: agentStore, tree" packages/core/src` → empty |
| `lucide-react` (dependency and every import) | `packages/studio/package.json`; ~10 files under `packages/studio/src/components/agent(s)?/` and `ai-elements/` (final list per step 220.19) | `rg -l "from 'lucide-react'" packages/studio/src` → empty; `rg -n "lucide-react" packages/studio/package.json` → empty |
| 21 exports + paired types from `ai-elements/prompt-input.tsx`, 9 from `message.tsx`, 2 from `conversation.tsx` | `packages/studio/src/components/ai-elements/` | §5 steps 220.2-220.4's `rg -c "^export "` counts |
| `'/workspace'` row | `scripts/check-routes.ts`'s `PENDING_REMOVAL` | `rg -n "'/workspace'" scripts/check-routes.ts` → empty |
| `ConnectorsSection`, `WebhooksSection` (as functions inside `app/settings/page.tsx`) | `packages/studio/src/app/settings/page.tsx:594-947` (today; superseded by plan 219's own rewrite before this plan's own deletion check runs, §3.6) | `rg -n "function ConnectorsSection\|function WebhooksSection" packages/studio/src/app/settings/page.tsx` → empty |

Forbidden-word check for this plan's own new files (plan 200 §2.4):

```bash
rg -n -i "\blease\b|\bcluster\b|co-control|\bassist\b|\bgrant\b" packages/studio/src/components/agents packages/studio/src/components/ai-elements
```
Expected: empty. (`deviceGrants`/`deviceGrantsOverride`/`grantSpawn`/`revokeSpawn` are existing protocol/runtime names this plan reads but does not introduce as new UI copy or new identifiers; the word-boundary pattern above does not match inside them.)

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
