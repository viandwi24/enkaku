# Plan 61 — M31a : Nodes, and the Word "Agent" Set Free

> Status: implemented — `packages/agent` renamed to `packages/node` (`@enkaku/node`), the `agents` table renamed to `nodes` and `devices.agent_id` to `devices.node_id` via a hand-written `ALTER TABLE`/`RENAME COLUMN` migration (verified against a copy of a real `.dev-cloud/enkaku.db`), the tunnel wire messages renamed to `node.hello`/`node.hello.ack`/`node.devices` with the pre-rename `agent.hello`/`agent.devices` accepted for one release (warn-logged, one warning per hello), a node adopts an existing `agent.json` and rewrites it as `node.json`, `/api/agents` is gone in favour of `/api/nodes` (no alias — a bare 404), and Studio's `/agents` route redirects to `/nodes` with the sidebar showing one entry, "Nodes". The plan's §3.4 misidentifies the renamed device column as `deviceEvents.agentId`; it is actually `devices.agentId` (schema.ts:36) — corrected during implementation, noted here rather than silently.
> Ships: packages/core/src/api/nodes.ts
> Depends on: nothing. **Hard prerequisite for Plans 63–68** — every one of them uses the word "agent" for the AI feature, and it cannot mean two things.
> Spec references: §14 (cloud mode), §14.2 (enrollment).

---

## 1. Goals

- The cloud tunnel process is called a **node** everywhere: package, table, routes, wire protocol, UI, docs, and dev scripts.
- The word **agent**, unqualified, becomes free and is reserved for the AI feature that starts in Plan 63.
- A node binary already enrolled and running in the field **keeps working across the upgrade** without re-enrolling and without a manual edit.

## 2. Non-goals

- Renaming `apps/guest-agent`. It stays. It is qualified by "guest-", it means something genuinely different (the on-device APK), and it is under active construction by another builder — touching it would collide.
- Any behaviour change. This plan renames things; if it also fixes something, the fix belongs in another plan.
- Renaming `ENKAKU_CP_URL` or `ENKAKU_ENROLL_TOKEN`. Both are already generic and appear in user-facing install docs and shell histories.

## 3. Context and design decisions

### 3.1 Three things are called "agent" today

| What | Where | After |
|---|---|---|
| The cloud tunnel process that holds locally-attached devices and relays them to a control plane | `packages/agent`, `agents` table, `/api/agents`, Studio `/agents` | **node** |
| The on-device APK that terminates the SOCKS5 tunnel | `apps/guest-agent` | unchanged |
| The AI feature we are about to build | does not exist yet | **agent** |

Only the first moves. The second is already qualified and is not ambiguous in practice — nobody writes "the agent" and means the APK. The third is why we are doing this at all.

### 3.2 "Node" and not something else

A tunnel agent holds many devices and reports them upward. That is a node in a fleet, and "node" is the word every comparable system already uses for it — it needs no explanation in the install guide. `Host` was the runner-up and was rejected because Enkaku already uses "host" for the machine an executor runs on (`packages/core/src/jobs/executor-host.ts`), which would trade one collision for another.

### 3.3 The wire protocol is part of the rename, and that has a cost

`packages/core/src/tunnel/router.ts:105,113,117` and `packages/agent/src/index.ts:114,119,196` exchange `agent.hello`, `agent.hello.ack`, and `agent.devices`. A node also persists its credential in `agent.json` (`packages/agent/src/state.ts:18,25`).

So a pure in-repo rename is not enough: a node binary deployed on somebody's machine last week will still send `agent.hello` and still look for `agent.json` after the control plane is upgraded. Two compatibility measures, both temporary and both dated:

1. **The control plane accepts both names for one release.** `node.hello` is what it sends and prefers; `agent.hello` is accepted with a `warn`-level log naming the node, so an operator can see which nodes still need upgrading. The alias is removed in the release after next, and this plan writes that removal down as a follow-up rather than leaving it to be discovered.
2. **The node reads `node.json`, falling back to `agent.json` once and rewriting it.** An upgraded node keeps its credential; it does not re-enroll and does not appear as a second row.

Renaming the wire is worth the compat window. Leaving `agent.hello` in place forever would mean the tunnel protocol permanently contradicts every other name in the system, and the next person to read `router.ts` would reasonably conclude the AI agents connect through it.

### 3.4 The migration renames the table, and one column elsewhere

`agents` → `nodes`, and `deviceEvents.agentId` (`packages/core/src/db/schema.ts:36`) → `nodeId`. SQLite supports `ALTER TABLE ... RENAME TO` and `RENAME COLUMN` directly, so no table rebuild is needed and no data moves.

The index `idx_agents_created` is renamed with it. Drizzle will not do this on its own from a schema edit — it will propose a drop-and-create, which on a table holding live credentials is a data loss. **The generated migration must be hand-checked and, if it proposes a drop, replaced with the two `ALTER` statements.** This is the one step in this plan where an unreviewed `db:generate` does real damage.

### 3.5 A comment in Indonesian goes while we are here

`schema.ts:457` reads `/** Multi-tenant (M8c) — null di single-tenant. */`. `CLAUDE.md` requires English throughout. It is on a line this plan already touches, so it is corrected here rather than left for a stranger to find.

## 4. Technical design

### 4.1 Package

`packages/agent` → `packages/node`; `@enkaku/agent` → `@enkaku/node`. Update `bun.lock` by running `bun install`, not by editing it.

Root `package.json`: `dev:agent` → `dev:node`. Keep `dev:agent` as an alias that prints a one-line deprecation and calls `dev:node`, so a muscle-memory invocation does not fail silently — remove it with the wire alias.

