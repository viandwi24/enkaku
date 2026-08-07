# Plan 79 — M44 : The KV Store

> Status: implemented — `packages/core/src/kv/store.ts`'s `createKvStore(db, dataDir, quotas)` is the whole store: `get`/`set`/`setIfVersion`/`increment`/`delete`/`list`/`deleteNamespace`/`deleteDevice`/`sweepExpired` against one new `kv_entries` table (`db/schema.ts`, migration `drizzle/0037_graceful_union_jack.sql`), keyed on `(scope, scopeId, namespace, key)` with a unique index enforcing the identity rule (§3.2) and `scopeId` holding a device's `stableId`, never `devices.id` (§3.3). Secrets reuse `secrets/store.ts` unchanged beyond adding `'kv'` to `SecretNamespace` — AES-256-GCM, namespace folded in as AEAD associated data. `setIfVersion`/`increment` wrap their read-then-write in `db.transaction()`, threading the real `tx` handle through every helper (not just closing over the outer `db`), so the CAS/increment atomicity is real rather than "works because bun:sqlite happens to be one connection." IPC: `kv.call`/`kv.result` added to `packages/session/src/runner/ipc.ts` (`KvCallSchema`, a discriminated union on `op`, self-contained — never sourced from `@enkaku/protocol`, since kv is never an `invoke()` capability); `packages/session/src/runner/kv-client.ts` (`createKvApiFor`) is the schema-validating client `child-entry.ts` wires as `ctx.kv.device`/`ctx.kv.global`; `job-runner.ts` gained `JobRunnerDeps.kv` (a local `KvRunnerDeps` port, `call`+`redact`, kept local because session cannot depend on core) and a `kv.call` branch in `handleChildMessage` resolving the namespace from the script's own `ready`-reported id. `packages/core/src/kv/runner-port.ts` (`createKvRunnerPort`) is the concrete parent-side implementation daemon.ts injects — resolves `devices.id` → `stableId` once per call, the one place that mapping happens. Log redaction (§4.7): `job-logger.ts`'s `createJobLogger` gained an optional `redact: (text) => string` applied to both `msg` and every string in `fields` before a line is written or broadcast; `kv/store.ts`'s `buildSecretRedactor` builds the replacement list from every secret currently readable in the job's global+device scope under its namespace, longest-plaintext-first, minimum length 8. REST: `packages/core/src/api/kv.ts` (`GET /`, `GET/PUT/DELETE /entry`) mounted at `/api/kv`, gated on a new admin-only `kv.manage` permission (`auth/acl.ts`, deliberately outside the `OPERATOR` set — the same admin-only default as `device.shell`/`device.adb`); every response redacts a secret entry's `value` to `null` regardless of which store method produced it. Audit actions `kv.set`/`kv.delete` added to `auth/audit.ts`, never carrying a value. Device lifecycle: `device/lifecycle.ts`'s `forget()` now calls `deps.kv.deleteDevice(stableId)` INSIDE its existing transaction, UNCONDITIONALLY (not gated on `deleteHistory` — a kv value is live state, not a historical record), and returns the count as a new `ForgetResult.kvDeleted` field. Settings: `FarmSettings.kv` (`packages/protocol/src/settings.ts`) carries the four quotas (`maxValueBytes` 64 KiB, `maxKeyLength` 256, `maxEntriesPerNamespace` 1,000, `maxEntriesPerDevice` 5,000), read fresh per call via `daemon.ts`'s `() => settingsStore.get().kv`. SDK: `KvApi`/`KvListItem`/`KvListResult`/`KvSetOptions` added to `packages/sdk/src/types.ts`, and `ScriptContext.kv: { device: KvApi; global: KvApi }`. `bun run typecheck` is green across all 12 packages; root `bun test` is 2240 pass / 0 fail (baseline 2182 + 58 net new, all in this plan's own files plus two pre-existing tests updated for the new `kvDeleted` field — see deviations); `bun run --cwd packages/studio test` is unchanged at 312 pass / 0 fail (this plan ships no Studio UI — see deviations). `bash scripts/check-harness-provenance.sh` and `bash scripts/check-plan-status.sh` both exit 0. **Deviations, recorded rather than silent:** (1) `kv_entries.value` is a plain `text` column, NOT `{mode:'json'}` as §4.2's illustration shows — a secret row holds the `secrets/store.ts` ciphertext envelope (`iv.tag.ciphertext`), not JSON, so the column has to accept either shape uniformly as a string; a non-secret row holds `JSON.stringify(value)` written and parsed by hand. (2) The store's own `KvEntry.value` does NOT follow §4.1's "null when secret and the reader is not a job" literally — `get()` always returns the decrypted plaintext (the only thing that makes `ctx.kv.get` usable from a job at all), while `list()` NEVER decrypts, unconditionally, regardless of caller (criterion 10 is a property of `list()` itself, not of who's asking). The HTTP API (`api/kv.ts`) redacts a secret's `value` to `null` on every response it sends, including a single-entry `GET`, which is where the plan's original wording actually needs to hold. (3) `kv.manage` is one permission, not a `kv.view`/`kv.manage` split — the plan says "admin-scoped" without naming a permission at all; a single admin-only permission was the narrowest reading that didn't invent a distinction the plan never asked for. (4) `KvSetOptions` gained an extra optional `updatedByJobId` field beyond the plan's `{secret?, ttlSec?}` (backing the `updated_by_job_id` column, informational only) — additive, not a narrowing. (5) `ForgetResult` gained `kvDeleted: number`, which is NOT gated behind `opts.deleteHistory` — deliberate: §3.3's own reasoning ("a phone leaving the farm does not leave its sessions behind") does not apply only when an operator happened to also check "delete history"; two pre-existing tests (`device/lifecycle.test.ts`, `api/devices.test.ts`) that asserted the exact `ForgetResult`/response shape via `toEqual` were updated to include the new field (their existing assertions are otherwise byte-for-byte unchanged). **Step 5.9 (the Studio KV panel) — built in a later pass, alongside plan 82's Studio work.** `packages/studio/src/components/kv/KvPanel.tsx` is the one component both call sites share: `scope: {kind:'global'}` under Settings' new "Key/Value store" section, `scope: {kind:'device', stableId}` on the device page's new "Storage" tab (`device.stableId`, never `device.id` — matching §3.3's own identity rule at the UI boundary, not just the store's). There is no "list every namespace" endpoint (the store never needed one — a script's own runtime supplies its namespace, §3.2), so the panel asks for a namespace to browse rather than pretending to discover one; browsing then lists/deletes entries and can set a new value (plain or `secret: true`) through the existing `GET/PUT/DELETE /api/kv` surface, unchanged. **The one rule that had to hold at this fourth surface (criterion 4/10's own promise, now also a UI concern):** a secret entry renders its hint plus a `secret` badge and NEVER reads `.value` — proven by `KvPanel.test.tsx`'s negative test, which mocks a response where the server DID send a secret's plaintext (simulating a `redactEntry` regression) and asserts the literal string appears NOWHERE in `document.body.innerHTML` — a defense-in-depth check of the component itself, not merely trust that the network behaves. New `packages/protocol/src/api/kv.ts` (`KvEntrySchema`/`KvListResponseSchema`/`KvEntryResponseSchema`/`KvDeleteResponseSchema`) is what the panel's `api()` calls are checked against (plan 72's own rule), verified against the REAL `createKvRoutes` app (not a mocked fetch) in `packages/core/src/api/plugins-kv-protocol.test.ts`. See plan 82's status header for the full accounting of this later pass (root `bun test` 2438 pass / 0 fail, `packages/studio` 352 pass / 0 fail, both baselines plus this pass's net-new tests).
> Ships: packages/core/src/kv/store.ts
> Depends on: Plan 65 (`secrets/store.ts`, the namespaced AEAD box this reuses), Plan 47 (device lifecycle teardown, which must delete device-scoped values).

