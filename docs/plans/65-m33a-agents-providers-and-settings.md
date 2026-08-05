# Plan 65 — M33a : Agents, Providers, and Per-Agent Settings

> Status: not started
> Ships: `packages/protocol/src/agent.ts`, `packages/core/src/agent/{store,config,provider}/*`, `packages/core/src/secrets/*`, `packages/studio/src/app/agents/`, one Drizzle migration
> Depends on: Plan 61 (the name `agents` must be free), Plan 63 (the tool allowlist names registry ids), Plan 64 (workspace scope).
> **Hard prerequisite for Plans 66–68.** They run agents; this plan defines what an agent *is*.
> Spec references: §10.1 (server-authoritative), §11.3 (crash containment, not a sandbox).

---

## 1. Goals

- An **agent** is a stored, editable record: identity, model, provider, context settings, tool allowlist, device grants, and workspace scope.
- Each agent can use a **different model and a different provider**, with its own credentials — the farm is a complete LLM client, not a wrapper around one hard-coded key.
- Settings are **farm defaults overridden per agent**, using the pattern Enkaku already uses for devices.
- Provider credentials are **encrypted at rest** and never returned by any API, to anyone, including admins.
- What an agent may touch — devices, capabilities, workspace paths — is declared on the agent and enforced by the server.

## 2. Non-goals

- Running an agent. No LLM call happens in this plan; it ships configuration and its UI. Plan 66 makes it move. This is deliberate: an agent that can be fully configured and inspected before it can act is much easier to reason about than one that arrives running.
- Chat, threads, runs, or streaming (Plan 66).
- Spawning sub-agents or messaging (Plan 67).
- Schedules (Plan 68).
- A key-management service. §3.6 states plainly what the encryption does and does not give you.

## 3. Context and design decisions

### 3.1 Farm defaults, per-agent overrides — the pattern already exists

`packages/protocol/src/settings.ts:171` documents the rule for devices: one schema for the entity's settings, with `FarmSettings.defaults` supplying values an entity does not override. It works, it is tested, and Plan 46 already built the Studio UI idiom for it.

Agents use the same shape, for the same reason and with one added one: an operator running twelve agents should be able to change the default model once. So `FarmSettings.agentDefaults` holds model, provider, context limits, and step budgets; `AgentSettings` overrides any of them; an agent field left unset means "follow the farm", not "null".

The distinction matters in the UI and is worth building properly the first time: a field showing an inherited value must look inherited, and clearing an override must return to inheritance rather than to empty.

### 3.2 Provider and model are per agent, and the model list is not hard-coded

An agent record names a **connector** (a configured provider endpoint plus credential) and a **model id**. Two agents may use two connectors; a cheap triage agent and an expensive analysis agent are the obvious first pair, and there is no reason the farm should force them onto one.

Model ids are **fetched from the provider**, not compiled in. Anthropic exposes `GET /v1/models`; the list is cached with a TTL and falls back to a small pinned list when the call fails. Hard-coding model ids into a UI dropdown guarantees the dropdown is wrong within a quarter, and an operator who cannot select a model that exists will hand-edit the database.

A model id typed by hand is accepted. The dropdown is a convenience, never a whitelist — the provider is the authority on what it serves.

### 3.3 Anthropic is first-class; the interface is not Anthropic-shaped

`ProviderAdapter` is the seam: `listModels()`, `stream(request)`, `countTokens(request)`. Anthropic is the only implementation in this plan, and it is written against the current API rather than a recalled one. Four points where a stale prior produces code that fails at runtime, recorded here because a builder will otherwise write them from memory:

- **Thinking.** `thinking: { type: 'adaptive' }`. The older `{ type: 'enabled', budget_tokens: N }` is **rejected with a 400** on Opus 5. Do not send `budget_tokens`.
- **Effort.** `output_config.effort` is the per-agent knob for how hard the model works; it is surfaced in the UI as a plain three-way choice, not as a token number.
- **Streaming.** Always stream. Agent turns are long and non-streaming requests hit request timeouts.
- **Prompt caching.** The tool list and system prompt are a stable prefix on every turn of every run — exactly what caching exists for, and the largest cost lever available. §3.4.

An OpenAI-compatible adapter is a natural second implementation and is out of scope; the interface is written so it does not require rework, and nothing beyond it is speculated.

### 3.4 The stable prefix is designed, not hoped for

The bitorex harness required every prompt section to be a static string **specifically so it would cache**, and then never set a cache breakpoint. The design was right and the payoff was left on the floor.

Here the ordering is a rule with a test: system prompt, then tool definitions, then conversation — and the cache breakpoint goes after the tool definitions. Consequences that follow, and that the schema must therefore enforce:

