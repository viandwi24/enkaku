# Where a plugin's data actually lives — the KV store, and what is not it

> An as-built account, read off the code on `main` (2026-08-18), not a plan. Where the code and a
> plan disagree, this document follows the code and says so. Plan 79 is the design record for the
> store, plan 108 §3.1/§4.5 for the plugin routes on top of it, plan 112 step 112.2 for the hint
> switch; `docs/spec.md` §12.4 is the product statement.

---

## 0. The report this document answers

A farm owner opened **Settings → Key/Value store** and **Device → Settings → KV**, saw nothing, and
asked what plugins actually store their data in. They expected four separate things:

1. device-scoped KV,
2. global KV,
3. plugin storage,
4. encrypted credentials.

Two things were wrong, and only one of them was a UI bug.

**The screen was not empty.** `proxy-manager` had an entry and `tiktok` had four. The panel required
a namespace to be *typed*, and `/api/kv` had no route that could enumerate namespaces — so it was a
search box with no index, and an operator who could not guess `proxy-manager` correctly read a blank
page as an empty store. `GET /api/kv/namespaces` and the picker in `KvPanel` fix that half.

**The four "stores" are one table.** That half is not a bug, but nowhere in the repo said so, which
is why it had to be guessed at. The rest of this document is that account.

---

## 1. One table, three axes, one flag

Everything a script or a plugin stores durably is a row in **`kv_entries`**
(`packages/core/src/db/schema.ts`). There is no second store, and a plugin has no storage engine of
its own.

| | column | values | what it means |
|---|---|---|---|
| axis 1 | `scope` | `global` \| `device` | the farm, or one phone |
| axis 2 | `namespace` | a plugin id | who owns the value — **injected by the runtime, never typed by a script** |
| axis 3 | `key` | `[A-Za-z0-9._:-]+` | the script's own name for the value |
| flag | `secret` | `0` \| `1` | whether `value` is AEAD-encrypted at rest |

`(scope, scope_id, namespace, key)` is a unique index — the identity rule is enforced by the
database, not by convention.

Mapping that back onto the four things the owner expected:

- **device-scoped KV** and **global KV** are axis 1, one column;
- **plugin storage** is axis 2, and it exists in *both* scopes — it is not a third place;
- **encrypted credentials** are the flag, and only for values a *plugin* stores. The farm's own
  credentials are genuinely elsewhere — see §6.

## 2. `scope` — the rule is one sentence

> **If forgetting the device should forget the fact, it is device-scoped.** (plan 108 §3.1)

- A **global** entry (`scope_id` is `''`, never `NULL`) is a catalogue or a farm-wide setting. One
  copy, read by every job on every device.
- A **device** entry is keyed on the device's **`stableId`**, never `devices.id` and never the adb
  serial (plan 79 §3.3). It is deleted in the same transaction that forgets the device
  (`device/lifecycle.ts`'s `forget()`), unconditionally — not gated on "delete history", because a
  stored session is live state, not a historical record.

Keying on `stableId` is what makes a forgotten-and-re-admitted phone's values reachable rather than
orphaned on disk under a dead row id.

A running job may only ever write **its own** device's scope: the child process sends no scope id
at all, and the parent resolves it from the job (`kv/runner-port.ts` is the one place
`devices.id → stableId` happens).

## 3. `namespace` — injected, not chosen

A script author never writes a namespace anywhere. `ctx.kv.device` and `ctx.kv.global` are already
bound to the owning plugin's id (or, for a standalone script published without a plugin, its own
script name), resolved parent-side from what the child reported at `ready`.

That is deliberate and it is the whole reason the key is three parts instead of two (plan 79 §3.2):
two plugins will both want `token`, two scripts in one plugin will both want `state`, and with a
two-part key the second write wins **silently** — the first plugin starts reading someone else's
value, of the right type, at the right key, meaning something else entirely.

Consequences worth knowing:

- **A plugin's namespace is shared by everything in it** — every member script, and the plugin's own
  Studio screens through `/api/plugins/:name/data*`. A script's scrape is what a screen reads.
- **A plugin under development uses the same namespace as its published counterpart** (plan 79
  §3.2), so a dev run works against real state — and can overwrite it.
