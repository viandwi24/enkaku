# Plan 77 — M42 : VFS, Skills, and the Plugin System

> Status: implemented — `packages/core/src/agent/harness/enkaku-vfs.ts`'s `EnkakuVFS implements VFS` (`@enkaku/harness`) drives Plan 64's `WorkspaceStore` exactly as upstream drives `PostgresVFS`: `writeIfVersion` is a direct pass-through to the store's `ifMatch` compare-and-swap, `version` is the store's **sha256** (recorded in a code comment so nobody "fixes" the sha1/sha256 mismatch later), and every method (`read`/`stat`/`write`/`writeIfVersion`/`delete`/`list`/`grep`) enforces the caller's own read/write scope — the bare `VFS` interface carries none of its own. An optional `root` chroots an instance into a subtree (relative paths, matching upstream's own per-project convention) and an optional `writeExcludePrefixes` refuses a write regardless of scope; both are used by the skills driver. §7's contract suite (`agent/harness/enkaku-vfs.test.ts`, `describe.each` over the harness's own `MemoryVFS` and `EnkakuVFS`, 2×18 shared cases) found no divergence; 24 more cases cover `EnkakuVFS`-only behaviour (sha256 shape, scope enforcement including the negative grep case, the `root`/`writeExcludePrefixes` options). `workspace/store.ts` gains `grep(prefix, pattern)` (step 77.1, one scan, capped at 200 hits with an honest `truncated` flag, invalid regex finds nothing rather than throwing) plus a new `fs.grep` capability (`capability/fs.ts`) for a human via Studio. `tools/file-tools.ts`/`tools/smart-replace.ts` come across with their bodies unchanged as `files.list`/`.read`/`.write`/`.edit`/`.delete`/`.grep`/`.todo` (`capability/file-tools.ts`) — a surface distinct from (and offered alongside) `fs.*`; the read-before-edit `Session` needs to survive across many `invoke()` calls to mean anything, so `capability/context.ts`'s new `fileToolsSessionFor(actor, runId)` keeps one per agent run (keyed off the now-optional `CapabilityContext.fileToolsSession`, wired live in `agent/harness/context.ts`'s tree branch) or per human/MCP actor identity otherwise, bounded at 2,000 entries. `/skills/` is read-only to a running agent: `capability/fs.ts`'s `SKILLS_PREFIX` check (gated on `ctx.currentRunId !== null`, so a human via Studio is unaffected) covers `fs.write`/`.delete`/`.move`, and `EnkakuVFS`'s `writeExcludePrefixes` (set by `capability/file-tools.ts`'s `vfsFor`) covers `files.write`/`.edit`/`.delete` the same way — unconditionally, even if an agent's own `workspaceScope.write` was configured to include `/` (a gap the plan's own §4.4 wording implied but which needed its own fix and test once file-tools existed as a second write surface). `agent/harness/skills.ts`'s `createSkillsVfs` builds one read-only, `/skills`-rooted `EnkakuVFS` that `skills.list`/`skills.read` (`capability/skills.ts`) read through — dedicated tools, never the general file tools. The plugin system (`agent/plugins/`) ports `AgentPlugin`/`defineAgentPlugin` (`types.ts`) and the fail-fast merge plus boot-time dry run (`index.ts`) with the plan's one change — `tools` returns `AnyCoreCapability[]`, not a raw `ToolSet` — regrouping the existing registry into ten plugins (`device-control`, `device-inspect`, `device-apps`, `device-files`, `fleet`, `workspace`, `skills`, `automation`, `orchestration`, `notify`; no capability handler rewritten) with a runs-at-module-load dry run that a real boot reaches transitively through `agent/runner.ts`'s import of `assembleSystemPrompt`. `buildRunEnv` (`agent/runner.ts`) splices each enabled plugin's STATIC prompt section (gated to plugins the run actually holds a capability of, in registry order) onto the agent's own system prompt; `agent/plugins/index.test.ts` asserts the assembled prefix is byte-identical across two calls with the same inputs, and `agent/runner.test.ts` gained two new tests proving a real run's captured system prompt does (and does not) include a plugin section depending on its granted capability ids. `bun run typecheck` is green across all 12 packages; root `bun test` is 2169 pass / 0 fail (baseline 2071 + 98 net new, every new test in this plan's own files); `bun run --cwd packages/studio test` is 326 pass / 0 fail, unchanged from baseline (this plan ships no UI — that is Plan 78). `scripts/check-harness-provenance.sh` exits 0 (`packages/harness/src` untouched). **Plan 64's own workspace suite (`workspace/store.test.ts`, `workspace/path.test.ts`) passes with every existing assertion unedited** — `store.test.ts` only gained new `grep` cases; `capability/fs.test.ts` (Plan 64's capability-layer suite, a different file) DID need editing: `fsWrite`/`.delete`/`.move`'s handlers gained the `/skills/` exclusion criterion 11 requires, and the test file's `fakeCtx` helper gained a third, optional, backward-compatible `currentRunId` parameter (defaulting to `null`, so every pre-existing call site and assertion is byte-for-byte unchanged) to exercise it — recorded here rather than silently, since the plan asks specifically whether any test needed an edit. **Deviations, recorded rather than silent:** (1) two grep surfaces exist by design, not oversight — `fs.grep` (§4.2, structured `{hits, truncated}`, store-level, for Studio) and the harness's own `grep` case inside `files.grep` (string-formatted, session-bound, part of the seven ported file tools) — they share no code path beyond both ultimately calling `WorkspaceStore.grep`. (2) the skills plugin's prompt section deliberately does NOT call the harness's own `skillsSystemBlock` (which lists live skill names/descriptions) because that output is dynamic and would violate criterion 9's static-prompt requirement; the section instead gives fixed instructions to call `skills_list` first, and criterion 10 is satisfied by the tool call itself, not by the prompt. (3) `PluginBuildCtx` is `Record<string, never>` (effectively empty) rather than carrying a live `vfs`/`session`/`projectId` the way upstream's does — Enkaku's capabilities are already fully self-contained consts invoked later through `invoke()` with a fresh `CapabilityContext` per call, so there is nothing live to hand a plugin at build time; the parameter is kept only so the shape (and the boot-time dry run) matches upstream. **Not done:** slash commands (`AgentPlugin.commands`) are declared in the type but no plugin populates one — §9's open question 2 says this is expected to stay inert until Plan 78 gives it a composer to wire into.
> Ships: packages/core/src/agent/harness/enkaku-vfs.ts
> Depends on: Plan 64 (the workspace store this drives), Plan 75 (the harness package), Plan 76 (the loop that consumes the tools).
> Source of truth for the port: `packages/harness/src/{vfs/*,tools/*,skills.ts}` and `bitorex-algo/packages/server/src/quant/{postgres-vfs.ts,plugins/*,skills.ts}`.