- Nothing time-varying may appear in the system prompt or tool descriptions. No timestamp, no device count, no "you are running at 14:32". Volatile context belongs in the first user message, after the breakpoint.
- Tool ordering is stable — the registry is iterated in a fixed order, not in `Map` insertion order that varies by import.
- Changing an agent's tool allowlist invalidates its cache. That is correct and expected; it just should not happen every turn.

Caching has a minimum prefix length, so a very small agent may not benefit. The implementation reports cache hit rates in the run record (Plan 66) rather than assuming.

### 3.5 An agent's authority is narrower than a user's, and is declared

Four independent scopes, all on the agent record, all enforced by Plan 63's `invoke`:

| Scope | Default for a new agent | Enforced at |
|---|---|---|
| **Capabilities** — registry ids it may call | read-only device capabilities | `invoke` step 2 |
| **Devices** — grants | **none**, which means **all** | `invoke` step 3 |
| **Workspace** — path prefixes | write `/agents/<slug>/`, read everywhere | Plan 64 §3.2 |
| **Permissions** — the ACL set it acts with | never more than its owner's | `invoke` step 2 |

The device rule is the user's, stated in their words: an agent granted specific devices is limited to them; an agent granted none may reach all of them. This is unusual — an empty list normally means nothing — so it is stated in the schema comment, in the API, and in the UI, where the control reads *"All devices (no restriction)"* rather than showing an empty box. An ambiguity here is an ambiguity about which phones a model can touch.

The last row is a ceiling, not a default: an agent created by an operator can never be given `device.shell`, because its owner does not have it. An agent is not a privilege-escalation path, and the check is at creation *and* at execution, since an owner can be demoted after creating an agent.

### 3.6 Credentials: what the encryption does, and what it does not

`packages/core/src/network/credential-store.ts` already encrypts secrets with AES-256-GCM under a key file created `0600` in the data directory, and `schema.ts:167-171` already states the honest claim: *"not readable by grepping the database"* — anyone with read access to the whole data directory can still decrypt, because the key sits beside `enkaku.db`.

That module is generalised rather than duplicated, and the same sentence is repeated in the agent settings UI. A second, differently-worded security claim about the same mechanism would be a claim someone eventually believes.

Rules that follow:

- A credential is **write-only** through the API. `GET` returns `{ configured: true, hint: 'sk-ant-…7Xq2' }` and never the value. There is no read path, for any role.
- `ENKAKU_ANTHROPIC_API_KEY` is read as a fallback when a connector has no stored credential, so local development works without touching the UI — config precedence stays env > file > default, as everywhere else.
- A credential that fails authentication marks its connector `unauthenticated` with the provider's message, rather than failing every run identically with no clue.

### 3.7 Context settings are budgets, and none of them fail open

Per agent, farm defaults behind them:

| Setting | Default | What it bounds |
|---|---|---|
| `maxSteps` | 30 | model turns in one run |
| `maxRunSeconds` | 600 | wall clock |
| `maxOutputTokens` | 1,000,000 | total output across a run |
| `compactAtRatio` | 0.7 | fraction of the context window before compaction |
| `maxConcurrentRuns` | 1 | runs at once for this agent |

Every one of these fails **closed**: reaching a limit stops the run with a named reason.

That is worth stating explicitly because the harness this design learned from did the opposite in the one place it mattered most. Its step guard consulted an auditor to decide whether to keep going, and `continue`d both when the verdict failed to parse *and* when the auditor threw — so with its shipped settings, two independent failures each led to 550 model turns. For an agent editing files that is expensive. For an agent driving twenty physical phones it is twenty phones doing something nobody asked for, and no operator watching at the time.

`maxSteps` here is a count that decrements. There is no auditor, no extension, and no path by which an error produces more steps rather than fewer.

`compactAtRatio` is a fraction of the *model's* context window, read from `GET /v1/models`, not a token count typed by an operator. A 1M-context model and a 200K one should not need different settings to behave the same way.

### 3.8 Settings UI: the vertical sub-tabs from Plan 46

Plan 46 built `SectionNav` for device settings — vertical sections on wide screens, a horizontal scroller when collapsed, arrow-key navigation, and a guaranteed-rendered section. It is generic already (`SettingsSection` is `{id, title, render, visible}`), so the agent settings page reuses the component rather than growing a second one.

Seven sections:

| Section | Contents |
|---|---|
| **Identity** | name, slug, description, colour |
| **Model** | connector, model, effort, thinking, max output tokens |
| **Instructions** | system prompt, with a live token count and a warning when it is volatile (§3.4) |
| **Tools** | the registry, checkboxes, grouped by prefix, showing each `effect` |
| **Access** | device grants, workspace scope, permission set |
| **Limits** | §3.7's five budgets |
| **Connectors** | farm-level: endpoints and credentials, shared across agents |

