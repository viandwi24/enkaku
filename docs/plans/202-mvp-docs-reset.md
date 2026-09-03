# Plan 202 — MVP wave 0 : Docs reset — archive the spec and plans, write the MVP spec skeleton

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: nothing (wave 0, `docs/plans/200-mvp-program.md` §4). Plans 201, 203 and 134 run in the same wave and may touch `CLAUDE.md` concurrently; see §8 R1.
> Spec references: none (this plan writes the spec). The prototype spec is archived whole; the new `docs/spec.md` §21 maps every prototype section number to its MVP successor so archived plans stay readable.
> Ships: docs/archive/README.md

---

## 0. Goal checklist

Every row is verified from the repo root on the `mvp` branch after the last step. Commands are literal; expected output is literal. One transcription rule: inside a table cell a regex alternation bar is written `\|` because of the table syntax; type a plain `|` when running the command.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The prototype spec is archived and a new spec stands in its place | `docs/archive/spec-prototype.md` exists; `docs/spec.md` is the new document whose first line is `# Enkaku MVP specification` | `test -e docs/archive/spec-prototype.md && head -1 docs/spec.md` prints `# Enkaku MVP specification` | [ ] |
| G2 | Every prototype plan is archived; only the MVP series and `00-overview.md` remain in `docs/plans/` | 136 files under `docs/archive/plans/`; no file in `docs/plans/` whose name starts with a number below 200 (the MVP series is 200–224; the five `13x-m9x` prototype plans are archived with the rest) | `ls docs/archive/plans/*.md \| wc -l` prints `136`; `ls docs/plans \| rg '^(0[1-9]\|[1-9][0-9]\|1[0-9][0-9])[.-]'` prints nothing; `ls docs/plans \| rg '^13[0-4]-m9'` prints nothing | [ ] |
| G3 | The five prototype audit documents are archived | `ux-audit.md`, `settings-audit.md`, `spec-divergences.md`, `tmp-try-arch-mikrotik.md`, `overview.md` live only under `docs/archive/` | `for f in ux-audit settings-audit spec-divergences tmp-try-arch-mikrotik overview; do test -e docs/archive/$f.md && test ! -e docs/$f.md \|\| echo "BAD $f"; done` prints nothing | [ ] |
| G4 | Git history follows the moved files | `git mv` was used, not copy plus delete | after the commit, `git log --follow --oneline -- docs/archive/spec-prototype.md \| wc -l` prints a number of at least `2` | [ ] |
| G5 | `docs/archive/README.md` exists and points at the live documents | it names `docs/mvp/16-consolidated-plan.md`, `docs/plans/200-mvp-program.md`, and `docs/spec.md` | `rg -c "docs/mvp/16-consolidated-plan.md\|docs/plans/200-mvp-program.md\|docs/spec.md" docs/archive/README.md` prints a number of at least `3` | [ ] |
| G6 | The new spec has the section set §4.2 defines, and every deferred section names a plan in the MVP series | 22 `## ` headings (§0 to §21); every `TBD by plan NNN` marker names a plan between 131 and 154 | `rg -c "^## " docs/spec.md` prints `22`; `rg -o "TBD by plan [0-9]+" docs/spec.md \| rg -v "plan (13[1-9]\|14[0-9]\|15[0-4])$"` prints nothing | [ ] |
| G7 | `spec:check` runs against the new spec and reports, never fails | exit code 0; the NOTE names the archived register | `bun run spec:check; echo "exit=$?"` ends with `exit=0`, and the output contains `docs/archive/spec-divergences.md` | [ ] |
| G8 | The spec-check unit tests still pass | 15 tests, 0 failures | `bun test ./scripts/spec-check.test.ts` prints ` 15 pass` and ` 0 fail` | [ ] |
| G9 | The plan-status check passes with the archive out of its scan | exit code 0 | `bash scripts/check-plan-status.sh; echo "exit=$?"` prints the line `  every plan that declares an artefact agrees with the code` and ends with `exit=0` | [ ] |
| G10 | `CLAUDE.md` points at the new documents and no longer describes the removed hold model | the reference list names `docs/plans/200-mvp-program.md`, `docs/mvp/`, `docs/archive/`; the `adb kill-server` bullet says "sessions and activities" | `rg -n "docs/spec.md" CLAUDE.md` prints exactly one line, and it contains `plan 202`; `rg -c "200-mvp-program" CLAUDE.md` prints a number of at least `2`; `rg -n "sessions and leases" CLAUDE.md` prints nothing; `rg -n "sessions and activities" CLAUDE.md` prints one line | [ ] |
| G11 | No live document links to a moved path | zero references to the old locations in `docs/guide`, `docs/feat`, `README.md`, `.env.example` | `rg -n "\.\./plans/\|\.\./overview\.md\|\.\./tmp-try\|docs/plans/(0[1-9]\|[1-9][0-9]\|1[0-2][0-9])[.-]\|docs/(ux-audit\|settings-audit\|spec-divergences\|tmp-try-arch-mikrotik\|overview)\.md" docs/guide docs/feat README.md .env.example` prints nothing | [ ] |
| G12 | The forbidden vocabulary is absent from the documents this plan writes | 0 matches | `rg -n -i -w "lease\|leases\|cluster\|clusters\|co-control\|assist\|heldBy\|assistedBy" docs/spec.md docs/archive/README.md` prints nothing | [ ] |
| G13 | Typecheck is clean | 0 errors | `bun run typecheck` exits 0 | [ ] |

## 1. Goals

1. `docs/spec.md` is a compact MVP specification derived from `docs/mvp/` (MVP 09 §1, MVP 16 §1), with decided sections written as prose and undecided sections marked `TBD by plan NNN`, so that the repo rule "the spec wins over the code" stops reintroducing what the MVP removes.
2. The prototype spec, all 136 prototype plans, and the five prototype audit documents live under `docs/archive/` with their git history, marked as history and not authority (`docs/archive/README.md`).
3. `docs/plans/` holds only `00-overview.md` and the MVP series (130 and up), so an agent told to "work the plans" sees only the MVP.
4. The two doc checks in CI (`scripts/spec-check.ts`, `scripts/check-plan-status.sh`) keep running green against the new layout and say truthfully what they check.
5. `CLAUDE.md`, `docs/plans/00-overview.md`, `docs/mvp/README.md`, and the user-facing documents that link to moved files point at the new locations.

## 2. Non-goals

- **Filling the `TBD` sections of the spec.** Each is owned by the plan it names (§4.2). Plan 224 finalises the spec (MVP 09 §1, 200 §4).
- **Rewriting `docs/design.md`.** MVP 15 §3 step 6 rewrites it as the screens land (plans 213 to 149). It stays live and unchanged here.
- **Updating code comments that cite `docs/plans/NN-*.md` by path.** About 100 source files cite prototype plans in comments (for example `.github/workflows/ci.yml:40`, `packages/core/src/server/ws-handlers.ts`). They are design history; the archive README (§4.1) says how to resolve such a citation. Rewriting them is churn with no reader, and 200 §2.1 forbids touching files a plan does not name.
- **Deleting the divergence-register code path in `scripts/spec-check.ts`.** The register file is archived; the script keeps its `DIV-` logic and reports the register as absent. Whether the MVP spec gets a register of its own, and whether `FAIL_ON_GAP` flips, is plan 224's call (MVP 09 §1, §5).
- **Editing the `docs/mvp/01..16` documents beyond one line of `README.md`.** They are the evidence and the history of each decision (200 §1); their `docs/spec.md:NNNN` line citations refer to the prototype spec and stay as written.
- **Archiving `docs/guide/`, `docs/research/`, `docs/benchmarks/`, `docs/feat/`.** Open question, §9 Q1 to Q3.
- **`AGENTS.md`.** Untracked, outside git, see §3.6 and §9 Q4.
- **The `mvp` branch itself.** 200 §6 owns the branch strategy; this plan assumes it is checked out.

## 3. Context and design decisions

### 3.1 What the docs tree is today

Verified 2026-09-03 with `ls docs docs/plans docs/research docs/benchmarks docs/feat docs/guide docs/mvp`:

| Path | Content | Fate in this plan |
|---|---|---|
| `docs/spec.md` | 1 198 lines, 225 KB, 22 top-level sections (`## 1. Summary and vision` … `## 22. Open questions / future`), prototype v0.2 to v0.8 | `git mv` to `docs/archive/spec-prototype.md`; a new `docs/spec.md` is written |
| `docs/plans/00-overview.md` | conventions and roadmap; §3, §4, §6, §7 still binding (200 §7) | stays; line 4 edited (§4.5) |
| `docs/plans/01-…` to `docs/plans/129-…` | 131 files (numbers repeat: `22.0`, `22.1`, two `56-m26-*`) | `git mv` to `docs/archive/plans/` |
| `docs/plans/130-m95-…`, `131-m96-…`, `132-m97-…`, `133-m98-…`, `134-m99-…` | 5 prototype plans (M95 to M99), all `implemented (software)`, committed in `37c73bf` | `git mv` to `docs/archive/plans/`; see §3.2 |
| `docs/plans/200-mvp-program.md` | the MVP conventions document, **untracked** at the time of writing | stays; nothing to move |
| `docs/ux-audit.md`, `settings-audit.md`, `spec-divergences.md`, `tmp-try-arch-mikrotik.md`, `overview.md` | prototype audits and one incident log | `git mv` to `docs/archive/` (MVP 13 A.10) |
| `docs/mvp/` | 16 decision documents, `README.md`, `design_handoff_enkaku_openpf/` | stays; `README.md` line 11 edited (§4.5) |
| `docs/design.md` | the Studio design system | stays (MVP 15 §3 step 6 rewrites it later) |
| `docs/guide/` (11 files), `docs/feat/` (3), `docs/research/` (1), `docs/benchmarks/` (1) | user guides, design records, research | stay; six of them link to moved files and are repointed (§4.6); archiving is §9 |
| `docs/.DS_Store`, `docs/mvp/.DS_Store` | Finder litter, untracked | ignored |

### 3.2 The number collision: `130-m95` to `134-m99` are prototype plans

`docs/plans/200-mvp-program.md` §1 says "The prototype (v0.1.32, plans 01–129)". The tree also holds five prototype plans numbered 130 to 134 (slugs `m95` to `m99`, headers `> Status: implemented (software)`), written 2026-08-26 and committed in `37c73bf`, before the MVP series claimed those numbers. `docs/plans/132-m97-assignment-is-a-constraint-not-a-preference.md` sits beside this plan.

Decision: they are archived with the rest of the prototype series. The intent of MVP 09 §1 and MVP 13 A.10 ("`docs/plans/01..129` (archived)") is "every prototype plan", and the number 129 was the last number the author of 130 knew about. Keeping five `implemented` prototype plans under MVP numbers would make `130-m95` look like a sibling of `200-mvp-program` and would let `check-plan-status.sh` keep checking their `Ships:` artefacts, which plans 205 to 149 delete. The archive README lists them by name.

### 3.3 What the checks enforce

- `scripts/spec-check.ts` (266 lines): a name-presence check. It reads `docs/spec.md` (`SPEC_PATH`, line 58) and `docs/spec-divergences.md` (`DIVERGENCES_PATH`, line 59, `readOptional`, degrades to `null`), extracts table names from `packages/core/src/db/schema.ts`, screens from `packages/studio/src/app/**/page.tsx`, and routes from `packages/core/src/api/*.ts` plus `server/http.ts`, then lists every name that appears in neither. `FAIL_ON_GAP = false` (line 55) so it always exits 0. Baseline on 2026-09-03: 48 tables, 32 screens, 211 routes, 1 gap (`plugin_webhooks`). Against the new skeleton the gap list will be long (every prototype route and table the MVP removes), which is the correct signal for plans 205 to 149 and stays a warning. Lines 231 and 232 print a NOTE saying the register "does not exist yet", which becomes false once the register is archived; §4.3 rewrites the wording. Wired as `bun run spec:check` (`package.json:26`) and run by CI (`ci.yml:94`); its unit tests run as `bun test ./scripts/spec-check.test.ts` (`ci.yml:101`) and use temp-dir fixtures only (`spec-check.test.ts:15-19`), so they are unaffected by the move.
- `scripts/check-plan-status.sh` (238 lines): `for plan in docs/plans/*.md; do` (line 108) and `total=$(ls docs/plans/*.md | wc -l ...)` (line 216). The glob is non-recursive, so `docs/archive/plans/` is never scanned; nothing structural changes. It requires a `> Ships:` line on every plan in `docs/plans/` (`FAIL_ON_UNDECLARED_SHIPS=true`, line 80) and refuses `implemented` while the artefact is missing or the header admits unbuilt work (`ADMISSION_REGEX`, line 106). This plan's `Ships:` is `docs/archive/README.md`, which does not exist while the plan is `draft` and exists once it is `implemented`, so both states pass. §4.4 adds a comment naming the archive as deliberately out of scope.
- `.github/workflows/ci.yml:81` runs `check-plan-status.sh`, `:94` runs `spec:check`, `:101` runs the spec-check tests, all on every push. The Windows job deliberately skips the two text checks (`ci.yml:161-168`).
- No test or script reads any other `docs/` file at runtime (verified: `grep -rn` for `readFileSync|readdirSync|Bun.file|existsSync` combined with `docs/` over `packages` and `scripts` matches only `spec-check.ts:58-59`).