---

## 1. Goals

- The harness's **`VFS` interface** is what agents edit through, driven by Plan 64's workspace store — the same way upstream drives it with `PostgresVFS`.
- **File tools** and **smart-replace** come across as-is and become capabilities.
- **Skills** work: drop a folder with a `SKILL.md` into the workspace and an agent discovers it, with no code change.
- The **plugin system** comes across: one feature contributes one prompt section plus its capabilities, merged fail-fast with a boot-time dry run.

## 2. Non-goals

- Replacing Plan 64's workspace store. It stays: path validation, quotas, compare-and-swap, `workspace_files`, the Studio browser. This plan puts the harness's interface **in front of** it.
- Replacing Plan 63's capability registry. A plugin registers capabilities into it; it does not bypass it (Plan 76 §3.2).
- The UI (Plan 78).

## 3. Context and design decisions

### 3.1 A driver, exactly as upstream does it

`vfs/types.ts` declares an async `VFS`: `read`, `stat`, `write`, `writeIfVersion`, `delete`, `list`, `exists`, `grep`, with `version` as a **content hash**. Upstream implements it once per backend — `PostgresVFS implements VFS` (`postgres-vfs.ts:9`) — and everything above it is backend-blind.

So Enkaku writes `EnkakuVFS implements VFS` over Plan 64's `createWorkspaceStore()`. That is the sanctioned extension point, not an adaptation.

