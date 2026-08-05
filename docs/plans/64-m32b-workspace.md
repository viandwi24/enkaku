# Plan 64 — M32b : The Workspace — A Filesystem People and Agents Share

> Status: not started
> Ships: `packages/core/src/workspace/*`, `packages/core/src/capability/fs.ts`, `packages/core/src/scripts/build.ts`, `packages/studio/src/app/workspace/`, one Drizzle migration
> Depends on: Plan 63 (capabilities — `fs.*` are registry entries), Plan 62 (`ScriptRef` — publishing from a workspace path produces one).
> Spec references: §11.4 (published bundles), §11.3 (crash containment, not a sandbox).

---

## 1. Goals

- A **virtual filesystem** stored in the database: agents write to it, people browse and edit it in Studio, and both see the same tree.
- An agent can **write a script, read it back, revise it, and publish it** — three separate actions with three separate gates, so iterating costs nothing and shipping costs a permission.
- The workspace **never touches the real filesystem**, so a compromised or misled agent cannot write outside it.
- Concurrent writes to one path cannot silently lose work.

## 2. Non-goals

- Replacing job artifacts. Screenshots, logs, and job outputs keep their existing store — they are immutable outputs of a run, and the workspace is mutable working material. Mixing them would make "delete this file" a question about audit integrity.
- A real filesystem mount, a FUSE layer, or `git`. §3.1.
- File history or diffs beyond the stale-write guard in §3.4. Versioned *scripts* already exist (Plan 62); versioned *files* is a separate feature nobody has asked for.
- Executing anything in the workspace directly. A workspace file becomes runnable only by being published as a script and run as a job.

## 3. Context and design decisions

### 3.1 Virtual, and stored in the database

A workspace backed by a real directory would be the obvious implementation and is the wrong one, for three independent reasons — any one of which is sufficient:

- **Injection reach.** An agent reads screenshots, UI dumps, and logcat from a device running an app under test; all of that content is attacker-controllable and can contain text addressed to the model. Scripts already run as the core's OS user with full filesystem and network access — the spec says so plainly at §11.3, *crash containment, not a sandbox*. Handing that same user a general write-anywhere tool, driven by a model reading attacker-controlled text, converts a prompt-injection into arbitrary file writes on the host. A database-backed tree makes the blast radius a table.
- **Cloud mode.** In orchestrator mode the core and the node are different machines. A path means nothing across that boundary; a row means the same thing everywhere.
- **Studio is a static export.** It cannot read a server directory anyway — it needs an API regardless. A real directory would buy nothing and cost the two problems above.

### 3.2 One tree, with scopes

A single tree, POSIX-shaped paths, no per-agent silos:

```
/shared/          readable and writable by anyone with fs.write
/scripts/         source that is meant to become published scripts
/agents/<slug>/   an agent's own home — its default write scope
/notes/           whatever people want
```

An agent's grant (Plan 65) names path prefixes it may read and write. The default for a new agent is **write to its own home, read everywhere** — enough to be useful, not enough to overwrite a colleague's work by hallucinating a path. Directories are implied by paths and are not rows; an empty directory does not exist, which removes an entire category of state to keep consistent.

Path rules, enforced at the schema and not by the caller: absolute, no `..`, no `.`, no empty segments, no trailing slash, NFC-normalised, max 512 bytes, max 32 segments. `..` is rejected rather than resolved — resolution is how path-traversal bugs are written.

### 3.3 Text first, binary allowed, both bounded

`content` is a `BLOB` with a `contentType`. Text is stored UTF-8 and returned as a string; anything else is base64 at the API edge and never rendered inline in Studio.

Limits are settings, with these defaults, and they exist because an agent in a retry loop is a fine way to fill a disk:

| Limit | Default |
|---|---|
| max file size | 1 MiB |
| max files per scope | 1,000 |
| max total bytes per scope | 64 MiB |

Exceeding one is `E_QUOTA` naming the limit and the current usage — not a generic failure, because an agent that knows it hit a quota can delete something, and an agent told "write failed" will retry.

### 3.4 Writes are compare-and-swap

Two agents — or an agent and a person in Studio — editing one file must not silently lose one of the two. Every read returns a `hash` (sha256 of content); every write may carry `ifMatch`. A mismatch is `E_STALE`, naming the hash the caller expected and the one that is there.

`ifMatch` is **required** when overwriting an existing file and forbidden when creating. That makes the safe path the default one rather than an option a caller can forget: a blind overwrite is not expressible.

This is deliberately the one concurrency mechanism in the plan. It is enough to prevent lost updates and it needs no locks, no leases, and no reconciliation — all of which would have to be reasoned about while an agent is mid-run.