- **A script cannot read another namespace.** Cross-plugin sharing needs a grant model that does not
  exist yet; it is plan 79's own open question 1.
- **The namespace is not a caller-supplied parameter on the plugin routes.** On
  `/api/plugins/:name/data*` it is the `:name` path segment — there is no request shape that can
  name another plugin's namespace. That is exactly why those routes are operator-level
  (`plugin.data`) while `/api/kv/entry`, which *can* name any namespace, is admin-only
  (`kv.manage`).

## 4. `secret: true` — what it does, and what it does not

`secret: true` encrypts the `value` column with AES-256-GCM through
`packages/core/src/secrets/store.ts`, under the `'kv'` `SecretNamespace` (folded in as AEAD
associated data, so a `kv` value cannot be opened as a `connector` one). No second mechanism was
invented for KV.

**What it buys, stated as narrowly as it is true:**

> The value is not readable by grepping the database.

**What it does not buy.** This is not a KMS and does not claim to be one. The key file
(`secrets.key`) sits in the data directory **right beside `enkaku.db`**, and anyone who can read
that directory can decrypt every secret in the farm. A database backup taken with the data directory
carries both halves. `secrets/store.ts` says this in its own header; it is repeated here rather than
softened, because a store that implied more would encourage storing things that deserve more.

**Three properties that hold regardless:**

- `list()` **never** decrypts, for any caller — a secret's `value` is `null` on every listing
  (plan 79 criterion 10). `get()` is the only path that decrypts, and it exists so a running job can
  actually use the value. **Unchanged by the reveal route below**, which answers one named key at a
  time and has no plural form to grow one.
- Every HTTP response redacts a secret's `value` to `null` — a listing, the namespace index, a
  single-entry `GET`, a write's echo (`redactEntry` in `api/kv.ts`, the one function
  `api/plugins.ts`'s data routes import rather than reimplement) — **except
  `POST /api/kv/entry/reveal`**, whose whole purpose is to hand back one secret's plaintext and
  record that it did. That route does not call `redactEntry` and does not weaken it: the boundary
  is bypassed by one named handler, visibly, rather than turned into a boundary with a condition in
  it. Nothing on the operator-level `plugin.data` routes changed.
- Job logs are redacted by value-match before a line is stored (`buildSecretRedactor`), so
  `ctx.log.info('token', { token })` does not defeat the encryption in the log file. Best-effort,
  minimum plaintext length 8. It matches log lines by value and knows nothing about HTTP responses
  — it is not, and must never be relied on as, a second net under the reveal route.

**The hint is a real disclosure, and the store still defaults it on.** A secret write also stores
`secretHint(plaintext)` — `${first 7}…${last 4}` — **in the clear** on the row, and every read path
returns it. That is right for an API key with a public prefix, where the point is telling two keys
apart, and wrong for a password, where eleven characters is a genuine leak. `hint: false`
suppresses it, **per write, not per key**: a caller storing a credential must pass it on every
write, exactly as it must pass `secret: true` on every one. Every writing surface can now decline
it — `ctx.kv.set(..., { hint: false })`, `PUT /api/plugins/:name/data/entry` (plan 112 step 112.2),
and `PUT /api/kv/entry` (hotfix **96.38**, closed 2026-08-18). **Studio's KV panel sends
`hint: false` by default** when the secret switch is on, and offers a switch to ask for one: what
gets typed into that form is overwhelmingly a credential, and identifying a row is now the reveal
button's job rather than a fragment's.

### The reveal: one route, admin-only, audited

`POST /api/kv/entry/reveal` (`kv.manage`) returns the plaintext of exactly one named secret.

**Why it exists, given the paragraph above.** `secrets.key` sits beside `enkaku.db`, so anyone
holding `kv.manage` can already open every secret in the farm with `sqlite3`. A UI that refuses to
show them protects nothing against that person — it only pushes them onto a path that leaves no
trace. The value is AES-256-GCM, not a hash; withholding it over HTTP was never what made it safe.
So the door is not kept shut, it is made explicit, single-purpose, and recorded. **That argument
reaches `kv.manage` and stops there** — it is not a reason to relax anything on the operator-level
`plugin.data` routes, whose holders have no equivalent standing access.