The two designs already agree on the hard part. `writeIfVersion(path, content, expected)` is compare-and-swap; Plan 64 §3.4 built exactly that as `ifMatch`, for exactly the same reason — two writers must not silently lose one another's work. The mapping is direct:

| `VFS` | Plan 64's store |
|---|---|
| `read` / `stat` | `read` — returns content and `hash` |
| `write` | `write` without `ifMatch` (create) or with (overwrite) |
| `writeIfVersion` | `write` with `ifMatch`; `false` on `E_STALE` |
| `delete` / `list` / `exists` | `delete` / `list` / derived from `read` |
| `grep` | **new** — §3.2 |

One discrepancy to settle rather than paper over: the harness hashes with **sha1** (`hashContent`, `vfs/types.ts`), Plan 64 stores **sha256**. Both are equality-only change detection, neither is a security claim. `EnkakuVFS` returns the store's sha256 as the `version` string — the interface says "content hash", not "sha1" — and `hashContent` goes unused here. Recorded so nobody later "fixes" the mismatch by rehashing every row.

### 3.2 `grep` is the one method Plan 64 does not have

Every other `VFS` method maps onto something that exists. `grep(pattern)` does not, and file tools use it.

It is added to the workspace store rather than implemented in the driver by scanning: the store owns the table, so a SQL `LIKE`/`GLOB` scan over the scoped prefix is one query instead of N reads. It respects the caller's scope (Plan 64 §3.2) — a grep that searched outside an agent's read scope would leak the contents of files it may not open, which is worse than a listing leak.

Results cap at a sane limit with a truthful "more matches were not shown", never a silent truncation.

### 3.3 File tools become capabilities, keeping their bodies

`tools/file-tools.ts` (174 lines) and `tools/smart-replace.ts` (63) come across unchanged. What changes is their **packaging**: upstream they are an AI SDK `ToolSet` bound to a VFS; here each becomes a Plan 63 capability whose handler calls the same function, so the projection in Plan 76 §3.2 turns them back into a `ToolSet` with `invoke()` in between.

That indirection is not ceremony. It is what gives a file tool a permission, an audit entry, and a per-agent workspace scope — none of which the upstream tool has, because upstream has no multi-tenant device farm behind it.

`smart-replace.ts`'s cascade (exact → line-trimmed → whitespace-normalised) is ported verbatim. It is the kind of small heuristic that is easy to reimplement subtly worse.

### 3.4 Skills, and where they live

`skills.ts` (90 lines) defines skills as folders holding a `SKILL.md` with frontmatter, discovered from a VFS, surfaced to the model as a prompt block, and read through **dedicated** tools (`list_skills`, `read_skill`) rather than the general file tools.

That separation is the design's point and it survives the port: a skill is reference material an agent consults, not part of the workspace it edits. Mixing them would let an agent rewrite its own instructions mid-run — which is both a correctness problem and, given an agent reads attacker-controllable device screens, an injection target.

Skills live under `/skills/` in the workspace, **read-only to agents**: `list_skills` and `read_skill` may read there; `fs.write`'s scope excludes it. A human edits skills through Studio's workspace browser.

Upstream's `quant/skills.ts` (534 lines) is the *content* of one application's skills, not the mechanism. It is not ported — Enkaku's skills are about driving phones.

### 3.5 The plugin system is the piece worth the most

`plugins/types.ts` (53 lines) is the best idea in the source project, and it is small:

```ts
export interface AgentPlugin {
  id: string
  title: string
  prompt: string                       // STATIC — prompt-cache friendly, introspectable
  tools: (build: PluginBuildCtx) => ToolSet
  commands?: QuantCommand[]
  skills?: string[]
}
export function defineAgentPlugin(plugin: AgentPlugin): AgentPlugin { return plugin }
```

with an assembler (`plugins/index.ts`, 122 lines) that merges **fail-fast** — a duplicate tool or command name **throws** instead of silently overriding — and **dry-runs every plugin's `tools` at boot** with a stub context to catch collisions before a user ever chats.

Enkaku already has half of it. Plan 63's registry has the boot-time duplicate check and the JSON Schema dry run. What it lacks is the grouping: there is no object that says "this feature contributes these capabilities *and* this prompt section". Today a capability's description is per-capability and the system prompt is one field on the agent.