### 3.5 Publishing is a separate gate, and it is where the real risk sits

The user's model, adopted whole:

| Action | Capability | Gate |
|---|---|---|
| write a file | `fs.write` | scope + quota. Cheap. It is text. |
| publish it as a script | `script.publish` | permission, off by default for a new agent |
| run it on a device | `job.run` | permission **and** a device grant **and** a lease |

This is better than the draft-and-approve model considered earlier, because an agent iterating on a script — write, read back, fix a selector, write again — needs a human for none of that, and needs one for the two moments that actually matter.

Publishing from a workspace path requires the core to **bundle**, which the CLI has always done on the author's machine. `Bun.build` does not execute the input, but it does resolve imports, so bundling agent-authored source is only safe with the constraints in §4.4.

### 3.6 Studio is the other half of the point

The user asked for a filesystem *accessible in Studio*, not an agent-private scratchpad. A workspace only an agent can see is a black box: when an agent produces something wrong, the file it wrote is the primary evidence.

So Studio gets a tree, a viewer, an editor, and a diff-free but honest conflict message when `ifMatch` fails. A person editing a file an agent wrote is the normal case, not an edge case.

## 4. Technical design

### 4.1 Storage

```ts
export const workspaceFiles = sqliteTable('workspace_files', {
  id: text('id').primaryKey(),
  /** Absolute, normalised, unique. Directories are implied (plan 64 §3.2). */
  path: text('path').notNull().unique(),
  content: blob('content').notNull(),
  contentType: text('content_type').notNull().default('text/plain'),
  size: integer('size').notNull(),
  /** sha256 of `content`; the compare-and-swap token (§3.4). */
  hash: text('hash').notNull(),
  /** 'user:<id>' or 'agent:<id>' — an agent's writes are attributable. */
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('idx_workspace_path').on(t.path)])
```

`path` unique is what makes `fs.write` a single upsert and makes listing a prefix scan.

### 4.2 Capabilities — `packages/core/src/capability/fs.ts`

| id | effect | Notes |
|---|---|---|
| `fs.list` | read | prefix + optional depth; returns paths, sizes, hashes, never content |
| `fs.read` | read | returns content and `hash` |
| `fs.write` | write | `ifMatch` required on overwrite, forbidden on create (§3.4) |
| `fs.delete` | destructive | single path; no recursive delete in v1 (§9.1) |
| `fs.move` | write | `ifMatch` on the source; refuses if the destination exists |

Permission `fs.read` / `fs.write` join the ACL in `packages/core/src/auth/acl.ts`. Operator gets both by default; the *scope* is what limits an agent, not the permission.

Descriptions matter here as much as anywhere. `fs.write`'s says, in the entry itself, that overwriting requires the current hash and that the way to get one is `fs.read` — a model that does not know this will loop on `E_STALE`.

### 4.3 Errors

`E_BAD_PATH`, `E_NOT_FOUND`, `E_EXISTS`, `E_STALE`, `E_QUOTA`, `E_OUT_OF_SCOPE`. Six, all distinguishable, all actionable — a caller can respond correctly to each without reading prose.

### 4.4 Server-side bundling — `packages/core/src/scripts/build.ts`

`script.publish` gains a second input form: `{ path }` instead of `{ bundle }`. The core bundles it under these constraints, which are the security boundary and not optimisations:

- **Import allowlist.** `@enkaku/sdk` and its transitive dependencies, plus other workspace paths. A bare specifier outside the allowlist is a build failure naming it. Node builtins are refused — a published script that reads `node:fs` is running on the core's host as the core's user.
- **No filesystem resolution.** Relative imports resolve inside the workspace tree, through a Bun plugin, never against disk.
- **Bounded.** 30 s, 20 MiB output. A build that exceeds either is a failure, not a wait.
- **Never executed.** Bundling only. If a script needs to run to be validated, it runs as a job, on a device, under Plan 63's checks.

The CLI path (`enkaku publish` with a pre-built bundle) is unchanged; this is an additional input, not a replacement.

### 4.5 API and Studio

REST at `/api/v1/cap/fs.*` comes free from Plan 63. Studio adds `/workspace`:

- a tree in the left column, lazily loaded per prefix;
- a viewer/editor on the right, monospace, with the file's `hash` held in component state and sent as `ifMatch` on save;
- a conflict banner on `E_STALE` offering "reload and lose my edits" or "copy mine to the clipboard" — never a silent merge and never a silent overwrite;
- `createdBy` / `updatedBy` shown as "written by agent *checkout-bot*", because attribution is the point;
- a **Publish as script** action for paths under `/scripts/`, prefilling name and version and showing the build error verbatim on failure.