Connectors are farm-level and appear inside the agent editor only as a picker plus a link, because a credential edited from inside one agent's page but affecting eleven others is a trap.

## 4. Technical design

### 4.1 Storage

```ts
export const aiAgents = sqliteTable('ai_agents', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),          // workspace home + mentions
  name: text('name').notNull(),
  description: text('description'),
  colour: text('colour'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

  connectorId: text('connector_id'),               // null ⇒ farm default
  model: text('model'),                            // null ⇒ farm default
  systemPrompt: text('system_prompt'),

  /** AgentSettings — every field optional; unset means inherit (§3.1). */
  settings: text('settings', { mode: 'json' }),
  /** Registry ids. Validated against the registry at write time. */
  tools: text('tools', { mode: 'json' }),
  /** Device ids. EMPTY OR NULL MEANS ALL DEVICES (§3.5) — not none. */
  deviceGrants: text('device_grants', { mode: 'json' }),
  /** Workspace prefixes: { read: string[], write: string[] }. */
  workspaceScope: text('workspace_scope', { mode: 'json' }),
  /** ACL permissions; capped at the owner's set at write AND at execution. */
  permissions: text('permissions', { mode: 'json' }),

  ownerId: text('owner_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const connectors = sqliteTable('connectors', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(),                    // 'anthropic'
  baseUrl: text('base_url'),                       // null ⇒ the provider default
  /** `iv.tag.ciphertext`, AES-256-GCM (§3.6). Never returned by any API. */
  credential: text('credential'),
  status: text('status').default('unknown'),       // unknown|ok|unauthenticated|unreachable
  statusMessage: text('status_message'),
  checkedAt: integer('checked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
```

The table is `ai_agents`, not `agents`, even though Plan 61 frees the latter. `agents` carried a different meaning for the whole life of the project so far; reusing the exact name for a different thing makes every old migration, backup, and support thread ambiguous. The cost is two characters.

Every JSON column is parsed through Zod on read. Never an `as`-cast (`CLAUDE.md`).

### 4.2 Protocol — `packages/protocol/src/agent.ts`