### 3.4 What the new spec must contain

MVP 09 §1: "write a new, compact `docs/spec.md` from the decisions in this directory once they are final". MVP 16 §1 is the product picture; 200 §7 is the immutable list. The sections are chosen so that every concept `CLAUDE.md` and the MVP documents refer to has a home, and so that the prototype spec sections archived plans cite (`§7.9`, `§10`, `§11.4`, `§11.6`, `§16`, `§19` are the ones cited from `CLAUDE.md:91`, MVP 01 to 05, MVP 13 A.1, A.4, A.6) have a named successor (spec §21).

Rules the skeleton obeys, taken from `docs/mvp/README.md` "Approach" and 130:

1. Sections are rewritten, never appended to; no history notes, no "NEW in v0.x" (README guard 2).
2. A section either carries decided text or a single line `TBD by plan NNN (source: docs/mvp/NN §M)`. A section may carry both: decided paragraphs and a trailing TBD for the part a later plan settles.
3. The vocabulary of 200 §2.4 is used; the forbidden words do not appear (G12).
4. Numbers are measured or marked "not measured" (MVP 09 §7: "The number goes into the README and the sales material only after it is measured").
5. Open decisions (MVP 16 §4) are stated as open with the owner named; the skeleton does not decide them (200 §2.1).

### 3.5 Authority after this plan

