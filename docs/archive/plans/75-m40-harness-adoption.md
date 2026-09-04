# Plan 75 — M40 : Adopting the Harness

> Status: implemented — `packages/harness` is a first-class workspace package: `harness` added to `scripts/typecheck.sh` between `session` and `core` (75.1); `core/resilient.ts` and `session/message-store.ts` carry the §3.5 unreferenced-file header note, added ONLY as a prepended comment block (75.2), verified against upstream by the new `scripts/check-harness-provenance.sh` (diffs `packages/harness/src` against `bitorex-algo@9eab029`, allowing exactly those two files to differ and only by added comment lines — exit 0). `@ai-sdk/anthropic@4.0.33`, `@openrouter/ai-sdk-provider@3.0.0`, and `ai@7.0.55` are core dependencies; `@anthropic-ai/sdk` is removed from `packages/core/package.json` and no file imports it (grep-verified — the only remaining occurrences are prose mentions inside comments, e.g. `loop/errors.ts`'s duck-typing note, which never imported it either). `packages/core/src/agent/provider/anthropic.ts` is rewritten on `@ai-sdk/anthropic` (`createAnthropic` + `streamText`, iterating `result.fullStream`): §3.4's four parameters (`thinking:{type:'adaptive'}` never `budget_tokens`, `output_config.effort`, `fallbacks:'default'`, the prompt-cache breakpoint after the last tool definition) all reach the real wire request via `providerOptions.anthropic` — verified empirically against `@ai-sdk/anthropic`'s actual serialised HTTP body (not an intermediate object) in nine new `anthropic.test.ts` cases using a fake `fetch` that captures the outgoing JSON and answers a scripted SSE stream; none were lost. `buildAnthropicRequestBody` (the pre-existing raw-JSON builder) is untouched byte-for-byte and still serves `countTokens()` and both `request.test.ts` and `anthropic.test.ts`'s original assertions unedited — `stream()` no longer calls it. `listModels()`/`countTokens()`/`testAnthropicConnection()` now call Anthropic's REST endpoints directly (`/v1/models`, `/v1/messages/count_tokens?beta=true`) since the AI SDK has no equivalent, Zod-parsing every response. `packages/core/src/agent/provider/openrouter.ts` is the new second connector kind, same shape, on `@openrouter/ai-sdk-provider`; `packages/core/src/agent/provider/message-mapping.ts` holds the one `ProviderMessage → ai ModelMessage` conversion both adapters share. `ProviderAdapter` (`provider/types.ts`) gains `languageModel(modelId): LanguageModel` (implemented by both adapters, unused until plan 76) and `countTokens` returns `{tokens, estimated}` — Anthropic `estimated: false` (exact, from the real endpoint), OpenRouter `estimated: true` (anchored to the last real `stream()` response's own `usage.inputTokens`, plus a character-count estimate over only the messages appended since — never a full-history restringify). `ConnectorKindSchema` gains `'openrouter'` (`connectors.kind` is free text, confirmed no migration needed); `ENKAKU_OPENROUTER_API_KEY` joins `ENKAKU_ANTHROPIC_API_KEY` as a kind-aware env fallback in `connector-store.ts` (`envApiKey` is now `(kind) => ...`, structurally backward-compatible with `connector-store.test.ts`'s existing zero-arg fakes) and both are documented in `.env.example` for the first time (neither was there before this plan, a plan 65 gap this closes). Studio's connector kind `<Select>` (`app/settings/page.tsx`) gains an OpenRouter option; `lib/agents.ts`'s hand-mirrored `ConnectorKind` type (Studio cannot import server-only `@enkaku/core`) is widened to match. `bun run typecheck` (`bash scripts/typecheck.sh`) is green across all 12 packages; root `bun test` is 2102 pass / 0 fail (baseline 2072 + 30 net new, every new test in this plan's own three files — `anthropic.test.ts`'s 14 additions, the new `openrouter.test.ts`'s 13, and the new `e2e-connector-kinds.test.ts`'s 2 definitions × 2 connector kinds); `bun run --cwd packages/studio test` is 326 pass / 0 fail, unchanged from baseline. No real network call is made anywhere in the test suite (criterion 13) — every adapter test injects a fake `fetch`, including a hand-built SSE fixture builder for `stream()` (both an Anthropic `event:`-framed one and an OpenRouter OpenAI-compatible one). **Deviations, recorded rather than silent:** (1) `ProviderAdapter.languageModel()` takes a `modelId: string` parameter — the plan's own §4.2 sentence shows it with no arguments, but a connector's adapter is created once per connector while a run picks its model per agent, so a parameterless `languageModel()` cannot express "which model"; every real call site (a future plan 76) will need to pass one regardless. (2) §4.3 says "Plan 76 owns compaction.ts" in the same breath criterion 10 requires "the compaction threshold applies a margin when estimated" — `compaction.ts` itself is untouched (only `createTokenEstimator`'s parameter type moved from `Pick<ProviderAdapter,'countTokens'>` to a locally-scoped `{countTokens(req): Promise<number>}` shape, a type-only edit `compaction.test.ts`'s existing bare-number fake still satisfies unedited); the actual unwrap-and-margin logic (`ESTIMATED_TOKEN_MARGIN = 1.15`, applied only when the last count was `estimated`) lives in `run.ts`, right where `tokenEstimator.estimate()` is already called — satisfying criterion 10 without editing compaction.ts or its test. (3) The plan's illustrative provider-error shape assumption (duck-typed `.status`/`.type`, `loop/errors.ts`) is preserved by translation: `@ai-sdk/anthropic`/`@openrouter/ai-sdk-provider` throw `AI_APICallError` with `.statusCode`/`.data.error.{type,message}` (verified empirically, not the old SDK's `.status`/`.type` directly) — both new adapters map this to the exact `{status,type,message}` shape `classifyError` already duck-types, so `loop/errors.ts` itself needed no change and still never imports a provider SDK's types. (4) `countTokens`'s OpenRouter estimate is per-adapter-instance closure state (anchored token count, anchored message count), not persisted — a fresh adapter (a new run) starts from zero and estimates the whole first request's character count, matching "the previous response's usage plus a character estimate for the tail" for every request after the first real `stream()` call within that instance's lifetime. (5) A new integration test file, `packages/core/src/agent/e2e-connector-kinds.test.ts`, was added beyond the plan's explicit step list — it is the one test that does NOT inject `RunnerDeps.createProvider` (unlike every existing loop/runner test), instead faking only the `fetch` seam, so it is the sole proof that the connector-kind branch in `provider/index.ts` actually reaches a real adapter end to end for both kinds (criterion 8, §7's "integration (fake transport)" row) rather than being proven only through provider-level unit tests.
> Ships: packages/harness/src/index.ts
> Depends on: Plan 65 (`ProviderAdapter`), Plan 66 (the loop that will be replaced by the harness's).
> **First of the harness series (75–78).**
> Source of truth for the port: `/Users/solpochi/Projects/devs/bitorex/bitorex-algo/packages/harness`.

---

## 1. Goals

- `packages/harness` is a **real workspace package** — typechecked in CI, tested, and importable as `@enkaku/harness`.
- Enkaku talks to models through the **Vercel AI SDK**, the way the harness already does.
- **OpenRouter** and **Anthropic** are both connector kinds, using the same packages the source project uses.
- The copied code stays **recognisably the source**. Every divergence is deliberate and recorded.

## 2. Non-goals

- Rewriting the harness to Enkaku's house style. It is imported code; it keeps its own shape, semicolons and all. Reformatting would destroy the ability to diff it against upstream, which is the whole point of copying rather than reimplementing.
- Replacing Enkaku's agent loop with the harness's. That is Plan 76.
- The VFS, skills, or file tools. Plan 77.
- Any UI. Plan 78.

## 3. Context and design decisions

### 3.1 What the copy already proved

The package was copied verbatim before this plan was written, and three things came out better than predicted:

| Prediction | Reality |
|---|---|
| Zod 3 vs Zod 4 would be a blocking conflict | It compiles today. `zod@4.4.3` ships a `v3` compat subpath and the harness resolves through it. Only **4 files** import zod at all, two of them tests. |
| The code would need heavy adaptation to TS 7 | `bunx tsc --noEmit -p packages/harness` → **0 errors** across all 28 files, verified real by planting a deliberate type error and watching it fail. |
| The tests would not run | `bun test packages/harness` → **15 pass, 0 fail**. |

So this is not a rescue operation. The starting position is working code, and the work is integration rather than repair.

### 3.2 It stays on the v3 compat layer for now, deliberately

`00-overview` §3 mandates Zod 4 at every boundary, and the harness currently resolves `zod` to Zod 4's bundled v3 compatibility surface. That is a real divergence from the rule.

It is not corrected in this plan. The boundary the rule protects is where **external input** enters — WS frames, HTTP bodies, JSON DB columns, config files. The harness's four zod usages are none of those: they are AI SDK tool-parameter schemas, which the SDK itself validates. Migrating them is a small, separate change (§9.1) and doing it in the same commit as the initial adoption would make the first diff against upstream unreadable.

What this plan does add is the thing that makes the divergence safe: `packages/harness` joins `scripts/typecheck.sh`'s list, so it can never silently drift.

### 3.3 The AI SDK comes with the harness, not instead of it

`packages/harness/package.json` declares `ai@^7.0.7`. That is the dependency the harness needs to function, and adopting the harness means adopting it.

The source project's own wiring (`packages/server/src/quant/registry.ts:1-2`) builds models with `createDeepSeek` and **`createOpenRouter`**, then hands the result to the harness as `HarnessConfig.model` — a `LanguageModel` from the AI SDK. So the provider layer is already provider-agnostic upstream, and OpenRouter is already a solved case there, not a new design.

Enkaku's `ProviderAdapter` (Plan 65) becomes the place that produces that `LanguageModel`:

| Connector kind | Package |
|---|---|
| `anthropic` | `@ai-sdk/anthropic` |
| `openrouter` | `@openrouter/ai-sdk-provider` |

`@anthropic-ai/sdk` is removed. Two client styles side by side is the thing this series exists to end.

### 3.4 Four Anthropic parameters must survive the move, or be reported lost

The current direct-SDK adapter sends four things that Plans 65, 66 and 70 depend on:

| Parameter | Why it matters |
|---|---|
| `thinking: { type: 'adaptive' }` | `budget_tokens` is rejected with a 400 on Opus 5 |
| `output_config.effort` | Plan 65's per-agent effort knob |
| `fallbacks: 'default'` | resilience |
| `cache_control` after the tool definitions | Plan 65 §3.4's stable prefix; Plan 66 §6.13 asserts a non-zero cache read |

The AI SDK passes provider-specific fields through `providerOptions` — which is exactly what `HarnessConfig.providerOptions` (`config.ts:33`) exists for, and what the source project uses for DeepSeek's `reasoningEffort`.

**Step 75.4 asserts each of the four reaches the request individually.** Anything that cannot be passed is named in the status header as a capability lost in the move, never quietly dropped. A capability lost loudly is recoverable.

### 3.5 The dead code comes across and is marked, not deleted

`core/resilient.ts` (65 lines) is a second loop the earlier analysis identified as never called. `session/message-store.ts` (94 lines) was in the same category.

They are copied because a verbatim copy is worth more than a curated one: the next person diffing against upstream should see the same file list. But each gets a header comment recording that it is unreferenced here, so nobody builds on it by accident. Deleting them is a follow-up once the series has settled (§9.2).

### 3.6 What this plan deliberately does not touch

The harness's loop is not yet used. After this plan, `@enkaku/harness` is present, typechecked, tested, and importable — and Enkaku's own `agent/loop/` is still what runs. Plan 76 makes the switch, with the migration of budgets, approval gates, leases and the run tree onto the harness's loop as its whole subject.

Landing adoption separately means that if Plan 76 goes badly, the fallback is "the harness is present but unused", not a half-migrated loop.

## 4. Technical design

### 4.1 The package

Already created: `packages/harness/{src,package.json,tsconfig.json}`, name `@enkaku/harness`, exporting `./src/index.ts`, depending on `ai@^7.0.7` and `zod@^4.0.0`.

`package.json.bitorex-original` is kept beside it as the provenance record — the upstream manifest, unedited.

Remaining: add `harness` to `scripts/typecheck.sh`'s package list, between `sdk` and `session`.

### 4.2 Provider adapters — `packages/core/src/agent/provider/`

- `anthropic.ts` — rewritten on `@ai-sdk/anthropic`, keeping its exported surface (`createAnthropicAdapter`, `testAnthropicConnection`, `pinnedModelFallback`, `assertApiKey`) so no caller changes.
- `openrouter.ts` — new, same surface, mirroring `registry.ts:2`'s `createOpenRouter` usage.
- `index.ts` — the kind branch gains `openrouter`.
- `types.ts` — `ProviderAdapter` gains `languageModel(): LanguageModel`, so Plan 76 can hand the model straight to `HarnessConfig`.

`stream()` and `ProviderEvent` stay for now: Enkaku's loop still consumes them, and removing them in the same plan that adds the AI SDK would mean two loops changing at once.

### 4.3 `countTokens` on OpenRouter

OpenRouter has no token-counting endpoint. `countTokens` returns `{ tokens, estimated }`:

- Anthropic → exact, `estimated: false`
- OpenRouter → the previous response's `usage` plus a character estimate for the tail, `estimated: true`

`estimated` is load-bearing: Plan 66's compaction threshold applies a safety margin when it is set, and Plan 73 §3.2 already requires Studio to label an estimate as one. A number that looks exact and is not is how a run dies at the context limit having reported room to spare.

Do **not** port the harness's `estimateTokens` shape here — `compaction.ts` computes `JSON.stringify(...).length / 4` over the full history twice per iteration, which is both wrong and quadratic. Plan 76 owns that file; this plan only needs the adapter's own estimate, over the appended tail, cached.

### 4.4 Protocol, storage, env

`ConnectorKindSchema` gains `'openrouter'`. `connectors.kind` is free text validated by that schema — **confirm no migration is needed before writing one.**

`ENKAKU_OPENROUTER_API_KEY` joins `ENKAKU_ANTHROPIC_API_KEY` as an env fallback (Plan 65 §3.6); `.env.example` records both.

### 4.5 Studio

The connector editor gains a kind selector. The model dropdown, "Test connection", and the per-agent model field already read from the connector and need no change.

## 5. Implementation steps

**75.1 — `harness` into `scripts/typecheck.sh`** and confirm CI covers it.

**75.2 — Mark the unreferenced files** (§3.5) with a header note; delete nothing.

**75.3 — Dependencies**: add `@ai-sdk/anthropic` and `@openrouter/ai-sdk-provider`; remove `@anthropic-ai/sdk` last, once nothing imports it.

**75.4 — `anthropic.ts` on the AI SDK** (§4.2), asserting §3.4's four parameters individually.

**75.5 — `openrouter.ts`** (§4.2), including `listModels` from `/api/v1/models` with each model's real context length.

**75.6 — `countTokens` and the honest estimate** (§4.3).

**75.7 — Kind branch, protocol, env fallback, Studio kind selector** (§4.4, §4.5).

## 6. Acceptance criteria

1. `packages/harness` is in `scripts/typecheck.sh` and typechecks clean; its 15 tests run in `bun test`.
2. The copied files are **byte-identical to upstream** except for §3.5's header notes — verifiable by diffing against `bitorex-algo@9eab029`.
3. `package.json.bitorex-original` is present and unedited.
4. No file imports `@anthropic-ai/sdk`, and it is gone from `packages/core/package.json`.
5. An agent on an `anthropic` connector behaves as before: Plans 66 and 70's suites pass **unedited**.
6. `thinking: {type:'adaptive'}`, `output_config.effort`, `fallbacks`, and a `cache_control` breakpoint after the tool definitions each **reach the request**, asserted individually. Anything that cannot is named in the status header.
7. `budget_tokens` is never sent.
8. An `openrouter` connector can be created, tested, and used by an agent end to end against a fake transport.
9. `listModels()` returns OpenRouter's catalogue with a real `contextWindow` per model; a failed call falls back to a pinned list labelled as a fallback.
10. `countTokens` returns `{tokens, estimated}` — `false` for Anthropic, `true` for OpenRouter — and the compaction threshold applies a margin when estimated.
11. `ProviderAdapter.languageModel()` returns an AI SDK `LanguageModel` for both kinds.
12. `ENKAKU_OPENROUTER_API_KEY` works as a fallback credential and is in `.env.example`.
13. No real network call is made in any test.
14. `bun run typecheck` passes; `bun test` and `bun run --cwd packages/studio test` are green.

## 7. Test plan

**Provenance:** a test (or a documented command) diffing `packages/harness/src` against the upstream path, allowing only the §3.5 header lines. This is what keeps criterion 2 true as the series proceeds.

**Unit — request shape:** §3.4's four parameters asserted individually against the built request; `budget_tokens` absent.

**Unit — `countTokens`:** exact for Anthropic; estimated for OpenRouter; the margin applied only when estimated.

**Integration (fake transport):** a full run on each connector kind — one tool call, one text turn, usage recorded.

**Regression:** Plans 66 and 70's suites unedited (criterion 5).

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. Settings → Connectors → add OpenRouter, paste a key, Test → ok
# 2. the model dropdown fills from OpenRouter's catalogue
# 3. point an agent at it, send a message → it answers
# 4. ask it to screenshot a device → the image path still works (plan 70)
# 5. switch the agent back to Anthropic → still works
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The AI SDK cannot express one of the four Anthropic parameters and it is dropped silently. | Criterion 6 asserts each individually, and anything lost must be **named**. Plan 66 §6.13's cache-read assertion fails independently if the breakpoint does not reach the wire. |
| The harness diverges from upstream and stops being diffable. | Criterion 2 and §7's provenance check; the whole reason for copying rather than reimplementing. |
| The v3 compat layer is removed by a future zod release. | `harness` in the typecheck list (75.1) turns that from a runtime surprise into a build failure. §9.1 is the planned migration. |
| An OpenRouter estimate makes the loop compact too late. | `estimated` is carried, a margin applied, and the figure labelled in Studio rather than presented as exact. |
| Adopting the AI SDK and switching the loop at once leaves nothing to fall back to. | §3.6 splits them: after this plan the harness is present but unused, which is a safe resting state. |

## 9. Open questions

1. Migrating the harness's four zod usages to Zod 4 proper. Small (two non-test files), and deliberately not mixed into the adoption diff.
2. Deleting `core/resilient.ts` and `session/message-store.ts` once Plans 76–78 have settled and their non-use is confirmed against the whole series rather than against upstream's usage.
3. Should `estimated` be recorded on the run, so a run that compacted on an estimate is identifiable afterwards? One column, and it would make a class of context-limit failure diagnosable.
