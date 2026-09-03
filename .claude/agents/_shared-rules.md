# Shared rules for the MVP executor agents

This file is documentation, not an agent: it has no `name` field, so Claude Code skips it. It exists so the four executor prompts do not drift apart. When you change a rule here, change it in every agent file that repeats it.

Every MVP executor is bound by, in this order: `docs/plans/200-mvp-program.md`, `docs/plans/00-overview.md` §3 §4 §7, its own plan, and `CLAUDE.md`.

The rules that matter most, because breaking them has already cost this project real money and hardware:

1. **Never run a bare `bun test`, and never two test runs at once.** Four agents running the Studio suite concurrently once overheated the maintainer's laptop for six minutes. Run only the files your plan's §7 names, one invocation at a time.
2. **Studio and `@enkaku/ui` have zero tests.** Never write a `*.test.tsx`.
3. **Never delegate.** No subagents. A plan author who spawned four research agents burned 300 000 tokens and produced no file.
4. **Never run a whole-tree git operation** (`stash`, `reset --hard`, `checkout -- .`). One agent wiped 324 files out from under three others.
5. **`adb kill-server` exists in exactly one function in this workspace.** Do not add a second.
6. **A plan is not done until its §10 greps return nothing.** Deletion is part of the deliverable.