### 4.2 Storage

```
ALTER TABLE agents RENAME TO nodes;
ALTER INDEX idx_agents_created RENAME TO idx_nodes_created;   -- or DROP/CREATE the index only
ALTER TABLE device_events RENAME COLUMN agent_id TO node_id;
```

`AgentRow` → `NodeRow`.

### 4.3 Core

| From | To |
|---|---|
| `packages/core/src/api/agents.ts` | `.../api/nodes.ts` |
| `packages/core/src/tunnel/agent-auth.ts` | `.../tunnel/node-auth.ts` |
| `GET/POST /api/agents` | `/api/nodes` |
| `agent.hello` / `.ack` / `agent.devices` | `node.hello` / `.ack` / `node.devices`, with §3.3's inbound alias |

`packages/core/src/tunnel/registry.ts`, `router.ts`, `rpc.ts`, `device-proxy.ts`, `remote-sessions.ts`, `adb-remote.ts` carry the vocabulary internally and follow.

### 4.4 Protocol

The tunnel messages are constructed inline in `router.ts` today rather than declared in `@enkaku/protocol`. Move the three of them into `packages/protocol/src/messages/tunnel.ts` as Zod schemas while renaming — the rename touches every call site anyway, and leaving hand-built objects on a wire that now has a compat alias is how the alias quietly outlives its deadline.

### 4.5 Studio

`src/app/agents/page.tsx` → `src/app/nodes/page.tsx`; sidebar entry "Agents" → "Nodes"; `/agents` keeps redirecting to `/nodes` for one release, matching how `/topology` was handled in Plan 49 §3.4.

### 4.6 Docs

`docs/plans/11-m8-cloud.md`, `docs/guide/cloud.md`, `docs/guide/install.md`, `docs/guide/enrollment.md`, `CLAUDE.md`, and `docs/spec.md` §14. In the plan archive, correct the vocabulary but **do not rewrite history** — Plan 11 shipped a thing called an agent, and a one-line note at its head saying it was renamed in Plan 61 is more useful than a silent search-and-replace.

## 5. Implementation steps

**61.1 — Migration first** (§4.2). Hand-check the generated SQL against §3.4. Verify against a copy of a real `.dev-cloud/enkaku.db` that rows survive.

**61.2 — Package rename** (§4.1), then `bun install`, then `bun run typecheck` to find every import.

**61.3 — Protocol messages** (§4.4): declare the three tunnel messages in Zod, both names accepted inbound.

**61.4 — Core rename** (§4.3), including the deprecation log line naming the node.

**61.5 — Studio** (§4.5).

**61.6 — Docs** (§4.6).

**61.7 — Write down the removal.** A dated follow-up entry in `00-overview.md` for deleting the `agent.hello` alias, the `agent.json` fallback, the `/agents` redirect, and the `dev:agent` alias.

## 6. Acceptance criteria

1. `grep -rn "@enkaku/agent" --exclude-dir=node_modules .` returns nothing.
2. No source file outside `apps/guest-agent/` uses the identifier `agent` for the tunnel process.
3. A control plane upgraded in place keeps its enrolled nodes: they appear in `/api/nodes` with the same ids, statuses, and `lastSeen`, and no row is duplicated.
4. A node binary from **before** this plan connects to an upgraded control plane, is accepted, and produces exactly one `warn` log naming it and the deprecated message.
5. An upgraded node with an existing `agent.json` starts, connects, does not re-enroll, and has rewritten its state to `node.json`.
6. `/agents` in Studio redirects to `/nodes`; the sidebar has one entry, "Nodes".
7. `apps/guest-agent/` is untouched — `git diff --stat` shows no file under it.
8. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** the tunnel message schemas parse both `node.hello` and `agent.hello`, and the deprecation path is asserted on the alias only. `node.json`/`agent.json` resolution: neither present → enroll; only `agent.json` → adopt and rewrite; both → prefer `node.json` and leave the stale file alone rather than deleting somebody's file.

**Migration:** apply against a snapshot of a real `.dev-cloud/enkaku.db` with ≥1 enrolled agent and ≥1 device event carrying `agent_id`; assert row counts, ids, and the renamed column before/after.

**Manual smoke:**
```bash
cp -r .dev-cloud .dev-cloud.bak            # the migration is the one irreversible step here
bun run dev:cloud
bun run dev:node                            # existing state adopted, no re-enrol
# then run the PREVIOUS node build against the same control plane → accepted + one warn
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Drizzle generates `DROP TABLE agents; CREATE TABLE nodes` and destroys live credentials. | §3.4 and step 61.1 make hand-checking the SQL the first action, and criterion 3 is tested against a real database copy, not a fresh one. |
| The compat alias never gets removed and the protocol stays permanently ambiguous. | Step 61.7 writes the removal into `00-overview.md` with a release target, and the alias logs on every use so it is visible rather than silent. |
| A rename this wide collides with the guest-agent work in the same tree. | Criterion 7 is a hard check on `git diff --stat`, and `apps/guest-agent` is a non-goal in §2. |
| Someone's bookmark or script hits `/api/agents`. | The Studio route redirects; the **API** route does not, and returns 404. That is deliberate — a silently-aliased API endpoint is how a rename becomes permanent. The release note names it. |

## 9. Open questions

1. Should `/api/agents` return a `410 Gone` with a message naming `/api/nodes`, rather than a bare 404? Kinder, and costs three lines. Deferred to the implementer's judgement.
2. `packages/core/src/jobs/executor-host.ts` uses "host" for a third concept. Not a collision today, but if "node" and "host" ever meet in one sentence it will need a decision. Left alone.