So `AgentPlugin` comes across with one change: `tools` returns **capabilities**, not a raw `ToolSet`.

```ts
tools: (build: PluginBuildCtx) => CoreCapability[]
```

Everything else holds — `prompt` stays a static string for the cache-prefix reason (Plan 65 §3.4 requires nothing time-varying in the prefix, which is the same constraint upstream's D13.2 states), the assembler stays fail-fast, the dry run stays.

`commands` (slash commands) comes across as a declaration now and is wired in Plan 78, where there is a composer to type them into.

### 3.6 Which plugins ship

Upstream's plugins are trading features (`backtest.ts` 563 lines, `strategy.ts` 385) and are **not** ported. What ships is the mechanism plus Enkaku's own capabilities regrouped into plugins along the lines they already fall on:

| Plugin | Capabilities |
|---|---|
| `device-control` | `device.tap`, `.swipe`, `.scroll`, `.fling`, `.type`, `.key` |
| `device-inspect` | `device.find`, `.dump`, `.waitFor`, `.screenshot` |
| `device-apps` | `device.app.launch`, `.app.forceStop`, `.install` |
| `device-files` | `device.push`, `.pull`, `.clipboard.*` |
| `fleet` | `device.list`, `.get`, `.wake`, `.sleep` |
| `workspace` | `fs.*` plus the ported file tools |
| `skills` | `list_skills`, `read_skill` |
| `automation` | `script.*`, `job.*` |
| `orchestration` | `agent.spawn`, `.send`, `.reply`, `.status`, `.cancel` |
| `notify` | `notify.send` |

Each gains the prompt section its capabilities need — the thing that is missing today, where a model gets tool descriptions but no framing for a whole area.

## 4. Technical design

### 4.1 `packages/core/src/agent/harness/enkaku-vfs.ts`

`EnkakuVFS implements VFS`, constructed with the workspace store and a scope (Plan 64 §3.2). Mirrors `postgres-vfs.ts`'s shape. `version` is the store's sha256 (§3.1).

### 4.2 Workspace store gains `grep`

§3.2: scope-respecting, capped, honest about truncation. New `fs.grep` capability alongside it, so a person can search from Studio too.

### 4.3 `packages/core/src/agent/plugins/`

- `types.ts` — `AgentPlugin`, `defineAgentPlugin`, `PluginBuildCtx`, ported with §3.5's one change.
- `index.ts` — the fail-fast assembler and boot dry run, ported.
- one file per §3.6 plugin, each a thin regrouping of existing capabilities plus its prompt section. **No capability handler is rewritten.**

### 4.4 Skills

`skills.ts` ported to `agent/harness/skills.ts`, reading `/skills/` through `EnkakuVFS`. `list_skills` and `read_skill` become capabilities with `effect: 'read'`. `fs.write`'s default scope excludes `/skills/`.

### 4.5 System prompt assembly

The agent's `systemPrompt` becomes: the agent's own instructions, then each enabled plugin's `prompt` section in **registry order**. Stable and static, so Plan 65 §3.4's cache prefix holds.

A plugin section appears only when the agent has at least one of its capabilities — an agent with no `agent.spawn` should not read about orchestration.

## 5. Implementation steps

**77.1 — `grep` on the workspace store** (§4.2), scope-respecting and capped. First, because `EnkakuVFS` needs it.

**77.2 — `EnkakuVFS`** (§4.1), tested against the same expectations `vfs/memory.ts` satisfies.

**77.3 — File tools and smart-replace** as capabilities (§3.3), bodies unchanged.

**77.4 — Plugin types and assembler** (§4.3), ported with fail-fast and the boot dry run.

**77.5 — Regroup existing capabilities into plugins** (§3.6) and write each prompt section.

**77.6 — Skills** (§4.4), including the `/skills/` scope exclusion.

**77.7 — System prompt assembly** (§4.5).

## 6. Acceptance criteria

1. `EnkakuVFS` satisfies every `VFS` method; a test suite written against the interface passes for both it and the harness's `memory.ts`.
2. `writeIfVersion` returns `false` on a stale version and does not write; a concurrent pair loses exactly one writer.
3. `version` is the store's sha256 and is stable across reads of unchanged content.
4. `grep` respects the caller's scope — a pattern matching a file outside it returns nothing — is capped, and says so when it truncates.
5. File tools and smart-replace behave identically to upstream: the cascade resolves exact, line-trimmed, and whitespace-normalised matches in that order.
6. Every file tool goes through `invoke()`, with a permission, an audit entry, and the agent's workspace scope enforced.
7. A duplicate capability id across two plugins **fails the boot**, naming both plugins.
8. Every plugin's `tools` is dry-run at boot with a stub context; a throwing plugin fails the boot rather than the first chat.
9. Every plugin's `prompt` is a static string; nothing time-varying appears in it, and a test asserts the assembled prefix is byte-identical across two builds.
10. A `/skills/` folder with a `SKILL.md` is discovered and readable through `read_skill` with no code change.
11. An agent **cannot write** to `/skills/`; `fs.write` there is refused with `E_OUT_OF_SCOPE`.
12. A plugin's prompt section appears only when the agent holds at least one of its capabilities.
13. Prompt caching still works: a non-zero cache read on the second turn (Plan 66 §6.13 unedited).
14. Plan 64's workspace suite passes **unedited** — the store is driven, not replaced.
15. `bun run typecheck` passes; `bun test` and `bun run --cwd packages/studio test` are green.

## 7. Test plan

**Contract suite:** one suite written against `VFS`, run against `memory.ts` and `EnkakuVFS`. Any divergence is a driver bug, and this is the cheapest way to find it.

**Unit — `grep`:** in scope, out of scope, cap reached, special characters not breaking the query.

**Unit — smart-replace:** each cascade level, and a no-match returning no match rather than a wrong one.

**Unit — assembler:** duplicate ids across plugins; a plugin throwing during dry run; prompt sections in registry order; a section omitted when its capabilities are absent.

**Unit — skills:** frontmatter parsed; a malformed `SKILL.md` skipped with a warning rather than failing the boot; `fs.write` to `/skills/` refused.

**Integration:** an agent writes a file, reads it back, greps for it, and publishes it as a script — the three-gate story from Plan 64 §3.5, now through the harness tools.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. /workspace → create /skills/checkout/SKILL.md with frontmatter
# 2. ask an agent what skills it has → it names it
# 3. ask it to read the skill → the content comes back
# 4. ask it to WRITE to /skills/ → refused, by name
# 5. ask it to write and publish a script → still works
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The driver diverges from the interface in a corner nobody tests. | §7's contract suite runs the same tests against the harness's own `memory.ts`, so a divergence is a failing test rather than a surprise in a run. |
| `grep` leaks file contents from outside an agent's scope. | Criterion 4 tests the negative directly; the scope check is in the store, not the driver, so no caller can skip it. |
| An agent rewrites its own skills mid-run. | `/skills/` is excluded from `fs.write`'s scope and criterion 11 tests the refusal. |
| Regrouping capabilities into plugins changes behaviour. | §4.3 forbids rewriting any handler; Plan 63's own suite is the check. |
| Plugin prompt sections bloat the prefix and cost more than they earn. | Sections are per-capability-group and only appear when relevant (criterion 12); the prefix is cached (criterion 13), so a longer stable prefix is cheap after the first turn. |
| The sha1/sha256 mismatch gets "fixed" later by rehashing. | §3.1 records why the interface's `version` is sha256 here, in the plan and in the driver's own comment. |

## 9. Open questions

1. Should skills be versioned like scripts (Plan 62)? A skill is instructions an agent follows; changing one silently changes behaviour, which is the same argument that produced `name@version`.
2. `commands` (slash commands) ship as declarations here and are wired in Plan 78. If Plan 78 slips, they are inert — visible in the registry, doing nothing.
3. Upstream's `overlay.ts` composes a writable base with read-only layers. `/skills/` read-only over a writable workspace is exactly that shape, and this plan does it with a scope rule instead. If a second read-only mount ever appears, the overlay driver is already ported and waiting.