---

## 1. Goals

- A script can read and write durable values under two scopes: **global** (the whole farm) and **device** (the phone the job is running on).
- Values survive across jobs, so a login script can store what a warmup script later needs.
- A value marked **secret** is encrypted at rest and never appears in an API response, a log line, an artifact, or the UI.
- Two plugins that both pick the key `token` do not overwrite each other.
- Concurrent writers get a way to not lose each other's work.

## 2. Non-goals

- A general database for scripts. This is a key/value store with quotas, not a place to keep a table of accounts.
- Cross-farm replication or sync to the control plane. Node-local only, like every other row.
- A cache with eviction policy. TTL expiry only, swept lazily (§4.5).
- Reading another device's values. A job sees global plus its own device (§3.3).

## 3. Context and design decisions

### 3.1 Why this exists before the plugin system

The stated goal for all of this is a TikTok automation pack: login, switch-account, scroll warmup. Every one of those needs state that outlives a job. Login without somewhere to put the session is a script that logs in and forgets. So the store is the dependency, not the decoration — and it is the piece with the fewest moving parts, which is why it goes first.

### 3.2 The key is three parts, not two

The obvious shape is `(scope, key)`. It is wrong, and it fails silently, which is worse than failing.

Two plugins will both want `token`. Two scripts in the same plugin will both want `state`. With a two-part key the second write wins and nothing anywhere reports a collision — the first plugin simply starts reading someone else's value, of the right type, at the right key, meaning something entirely different.