`AgentSettingsSchema` (all optional, `.describe()` on every field — the descriptions are the UI's help text and the API documentation), `AgentSchema`, `ConnectorSchema`, `ResolvedAgentConfigSchema`, and:

```ts
/** Farm defaults + the agent's overrides. The ONLY shape a runtime sees. */
export function resolveAgentConfig(farm: FarmSettings, agent: Agent): ResolvedAgentConfig
```

Plan 66 never reads `agent.settings` directly. Resolution happens once, in one function, so "which setting won" has one answer.

### 4.3 Provider — `packages/core/src/agent/provider/`

```ts
export interface ProviderAdapter {
  listModels(): Promise<ModelInfo[]>   // { id, contextWindow, supportsThinking }
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>
  countTokens(req: ProviderRequest): Promise<number>
}
```

`anthropic.ts` uses the official `@anthropic-ai/sdk`, with `claude-opus-5` as the farm default, adaptive thinking, `output_config.effort`, streaming always, and `fallbacks: 'default'`. `ProviderEvent` is Enkaku's own union — text delta, thinking delta, tool call, usage, error — so Plan 66 does not import provider types into its loop.

`contextWindow` comes from `listModels()` and feeds `compactAtRatio` (§3.7).

### 4.4 Secrets — `packages/core/src/secrets/`

Generalise `network/credential-store.ts` into a namespaced store (`network`, `connector`) over one key file, keeping the existing table and behaviour intact. Plan 52's network credentials must keep working; this is a refactor with an unchanged public surface, not a migration.

### 4.5 API

`GET/POST/PATCH/DELETE /api/v1/agents`, `/api/v1/connectors`, `GET /api/v1/connectors/:id/models`, `POST /api/v1/connectors/:id/test`.

Validation at write time, so a broken agent cannot be saved and then fail mysteriously at run time: unknown capability id → 400 naming it; permission above the owner's → 403 naming it; workspace prefix outside the tree → 400; unknown device id in the grants → 400.

`POST /api/v1/connectors/:id/test` makes one cheap authenticated call, stores `status` and `statusMessage`, and is what the UI's "Test connection" button calls. A credential that is wrong should be discoverable in the settings page, not from a failed run at 3 a.m.

### 4.6 Studio

`/agents` (list: name, model, enabled, device grant summary, last run once Plan 66 lands), `/agents/detail?id=…` with `SectionNav` and §3.8's seven sections, and `/settings` gaining a **Connectors** section.

Inherited values render in muted text with the farm value shown and a "Override" affordance; clearing an override restores inheritance and says so.

## 5. Implementation steps

**65.1 — Protocol schemas and `resolveAgentConfig`** (§4.2), pure and fully tested. Everything downstream depends on inheritance being right.

**65.2 — Secrets generalisation** (§4.4), with Plan 52's network credential tests passing unchanged.

**65.3 — Tables and migration** (§4.1).

**65.4 — `ProviderAdapter` and the Anthropic implementation** (§4.3), including `listModels` and its cache.

**65.5 — Store and API** (§4.5), with every write-time validation.

**65.6 — Studio agent list and editor** (§4.6).

**65.7 — Connectors section and "Test connection"**.

## 6. Acceptance criteria

1. An agent with no overrides resolves to the farm defaults for every field; overriding one field changes only that field.
2. Clearing an override returns the field to inheritance, and the UI shows it as inherited with the farm value.
3. Two agents can be configured with two different connectors and two different models, and each resolves to its own.
4. A connector credential is never returned by any API to any role; `GET` returns only `configured` and a masked hint.
5. `ENKAKU_ANTHROPIC_API_KEY` is used when a connector has no stored credential, and a stored credential wins over it.
6. "Test connection" reports `ok`, `unauthenticated`, or `unreachable` with the provider's message, and stores it.
7. The model dropdown is populated from the provider; a hand-typed model id is accepted; the list falls back to a pinned set when the call fails, labelled as a fallback.
8. An agent's tool allowlist accepts only registry ids; an unknown id is a 400 naming it.
9. An agent cannot be given a permission its owner lacks — refused at creation, and refused at execution if the owner is demoted afterwards.
10. **An agent with no device grants may reach every device; an agent with grants may reach only those.** The UI says "All devices (no restriction)" rather than showing an empty list.
11. An agent's workspace scope defaults to write `/agents/<slug>/` and read everywhere.
12. Every §3.7 budget is stored, resolved, and displayed; none has a value meaning "unlimited".
13. Every JSON column is parsed through Zod on read; no `as`-cast exists in the agent store.
14. Plan 52's network credentials continue to work after the secrets refactor, with their tests unedited.
15. The agent settings page uses Plan 46's `SectionNav`, with arrow-key navigation and a section always rendered.
16. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit — `resolveAgentConfig`:** every field inherited, every field overridden, partial overrides, a field explicitly set to a falsy value that is *not* treated as unset (`maxSteps: 0` must not silently inherit 30 — this is the classic bug in inheritance code and gets its own case).

**Unit — secrets:** round-trip; a wrong key fails to decrypt rather than returning garbage; the namespace separation; Plan 52's suite unedited.

**Unit — validation:** unknown capability, over-privileged permission, out-of-tree workspace prefix, unknown device id.

**Unit — provider:** `listModels` parsing and cache expiry; the request builder asserted to send `thinking: {type: 'adaptive'}` and **never** `budget_tokens`; the cache breakpoint placed after the tool definitions and not before.

**Integration:** create an agent, override two settings, read it back resolved; create two agents on two connectors and confirm independent resolution.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. Settings → Connectors → add Anthropic, paste a key, Test → ok
# 2. Agents → New → model list populated from the provider
# 3. Tools section → check five capabilities; Access → grant one device
# 4. reload → everything persisted; the key is not in the response (check the network tab)
# 5. a second agent on a different model → both resolve independently
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| An operator believes the encryption protects a key from someone with server access. | The existing honest sentence is reused verbatim in the UI (§3.6). It is repeated, not reworded. |
| The empty-grants-means-all rule surprises someone and an agent touches a phone it should not. | Stated in the schema comment, the API, and the UI copy, and pinned by criterion 10. It is the user's explicit decision, and the mitigation is that it is never implicit. |
| Hard-coded model ids go stale. | They are fetched (§3.2); the pinned list is a labelled fallback, not the source of truth. |
| Settings inheritance produces a value nobody intended. | One resolver (§4.2), tested including the falsy-override case, and the UI shows provenance rather than only the value. |
| An agent is configured with tools its permissions do not allow, and fails confusingly at run time. | Write-time validation (§4.5) refuses the combination, naming the specific tool and the missing permission. |

## 9. Open questions

1. Should an agent be able to *change its own* settings through a capability? Powerful, and an obvious injection target — an agent talked into granting itself more devices. Not in this plan; if it is ever wanted it should be a distinct capability with its own permission, never `agent.update`.
2. Should connectors be per-tenant in cloud mode? They must be; deferred to whatever multi-tenancy becomes, like Plan 64 §9.3.
3. Should `maxOutputTokens` be a farm-wide spend cap as well as a per-run one? A per-run cap does not stop a schedule from firing a thousand runs. Plan 68 will need an answer.
