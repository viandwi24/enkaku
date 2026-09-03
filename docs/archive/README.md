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