| property | how |
|---|---|
| its own route, not a flag | a `?reveal=1` on `GET /entry` is set by accident and makes the audit row ambiguous; a separate path cannot be arrived at by mistake |
| POST, not GET | a GET's URL lands in access logs, proxy logs, history and `Referer`, and is prefetchable; the side effect here is the audit row |
| refuses a non-secret row | its value is already in the listing — answering it would push ordinary reads through reveal and make `kv.reveal` stop meaning "somebody read a secret" |
| one row per request | the gate is checked **inside** the handler, not by `requirePermission`, because a refusal that leaves no trace is the half of the log that matters most |
| never cacheable | `Cache-Control: no-store` (not `no-cache`, which still permits storing and revalidating) |

The audit row is `kv.reveal`: `userId` the operator, `target` the key, `meta` the outcome
(`revealed`, `forbidden`, `not-found`, `not-secret`, `bad-request`, `unreadable`), the scope, the
stableId and the namespace. **Never the value and nothing derived from it** — no hint, no length,
no prefix. It is written *before* the body is serialised, so an audit insert that fails fails the
request: an unaudited reveal is not a degraded success, it is the one outcome this route must not
have.

In Studio, `KvPanel` puts a **Show** button beside a secret row's badge. Nothing is fetched until
it is pressed; the plaintext lives in component state and nowhere else; Hide, a namespace change, a
scope change, a write, a delete and a remount all remove it from the DOM; one value is shown at a
time; and there is a copy button, because reading a SOAX credential back out to paste elsewhere is
the case the feature was asked for.

## 5. Identity, versions, expiry, quotas

- **`version`** is bumped on every write and is the compare-and-swap token: `setIfVersion` returns
  `null` when the caller lost the race rather than overwriting, and `delete(..., { ifVersion })`
  does the same at the end of a value's life. `increment` exists because a read-modify-write from
  two jobs drops one.
- **`expiresAt`** is unix seconds, `null` = never. An expired row reads as absent on **every** path
  the instant it is past, whether or not `sweepExpired` has run — including the namespace index.
- **Quotas** are farm settings (`FarmSettings.kv`, Settings → Key/Value store): `maxValueBytes`
  64 KiB (measured on the plaintext JSON, before encryption), `maxKeyLength` 256 characters,
  `maxEntriesPerNamespace` 1,000, `maxEntriesPerDevice` 5,000 across all namespaces. Exceeding one
  throws a coded error naming both numbers.

## 6. What is *not* in this table

The farm's own credentials are separate tables, each under its own `SecretNamespace`, none of them
plugin KV, and none of them visible on the Key/Value store screen:

| table | holds | surface |
|---|---|---|
| `network_credentials` | a Wi-Fi/proxy upstream's password (`'network'`) | Device → Network |
| `connectors` | an LLM provider API key (`'connector'`) | Settings → Connectors |
| `webhook_endpoints` | an **outbound** webhook's signing secret (`'webhook'`) | Settings → Webhooks |
| `plugin_webhooks` | an **inbound** webhook's secret, farm-minted (`'webhook'`) | the plugin's own page |

`plugin_webhooks` is the interesting one, because it is the case that *looks* like plugin KV and
deliberately is not (its own schema comment has the full argument): the farm generates the value,
the farm verifies against it, the operator rotates it. It must keep verifying while the plugin is
stopped or `failed`; it must not be swept by `?deleteKv=1` **or by Reset data** (which leaves the
plugin installed and active, so a webhook whose secret vanished would answer 200 and reject every
delivery), count against the plugin's quota, or be rewritable by the plugin as a side effect of an
ordinary `set`. And it has no hint column at all —
there is nothing to suppress, because 32 random bytes have no public prefix worth showing.

Also not this table: **artifacts** (files on disk, `POST /api/artifacts`) and the **workspace**
(`workspace_files`, a content-addressed virtual filesystem). A value over 64 KiB belongs in one of
those, not here.

## 7. Reaching it