Today `docs/mvp/README.md:11` says "`docs/spec.md` remains the single source of truth", and plan 200 line 5 says "until then, where `docs/spec.md` and `docs/mvp/16` disagree, `docs/mvp/16` wins for the MVP series only". After this plan the new spec is derived from 16, so the conflict has no instance. The precedence rule written into spec §0 is: a decided section wins over the MVP document it was written from; a `TBD` section has no authority and the MVP document it names is the decision of record until the owning plan lands. 130 line 5 is not edited (130 is the CTO's document); its "until then" clause simply expires.

### 3.6 `AGENTS.md`

Untracked at the repo root (`git status` shows `?? AGENTS.md`), 103 lines, the same text as `CLAUDE.md` with line 3 reading "This file provides guidance to Codex (Codex.ai/code)". It duplicates `CLAUDE.md` line for line, including the reference list this plan rewrites. Per the brief for this plan it is left untracked and unchanged: it is outside git, so nothing this plan commits can update it, and whether it should exist at all is the owner's call (§9 Q4). Its staleness after this plan is a risk (§8 R4), not a task.

### 3.7 Code evidence cited by the edits

Every line below was read on 2026-09-03; match on content if the number drifts.

| File:line | Content (verbatim start) |
|---|---|
| `CLAUDE.md:9` | `- \`docs/spec.md\` — the product spec, the **single source of truth**. If a plan or the code contradicts the spec, the spec wins.` |
| `CLAUDE.md:11` | `- \`docs/plans/01..16-*.md\` — milestone plans M0–M10 (a nine-section template, with acceptance criteria per plan).` |
| `CLAUDE.md:83` | `- **\`adb kill-server\` is forbidden everywhere except …` containing `Both drain sessions and leases (plus any running job the caller explicitly overrode)` |
| `CLAUDE.md:91` | `- The driver subsystem has **five** layers, not four: transport, display, input, inspector, and \`network\` (spec §7.9).` |
| `scripts/spec-check.ts:12-13` | `* or \`page.tsx\` screen exists whose name appears NOWHERE in \`docs/spec.md\`` / `* and has NO \`DIV-\` row in \`docs/spec-divergences.md\`.` |
| `scripts/spec-check.ts:50-53` | the four comment lines starting `// The switch. Exit code 0 today: 29+ divergence rows are open (plan 84 §3),` |
| `scripts/spec-check.ts:59` | `const DIVERGENCES_PATH = join(ROOT, 'docs/spec-divergences.md')` |
| `scripts/spec-check.ts:231-232` | `console.log(\`  NOTE: ${relative(ROOT, DIVERGENCES_PATH)} does not exist yet.\`)` / `console.log('        Treating it as zero rows — nothing is recorded as a known divergence yet.')` |
| `scripts/check-plan-status.sh:108` | `for plan in docs/plans/*.md; do` |
| `.github/workflows/ci.yml:86-93` | the eight comment lines starting `# Plan 84 (M49) §4.4 "closing the loop": a deliberately dumb name-presence` |
| `docs/plans/00-overview.md:4` | `> The product source of truth is \`docs/spec.md\` (Enkaku draft v0.2). If a plan contradicts the spec, the spec wins — then update the plan.` |
| `docs/mvp/README.md:11` | `- \`docs/spec.md\` remains the single source of truth. Where an MVP document proposes changing a spec commitment, it says so explicitly.` |
| `.env.example:75` | `# looked up the name — see docs/plans/51-m24b-verified-egress-and-fail-closed.md §3.3.` |
| `docs/guide/install.md:272` | `[\`docs/tmp-try-arch-mikrotik.md\`](../tmp-try-arch-mikrotik.md) for the incident. After any change,` |
| `docs/guide/install.md:277` | `\`docs/tmp-try-arch-mikrotik.md\` is one operator's own worked log of doing exactly this for a farm` |
| `docs/guide/cloud.md:48` | contains `(plan 28, \`docs/plans/28-m12g-cloud-adb-endpoint.md\`)` |
| `docs/guide/physical-labelling.md:86` | `   entry 96.21 in \`docs/plans/96-m61-hotfixes.md\`), not a bug in the` |
| `docs/guide/physical-labelling.md:254` | `phones yourself. \`docs/plans/89-m54-device-identity-and-physical-labelling.md\`` |
| `docs/guide/record-and-replay.md:8` | `\`docs/plans/94-m59-action-recorder-and-task-scheduling.md\`; the SDK's` |
| `docs/feat/kv-storage.md:6` | `> switch; \`docs/spec.md\` §12.4 is the product statement.` |
| `docs/feat/plugin-and-script.md:5` | `> 97, 98 and 99 are the design record; \`docs/spec.md\` §11 is the product statement.` |
| `docs/feat/plugin-proxy-manager.md:692` | contains `Plan 123 (\`docs/plans/123-m88-bind-capability-probe` |
| `docs/feat/plugin-proxy-manager.md:1344` | `| understand the farm's own four network engines | [\`docs/overview.md\`](../overview.md) §11, spec §7.9, plan 114 |` |
| `docs/feat/plugin-proxy-manager.md:1346` | `| read the design record | plans [112](../plans/112-m77-proxy-manager.md), [114](../plans/114-m79-device-proxy.md), [117](../plans/117-m82-egress-binding.md), [118](../plans/118-m83-windows-adb-performance.md), [121](../plans/121-m86-proxy-failover.md) |` |
| `packages/scrcpy/src/version.ts:11` | `export const SCRCPY_VERSION = '3.3.1'` |
| `packages/protocol/src/settings.ts` | 2 694 lines (`wc -l`), the number MVP 12 §6 quotes |

## 4. Technical design

### 4.1 Target layout and `docs/archive/README.md`

```
docs/
  spec.md                      # NEW: the MVP specification (§4.2)
  design.md                    # unchanged
  archive/
    README.md                  # NEW (text below)
    spec-prototype.md          # was docs/spec.md
    overview.md                # was docs/overview.md
    ux-audit.md                # was docs/ux-audit.md
    settings-audit.md          # was docs/settings-audit.md
    spec-divergences.md        # was docs/spec-divergences.md
    tmp-try-arch-mikrotik.md   # was docs/tmp-try-arch-mikrotik.md
    plans/                     # 136 files: 01-… to 129-… plus 130-m95-… to 134-m99-…
  plans/
    00-overview.md
    200-mvp-program.md
    131-… to 154-…             # the MVP series, as each is written
  mvp/                         # unchanged except README.md line 11
  guide/ feat/ research/ benchmarks/   # unchanged except the link fixes in §4.6
```

`docs/archive/README.md`, complete text (the executor writes it verbatim; the plan count is filled from the `ls | wc -l` of step 202.1):

```markdown
# Archive: the prototype's documents

Everything in this directory is **history, not authority**. It is kept so that a design decision, a field incident, or a measured number can still be looked up, and so that the citations in older code comments still resolve. Nothing here may be used to justify a change to the code: the live documents are

- `docs/spec.md`, the MVP specification (rewritten from `docs/mvp/` by plan 202);
- `docs/plans/200-mvp-program.md`, the rules and the wave table for the MVP series (plans 201 to 154);
- `docs/mvp/16-consolidated-plan.md` and the other `docs/mvp/` documents, the decisions the MVP is built from;
- `docs/plans/00-overview.md` §3, §4, §6, §7, still binding.

## What is here

| Path | Was | What it is |
|---|---|---|
| `spec-prototype.md` | `docs/spec.md` | the prototype specification, v0.2 to v0.8 (2026-08). Section numbers cited by archived plans and by code comments (`spec §7.9`, `§10`, `§11.4`, `§16`, `§19`) refer to this file; `docs/spec.md` §21 maps each to its MVP successor. |
| `plans/01-…` to `plans/129-…` | `docs/plans/` | the 131 prototype milestone plans (M0 to M94). A citation `docs/plans/NN-slug.md` in a code comment or in a `docs/mvp/` document resolves to `docs/archive/plans/NN-slug.md`. |
| `plans/130-m95-…`, `131-m96-…`, `132-m97-…`, `133-m98-…`, `134-m99-…` | `docs/plans/` | five prototype plans (M95 to M99, 2026-08-26) whose numbers collide with the MVP series. `docs/plans/200-…` and up are MVP plans; these five are not. |
| `overview.md` | `docs/overview.md` | the prototype's architecture overview |
| `ux-audit.md` | `docs/ux-audit.md` | the Studio UX audit that preceded MVP 03 |
| `settings-audit.md` | `docs/settings-audit.md` | the settings audit that preceded MVP 12 |
| `spec-divergences.md` | `docs/spec-divergences.md` | the `DIV-` register plan 84 kept between the prototype spec and the code. `scripts/spec-check.ts` no longer reads it. |
| `tmp-try-arch-mikrotik.md` | `docs/tmp-try-arch-mikrotik.md` | one operator's worked log of a MikroTik routing incident, cited by `docs/guide/install.md` |

## Rules

1. Do not edit a file here except to fix a path that points at another archived file.
2. Do not add a file here. A new decision is a `docs/mvp/` document or an MVP plan.
3. A plan in `plans/` keeps its `> Status:` and `> Ships:` lines as they were; `scripts/check-plan-status.sh` does not scan this directory, so those lines are no longer checked and may go stale as the MVP deletes the artefacts they name.
4. The vocabulary in these files (the words `docs/plans/200-mvp-program.md` §2.4 forbids) is the prototype's. It is not a precedent.

Archived by plan 202 (`docs/plans/202-mvp-docs-reset.md`) on the date of its commit; 136 plans, one spec, five audits.
```

### 4.2 The new `docs/spec.md`

The executor writes this file verbatim, then fills the two placeholders marked `<DATE>` with the commit date. No section is skipped, reordered, or renumbered: §21's map and `CLAUDE.md`'s `spec §5 and §9` citation depend on the numbers. The text is written so that G12's grep is empty; do not "improve" wording with the words that grep forbids.

````markdown
# Enkaku MVP specification

> Status: skeleton, written by plan 202 on <DATE> from the decisions in `docs/mvp/` (MVP 16 wins where those documents disagree). Sections marked `TBD by plan NNN` are filled by that plan; plan 224 finalises the whole document.
> The prototype specification this replaces is `docs/archive/spec-prototype.md`; §21 maps its section numbers to this document.

## 0. How to read this document

- **Authority.** A section that carries decided text is the product statement: if a plan or the code contradicts it, the spec wins and the plan or the code is corrected. A line `TBD by plan NNN (source: docs/mvp/MM §K)` carries no authority; until plan NNN lands, the `docs/mvp/` document it names is the decision of record for that topic.
- **Rewritten, never appended.** A plan that changes a section replaces its text. There are no history notes, no "revised in", no strike-throughs (`docs/mvp/README.md`, Approach, guard 2). History lives in `docs/archive/` and in the plan that made the change.
- **Vocabulary.** The words for the MVP's concepts are fixed in `docs/plans/200-mvp-program.md` §2.4. This document uses them and only them.
- **Measured, not promised.** A number in §17 is either measured (with the plan that measured it and the hardware) or marked "not measured". A target that has not been measured is not a promise to a client (MVP 09 §7).
- **Immutable decisions** are in §2. A plan may not change them; only a revision of this document by the CTO may.

## 1. Product

Enkaku is a self-hosted Android phone farm: plug in phones, see all of them live, drive any one of them by hand, and run automation on many of them at once. One host, one binary, one browser. Cloud mode, mirroring at scale, and internationalisation come after the MVP (MVP 09 §8, MVP 06 §4.1).

**Nouns.** A **device** belongs to at most one **group**. A device has a list of **activities** (a job, an install, a transfer, someone controlling it) and a status of offline, online, or quarantined. A **plugin** is the only way code reaches the farm; it has versions and one active version, and it registers **scripts**, which have no version of their own. A **workflow** is a document chaining scripts, authored in the UI, with no version. A **schedule** names a script or workflow, a target, and a cron. A **job** is the intent to run one script or workflow on one device; each execution is a **run**, and runs accumulate. A **batch** is the jobs created together from one target. An **agent** is an AI operator with its own runs, approvals, and **files**.

**Surfaces.** An icon rail with Devices, Scripts & Workflows, Jobs, Plugins, then the dynamic plugin menu, then theme, Settings, avatar. Agents is either the fifth icon or the first plugin entry (open, MVP 16 §4.1). A status bar with health, counters, alerts, clock. Devices: group tabs, table or Screens grid, discovery sheet, selection with marquee, a bulk pill with the generic action set. **Device Control**: a floating window with hardware shortcuts, the cast with a latency readout, full keyboard and mouse passthrough, Actions, Inspector, and Device (Jobs, Files). Scripts & Workflows: Scripts, Workflows, Schedules. Jobs: Jobs, Batches, detail with Inputs, Output, Logs, Timeline, Artifacts, and a run picker. Plugins. Settings: 15 visible fields, 11 advanced.

**Mechanisms.** Sessions live as long as the device is online; the Screens encoder never stops; the browser only attaches. Activities replace the prototype's exclusive-hold model; a policy table answers allow, warn, or forbid; control is a marker that expires from the last input. Every action takes a target and answers per device. The inspector is a first-party accessibility service in the guest agent with push-based `waitFor`, ui-server as fallback. The guest agent's own screen tells a person holding the phone what the farm is doing to it.

**Who it is for.** An operator running 20 to 100 phones on a shelf, who compares the product with Panda by some3c (`docs/mvp/README.md`, Reference competitor). The MVP is judged on three measured numbers: latency, attach time, and a warm-up time for the whole farm (MVP 16 §5.2).

## 2. Stack (immutable)

From `docs/plans/00-overview.md` §3 and `docs/plans/200-mvp-program.md` §7. No plan changes these.

| Area | Decision |
|---|---|
| Core runtime | Bun, not Node. The core daemon is Bun plus Hono. |
| Web UI | Next.js (Studio), static export (`output: 'export'`), served by the core on one origin. |
| Database | SQLite plus Drizzle ORM. Migrations are generated (`bun run --cwd packages/core db:generate`), never hand-written. Timestamps are integer unix seconds (`mode: 'timestamp'`). |
| Validation | Zod 4 at every boundary: WS messages, HTTP bodies, JSON DB columns, config files, script params. No `as`-cast of external input. |
| Monorepo | Bun workspaces (§3). Cross-package imports go through `@enkaku/*` package names. |
| scrcpy-server | Genymobile's vanilla jar, pinned in `packages/scrcpy/src/version.ts` (3.3.1 today); the Java side is never forked. |
| Default input | `scrcpy-uhid`, falling back to `scrcpy-sdk`; `adb-input` only as a last resort. |
| Default inspector | a persistent on-device engine (§8); `uiautomator dump` is the last rung. |
| Core to Studio | one `/ws` WebSocket for realtime and streaming, REST for CRUD; the contract lives in `packages/protocol` as Zod schemas; no message type string exists outside that package. |
| adb | one per-device command queue plus a global semaphore; `adb kill-server` runs only inside `packages/core/src/tools/adb-server-control.ts`'s `cycle()`. |
| Isolation | crash containment (child process plus hard-timeout kill), never called a sandbox. |
| Identity | `stableId` (ro.serialno, then ANDROID_ID) is the device identity; the adb serial is a transport address. |
| Added by the MVP | a script exists only inside a plugin and has no version of its own; a device's state is `offline \| online \| quarantined` plus an activity list; a session lives as long as the device is online; every action takes a target and answers per device; a job is an intent and a run is an execution; the design of record is `docs/mvp/design_handoff_enkaku_openpf/` as corrected by MVP 15 §0.1 and §1. |

## 3. Repository layout

```
openpf/
  packages/
    core/          the Bun + Hono daemon: registry, sessions host, jobs, plugins, API, WS, DB
    studio/        the Next.js UI (standalone TypeScript 5; never merged with the root TS 7 config)
    ui/            @enkaku/ui, the component primitives Studio and plugin views share
    protocol/      @enkaku/protocol, Zod schemas for every message, body, setting, and vocabulary table
    sdk/           @enkaku/sdk, defineScript and the plugin CLI (init, publish)
    session/       DeviceSession assembly, video profiles, input arbiter, text input, port allocation
    drivers/       the five driver layers (§5) and their engines
    adb/           the adb client (track-devices, forward, shell)
    scrcpy/        the scrcpy protocol client, version-locked
    toolchain/     tool provisioning: download, sha256, versions, manifest
    harness/       the AI agent harness (vendored, provenance-checked, never edited locally)
    node/          the cloud tunnel mini-core (post-MVP; stays, outside the MVP definition of done)
    probe-server/  the self-hosted egress/geo/DNS probe endpoint
  apps/
    guest-agent/   the on-device APK (§19)
    desktop/       the Tauri shell (parked; §18)
  plugins/         bundled plugins: google/tiktok/youtube automation packs, proxy-manager, mikrotik-routing, networking
  examples/        example scripts
  scripts/         repo tooling (typecheck, spec-check, check-plan-status, bench, doctor, smoke)
  docs/            spec.md, design.md, plans/, mvp/, guide/, archive/
```

`packages/sdk` and `packages/protocol` are designed to be publishable; everything else is private. The release binary embeds the Studio export and the bundled packs (`packages/core/packs/`, built by `bun run build:packs`).

## 4. Data model

Storage is SQLite through Drizzle (`packages/core/src/db/schema.ts`). Every JSON column is parsed through a Zod schema on read. Every timestamp is an integer of unix seconds. Identifiers are `crypto.randomUUID()`.

### 4.1 Device

- Identity: `stableId`; the adb serial is the transport address and may change (`device_endpoints` remembers network addresses).
- Status: `offline | online | quarantined`. Nothing else is stored as a state; "busy" and "controlled" are views over the activity list.
- Fields an operator sets: `groupId` (at most one group), tags (`device_tags`), number (`device_numbers`, the `#` shown everywhere and on the physical label), label.
- Readiness (`desiredReadiness`, `awake` by default and applied at connect), preparation map (per component), guest agent state, network route (§9), identity overrides.
- Admission: a phone adb can see is **not** on the farm until an operator adds it (`discovered_devices`, `blocked_devices`, `deleted_devices`). Quarantine is automatic after repeated infrastructure failures (§14 advanced setting).
- Tables kept from the prototype: `devices`, `device_tags`, `device_endpoints`, `device_numbers`, `discovered_devices`, `blocked_devices`, `deleted_devices`, `device_events` (the event log, two streams: `main` and `input`), `network_credentials`, `sequences`, `migration_markers`, `tool_installs`.

### 4.2 Group

A group is a named set of devices; a device belongs to at most one. Groups are managed from the Devices tab strip only (create, rename, delete by right-click); there is no page. Table `groups`; column `devices.groupId`; routes `/api/groups`; target shape `{ groupId }`. The prototype's table, routes, messages, settings, and Studio components for the same concept carry its old name (the word 200 §2.4 forbids) and are renamed by plan 207 (MVP 15 §0.1.3, MVP 13 A.6a).

### 4.3 Activity

One list per device, served as `DeviceInfo.activities` and pushed as `device.activity` (added, updated, ended):

```ts
type DeviceActivity = {
  id: string
  kind: 'control' | 'job' | 'workflow-job' | 'install' | 'transfer' | 'prep'
      | 'command' | 'agent' | 'network-apply' | 'wake'
  label: string                 // a human sentence, never an id
  actor: { kind: 'user' | 'agent' | 'system' | 'plugin'; id: string; label: string }
  startedAt: number             // unix seconds
  updatedAt: number             // last heartbeat or last input
  href?: string                 // where to look: job detail, transfer, plugin view
  meta?: Record<string, unknown>
}
```

Entries with a durable row (jobs, transfers, preparation) are projected from that row; `control`, `command`, and `wake` are in memory and are empty after a restart.

**Control is a marker, not a permission.** The first input from a client creates or refreshes a `control` activity with the user and `updatedAt`; it ends after `controlIdleSec` (default 30) without input. There is no acquire, release, takeover, or second authorisation object. The Screens card, table row, and Device Control header say "Controlled by Rani" while live and "Last controlled 12 s ago by Rani" for a short tail (default 120 s).

**Policy table.** Before starting activity X on a device whose list holds Y, the core answers `allow | warn | forbid` with a sentence:

| Starting, over existing | job / workflow-job | install | control (fresh input) | command | prep |
|---|---|---|---|---|---|
| job / workflow-job | forbid (queue behind it) | forbid | allow | warn | warn |
| install | forbid | forbid | allow | warn | warn |
| control | warn ("a job is running; your taps will interfere") | warn | allow, marker only | allow | allow |
| command (adb) | warn | warn | allow | allow | allow |
| transfer | allow | forbid | allow | allow | allow |
| wake / network-apply | forbid while a job runs | forbid | allow | allow | allow |

`warn` returns the sentence; Studio shows it once and proceeds on confirmation; a script or agent may pass `force: true`. `forbid` returns `E_DEVICE_CONFLICT` with the conflicting activity. Two rows are farm settings: control over control (default `allow`; `warn` or `forbid` selectable) and control idle seconds. A queued job whose device has a fresh `control` entry waits until the entry ends or `maxWaitSec` elapses. The job heartbeat (`heartbeatExpiresAt` on the run) stays as job liveness detection. The input arbiter stays with sources `{ kind: 'user' | 'job' | 'agent' }`. Capabilities declare `activity?: { kind, exclusiveWith?: kind[] }` and the invoke pipeline consults the policy table.

Plan 205 lands this section (source: MVP 04 §1). Open within it: whether `agent` is its own kind (proposed yes) and whether plugins may add kinds (proposed: deferred), MVP 04 §5.

### 4.4 Plugin

A plugin is the only way code reaches the farm. It is staged, verified, then activated; it has versions and exactly one active version; activation and rollback move every member script together and never delete older rows, so pinned jobs keep running. States: **active** or not ("latest" and "enabled" are not product words). Tables: `plugins`, `plugin_webhooks`, `kv_entries` (plugin KV, browsed from the Plugins page). A plugin may register scripts, navigation entries and views (`PluginSurface.nav`: id, label, icon, view), actions under `<plugin>/<verb>`, a service with `ctx.onRequest`, webhooks, and KV. Bundled packs are seeded once per `${name}@${version}` (record in `<dataDir>/seeded-packs.json`) and staged, not activated; editing a bundled plugin's source means bumping its version in all three sites (`package.json`, `src/index.ts`, `src/index.test.ts`) or the change never reaches a farm that has already booted.

### 4.5 Script

A script is a member of a plugin and has no version of its own. `scripts.version` remains as an internal denormalisation equal to the owning plugin's version, never shown, never listed, never documented as a script property; jobs display `plugin@1.2.0 / login`. Direct publish (`POST /api/scripts` publish branch, the non-plugin `enkaku publish`, the `script.publish` capability), the synthetic `recordings` owner, and `scripts.kind` are removed by plan 210 (MVP 03 §2.2, MVP 13 A.4). `script_param_sets` stay keyed on script name so presets survive plugin upgrades. The `defineScript` contract: `run()` does the work; `finish()` is stateless and idempotent because after a timeout kill the core runs it again in a fresh process. A script declares its runtime envelope (`timeoutMs`, `retries`, `maxRssBytes`, `maxConcurrent`) and, optionally, a result schema; the output verdict (`undeclared | valid | invalid | partial | oversize`) is stored on the run.

### 4.6 Workflow

A workflow is a document chaining scripts, authored in the Studio editor, owned by the farm, with no version. Table `workflows`: `name` (unique), `doc`, `createdBy`, `updatedAt`. Enqueuing a workflow job copies the validated document onto the job, so editing never changes a queued or running job. Workflows leave the `scripts` table (plan 210). Single device, sequential steps only for the MVP (MVP 05 §4; the CEO decision is recorded in `docs/mvp/README.md`, Open decisions 4).

### 4.7 Schedule

A schedule names a script or a workflow (`target: { kind: 'script', ref } | { kind: 'workflow', name }`), a device target (§11), and a cron. It owns one job per target device; every fire adds a run with `trigger = 'schedule'`. `onOverlap` (skip, queue, cancel previous) applies to the job's running run. The prototype's `schedule_runs` table is deleted by plan 211; `schedule_agent_targets` stays for agent schedules. Schedules are listed on the third tab of Scripts & Workflows.

### 4.8 Job, run, batch

```
jobs:      id, kind ('script' | 'workflow'), scriptRef | workflowName, params,
           deviceId, batchId?, scheduleId?, createdBy, createdAt,
           latestRunId, runCount
job_runs:  id, jobId, seq (1..n),
           trigger ('manual' | 'rerun' | 'schedule' | 'batch' | 'resume' | 'workflow-step'),
           status, startedAt, finishedAt, heartbeatExpiresAt,
           result, error, failureClass, errorPhase, infraAttempts, assistCount,
           resumedFromRunId?, resumedFromStep?
```

- A **job** is the intent: what to run, with which parameters, on which device, made by whom. Its id is stable; its displayed status is `latestRun.status`.
- A **run** is one execution. Re-running adds a run with `seq + 1`; earlier runs never change. Logs, trace frames, UI captures, artifacts, and the input audit are keyed by `runId`. Infrastructure retries stay inside a run (`infraAttempts`).
- A **batch** is the set of jobs created together from one target. `run-script` and `run-workflow` always create a batch, even for one device; a batch of one is displayed as its single job. "Re-run" adds a run to every job in the batch; "re-run failed" only to jobs whose latest run failed. A batch's status is the projection of its jobs' latest runs.
- A **workflow job** orchestrates script jobs as steps: each script step is a real script job with `parentWorkflowJobId` and `stepSeq`; gate steps are rows of the workflow run's step table with a verdict. `workflow_runs` per workflow job, `workflow_steps` per run; the prototype's `job_nodes` is deleted. Resume is a run with `trigger = 'resume'`, `resumedFromRunId`, `resumedFromStep`.
- Changing parameters before running again creates a new job, because the intent changed.
- Tables kept: `jobs`, `batches`, `artifacts`, `job_events` (the trace), `job_resumes` (until plan 211 folds it into runs), `schedules`, `scripts`, `script_param_sets`. Plans 210 and 141 land §4.5 to §4.8 (source: MVP 05, MVP 14).

### 4.9 Agent and files

An AI agent has a roster entry (`ai_agents`), threads, runs, messages, approvals, an inbox, spawn grants (`agent_threads`, `agent_runs`, `agent_messages`, `agent_approvals`, `agent_inbox`, `agent_spawn_grants`), connectors (`connectors`), notifications (`notifications`, `webhook_endpoints`), and files (`workspace_files`, `agent_blobs`; shown as Files under Agents). Agents stay in the core, compacted to one page with their settings on that page (MVP 06 §4.2). An agent run appears on a device as an `agent` activity. The agent surface is not yet designed; TBD by plan 220 (source: MVP 06 §3, MVP 15 §2).

### 4.10 Farm, users, audit

`farm_settings` (§14), `users`, `sessions` (login sessions; only the sha256 of a token is stored), `api_tokens`, `audit_log` (who ran what, enrolled which device, activated which plugin), `nodes` (cloud mode, post-MVP, outside the definition of done).

## 5. Device layer

### 5.1 Five driver layers

A driver is five separate abstractions so each can be swapped alone. A factory assembles them into one `DeviceSession`; a script only ever sees that handle.

| Layer | Interface | Default engine | Alternatives |
|---|---|---|---|
| 1 Transport | `connect() disconnect() exec() serial stableId` | `adb-usb` | `adb-tcp` (wireless adb, remembered addresses, bounded subnet scan) |
| 2 Display | `start() onFrame(chunk, meta) stop()` | `scrcpy` (H.264, PTS carried in `FrameMeta`) | `screencap-loop` only when scrcpy is unavailable |
| 3 Input | `tap swipe key text gesture scroll keyDown keyUp pinch setClipboard getClipboard` | `scrcpy-uhid` (API 29 and up) | `scrcpy-sdk`, `adb-input` |
| 4 Inspector | `dump() find(sel) waitFor(sel) screenshot()` | `ui-server` in phase 1, `ui-tree` after plan 222 | the other of the two, then `uiautomator dump` |
| 5 Network | `capabilities apply(cfg) observe() revert() probe()?` | `none` | `adb-proxy`, `adb-reverse-proxy`, `vpn-helper` (§9) |

Engines declare the capability locks they take (for example `instrumentation`), so two engines cannot collide on one device.

### 5.2 Toolchain

adb, scrcpy-server, ui-server, and the guest agent APK are downloaded on first run into `<dataDir>/tools/<toolId>/<version>/` with an `active` pointer, sha256-verified against `packages/toolchain/manifest/enkaku-tools.json`, and never taken from the system PATH. adb is not redistributed (`LICENSES.md`). scrcpy-server is `swappable: false` and pinned to the core version. The guest agent APK resolves `ENKAKU_GUEST_AGENT_PATH`, then a local Gradle build, then the pinned artifact; it is never auto-built. Toolchain versions and `doctor` live under Settings (§13).

### 5.3 Session lifetime equals device lifetime

- When a device becomes online, the core builds its session in the background: forward, scrcpy server, control socket, wake, inspector prewarm, guest agent hello. The activity list shows `prep` while this runs, so a tile says "Preparing" only for a device that just arrived.
- The session stays up until the device goes offline or is forgotten. No idle TTL, no idle cap, no per-view build. The one knob is the connect-time stagger: concurrency per USB root (default 4) and a farm-wide ceiling (default 16), ordered by device number; a waiting device shows "Preparing, queued".
- A session whose scrcpy process dies is rebuilt with backoff; the tile shows "Recovering". Unplug and replug rebuild the session with no operator action. A core restart rebuilds every session under the stagger; the browser reconnects and attaches.
- Readiness desired is `awake` by default. A device an operator puts to sleep stays asleep with its session up; its tile shows a dark screen, not a loading panel.

Plan 206 lands this section (source: MVP 11 §1). Per-USB-root install serialisation and the lifecycle targets are plan 223 (MVP 09 §2).

### 5.4 Identity and admission

`stableId` is `ro.serialno`, then `ANDROID_ID`. A transport address change (USB port, TCP address) is not a new device. Admission: discovered, then added by an operator; a blocked device never appears again until unblocked; quarantine is automatic after N infrastructure failures and cleared by the `unquarantine` action.

## 6. Video

Phone MediaCodec → scrcpy-server over an adb forward → core demuxer (ring buffer, device PTS preserved) → one binary WebSocket frame per access unit (11-byte header carrying keyframe flag, dimensions, PTS) → Studio WebCodecs `VideoDecoder` → canvas. The host never transcodes; the Java side is never forked.

- **Two encoders per session.** The Screens encoder (`wall` profile in code: 480 px, 18 fps, about 1.1 Mbit) runs for the whole session; the Screens view attaches to it instantly. The control encoder (`control` profile) starts when a Device Control opens; until its first keyframe, Device Control shows the Screens stream upscaled, then switches; it stops with a short linger when the last Device Control on that device closes.
- **The browser is a viewer.** `stream.start` attaches to a running session and primes with the cached SPS/PPS and keyframe; it never builds. A device with no session answers with its activity (`prep`, `offline`), not a build. Only visible tiles are decoded.
- **Decode and paint.** `hardwareAcceleration: 'prefer-hardware'` with fallback to `'no-preference'` on `NotSupportedError` (200 §5 R3); `optimizeForLatency: true`; paint on `requestAnimationFrame`, newest frame wins, `decodeQueueSize` read and a keyframe requested when it grows; canvas `desynchronized: true, alpha: false`. A keyframe is obtained only through the `RESET_VIDEO` control message.
- **Latency is measured in band.** Device PTS travels to the decoder's chunk timestamp; a latency overlay (device PTS versus paint time, decode queue depth, dropped frames) is shown in Device Control's stats strip.
- **Backpressure.** Per viewer, drop to keyframe above the buffered-amount limit, plus Bun's `drain()` handler (200 §5 R8).

Profiles (launch arguments; a change rebuilds the encoder):

| Profile | maxSize | maxFps | bitRate |
|---|---|---|---|
| control `sharp` | 1600 | 30 | 4 000 000 |
| control `balanced` | 1080 | 30 | 2 500 000 |
| control `light` | 720 | 20 | 1 200 000 |
| Screens `balanced` (default) | 480 | 18 | 1 100 000 |

Whether `balanced` becomes the shipped control default is decided by plan 209 after plan 203 measures. Plan 203 lands the PTS path, the overlay, and the bench harness; plan 209 lands the quick wins (source: MVP 01 §4 steps 1 and 2). The cloud path (MVP 01 §4 step 3) and WebRTC (step 4) are post-MVP.

## 7. Input

**Rule.** While Device Control has focus, every key goes to the device. Focus is taken by clicking the cast and shown by a visible frame; it is released by clicking outside, by the release chord, or when the window closes.

| Host gesture | Device action | Mechanism |
|---|---|---|
| Click | tap; hold equals the real press length | `INJECT_TOUCH_EVENT` down/up |
| Press and hold | long press | same |
| Drag | touch move streamed live at 8 ms sampling | one `INJECT_TOUCH_EVENT` move per sample |
| Wheel; Shift+wheel | vertical; horizontal scroll at the pointer | `INJECT_SCROLL_EVENT` |
| Right click | Back | `BACK_OR_SCREEN_ON` |
| Middle click | Home | `INJECT_KEYCODE HOME` |
| Ctrl+drag (Cmd on macOS); Alt+drag | pinch around the screen centre; around the drag start | two touch pointers |
| Pointer leaves the canvas mid-drag | touch up at the last point | never a stuck finger |

Keyboard, three layers: hotkeys (Esc → Back always; Alt+H Home, Alt+S Recents, Alt+P power, Alt+R rotate, Alt+N notifications, Alt+M settings panel, Alt+O collapse panels, Alt+F fullscreen, Alt+K toolbar, Alt+C device clipboard to host, Alt+V host clipboard to device, Alt+Shift+K release focus; Cmd on macOS; the table is one export in `@enkaku/protocol`), key passthrough (every other key with real down and up through a UHID keyboard on API 29 and up, `INJECT_KEYCODE` with meta state below), and text (printable keys through UHID with no debounce; paste and anything UHID cannot express through the guest agent IME `text.commit`, falling back to `INJECT_TEXT`). Clipboard both ways. The 500 ms text debounce and the synthetic tap hold are gone; the synthetic hold survives only as a script-side option.

Toolbar: Back, Home, Recents, Power, Volume up/down, Rotate, Notifications, Screenshot, Paste, Copy, Keyboard, Keep awake, Fullscreen; every button's tooltip shows its hotkey from the same table. Device Control is one device; with several devices selected, the host banner fans `input.*` out to the selection client-side, each member getting a `control` marker; the server holds no mirror object.

New protocol messages: `input.scroll`, `input.keyEvent`, `input.pinch`, `clipboard.get`, `clipboard.set`. `input.*` stays single-device and fire-and-forget. Plan 209 lands the driver verbs and plan 215 the window (source: MVP 08 §1, §2). Open: the hotkey modifier (proposed Alt on Windows and Linux, Cmd on macOS, user-switchable) and a first-open overlay (MVP 08 §5).

## 8. Inspector

The inspector reads the UI tree for scripts, agents, and the Inspector tab.

**Phase 1 (plan 208, source: MVP 02 §4).** The engine is openatx ui-server, session-scoped: started in the background after the first video frame, kept until session close; the Inspect tab attach is a no-op when it is up. Start fails fast by reading the instrumentation's own stdout (`INSTRUMENTATION_STATUS`, `ClassNotFoundException` within 1 to 2 s); the 15 s ceiling is for the silent case only. `waitForIdleTimeout` and `waitForSelectorTimeout` are configured through the JSON-RPC configurator. The capability path (`deviceCall()`) awaits the session's inspector and never instantiates the dump engine while a ui-server is alive. The last dump is reused for a failing action's trace capture. A start that did not succeed is reported as a failure, never as `ready`.

**Phase 2 (plans 221 and 152, source: MVP 02 §4 phase 2, MVP 10 §1.1).** The default engine becomes `ui-tree`: an `AccessibilityService` in the guest agent exposing `ui.dump`, `ui.find`, `ui.watch` over the agent's control channel; `waitFor` subscribes to `TYPE_WINDOW_CONTENT_CHANGED` instead of polling. Enabled from adb (`cmd appops set <package> ACCESS_RESTRICTED_SETTINGS allow`, then `settings put secure`; 200 §5 R4). The degradation ladder becomes `ui-tree` → `ui-server` → `uiautomator dump`. Funding phase 2 is MVP 16 §4.4, recommended by the CTO, decided by the CEO.

Targets are in §17.

## 9. Network

The fifth driver layer routes a device's traffic without giving a script a raw shell. Three engines beside `none`:

| Engine | Auth | Enforcing | Needs the agent | What it is |
|---|---|---|---|---|
| `adb-proxy` | no | advisory | no | `settings put global http_proxy`; world-readable, credentials refused (`E_HTTP_PROXY_NO_AUTH`); health is structurally `unverified` |
| `adb-reverse-proxy` | yes | advisory | no | `adb reverse` to a proxy on the host that holds the credentials; re-established on every device-online transition |
| `vpn-helper` | yes | yes | yes | the guest agent's `VpnService` SOCKS5 full tunnel; the only engine an app cannot bypass; fail-closed with bounded recovery and re-arm |

Rules for every engine: configuration is bound to the device and survives client disconnect, reboot, and core restart until an explicit act removes it; declared intent (`getConfig()`) and observed state (`observe()`) are separate reads; `apply()` is not a success signal, only a passing `egress` probe moves health from `unverified` to `ok`, and `unverified` is never worded as success; credentials are referenced by id (`network_credentials`, AES-256-GCM at rest), never inlined; every change is written to `device_events` with secrets redacted; HTTPS interception is out of scope. The operator surfaces are the plugin views of `proxy-manager` and `mikrotik-routing` and the `[i]` engines popover in Device Control; the bulk verb is `set-network` (§11). A `network-apply` activity appears while a route is applied.

## 10. Plugins

The plugin pipeline is stage → verify → activate; rollback and disable are the other two lifecycle actions; dev slots exist for local development. A plugin's surface may add navigation entries under the static rail (rendered from `PluginSurface.nav`), views, actions (`<plugin>/<verb>`, §11), a service, webhooks, and KV. The icon allowlist maps ids to Phosphor names (200 §5 R6). Plugin views are the only place device-scoped plugin data is shown. `enkaku init` scaffolds a plugin; `enkaku publish` stages one. The Plugins page lists Plugin · Status · Scripts · Verified · Actions (Disable or Activate; overflow with Reset data, Remove). Whether the plugin service contract shrinks to what a bundled plugin has needed (`onQuery`, `onSocket`, `onWebhook`, `onEvent` have no users) is MVP 06's call; TBD by plan 219 (source: MVP 13 Part B, plugin surface).

## 11. Actions API

Every action takes a target and answers per device.

```
POST /api/actions/<verb>
{
  "target": { "deviceIds": ["…"] } | { "groupId": "…" } | { "tags": ["…"] },
  ...verb-specific parameters,
  "force": false            // acknowledge policy warnings (§4.3)
}
→ 202 { "operationId": "…",
        "results": [ { "deviceId": "…",
                       "status": "accepted" | "skipped" | "forbidden" | "warned",
                       "message": "…", "activityId": "…" } ] }
```

- One endpoint per verb, no `/:id/<verb>` routes. A single device is a list of one.
- Partial acceptance is normal. `warned` devices are not started until the caller repeats with `force: true`. `forbidden` carries the policy sentence.
- Long-running verbs create one activity per device; completion arrives on `device.activity`; `GET /api/operations/:id` returns the same array with final statuses.
- Verbs: `run-script`, `run-workflow`, `install`, `push`, `pull`, `adb`, `wake`, `sleep`, `reconnect`, `disconnect`, `cutover`, `forget`, `block`, `unquarantine`, `set-network`, `set-label`, `clear-label`, `set-group` (shown as "Move group"), `set-tags`, `prepare`, `retry-prepare`, `reprofile`, `screenshot`, `clear-cache`, `settings`. The first twelve entries of every action menu are the handoff's generic action set in its order (Reconnect, Disconnect, Install apk, Adb command, Run script, Screenshot, Sleep, Move group, Upload file, Clear cache, Settings, Forget); the rest sit in an overflow. Plugins add verbs as `<plugin>/<verb>`.
- Reads stay per device (`GET /api/devices/:id`, `/inspect/*`, `/screenshot`, `/logs`, `/files`); the only multi-device read is `GET /api/devices`. `input.*` over WebSocket is single-device and fire-and-forget.
- Errors follow `{ error: { code, message } }` with `E_DEVICE_CONFLICT` for a forbidden policy answer.

Studio: one dialog per verb, each with the `DevicePicker` as its first row in its own container, pre-filled from where it was opened, editable in place, three modes (devices, group, tags), readiness markers on the chips, `warned` and `forbidden` sentences inline, primary button "Continue for N devices". Plan 207 lands the API and plan 216 the dialogs (source: MVP 07). Open: `/api/actions/<verb>` versus `/api/devices/actions/<verb>` (proposed the former), MVP 07 §5.

## 12. Jobs and runs (execution)

- The queue is in SQLite; a scheduler claims the next run for a device whose policy answer is `allow` (or `warn` with `force`). Two queues, one scheduler: a workflow job creates a `workflow-job` activity and enqueues its script steps one at a time, waiting on each terminal status; nothing else may start a job on that device until the workflow job ends.
- Every run is a child process with crash containment: a hard timeout kill, then `finish()` again in a fresh process; a silence watchdog; a memory limit with `peak_rss_bytes` recorded; infrastructure retries with backoff and a failure class (`failureClass`, `errorPhase`).
- The trace: one event stream per run (`job_events`) with frames and UI captures per action, rendered as the Timeline (transport, lanes, frames, event panel). Typed text and clipboard writes are recorded as a length only.
- Artifacts are the file outputs of a run (frames, UI dumps, replay video, files a script saved), distinct from the JSON output snapshot.
- Retention is per run (§16).
- The prototype's `POST /api/jobs/:id/resume`, `POST /api/batches/:id/rerun` and `/rerun-failed` as job-creating routes, `job_nodes`, and `schedule_runs` are removed by plan 211. Plan 211 lands this section (source: MVP 05, MVP 14).

## 13. Studio

The design of record is `docs/mvp/design_handoff_enkaku_openpf/README.md` and the prototype HTML beside it, as corrected by MVP 15 §0.1 (Schedules under Scripts & Workflows; Workspace renamed Files under Agents; groups; no Console; Recordings deferred) and §1. `docs/design.md` is rewritten from the handoff as the screens land.

- **Shell.** A 60 px icon rail (Devices `ph-devices`, Scripts & workflows `ph-code`, Jobs `ph-lightning`, Plugins `ph-puzzle-piece`; then the dynamic plugin menu; then theme toggle, Settings `ph-gear`, avatar), a 44 px status bar (pulsing dot plus "System OK", `Devices n/m`, `Jobs n/m`, Alerts bell, clock in Geist Mono; no console toggle), one 16 px-radius page panel. Desktop-first, 1280 to 1600 px, usable to 960 px, no mobile layout. Theme persisted under `enkaku-theme`.
- **Devices.** Group tab pills with counts and a "+" popover (rename and delete by right-click); Discovered (N) opening a 452 px right sheet; search, filter, view, rescan icon buttons; a table with grid `38px 44px 1.3fr 108px 92px 138px 70px 74px 62px 62px 62px 76px 1.1fr` (checkbox · # · Device · Serial · OS · Endpoint · Batt · Temp · CPU · Mem · Disk · Uptime · Task) or a Screens card grid with width presets S 112 / M 146 / L 190 / XL 240. Selection: click toggles (deferred 200 ms), double-click opens Device Control, marquee drag, Ctrl/Cmd+A, tiered Escape. A floating "N selected" pill opens the generic action set; no per-row actions column. State dot: green free, amber someone controlling, red job running, grey disconnected, warn unauthorized; the reason only in a tooltip; the same mapping in table and grid. The Task column is the activity list. Live cast at every card width is proposed (MVP 16 §4.5, open).
- **Device Control.** A draggable floating window, not a modal; width `max(560 * (w/h) + 36, 380) + 52 + 274` px; a 52 px shortcut rail (Power, Volume up, Volume down, Mute, Back, Home, Recents, Rotate, Brightness, Clipboard); the cast with a 40 px stats strip (fps, resolution, codec, latency from §6); a 274 px info column with header (state dot, `#11`, name, `[i]`, close), the `[i]` popover (identity and active engines with Change), meta strip, and compact tabs Actions · Inspector (Snapshot, UI nodes, Node details) · Device (Jobs, Files). Double-clicking another device retargets the window. The host banner appears with several devices selected (§7).
- **Scripts & Workflows.** Tabs Scripts, Workflows, Schedules. Scripts table columns: Name (`plugin/script`, mono) · Plugin (version chip) · Params · Last run · Run; no version or enabled columns; "New script" opens the plugin scaffold or install flow. Workflows as cards with the step chain and a footer ("12 devices · daily 07:00"). The workflow editor and the Schedules tab are not yet designed.
- **Jobs.** Tabs Jobs and Batches; a 268 px left list with wrapping filter chips (All · Running · Queued · Success · Failed) and 12 rows per page; the right detail with a run picker in the header meta line ("run 3 of 3 ·"), Re-run, Open device, Export, and sub-tabs Inputs, Output, Logs, Timeline, Artifacts.
- **Plugins.** Table Plugin · Status · Scripts · Verified · Actions (§10).
- **Settings.** Two columns, the handoff's group structure, the field list of §14.
- **Agents.** Roster, Runs, Approvals, Files; placement open (MVP 16 §4.1); not designed.
- **Removed from the navigation.** The device page and its twelve tabs, Console, Recordings (deferred, code parked), Topology, Tools (into Settings), Workspace (into Agents), Nodes (post-MVP), and every redirect stub. Each new screen deletes its old route directory as it lands.
- **Rules.** Static export; links through `next/link`; Tailwind v4 classes (`bg-surface`, never bracket variables); workspace packages in `transpilePackages`; `@enkaku/ui` primitives; Geist and Geist Mono self-hosted (200 §5 R7); Phosphor icons (R6). A client must `GET /api/devices` before subscribing on `/ws`; there is no snapshot replay.

Plans 204 (tokens and primitives), 213 (shell), 214 (Devices), 215 (Device Control), 216 (dialogs), 217 (Scripts, Workflows, Schedules), 218 (Jobs), 219 (Plugins and Settings), 220 (Agents) land this section (source: MVP 15, MVP 03, the handoff). The undesigned screens (MVP 15 §2) are drawn before wave 3 starts (MVP 16 §5.3).

## 14. Settings

A setting is visible only if the right value differs between farms **and** a non-engineer can predict what changing it does. Everything else is advanced (one disclosure, default shown, reset), a constant (a named export with an `ENKAKU_*` environment override listed in `.env.example` under "support overrides"), removed with its feature, or moved to a device, a plugin, or the Agents page.

Visible (15): Farm name; Control quality (sharp, balanced, light); Screens quality (minimal, light, balanced, detailed); Networks to scan for wireless devices; Battery: pause jobs above N °C; Physical label on the screen (off, number, number and name); When someone controls a device another person just touched (allow, warn, forbid); Default job timeout; Reset the app before each job (never, always, on failure); Human-like touch profile (precise, natural, slow); Adb command action for operators (on, off); Users and API tokens (a table); Keep job history, logs, and traces for N days; Keep artifacts for N days or up to N GB; Egress probe endpoint.

Advanced (11), with defaults: max concurrent adb commands 8; max concurrent installs 1 per USB root; session build concurrency per USB root 4; infrastructure retries and backoff base 3, 1 s; job memory limit 256 MB; push / pull / bulk download caps 512 MB, 512 MB, 2 GB; install timeout 120 s; adb health probe interval 30 s; failures before quarantine 5; Screens bandwidth budget on WAN 20 Mbit; recovery resets per hour 6.

Layout: the handoff's two columns and groups (General; Connection: Host & daemon, ADB transport, Network scan; Automation: Job runner, Capture & replay; Storage: Artifacts, Retention; Farm: Groups, Privacy, Appearance, Advanced); fields the handoff draws that are constants here are not built. Per-device overrides keep the same visible set plus "use farm default". Config precedence is env > file > default; an invalid config fails the boot with `E_BAD_CONFIG` and never falls back. The schema file is expected under 600 lines (2 694 today). Plan 212 lands this section (source: MVP 12). Open: whether Retention is visible or advanced (proposed visible) and whether "reset the app before each job" is a per-script declaration with a farm default (proposed yes), MVP 12 §7.

## 15. Security and auth

- Server-authoritative: conflicts, policy answers, and ACL live in the core.
- Auth mode derives from the bind address: bound to loopback, the core may auto-create an admin and skip login; bound to anything else it is server mode, login is mandatory (argon2), sessions are stored as token hashes, and TLS is required unless `ENKAKU_ALLOW_INSECURE=1`. API tokens for scripts and agents.
- Crash containment is not a sandbox; a security boundary is post-MVP cloud work.
- Tool integrity: sha256 is mandatory for every downloaded tool.
- adb: per-device queue plus a global semaphore; `adb kill-server` only in `cycle()`, which drains sessions and activities first and reattaches remembered addresses afterwards.
- Audit: `audit_log` records who ran what, enrolled which device, activated which plugin.
- Data hygiene: the "reset the app before each job" policy (§14) clears app state between jobs so accounts do not leak between runs.
- Redaction: typed text and clipboard writes are stored as a length; proxy credentials are masked in every log and event.
- Multi-role authorisation beyond admin and operator is post-MVP (MVP 09 §8).

## 16. Retention

Per kind, with defaults: jobs and logs 30 days, trace frames 7 days, artifacts 30 days or a size cap, audit 90 days. Retention applies per run: old runs of a job expire individually; the job row stays while it has any run or while a schedule owns it, and is deleted by the same nightly sweeper otherwise. A Storage row in Settings shows usage per kind. TBD by plan 224 (source: MVP 09 §6, MVP 14 §5).

## 17. Non-functional targets (measured, not promised)

A number in this table is a **target** until the Measured column names a plan, a date, and the hardware. Until then it is not quoted to a client (MVP 09 §7).

| Metric | Target | Measured |
|---|---|---|
| Glass-to-glass latency, Device Control, LAN | restated by plan 203 after measuring; the prototype's 150 ms is the reference | not measured |
| Input leg (key or tap to visible effect) | measured with the same overlay | not measured |
| Device Control first picture (Screens stream) then sharp picture | under 100 ms, then under 2 s | not measured |
| Inspector attach, lab device | under 3 s warm, under 8 s cold | not measured |
| Inspector `find` p95 | under 200 ms | not measured |
| Inspector fallbacks during a 10-minute job run on 20 devices | zero | not measured |
| `waitFor` on a push event (phase 2) | resolves on the event, no poll interval | not measured |
| Core restart to all tiles live, owner's 20-device farm | under 60 s, no browser interaction | not measured |
| USB plug to first painted frame | under 5 s warm, under 20 s on first provisioning | not measured |
| USB unplug and replug to recovered stream | under 5 s, no operator action | not measured |
| adb child processes and forwards after 24 h | equal to the count at boot | not measured |
| Concurrent installs per USB root | serialised, never more than one | not measured |
| Screens view, 20 live tiles, 1 h | zero decoder rebuilds except on rotation, zero session restarts | not measured |
| Devices per host | 20 (owner's farm), then 100 on the lab host with the USB topology documented | not measured |
| First run to first device visible, without reading the guide | under 5 minutes | not measured |
| First-run tool provisioning | under 90 s | not measured |
| Full test suite on a laptop | under 2 minutes (then the "never run a full suite" rule is retired) | not measured |
| Settings schema file | under 600 lines | 2 694 today |

Plans 203 (latency), 208 and 152 (inspector), 206 (warm-up), 223 (lifecycle and scale), 224 (first run, test strategy) fill the Measured column. The harness is `scripts/bench-device-nfrs.ts`, extended by plan 203.

## 18. Release and packaging

- The release workflow builds per-OS core binaries on a `v*` tag, boots each and checks `/api/health` before publishing. The binary embeds the Studio export and the bundled packs.
- The release workflow builds the guest agent APK, signs it, computes its sha256, and writes the pin into the toolchain manifest in the same commit as the core release; a core release never ships with an agent pin it did not build (plan 221, source: MVP 10 §3).
- First run: tools are downloaded and verified in under 90 s; provisioning progress is the first thing Studio shows on a fresh install; `bun run doctor` becomes a screen, not only a CLI.
- Packaging for the MVP: single binary plus a browser is the CTO's recommendation; the desktop app (`apps/desktop`, Tauri) is parked outside the MVP definition of done, not deleted. Decision: CEO, `docs/mvp/README.md` Open decisions 6 and MVP 09 §4. TBD by plan 224 (source: MVP 09 §4).
- Test strategy: colocated unit tests; Studio component tests in one process with per-file mock hygiene or shrunk to the components with logic; one hardware smoke suite on the lab device on every merge to `main`. TBD by plan 224 (source: MVP 09 §5).

## 19. Guest agent

One APK, provisioned unattended over adb on every admitted device, containing only what must run as an ordinary Android app. Facets: route (`VpnService` SOCKS5 tunnel), screen label (wallpaper), text input (`EnkakuIme`: `text.commit`, `text.status`, the per-device "show soft keyboard with a hardware keyboard" preference), mock location, and, added by the MVP, `ui-tree` (§8) and `activity` (a read-only copy of the device's activity list, pushed by the host; shown stale when the host is silent). Capabilities are advertised by `hello()`; an agent without the new ones is an older build, not an error; `versionCode` increments on every release and the host re-installs when the device reports a lower one.

The status screen (no Compose, 2 s refresh, never overstates, no secrets, omits unknown rows, Copy report): Banner; Now (the activity list); Device (label and number, group, tags, stable id, model, Android version, battery, screen state); Farm link; Video (whether a scrcpy server process runs and at what resolution and fps); Inspector; Route; Checks; Keyboard; Label; Location; This build (with "host expects version X"). Buttons: Refresh, Copy report, Switch keyboard, Open accessibility settings. Plan 221 lands this section (source: MVP 10). Everything is verified on the lab device (Android 16) and spot-checked on the owner's farm before the MVP is called done.

## 20. What the prototype had and the MVP does not

The master list is `docs/mvp/13-removal-register.md`; each MVP plan carries the rows it owns in its §10 and proves them gone by grep. In short: the exclusive-hold model and its second authorisation object, mirror grants, the single-slot device state machine, the quiet-period gate; the console page, saved commands, command runs; direct script publish, script versions, the synthetic recordings owner, workflow rows in `scripts`; child-process workflow steps and `job_nodes`; `schedule_runs`; per-device action routes and their multi-device twins, two target pickers; the device page and its twelve tabs, Topology, Tools, Workspace, Nodes, and the redirect stubs; 89 of 115 settings; lazy session build, "Waking", idle TTLs; the WebRTC client, licensing, telemetry, and the other dead code in MVP 13 Part B. Cloud mode stays in the tree behind its mode flag and outside the definition of done (MVP 06 §4.1). Recordings are parked, not deleted (MVP 06 §4.3).

## 21. Section map from the prototype specification

For readers of `docs/archive/plans/*` and of code comments that cite the prototype spec (`docs/archive/spec-prototype.md`) by section number.

| Prototype § | Topic | MVP § |
|---|---|---|
| 1, 2, 3 | vision, principles, personas | 1 |
| 4 | architecture | 2, 3 |
| 5 | deployment modes | 1 (cloud is post-MVP), 18 |
| 6 | competitor analysis | `docs/mvp/README.md`, Reference competitor |
| 7, 7.1 | five driver layers, engines | 5 |
| 7.2, 7.3, 7.6, 7.7, 7.8 | toolchain, manifest, scrcpy pin, tool API, tool security | 5.2, 15 |
| 7.4 | inspector | 8 |
| 7.5 | stable identity | 5.4 |
| 7.9, 7.10 | network layer, vpn-helper | 9, 19 |
| 7.11 | device preparation | 5.3 (`prep` activity) |
| 8 | registry and schema-driven UI | 14 |
| 9 | input modes | 7 |
| 10, 10.1, 10.2, 10.5 | session, device state, exclusive hold, second authorisation | 4.3 (rewritten: activities and the policy table), 5.3 |
| 10.3, 10.4 | queue, adb serialisation | 12, 2 |
| 11, 11.1, 11.2, 11.3, 11.9 | script framework, trust model, output contract | 4.5, 12 |
| 11.4, 11.5, 11.6 | dependencies, lifecycle, plugins | 4.4, 4.5, 10 |
| 11.7 | workflows | 4.6, 4.8 |
| 11.8 | action recordings | deferred (MVP 06 §4.3) |
| 12, 12.1 to 12.6 | data model, agents, connectors, batches and schedules, console, trace | 4, 4.9, 12 (console: removed) |
| 13 | protocol | 2, 6, 7, 11 |
| 14 | security | 15 |
| 15 | enrollment, battery, thermal | 5.4, 14 |
| 16 | non-functional requirements | 17 |
| 17 | positioning | 1 |
| 18 | housekeeping and business plumbing | 15, 18 |
| 19 | Studio screens | 13 |
| 20, 21, 22 | roadmap, sources, open questions | `docs/plans/200-mvp-program.md` §4, MVP 16 §4 |
````

### 4.3 `scripts/spec-check.ts` edits

Three edits, all wording; no logic changes, so `spec-check.test.ts` is untouched.

Edit 1, header comment, lines 11 to 13 (verbatim today):

```ts
 * It fails — reports, for now; see FAIL_ON_GAP below — when a table, route,
 * or `page.tsx` screen exists whose name appears NOWHERE in `docs/spec.md`
 * and has NO `DIV-` row in `docs/spec-divergences.md`.
```

becomes:

```ts
 * It fails — reports, for now; see FAIL_ON_GAP below — when a table, route,
 * or `page.tsx` screen exists whose name appears NOWHERE in `docs/spec.md`
 * (the MVP specification, rewritten by plan 202) and has NO `DIV-` row in
 * `docs/spec-divergences.md`. That register was archived by plan 202 to
 * `docs/archive/spec-divergences.md` and is not read; the path below is
 * kept so plan 224 can decide whether the MVP spec gets a register of its
 * own or this pass is deleted. Until then every gap is reported against the
 * spec alone, which during the MVP rebuild is the intended signal: a table
 * or route the spec no longer names is one a plan still has to delete.
```

Edit 2, the switch comment, lines 50 to 53 (verbatim today):

```ts
// The switch. Exit code 0 today: 29+ divergence rows are open (plan 84 §3),
// so a hard failure would block every commit on day one (plan 84 §4.4). Flip
// this to `true` — and ONLY this — once `docs/spec-divergences.md` has zero
// open (undecided) rows and the register itself is complete (plan 84 §9 Q4).
```

becomes:

```ts
// The switch. Exit code 0 today: the MVP spec is a skeleton (plan 202) and
// the code still carries every prototype table and route the MVP removes, so
// a hard failure would block every commit until wave 3 lands. Plan 224 flips
// this to `true` — and ONLY this — once the spec is final and the gap is zero.
```

Edit 3, the NOTE, lines 231 to 232 (verbatim today):

```ts
    console.log(`  NOTE: ${relative(ROOT, DIVERGENCES_PATH)} does not exist yet.`)
    console.log('        Treating it as zero rows — nothing is recorded as a known divergence yet.')
```

becomes:

```ts
    console.log(`  NOTE: ${relative(ROOT, DIVERGENCES_PATH)} does not exist; the prototype register is archived at docs/archive/spec-divergences.md and does not count.`)
    console.log('        Treating it as zero rows: every gap below is against the MVP spec alone.')
```

Do not change `SPEC_PATH`, `DIVERGENCES_PATH`, `FAIL_ON_GAP`, or any exported function. Do not point `DIVERGENCES_PATH` at the archive: archived rows are history and must not count as coverage.

### 4.4 `scripts/check-plan-status.sh` and `ci.yml` comments

`check-plan-status.sh`, insert two comment lines directly above line 108 (`for plan in docs/plans/*.md; do`):

```bash
# Non-recursive on purpose: docs/archive/plans/ holds the prototype series
# (archived by plan 202) and is history, not a set of status claims to check.
for plan in docs/plans/*.md; do
```

`.github/workflows/ci.yml`, replace the eight comment lines 86 to 93 (starting `# Plan 84 (M49) §4.4 "closing the loop"`) with:

```yaml
      # Plan 84 (M49) §4.4 "closing the loop": a deliberately dumb name-presence
      # check for a table, route, or `page.tsx` screen that appears nowhere in
      # docs/spec.md (the MVP spec, plan 202). Warning only — it always exits 0
      # today (see FAIL_ON_GAP in scripts/spec-check.ts): the spec is a skeleton
      # and the code still carries the prototype tables and routes the MVP
      # deletes, so the gap list is the to-do list, not a failure. Plan 224
      # flips the single constant once the spec is final.
```

Line 94 (`- run: bun run spec:check`) stays.

### 4.5 `CLAUDE.md`, `docs/plans/00-overview.md`, `docs/mvp/README.md` edits

`CLAUDE.md` edit 1: replace lines 9 to 14 (the six bullets under `## Reference documents`) with:

```markdown
- `docs/spec.md` — the MVP specification, rewritten by plan 202 from `docs/mvp/`. A section with decided text is the single source of truth: if a plan or the code contradicts it, the spec wins. A section marked `TBD by plan NNN` has no authority; until that plan lands, the `docs/mvp/` document it names is the decision of record.
- `docs/plans/200-mvp-program.md` — **required reading before touching any MVP plan**: the rules for an executing agent, the plan format (§0 goal checklist, §10 removed, §11 handoff), the wave table, the verified external references, and the vocabulary (§2.4).
- `docs/plans/00-overview.md` — still binding for §3 (immutable stack decisions), §4 (repo/TS/API/test/commit conventions), §6 (plan template), §7 (Definition of Done); its roadmap describes the archived prototype series.
- `docs/plans/201-*.md` to `154-*.md` — the MVP series, one plan per wave-table row in 200 §4.
- `docs/mvp/` — the decision documents the MVP is built from (01 to 16 plus the design handoff); `16-consolidated-plan.md` wins where they disagree.
- `docs/archive/` — the prototype spec (`spec-prototype.md`), plans 01 to 129 plus the five M95 to M99 plans that carried the numbers 130 to 134, and the audits. History, not authority; `docs/archive/README.md` says how to resolve an old citation.
- `docs/design.md` — the Studio design system: tokens, screen patterns, writing rules, quality floor (rewritten from the design handoff as the wave 3 screens land).
- `docs/guide/` — user guides: `install.md`, `cloud.md`, `enrollment.md`, `redroid.md`, `mikrotik-routing.md`.
- `LICENSES.md` — the redistribution audit (adb is NOT redistributed; it is downloaded on first run and sha256-verified).

The MVP series (plans 200 to 154) is executed on branch `mvp`; read `docs/plans/200-mvp-program.md` first. `main` stays shippable for hotfixes until wave 3 lands.
```

`CLAUDE.md` edit 2, line 83: replace the fragment `Both drain sessions and leases (plus any running job the caller explicitly overrode)` with `Both drain sessions and activities (plus any running job the caller explicitly overrode)`. Nothing else on the line changes. (The code says "leases" until plan 205 renames it; `CLAUDE.md` states the rule, plan 205 makes the code match.)

`CLAUDE.md` edit 3, line 91: replace the fragment `and \`network\` (spec §7.9).` with `and \`network\` (spec §5 and §9).`. Nothing else on the line changes.

`docs/plans/00-overview.md` line 4 (verbatim today):

```markdown
> The product source of truth is `docs/spec.md` (Enkaku draft v0.2). If a plan contradicts the spec, the spec wins — then update the plan.
```

becomes:

```markdown
> The product source of truth is `docs/spec.md`, rewritten for the MVP by plan 202; the prototype spec this document was written against is `docs/archive/spec-prototype.md`. Plans 01 to 129 are archived under `docs/archive/plans/`; the MVP series starts at `200-mvp-program.md`, which is read before this document. §3, §4, §6 and §7 below remain binding. If a plan contradicts the spec, the spec wins, then update the plan.
```

`docs/mvp/README.md` line 11 (verbatim today):

```markdown
- `docs/spec.md` remains the single source of truth. Where an MVP document proposes changing a spec commitment, it says so explicitly.
```

becomes:

```markdown
- `docs/spec.md` was rewritten from these documents by plan 202 (the prototype spec is `docs/archive/spec-prototype.md`). A spec section with decided text wins over the document it was written from; a section marked `TBD by plan NNN` defers to the document it names until that plan lands. Where a document here cites `docs/spec.md:NNNN` by line, it means the prototype spec.
```

### 4.6 Link fixes in live documents

Exact substitutions, one per line. Nothing else in these files changes.

| File:line | Old fragment | New fragment |
|---|---|---|
| `.env.example:75` | `docs/plans/51-m24b-verified-egress-and-fail-closed.md` | `docs/archive/plans/51-m24b-verified-egress-and-fail-closed.md` |
| `docs/guide/install.md:272` | `[\`docs/tmp-try-arch-mikrotik.md\`](../tmp-try-arch-mikrotik.md)` | `[\`docs/archive/tmp-try-arch-mikrotik.md\`](../archive/tmp-try-arch-mikrotik.md)` |
| `docs/guide/install.md:277` | `\`docs/tmp-try-arch-mikrotik.md\` is` | `\`docs/archive/tmp-try-arch-mikrotik.md\` is` |
| `docs/guide/cloud.md:48` | `docs/plans/28-m12g-cloud-adb-endpoint.md` | `docs/archive/plans/28-m12g-cloud-adb-endpoint.md` |
| `docs/guide/physical-labelling.md:86` | `docs/plans/96-m61-hotfixes.md` | `docs/archive/plans/96-m61-hotfixes.md` |
| `docs/guide/physical-labelling.md:254` | `docs/plans/89-m54-device-identity-and-physical-labelling.md` | `docs/archive/plans/89-m54-device-identity-and-physical-labelling.md` |
| `docs/guide/record-and-replay.md:8` | `docs/plans/94-m59-action-recorder-and-task-scheduling.md` | `docs/archive/plans/94-m59-action-recorder-and-task-scheduling.md` |
| `docs/feat/kv-storage.md:6` | `\`docs/spec.md\` §12.4 is the product statement.` | `\`docs/archive/spec-prototype.md\` §12.4 was the product statement; the MVP spec covers it in \`docs/spec.md\` §4.4 and §10.` |
| `docs/feat/plugin-and-script.md:5` | `\`docs/spec.md\` §11 is the product statement.` | `\`docs/archive/spec-prototype.md\` §11 was the product statement; the MVP spec covers it in \`docs/spec.md\` §4.4 to §4.6 and §10.` |
| `docs/feat/plugin-proxy-manager.md:692` | `docs/plans/123-m88-bind-capability-probe` | `docs/archive/plans/123-m88-bind-capability-probe` |
| `docs/feat/plugin-proxy-manager.md:1344` | `[\`docs/overview.md\`](../overview.md) §11, spec §7.9, plan 114` | `[\`docs/archive/overview.md\`](../archive/overview.md) §11, \`docs/spec.md\` §9, plan 114` |
| `docs/feat/plugin-proxy-manager.md:1346` | each of `../plans/112-`, `../plans/114-`, `../plans/117-`, `../plans/118-`, `../plans/121-` | `../archive/plans/112-`, `../archive/plans/114-`, `../archive/plans/117-`, `../archive/plans/118-`, `../archive/plans/121-` |

`README.md:3` links `docs/spec.md` (now the MVP spec) and the directory `docs/plans/`; both remain valid and are not edited. `docs/guide/release-checklist.md:30,77` name `docs/spec.md` generically; not edited.

## 5. Implementation steps

Work on branch `mvp`. Commit prefix `chore(mvp-202): …`. Never `git stash`, never a whole-tree checkout (200 §2.2). step 202.1 and 202.2 are one commit so the tree never has an archive without its README.

### 202.1 Move the prototype documents with `git mv`

Files created: `docs/archive/`, `docs/archive/plans/` (directories).
Files changed: none.
Files deleted (moved): `docs/spec.md`, `docs/overview.md`, `docs/ux-audit.md`, `docs/settings-audit.md`, `docs/spec-divergences.md`, `docs/tmp-try-arch-mikrotik.md`, 206 files under `docs/plans/`.
Test file: none (a filesystem change).

```bash
mkdir -p docs/archive/plans
git mv docs/spec.md docs/archive/spec-prototype.md
for f in overview ux-audit settings-audit spec-divergences tmp-try-arch-mikrotik; do git mv docs/$f.md docs/archive/$f.md; done
# every prototype plan: numbers 01..129 (including 22.0, 22.1 and the two 56-*) plus the five 13x-m9x plans
for f in $(ls docs/plans | rg '^(0[1-9]|[1-9][0-9]|1[0-2][0-9])[.-]|^13[0-4]-m9'); do git mv "docs/plans/$f" "docs/archive/plans/$f"; done
ls docs/archive/plans/*.md | wc -l      # expected: 136
ls docs/plans                           # expected: 00-overview.md, 200-mvp-program.md, and any 13x/14x/15x MVP plan already written
```

Verifiable result: G2 and G3 greps are empty; `git status --short docs | rg '^R' | wc -l` prints `142` (136 plans, the spec, five audits). If the plan count is not 136, list the unexpected names in the report and move nothing that does not match the pattern.
Do not: copy and delete (history must follow); do not move `docs/plans/200-mvp-program.md` (untracked, and the live program document); do not touch `docs/mvp/`, `docs/design.md`, `docs/guide/`, `docs/feat/`, `docs/research/`, `docs/benchmarks/`; do not delete `.DS_Store` files (untracked litter, outside this plan).

### 202.2 Write `docs/archive/README.md`

Files created: `docs/archive/README.md` (the verbatim text of §4.1; replace "136 plans" only if step 202.1 counted differently).
Files changed: none.
Test file: none.
Verifiable result: G5; G12's grep over this file is empty.
Do not: add a table of every archived plan (the directory listing is the index); do not restate MVP decisions here.

Commit: `chore(mvp-202): archive the prototype spec, plans, and audits under docs/archive`.

### 202.3 Write the new `docs/spec.md`

Files created: `docs/spec.md` (the verbatim text of §4.2, with `<DATE>` replaced by the commit date `YYYY-MM-DD`).
Files changed: none.
Test file: none; verified by `bun run spec:check` (G7) and the greps in G6 and G12.
Verifiable result: G1, G6, G7, G12. `bun run spec:check` prints a long gap list (expected; it is the removal to-do) and exits 0.
Do not: fill a `TBD` section with text of your own; do not renumber sections; do not add a "history" or "changelog" section; do not paste prototype spec paragraphs (they use the forbidden vocabulary and carry history notes); do not reduce the gap count by adding table or route names the MVP removes.

Commit: `chore(mvp-202): write the MVP spec skeleton from docs/mvp`.

### 202.4 Retarget the spec check's wording

Files changed: `scripts/spec-check.ts` (the three edits of §4.3), `.github/workflows/ci.yml` (the comment of §4.4).
Files created / deleted: none.
Test file: `scripts/spec-check.test.ts` (unchanged; run it).
Verifiable result: `bun test ./scripts/spec-check.test.ts` prints ` 15 pass`, ` 0 fail` (G8); `bun run spec:check` output contains `docs/archive/spec-divergences.md` and exits 0 (G7); `rg -n "does not exist yet" scripts/spec-check.ts` prints nothing.
Do not: change `DIVERGENCES_PATH`; do not flip `FAIL_ON_GAP`; do not remove `divergenceRowLines` or `computeGaps`'s third argument (the tests import them); do not add a second spec path.

### 202.5 Comment the plan-status check

Files changed: `scripts/check-plan-status.sh` (two comment lines above line 108, §4.4).
Test file: none; the script is its own test.
Verifiable result: between step 202.2 (which creates `docs/archive/README.md`, this plan's `Ships:` artefact) and step 202.8 (which flips this plan's status to `implemented`), `bash scripts/check-plan-status.sh` prints exactly one `MISMATCH` line, for `202-mvp-docs-reset.md` ("says draft but docs/archive/README.md exists"), and exits 1. That is expected and is the only line allowed to differ from a clean run; any other `MISMATCH`, `UNBUILT`, or `UNDECLARED` line is a defect to report. G9 (exit 0 and the final line `  every plan that declares an artefact agrees with the code`) is verified at step 202.8.
Do not: add a recursive scan; do not add an exclusion list; do not make the script read `docs/archive/`.

Commit (202.4 and 202.5 together): `chore(mvp-202): point the doc checks at the archived register and the new spec`.

### 202.6 Update `CLAUDE.md`; check `AGENTS.md`

Files changed: `CLAUDE.md` (the three edits of §4.5).
Files created / deleted: none.
Test file: none.
Verifiable result: G10; `rg -n "01\.\.16" CLAUDE.md` prints nothing; `rg -n "spec §7.9" CLAUDE.md` prints nothing. Then run `git status --short AGENTS.md`: it prints `?? AGENTS.md` (untracked); read its line 3 and confirm it names Codex; leave the file unchanged and record in the report: "AGENTS.md is untracked and duplicates the pre-132 CLAUDE.md; left as is (§9 Q4)".
Do not: edit `AGENTS.md`; do not `git add AGENTS.md`; do not delete it; do not remove the plugin-seeding paragraph from `CLAUDE.md` (it is still true); do not change any other bullet under "Rules that get broken".

### 202.7 Repoint the live documents

Files changed: `docs/plans/00-overview.md` (line 4), `docs/mvp/README.md` (line 11), and the twelve line edits of §4.6 in `.env.example`, `docs/guide/install.md`, `docs/guide/cloud.md`, `docs/guide/physical-labelling.md`, `docs/guide/record-and-replay.md`, `docs/feat/kv-storage.md`, `docs/feat/plugin-and-script.md`, `docs/feat/plugin-proxy-manager.md`.
Test file: none.
Verifiable result: G11's grep is empty; `rg -n "Enkaku draft v0.2" docs/plans/00-overview.md` prints nothing; `rg -n "remains the single source of truth" docs/mvp/README.md` prints nothing.
Do not: touch any other line of those files; do not edit `docs/mvp/01..16`; do not edit code comments that cite `docs/plans/NN-*.md` (§2); do not edit `README.md:3`.

Commit (202.6 and 202.7 together): `chore(mvp-202): point CLAUDE.md, the overview, and the guides at the new docs layout`.

### 202.8 Final verification and status

Files changed: `docs/plans/202-mvp-docs-reset.md` (the `> Status:` line starts with `implemented` and states the date; §0 boxes ticked; §11 filled).
Verifiable result: every G row passes in order; `bun run typecheck` clean (G13); `ps -Ao pid=,command= | grep -i "[o]penpf"` shows only your shell.
Do not: write `implemented` while a G row is unticked; do not run any test beyond §7.

Commit: `chore(mvp-202): mark plan 202 implemented`.

## 6. Acceptance criteria

1. G1 to G13 pass, in that order, from the repo root on `mvp`.
2. `docs/plans/` contains `00-overview.md`, `200-mvp-program.md`, this plan, and nothing else numbered below 131 or slugged `-m9x`.
3. `docs/archive/README.md` exists, names the four live documents, lists the five M95 to M99 plans by name, and contains none of G12's words.
4. `docs/spec.md` has sections §0 to §21 in the order of §4.2; every `TBD by plan NNN` names a plan in 131 to 154; the word "sandbox" appears only inside the phrase "never called a sandbox" or "is not a sandbox" (`rg -n -i sandbox docs/spec.md` prints exactly those lines).
5. CI's `check` job would pass its three doc steps: `bash scripts/check-plan-status.sh`, `bun run spec:check`, `bun test ./scripts/spec-check.test.ts`.
6. `CLAUDE.md` contains the paragraph "The MVP series (plans 200 to 154) is executed on branch `mvp`; read `docs/plans/200-mvp-program.md` first."
7. Every commit message starts with `chore(mvp-202):`; no attribution lines.
8. The §11 handoff report is filled in.

## 7. Test plan

No package code changes, so no package test is scoped to this plan. The only test run is the one file the plan touches the neighbourhood of:

```bash
bun test ./scripts/spec-check.test.ts        # the leading ./ is load-bearing (ci.yml:95-101); expected: 15 pass, 0 fail
```

Manual smoke, in this order, all from the repo root:

```bash
bun run spec:check; echo "exit=$?"            # exit=0; NOTE line names docs/archive/spec-divergences.md; a long gap list is expected
bash scripts/check-plan-status.sh; echo "exit=$?"   # exit=0; last line: every plan that declares an artefact agrees with the code
bun run typecheck                             # clean
rg -c "^## " docs/spec.md                     # 22
ls docs/archive/plans/*.md | wc -l            # 136
git log --follow --oneline -- docs/archive/spec-prototype.md | head -3   # at least two commits: the move and an older one
```

Do not run `bun test`, `bun test packages/...`, or any Studio, ui, plugin, or examples suite: nothing under `packages/`, `plugins/`, `apps/`, or `examples/` changes in this plan. No device is needed; nothing is gated on `ENKAKU_TEST_DEVICE`.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Plans 201, 203, 204 run in the same wave and may edit `CLAUDE.md` or add files to `docs/plans/` while this plan runs | The `git mv` step moves only files matching the prototype patterns, so a new `13x-*.md` MVP plan is untouched. `CLAUDE.md` edits are line-scoped (§4.5); if a line has drifted, match on content and record the discrepancy. Commit 202.1 and 202.2 first, before any other plan's commits pile up. |
| R2 | An agent following an archived plan's `docs/spec.md §N` citation reads the new spec's §N and gets the wrong topic | Spec §21 is the map; `docs/archive/README.md` says the old numbers refer to `spec-prototype.md`; `CLAUDE.md` names the archive as history. |
| R3 | `spec:check`'s gap list becomes long and someone "fixes" it by naming removed tables in the spec | step 202.3's "Do not"; the §4.3 comments say the gap list is the removal to-do. |
| R4 | `AGENTS.md` (untracked, Codex-facing) keeps the pre-132 reference list and rules | Recorded in the report and in §9 Q4; the owner decides whether to delete or regenerate it. |
| R5 | About 100 code comments cite `docs/plans/NN-*.md` paths that no longer resolve | §2 non-goal, documented resolution rule in the archive README. Plans that touch those files may fix the comment in passing. |
| R6 | The `Ships:` artefact `docs/archive/README.md` exists while the plan is still `draft` between step 202.2 and 202.8, so `check-plan-status.sh` reports one MISMATCH in the interim | step 202.5 names that line as the only allowed difference; step 202.8 clears it. CI does not run between local steps. |
| R7 | A later MVP plan author writes a spec section without reading §0's rules and appends history notes | Spec §0 states the rewrite rule; 200 §3.3 binds plan authors to the spec. |
| R8 | The five `13x-m9x` plans reference artefacts plans 205 to 149 delete; their `Ships:` lines go stale in the archive | Archive README rule 3 says so explicitly; the checker does not scan the archive. |

## 9. Open questions

Only things a human must decide. The steps above do not depend on any of them.

1. **`docs/guide/*.md` (11 user guides).** Recommendation: stay live; plan 224 updates them for the MVP product (first run, packaging). Several describe removed surfaces (`record-and-replay.md`, `workflows.md` "under one lease", `cloud.md`), so they will be wrong for a while. Owner: CTO.
2. **`docs/research/android-guest-agent.md` and `docs/benchmarks/webrtc.md`.** Recommendation: stay where they are; they are cited by MVP 02 and MVP 01 as research, and neither claims authority. Owner: CTO.
3. **`docs/feat/*.md` (three design records: kv-storage, plugin-and-script, plugin-proxy-manager).** Not named by the brief. They cite the prototype spec by section and stay accurate as design history; recommendation: leave live until plans 210 and 149 decide whether they are rewritten or archived. Owner: CTO.
4. **`AGENTS.md`.** Untracked, duplicates the pre-202 `CLAUDE.md` for Codex. Options: delete it; regenerate it from `CLAUDE.md` after this plan and keep it untracked; or track it as a symlink or copy so future `CLAUDE.md` edits apply to both. Owner: repo owner.
5. **Spec §18 packaging** (single binary plus browser versus the desktop app) is the CEO's decision (`docs/mvp/README.md` Open decisions 6, MVP 09 §4); the spec records the CTO's recommendation and a `TBD by plan 224`. Not decided here.
6. **Spec §13 Agents placement** (fifth rail icon versus first plugin entry) and **live cast at every Screens card width** are MVP 16 §4.1 and §4.5; recorded as open in the spec. Not decided here.

## 10. Removed

Rows from `docs/mvp/13-removal-register.md` A.10 (docs) that this plan owns, plus the wording this plan retires. The `\|` transcription rule of §0 applies to the proof column.

| What | Where it was | Proof |
|---|---|---|
| The prototype `docs/spec.md` as the live spec (all 22 sections, including §10.5 co-control, §10.1 and §10.2's hold model, §11.4's workflow exemption, §11.8 recordings, §19's screen list) | `docs/spec.md` | `rg -n -i -w "co-control\|heldBy\|assistedBy\|quiet period" docs/spec.md` → empty; `rg -c "^## " docs/spec.md` → `22`; `test -e docs/archive/spec-prototype.md` |
| Prototype plans 01 to 129 in the live plan directory | `docs/plans/` | `ls docs/plans \| rg '^(0[1-9]\|[1-9][0-9]\|1[0-9][0-9])[.-]'` → empty |
| Prototype plans M95 to M99 numbered 130 to 134 | `docs/plans/13[0-4]-m9*.md` | `ls docs/plans \| rg '^13[0-4]-m9'` → empty |
| `docs/ux-audit.md` | `docs/` | `test ! -e docs/ux-audit.md` |
| `docs/settings-audit.md` | `docs/` | `test ! -e docs/settings-audit.md` |
| `docs/spec-divergences.md` (the `DIV-` register as a live document) | `docs/` | `test ! -e docs/spec-divergences.md` |
| `docs/tmp-try-arch-mikrotik.md` | `docs/` | `test ! -e docs/tmp-try-arch-mikrotik.md` |
| `docs/overview.md` | `docs/` | `test ! -e docs/overview.md` |
| The reference-list bullet `docs/plans/01..16-*.md — milestone plans M0–M10` | `CLAUDE.md:11` | `rg -n "01\.\.16" CLAUDE.md` → empty |
| "drain sessions and leases" in the `adb kill-server` rule | `CLAUDE.md:83` | `rg -n "sessions and leases" CLAUDE.md` → empty |
| `(spec §7.9)` as the citation for the network layer | `CLAUDE.md:91` | `rg -n "spec §7\.9" CLAUDE.md` → empty |
| "does not exist yet" NOTE about the divergence register | `scripts/spec-check.ts:231` | `rg -n "does not exist yet" scripts/spec-check.ts` → empty |
| "Enkaku draft v0.2" as the named source of truth | `docs/plans/00-overview.md:4` | `rg -n "draft v0.2" docs/plans/00-overview.md` → empty |
| "`docs/spec.md` remains the single source of truth" | `docs/mvp/README.md:11` | `rg -n "remains the single source of truth" docs/mvp/README.md` → empty |
| Relative links into the moved files from live documents | `docs/guide/install.md`, `docs/guide/cloud.md`, `docs/guide/physical-labelling.md`, `docs/guide/record-and-replay.md`, `docs/feat/*.md`, `.env.example` | the G11 grep → empty |

Forbidden vocabulary introduced by this plan's area (200 §2.4), proven absent from the documents it writes: `rg -n -i -w "lease\|leases\|cluster\|clusters\|co-control\|assist\|heldBy\|assistedBy" docs/spec.md docs/archive/README.md` → empty (G12). The archived files keep the prototype's words by design (archive README rule 4).

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