Syntax highlighting is out of scope for v1 — a `<textarea>` with a monospace font and correct save semantics is worth more than a highlighted editor that loses work.

## 5. Implementation steps

**64.1 — Path normalisation and validation** (§3.2), pure and fully tested first. Every later step trusts it; a traversal bug here is a traversal bug everywhere.

**64.2 — Table and migration** (§4.1).

**64.3 — Store**: read/write/list/delete/move with compare-and-swap and quotas (§3.3, §3.4).

**64.4 — Capabilities** (§4.2), scope checks against the caller's grant.

**64.5 — Server-side bundling** (§4.4), allowlist and workspace-only resolution first, before the happy path.

**64.6 — Studio workspace** (§4.5).

**64.7 — Publish-from-path** in the run/publish flow.

## 6. Acceptance criteria

1. `..`, relative paths, empty segments, and over-long paths are rejected with `E_BAD_PATH` — never normalised into something that resolves.
2. No workspace operation touches the real filesystem: the store's tests run with the data directory read-only.
3. Creating an existing path fails `E_EXISTS`; overwriting without `ifMatch` fails; overwriting with a stale `ifMatch` fails `E_STALE` naming both hashes.
4. Two concurrent writes to one path: one succeeds, the other gets `E_STALE`. Neither is silently lost.
5. Exceeding file size, file count, or total bytes fails `E_QUOTA` naming the limit and current usage.
6. An agent scoped to `/agents/x/` cannot write to `/agents/y/` and gets `E_OUT_OF_SCOPE`, not `E_NOT_FOUND` — a wrong-scope write and a missing file are different problems.
7. Publishing from a workspace path produces a script identical to publishing the same source through `enkaku publish`.
8. A source importing `node:fs`, or any specifier outside the allowlist, fails the build **naming the specifier**, and no script row is created.
9. Bundling never executes the source: a source with a top-level side effect that would be observable produces no such effect.
10. A build exceeding 30 s or 20 MiB fails rather than hanging.
11. Studio lists, opens, edits, and saves; a conflicting save shows the conflict and never silently overwrites.
12. Every file shows who wrote it, distinguishing a user from an agent.
13. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit — path validation:** a table of traversal attempts (`/a/../../etc/passwd`, `//a`, `/a/./b`, `/a/b/`, unicode-normalisation pairs, 33 segments, 513 bytes). This table is the plan's most important test and should be over-long rather than representative.

**Unit — compare-and-swap:** create/overwrite/stale/missing-`ifMatch`, and a genuine race driven from two async writers against one path.

**Unit — quotas:** each of the three limits at its boundary, and the error naming current usage.

**Unit — bundling:** allowlisted import succeeds; `node:fs` fails naming it; a relative import resolves within the workspace; an import escaping the workspace fails; a source with an observable side effect produces none; timeout and size caps trip.

**Integration:** write source → publish from path → enqueue a job → it runs. This is the whole three-gate story and is worth one end-to-end test.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. /workspace → create /scripts/hello.ts, save
# 2. open in a second tab, edit both, save both → the second gets a conflict, not a silent overwrite
# 3. Publish as script → appears in /scripts as hello@1.0.0
# 4. run it → a job with a concrete version
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Server-side bundling becomes an execution path on the core's host. | §4.4: bundling never executes, imports are allowlisted, resolution never reaches disk, and §6.9 tests the negative directly rather than assuming it. |
| An agent fills the database with files. | Three quotas (§3.3), errors that tell an agent what to do about it, and per-scope accounting so one agent cannot exhaust another's. |
| Storing content in SQLite performs badly at size. | The 1 MiB cap keeps rows small and the workspace is working material, not an artifact store. Artifacts, which are large, keep their existing store (§2). |
| Compare-and-swap frustrates an agent that keeps getting `E_STALE`. | `fs.read` returns the hash on every read and `fs.write`'s description says so (§4.2). If it still happens in practice it is a prompt problem with a visible signature in the run log, not a silent one. |
| A person and an agent fight over one file. | Attribution is displayed (§6.12) and every write is audited, so the fight is legible. Locking was considered and rejected: a lock held by a crashed agent is worse than a conflict message. |

## 9. Open questions

1. Recursive delete. Deliberately absent — an agent that can delete a subtree can delete `/scripts/` on a misread. Individual deletes are tedious for a person, which argues for Studio-only recursive delete rather than a capability.
2. Should `/scripts/` files be linked to the published script they became, so Studio can show "published as `hello@1.0.2`"? Cheap and useful; deferred to keep the schema minimal.
3. Should the workspace be per-tenant in cloud mode? It must be, but multi-tenancy is unfinished elsewhere (`tenantId` is nullable throughout), so this follows whatever that becomes rather than inventing a second answer.