| surface | permission | notes |
|---|---|---|
| `ctx.kv.device` / `ctx.kv.global` | — | a running job; namespace and device scope both injected |
| `GET /api/kv/namespaces?scope=…[&stableId=…]` | `kv.manage` (admin) | **the index**: `{ items: [{ namespace, entries, secrets }] }`, one `GROUP BY` per scope |
| `GET /api/kv?scope=…&namespace=…` | `kv.manage` (admin) | keyset-paged entries, secrets redacted |
| `GET/PUT/DELETE /api/kv/entry` | `kv.manage` (admin) | can name *any* namespace — that is why it is admin-only; `PUT` takes `hint` |
| `POST /api/kv/entry/reveal` | `kv.manage` (admin) | the **only** response in this surface carrying a secret's plaintext — one named key, `no-store`, one `kv.reveal` audit row per request including refusals (§4) |
| `GET /api/plugins/:name/data`, `PUT/DELETE /data/entry`, `GET /data/count`, `GET /data/scan` | `plugin.data` (operator) | namespace fixed to `:name`; `scan` answers one key across every device |
| `DELETE /api/plugins/:name/:version?deleteKv=1` | plugin management (`script.delete`) | bulk delete #1: the plugin GOES, and its namespace with it |
| `POST /api/plugins/:name/reset` | plugin management (`script.delete`) | bulk delete #2 — **Reset data**: the plugin STAYS installed and active, only its namespace goes, and the plugin's own cleanup handler runs **first** (see below) |

The two bulk deletes share one sweep function (`PluginRuntime.deleteData`) and therefore one definition of "this plugin's data": both scopes, every device row, and never `plugin_webhooks` (§6). What Reset adds is the ordering and the veto.

**The handler runs before the delete, and its report can stop the delete.** A plugin's stored data is frequently the only record of what it did to the outside world — `proxy-manager`'s assignments are the only place the farm knows which phones it pointed at a proxy — so a reset gives the plugin one run (`defineService({ onResetData })`) to undo that while the data is still intact. What comes back decides what happens next:

| the handler reported | the data |
|---|---|
| nothing outstanding, or the plugin declares no handler | deleted |
| debts only — cleanups that did not complete but are now recorded somewhere that outlives this plugin (a device row's `pendingClear`) | deleted; the screen says how many are owed and never calls it a plain success |
| any outright failure, a handler that threw, a handler that could not run, or a report the farm cannot parse | **nothing is deleted** — not even the rows for the parts that cleaned up, because those rows are the record of which devices are still carrying something |

The handler is contractually idempotent and re-runnable, so a blocked pass is fixed by fixing the cause and pressing Reset again. A `resetData.permissions` list may borrow capabilities the running service does not hold, live only for the length of one operator-initiated pass — that is how `proxy-manager` reaches `device.network.clear` without holding it the rest of the time.

The index route returns **metadata only** — a namespace name and two counts. No key, no value, and
no hint, by construction: it exists so a browsing surface can offer a picker instead of a text box,
and widening it into a preview would turn an enumeration route into a disclosure route. The secret
count is included on purpose — "12 values · 3 secret" is honest where "12 values" quietly is not,
and it reveals strictly less than listing the namespace already does.

### What the picker shows, and the three states it keeps apart

`packages/studio/src/components/kv/KvPanel.tsx` is one component, mounted at global scope under
Settings and at device scope on the device page and in the device popup. The device mount queries
the index at `scope=device&stableId=…`, so it lists only namespaces that have rows **for that
device** — never a plugin that has only ever written global values.

Three facts that used to render identically and must not again:

| what is true | what the screen says |
|---|---|
| the index came back empty | *"This device has no stored values"* / *"Nothing is stored farm-wide yet"* |
| the index has namespaces, none picked | *"Pick a namespace to browse"* |
| a chosen namespace holds nothing | *"No values under this namespace yet"* |

The free-text box under the picker is the escape hatch for the one case an index structurally cannot
cover: a namespace with zero rows has nothing to be indexed by, so a plugin that declared one and
never wrote to it will not be listed. The panel says that on screen.

## 8. What this store cannot answer

KV answers *"what does device X have"*. It cannot answer *"which devices have Y"* without the plugin
routes' `scan` (one left-joined, keyset-paged statement, five allowlisted device fields, secrets
redacted). It cannot order by value, and it cannot join. The moment a plugin needs any of those as a
query, that is the case for real relational storage — not a bigger KV store.