So the key is `(scope, namespace, key)`, where `namespace` is the owning plugin's id (or, for a standalone script published without a plugin, its script name). The runtime supplies it; a script never types it. That makes collisions impossible rather than discouraged.

A script cannot read another namespace's values in this plan. Sharing between plugins is a real want (a "login" pack and a "posting" pack sharing a session) but it needs a grant model to be safe, and inventing one here without a caller would be guessing. Recorded as open question 1.

A plugin under development (plan 82 §3.5's dev slot) uses the **same namespace as its published counterpart**, so a developer works against real stored state instead of an empty one — which is the only way to debug "switch account fails when a session already exists". The cost is that a dev run can overwrite production state; plan 82 §4.6 makes that visible on the Plugins page rather than leaving it to be discovered.

### 3.3 Device scope is keyed on `stableId`, not the device row id

Device identity in this repo is `stableId` (spec §7.5); the `devices.id` row is a local record that a Forget deletes and a re-admission recreates. Keying on the row id means a device that is forgotten and re-admitted comes back with its values orphaned but still on disk — invisible, unreachable, and counted against nothing.

Keying on `stableId` makes the question answerable either way, and the answer is deliberate: **Forget deletes the device's values** (§4.6), in the same transaction that already deletes its jobs, artifacts, and events. A phone leaving the farm does not leave its sessions behind. An operator who wants the values kept can export them first; silently retaining credentials for a device someone removed is not a default worth having.

### 3.4 Secrets reuse `secrets/store.ts`; nothing new is invented

The first use of this store is "write auth" — TikTok session tokens. A plain-text `value` column would put those in every `GET /api/kv` response, every job log that dumps a fetched value, and every database copy.

`packages/core/src/secrets/store.ts` already solves this: AES-256-GCM with the namespace folded in as AEAD associated data, one key file per data directory. It takes a `SecretNamespace` union — `'network' | 'connector' | 'webhook'` — and this plan adds `'kv'`.

The honest claim is the one that module already makes and this plan repeats rather than upgrades: a secret here is **not readable by grepping the database**. Anyone with read access to the data directory can read `secrets.key` sitting beside `enkaku.db` and decrypt everything. This is not a KMS. Saying so plainly is the point — a store that implied more would encourage storing things that deserve more.

A secret value:
- is written encrypted, with a `hint` computed once at write time (`secretHint`, e.g. `sk-…7Xq2`);
- is returned decrypted **only** to a running job through `ctx.kv`, never through the HTTP API;
- renders in Studio and in `GET /api/kv` as its hint plus `secret: true`, never its value;
- is redacted from job logs by value-match before a log line is stored (§4.7).

The last one matters more than it looks. A script that does `ctx.log.info('token', { token })` would otherwise put the secret in the log the encryption was protecting it from.

### 3.5 Get and set are not enough

Two jobs on two different devices will write the same global key at the same time — a shared counter, a rotating account pool, a "who has the lock" marker. Last-write-wins loses one of them with no signal.

The store therefore offers, from the start:

| operation | why it cannot be built from get + set |
|---|---|
| `setIfVersion(key, value, expectedVersion)` | compare-and-swap; the caller learns it lost instead of overwriting |
| `increment(key, by)` | a read-modify-write from two processes drops one |
| `delete(key, { ifVersion })` | same race, at the end of a value's life |

`version` is a monotonically increasing integer per row, bumped on every write. The workspace store (plan 64) already made exactly this call for exactly this reason (`ifMatch`), and `EnkakuVFS` (plan 77) drives it — so the pattern, and the operator's mental model of it, already exist in this codebase.

### 3.6 Values are JSON, validated on read by the caller's own schema

Storing a typed value means storing JSON. Reading it back means trusting bytes written by an older version of a script, which is exactly the boundary the repo's Zod rule covers.

So `ctx.kv.get(key, schema)` takes a Zod schema and validates before returning. A value that no longer matches yields a typed error naming the key, not a silently mis-shaped object that fails three lines later. `getRaw(key)` exists for the caller who genuinely wants `unknown`.

## 4. Technical design

### 4.1 `packages/core/src/kv/store.ts`

```ts
export type KvScope = { kind: 'global' } | { kind: 'device'; stableId: string }

export interface KvEntry {
  key: string
  value: unknown          // null when secret and the reader is not a job
  secret: boolean
  hint: string | null     // set only when secret
  version: number
  expiresAt: number | null
  updatedAt: number
}

export interface KvStore {
  get(scope: KvScope, ns: string, key: string): KvEntry | null
  set(scope: KvScope, ns: string, key: string, value: unknown, opts?: KvSetOptions): KvEntry
  setIfVersion(scope, ns, key, value, expectedVersion, opts?): KvEntry | null   // null = lost the race
  increment(scope, ns, key, by: number): number
  delete(scope, ns, key, opts?: { ifVersion?: number }): boolean
  list(scope, ns, q: { prefix?: string; limit: number; cursor?: KvCursor | null }): Page<KvEntry>
  deleteNamespace(scope, ns): number
  deleteDevice(stableId: string): number      // called by lifecycle teardown (§4.6)
  sweepExpired(now?: Date): number
}
```

`KvSetOptions` is `{ secret?: boolean; ttlSec?: number }`.

### 4.2 Schema — one new table

```ts
export const kvEntries = sqliteTable('kv_entries', {
  id: text('id').primaryKey(),
  /** 'global' | 'device' — the scope discriminator. */
  scope: text('scope').notNull(),
  /** stableId for a device-scoped row; '' for global. NOT devices.id — see §3.3. */
  scopeId: text('scope_id').notNull().default(''),
  /** The owning plugin id, or the script name for a standalone script (§3.2). */
  namespace: text('namespace').notNull(),
  key: text('key').notNull(),
  /** JSON for a plain value; the `secrets/store.ts` envelope for a secret. */
  value: text('value', { mode: 'json' }),
  secret: integer('secret', { mode: 'boolean' }).notNull().default(false),
  /** Masked tail, computed once at write time. Null unless `secret`. */
  hint: text('hint'),
  /** Bumped on every write — the CAS token (§3.5). */
  version: integer('version').notNull().default(1),
  /** Unix seconds; null never expires. */
  expiresAt: integer('expires_at'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  updatedByJobId: text('updated_by_job_id'),
}, (t) => [
  uniqueIndex('idx_kv_identity').on(t.scope, t.scopeId, t.namespace, t.key),
  index('idx_kv_scan').on(t.scope, t.scopeId, t.namespace, t.key),
  index('idx_kv_expiry').on(t.expiresAt),
])
```

The unique index IS the identity rule from §3.2 — enforced by the database, not by convention.

### 4.3 Quotas

Unbounded, this becomes a place to put a 40 MB screenshot. Limits, farm-settable under `kv.*`, enforced in the store and reported as typed errors:

| limit | default | error |
|---|---|---|
| value size | 64 KiB | `E_KV_VALUE_TOO_LARGE` |
| key length | 256 chars | `E_KV_KEY_INVALID` |
| entries per (scope, namespace) | 1,000 | `E_KV_QUOTA_EXCEEDED` |
| total entries per device | 5,000 | `E_KV_QUOTA_EXCEEDED` |

Key charset is `[A-Za-z0-9._:-]{1,256}` — no whitespace, no `/`, so a key never has to be escaped to appear in a log line or a URL.

### 4.4 The script API and its IPC

`ctx.kv` follows the existing child→parent request/response pattern exactly (`device.call` / `artifact.save` in `packages/session/src/runner/ipc.ts`): a new `kv.call` message with a `callId`, answered by `kv.result`. The child holds no state and no database handle; every operation is the parent's.

```ts
interface KvApi {
  get<T>(key: string, schema: ZodType<T>): Promise<T | null>
  getRaw(key: string): Promise<unknown | null>
  set(key: string, value: unknown, opts?: { secret?: boolean; ttlSec?: number }): Promise<{ version: number }>
  setIfVersion(key: string, value: unknown, expectedVersion: number, opts?): Promise<{ version: number } | null>
  increment(key: string, by?: number): Promise<number>
  delete(key: string, opts?: { ifVersion?: number }): Promise<boolean>
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ items: KvEntry[]; nextCursor: string | null }>
}

ctx.kv.device   // this job's device, by stableId
ctx.kv.global   // the farm
```

The namespace is injected by the parent from the job's script row. A script cannot name a namespace and therefore cannot reach another plugin's values.

### 4.5 Expiry is swept, not scheduled

A TTL'd row is filtered out on read the moment it is past `expiresAt`, regardless of whether anything has swept it — so an expired value is never returned, even between sweeps. `sweepExpired()` then deletes them, called from the existing retention GC pass (`retention.gc` already exists as an audit action) rather than from a new timer.

### 4.6 Forget deletes the device's values

`device/lifecycle.ts` already deletes a device's artifacts, events, jobs, and tags inside one transaction. `deleteDevice(stableId)` joins that transaction and the count joins the returned summary, so the Forget dialog says how many values are going with it. The device row is read for its `stableId` before the delete, since the row is gone by the end of the transaction.

### 4.7 Log redaction

Before a job log line is persisted, every secret value currently readable by that job's namespace and device is replaced with `«redacted:<key>»`. Match is on the exact decrypted string, minimum length 8 (below that, the false-positive rate on ordinary text makes the redaction worse than useless).

This is best-effort and the plan says so: a script that base64s a token before logging it defeats it. It exists to catch the accident, not the adversary.

## 5. Implementation steps

1. `kvEntries` table + migration (`bun run --cwd packages/core db:generate`).
2. `secrets/store.ts`: add `'kv'` to `SecretNamespace`.
3. `kv/store.ts` — the store, quotas, CAS, expiry filtering.
4. `api/kv.ts` — `GET/PUT/DELETE /api/kv`, admin-scoped, secrets rendered as hint only. Audit actions `kv.set` / `kv.delete`.
5. IPC: `kv.call` / `kv.result` in `runner/ipc.ts`; parent handler in the script executor; `ctx.kv` in `runner/child-entry.ts`.
6. SDK: `KvApi` on `ScriptContext`.
7. `device/lifecycle.ts`: `deleteDevice` in the teardown transaction, count in the summary.
8. Log redaction in the job logger.
9. Studio: a KV panel on the device page (device scope) and under Settings (global).

## 6. Acceptance criteria

1. A script writes a device-scoped value; a later job **on the same device** reads it back.
2. A later job on a **different** device reads null for the same key.
3. Two plugins writing `token` in the same scope do not see each other's value.
4. A secret's plaintext appears nowhere in `GET /api/kv`, in the job log, or in `enkaku.db` (asserted by grepping the file for the literal).
5. `setIfVersion` with a stale version returns null and leaves the stored value unchanged.
6. Two concurrent `increment` calls on one key yield exactly +2.
7. A value past its TTL reads as null **before** any sweep has run.
8. A value larger than the cap is refused with `E_KV_VALUE_TOO_LARGE`; nothing is written.
9. Forgetting a device deletes its values, and the returned summary counts them.
10. `list` pages by keyset and never returns a secret's plaintext.
11. A `get` whose stored JSON no longer matches the caller's schema throws naming the key.
12. A key with a `/` or a space is refused.

## 7. Test plan

Colocated `kv/store.test.ts` against an in-memory DB, following `workspace/store.test.ts`'s shape. The concurrency cases (6) run real overlapping transactions rather than simulating them — a CAS test that never races proves nothing. Criterion 4's grep runs against a real file-backed DB, not `:memory:`. Lifecycle integration goes in the existing `device/lifecycle.test.ts`.

## 8. Risks and mitigations

- **Secrets look safer than they are.** Mitigation: the honest claim is repeated in the module comment, the API response, and the Studio panel, in the same words `secrets/store.ts` already uses. No wording anywhere implies key management.
- **KV becomes a database.** Mitigation: quotas from day one, not added later under pressure; no query surface beyond prefix listing.
- **Redaction gives false confidence.** Mitigation: documented as best-effort in the SDK type doc, where a script author reads it.
- **A device is forgotten and its sessions are wanted back.** Mitigation: the Forget dialog states the count before confirming. No undo — consistent with jobs and artifacts, which already go.

## 9. Open questions

1. **Cross-namespace reads.** A posting pack wanting the login pack's session is a real case. Deferred rather than guessed: it needs a grant model (who may read whose namespace, granted by whom). Revisit when a second plugin exists.
2. **Should global scope be admin-writable from a script at all?** A script on any device can currently write a farm-wide key. An allowlist per plugin may be wanted once more than one plugin exists.
3. **Export/import.** Moving a device between farms with its sessions is plausible but has no caller yet.
