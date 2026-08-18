# Plan 112 — M77 : The proxy manager stops being a separate app

> Status: partial — **steps 112.1 and 112.3–112.7 are built and tested** (2026-08-17): the engine. `socks` is a dependency and a published `.enkaku` carrying it verified, activated and served real traffic on a real farm (H1 **PASS**, §0.2); the v2 record, its two-key split, its four coded refusals and its read-time migration are in `src/shared.ts` + `src/record.ts`; both upstream diallers, both listeners and the supervisor are in `src/service/`. **H2 and H3 have been run and their numbers are in §0.3.** Not built: **112.2** (the KV `hint: false` fix — so a credential still cannot be stored safely, and the pack deliberately does not write one; `index.test.ts` fails the day it lands), 112.8–112.11 (gated on plan 109 steps 109.6/109.8/109.9/109.10), and 112.12. The screen was widened only as far as the record's own shape required: it has no state cell, no Start/Stop, no Logs tab and no password field.
> Depends on: plan 108 (M73) — the manifest, `plugin.data`, the KV namespace, the Plugins page. Plan 109 (M74) — `defineService`, the service host, `ctx.onStop`, and later its listeners, HTTP handlers and logs. Plan 111 (M76) — tier C, `@enkaku/ui`, and the pack this plan extends.
> Deliberately does NOT depend on: the `network` driver layer (plans 33/43/44/51/52/54/55). A proxy an app *can be pointed at* and a route an app *cannot escape* are different things, and §3.12 keeps them apart. Nothing here reads `Socks5RouteConfig`, and nothing here claims to route a device's traffic.
> Spec references: §7.9 (the network layer, and why this is not it), §11.3 (crash containment, never "sandbox"), §11.6 (plugins), §19 (Studio screens)
> Ships: plugins/proxy-manager/src/service/supervisor.ts

---

## 0. Evidence

The owner has been running a **separate desktop application** to manage proxies, built around [`go-gost/gost`](https://github.com/go-gost/gost). Their own example of the one line it spawns:

```
gost.exe -L "http://:9902" -F "socks5://country-id-rxxxxxxx:xxxx:xxxx@xxxx"
```

> *"jadi saya manfaatkan buat bikin bridge proxy misalnya port 9902 dengan protocol http, yang kalau diakses di tunneling ke socks5. nah ini saya sebelumnya ada bikin manager app nya, jadi ada crudnya, terus kalau distart otomatis spawn process dengan cli gost kaya diatas. nah sekarang saya pikir lagi aga ribet kalau aplikasi terpisah, gimana kalau kita satukan?"*

> *"targetnya sama harapannya proxy manager plugin ini punya ui, bisa crud, daftarin proxy nya dan protocolnya dan bikin proxy baru di local kita ini, ada logsnya juga, logs all atau logs per proxy, bisa start dan stop, dll."*

> *"jika ada library npmjs untuk proxy tunell itu diutamakan biar ga perlu download atau harus pakai binary apliaksi lain kaya go gost ini."*

So: fold the separate app into the farm as a plugin, and prefer an npm library over shipping a Go binary.

### 0.1 Confirmed findings

Every row was checked against the code on 2026-08-17, not taken from a brief.

| # | Finding | Evidence |
|---|---|---|
| **F1** | **A plugin bundle carries every npm dependency it imports, and nothing refuses it.** `enkaku publish` runs `Bun.build({ entrypoints, target: 'bun', format: 'esm', outdir, naming: 'bundle.mjs' })` — **no `external` key at all** — and its own comment says *"Bundles EVERY dependency (`@enkaku/sdk` and `zod` included), nothing external — the farm only ever accepts a finished bundle, so the runner installs nothing."* | `packages/sdk/src/cli/publish.ts:34`, `:47-53`, `:219-222` |
| **F2** | **There is no bundle size cap and no import blocklist on the publish path.** The CLI only *prints* the size; the staging body schema is `bundle: z.string().min(1)` — a minimum, no maximum; the verify child gates declared JSON Schemas and never the code. The caps that do exist (`maxSchemaBytes` 64 KiB, `maxSurfaceBytes` 256 KiB, `maxUiBytes` 8 MiB) are all about declarations or `ui/`, never the script bundle. | `publish.ts:326`; `packages/core/src/api/plugins.ts:33`; `packages/core/src/plugins/verify-child.ts`, `verify-child-entry.ts`; `packages/core/src/plugins/package.ts:264-265`; `packages/protocol/src/schema/limits.ts:15-19`; `packages/protocol/src/plugin-surface.ts:51-53` |
| **F3** | The one import allowlist in the repo (`ALLOWED_BARE_SPECIFIERS = new Set(['@enkaku/sdk', 'zod'])`, refusing `node:*`) governs the **server-side workspace build** — code authored inside the farm — and does not apply to a CLI-published `.enkaku`. Do not mistake one for the other. | `packages/core/src/scripts/build.ts:33`, `:76` |
| **F4** | **Bun auto-externalises `node:*` builtins under `target: 'bun'`.** So a bundled `socks` inlines its own source and leaves `import … from "net"/"stream"/"events"` as live imports resolved by the Bun runtime that loads the bundle. The repo already knows this and says so. | `packages/core/src/scripts/build.ts:26-30`; reproduced by building a core module and reading the emitted imports |
| **F5** | **`socks` is not in this repo.** Adding it is one line in `plugins/proxy-manager/package.json` — plugins are workspaces (`"plugins/*"` in the root `package.json`). Its only dependencies are `ip-address` and `smart-buffer`; all three are pure JS. | `grep -c socks bun.lock` → 0; root `package.json:4-9` |
| **F6** | **A plugin's service runs by `await import()` in the core's own process**, from a content-addressed single `.mjs` file, with a cache-busting `?service=<starts>` query so a reload actually re-evaluates the module. There is no directory, no `npm install`, no second process. | `packages/core/src/plugins/runtime-host.ts:705-712`; `packages/core/src/scripts/bundle-cache.ts:22-34` |
| **F7** | **Plan 109 steps 109.1 and 109.2 have landed** (untracked in the working tree as of this writing, so plan 109's own status line saying 109.2 is unbuilt is already stale). `defineService` exists, `PluginDefinition.service` is the field, `runtime-host.ts` is 38 KB with `invoke()` as the single containment funnel, `ctx.onStop` with a **5 s total** disposer budget, the error budget (20 failures / 60 s), and the five-word status vocabulary with `starting ≠ running` written into the schema's own doc comment. | `packages/sdk/src/runtime.ts`; `packages/protocol/src/plugin-service.ts`; `packages/core/src/plugins/runtime-host.ts:65-202`; `packages/core/src/daemon.ts:1426`, `:2734`, `:3637` |
| **F8** | **`ctx` today is exactly `{ storage, log, farm }`** — asserted exhaustively by a test, not merely by convention. `ctx.farm` refuses `E_FARM_UNAVAILABLE` until 109.3 wires a broker. `isPortFree`, `reportListener`, `onRequest`, `onSocket`, `onEvent`, `onQuery` and `exposeToDevice` **do not exist**. | `packages/core/src/plugins/plugin-context.test.ts:143`; `packages/sdk/src/runtime.ts:114-121`, `:137-138` |
| **F9** | **There is no `ctx.settings`.** Plan 109 §3.3 says *"the port itself is an ordinary plugin setting, so an operator can change it from the schema-driven settings form plan 108 already renders"* — no such mechanism exists in either plan's code. `PluginServiceDeclarationSchema` carries only `permissions` and `isolation`. | `packages/protocol/src/plugin-service.ts:39-50`; F8's test |
| **F10** | **KV secrets are real.** `set(key, value, { secret: true })` stores AES-256-GCM ciphertext (`ALGO = 'aes-256-gcm'`, 12-byte random IV, the namespace string as AEAD associated data, format `iv.tag.ciphertext` base64). The key is 32 raw random bytes at `<dataDir>/secrets.key`, mode `0600`. **No KDF, no passphrase, no keychain** — and the module says so itself: this is *"not a KMS"*, the honest claim is only "not readable by grepping the database". | `packages/core/src/kv/store.ts:218-219`; `packages/core/src/secrets/store.ts:23-28`, `:45-46`, `:72-76`, `:93-98` |
| **F11** | **A secret's plaintext structurally cannot reach the browser.** `list()` never decrypts (`value` is always `null` for a secret row) and every HTTP path additionally redacts. Plaintext leaves the store only through `get()`, in-process. This is a property this plan wants, and it is what forces §3.10's two-key split. | `packages/core/src/kv/store.ts:152-163`; `packages/core/src/api/kv.ts:43-45`; `packages/core/src/api/plugins.ts:146-160` |
| **F12** | **…except for the hint, which leaks eleven characters.** `secretHint(plaintext)` returns `` `${plaintext.slice(0, 7)}…${plaintext.slice(-4)}` `` for anything longer than 8 characters, it is stored on the row, and `redactEntry` keeps it. There is no way to turn it off. For a proxy password handed to anyone holding `plugin.data`, that is a real disclosure — and this plan would be the first thing in the repo to put a real credential in KV. **Step 112.2 fixes it.** | `packages/core/src/secrets/store.ts:182-185`; `packages/core/src/kv/store.ts:219`; `packages/core/src/api/kv.ts:43-45` |
| **F13** | **`increment()` silently un-secrets a key.** `store.ts`'s increment path passes no options through to the write, so `secret` falls back to `false` and the value is rewritten as plaintext. Nothing in this plan may `increment` a secret key; it is filed as a hotfix candidate in §8, not fixed here. | `packages/core/src/kv/store.ts:282`, `:294` |
| **F14** | **KV quotas are a hard synchronous throw, not a soft cap.** `maxValueBytes` 65 536 (measured on the plaintext JSON, before encryption), `maxKeyLength` 256, `maxEntriesPerNamespace` 1 000, `maxEntriesPerDevice` 5 000 — the entry-count caps are checked on **create** only. `E_KV_VALUE_TOO_LARGE` / `E_KV_QUOTA_EXCEEDED`. Keys must match `/^[A-Za-z0-9._:-]+$/`. | `packages/core/src/kv/store.ts:96`, `:114-133`, `:205-214`; `packages/protocol/src/settings.ts:2352-2394` |
| **F15** | **A value-based log redactor exists and is wired into the JOB logger only.** `buildSecretRedactor` lists a namespace's secrets, decrypts them, sorts longest-first, and substring-replaces each with `«redacted:<key>»`; secrets shorter than 8 characters are never matched. It reaches the job logger through `KvRunnerPort.redact`. **Plugin runtime logs have no redaction, because `plugins/runtime-logs.ts` (109.8) does not exist.** | `packages/core/src/kv/store.ts:352`, `:362-377`; `packages/core/src/kv/runner-port.ts:25`, `:103-118`; `packages/session/src/runner/job-runner.ts:1130` |
| **F16** | **Container isolation spawns a job child with `--network=none` and `--cap-drop=ALL`**, on the stated reasoning that *"scripts need no network of their own; devices are reached via the parent"*. A script member that dials a proxy has no network in that mode. This is why the bridge and the reachability check belong in the **service**, not in a script. | `packages/session/src/runner/isolation.ts:105-106` |
| **F17** | **`adb reverse` still does not exist** in the one bounded adb CLI helper. Plan 109's H1 nonetheless **PASSED over USB** on real hardware (`ZP2222RMBS`, adb 36.0.0) — a process on the device dialled `127.0.0.1:<port>` and bytes crossed both ways. Wireless is deliberately untested. So device reachability is real, and unbuilt. | `packages/core/src/device/host-adb.ts` (no `reverse`); `docs/plans/109-m74-plugin-runtime.md:40`, `:44-46` |
| **F18** | **`@enkaku/ui` carries the behaviour layer, not just components** — 143 names through the plugin import-map shim, including `api(path, schema, init?)` (the schema is a **required** positional argument), `useAction()` → `{ run, pending, isPending }`, `coreBase()`, `EmptyState`/`ErrorState`/`LoadingRows`, `ConfirmDialog`, `relativeTime`, and `z`. It deliberately exports **no `toast`** (use `useAction`) and **no `PageHeader`** (the host renders one above every plugin view). | `packages/ui/src/index.ts`; `packages/ui/src/lib/actions.ts:103-172`; `packages/ui/src/lib/core-base.ts:86-97`; `docs/plans/111-m76-plugin-react-ui.md:179-183`, `:296-306` |
| **F19** | **The pack already exists on tier C with three tabs and working CRUD.** `proxy:`-prefixed rows in the plugin's **global** KV namespace, `ProxyRecordSchema` = `{ label, kind, host, port, notes }` with `kind ∈ {http, https, socks5}`, writes through `PUT/DELETE /api/plugins/proxy-manager/data/entry`, one device-scoped `assigned` key behind the Assignments tab, and one script member `check` that dials nothing and returns `reachable: false` on purpose. Every "this does nothing yet" sentence is declared once in `src/shared.ts` and asserted by `index.test.ts`. | `plugins/proxy-manager/src/index.ts`, `record.ts`, `shared.ts`, `ui/parts/api.ts`, `ui/parts/catalogue.tsx` |
| **F20** | **`Bun.listen`'s socket is not a Node stream and has no `.pipe()`.** `SocksClient.createConnection` hands back a `node:net.Socket`. Plan 109 §4.7's worked example uses `Bun.listen`; pairing that with a `socks` upstream would mean hand-writing backpressure between two socket kinds. The listener side of `SocketListener` is `stop(closeActiveConnections?: boolean)` — one call — which is the only thing `Bun.listen` buys here. | Bun types: `SocketListener.stop(closeActiveConnections?)`, `TCPSocketListener`; `socks` typings `SocksClientEstablishedEvent.socket: Socket` |

### 0.2 The feasibility probe — run, PASSED, and re-run before writing this

The full chain was built and executed under Bun with `socks@2.8.9`, everything on loopback:

```
client --HTTP proxy--> [bridge] --SOCKS5 + user/pass auth--> [upstream] --TCP--> [target]
```

The upstream is a **real minimal RFC 1928 + RFC 1929 SOCKS5 server with username/password auth**, not a mock, because auth is what the owner's actual proxies use and a no-auth probe proves only the easy half. The client is Bun's own `fetch({ proxy })`, so the HTTP-proxy side is exercised by a real proxy client rather than a hand-rolled approximation.

Result, reproduced on 2026-08-17 immediately before this document was written:

```
bridge accepted CONNECTs : 1
upstream auth accepted   : true
upstream TCP connects    : 1
body through the chain   : "hello-from-target"
socks-under-bun          : PASS
```

The bridge in that probe is about forty lines. That is the honest size of the core of this feature, and it is why §3.1 refuses the Go binary.

**The first run FAILED, and the reason is a finding, not a footnote — it would otherwise ship as a bug that passes every test.**

> An HTTP proxy must serve **two** request forms. Bun's `fetch({ proxy })` sends `CONNECT host:port HTTP/1.1` only for **https** targets. For an **http** target it sends **absolute-form** — `GET http://host:port/path HTTP/1.1` — which a CONNECT-only bridge answers `405` to. Every https test passes; plain http dies silently. `gost` handles both, and so must this: the bridge rewrites the request line to origin-form and replays the head upstream before piping.

Both forms are therefore separate acceptance criteria (§6.4, §6.5) and separate unit tests (§7), never one "the bridge works" test.

Two measurements taken at the same time, so §3.3's claim about bundle cost is a number rather than a hope:

| | |
|---|---|
| `socks` + `ip-address` + `smart-buffer` on disk | 768 KB |
| bundled with `bun build --target=bun --format=esm` | 115 KB, 18 modules |
| the same, `--minify` | **66 KB** |

### 0.2.1 H1 — RESULT: **PASS**, with the real numbers, and one correction to the table above

Run on 2026-08-17 as step 112.1, against a throwaway core (`ENKAKU_PORT=7791`, its own data dir), not the owner's:

```
✓ staged plugin proxy-manager@0.3.0 (1 script)
  bundle : 924.1 KB
  ui     : 2 files, 28.8 KB (sent as a .enkaku package)
  status : verified — check
→ POST …/activate   → core.plugin-host: plugin "proxy-manager@0.3.0" service running
```

Then, with a record enabled and a real SOCKS5 upstream demanding RFC 1929 username/password:

```
curl -x http://127.0.0.1:9902 http://127.0.0.1:7871/    → hello-from-target   (absolute-form)
curl -p -x http://127.0.0.1:9902 http://127.0.0.1:7871/ → hello-from-target   (CONNECT)
upstream auth: user=country-id-r9931204 ok=true ; upstream TCP connects: 2
```

| measured, 2026-08-17 | bytes |
|---|---|
| the whole published bundle, as `enkaku publish` sends it | **945 485 B (923.3 KB), 208 modules** |
| the same pack before `socks` (HEAD's entry, same toolchain) | 798 259 B |
| ⇒ `socks` + this plan's own service code | **+147 226 B** |
| `socks` alone, `--target=bun --format=esm` | 115 148 B — **exactly** §0.2's 115 KB |
| `socks` alone, `--minify` | 66 125 B — **exactly** §0.2's 66 KB |

**The correction §0.2 needs: 66 KB is not the number that ships.** `enkaku publish` calls `Bun.build` with no `minify` (`publish.ts:47-53`), so the bundle that crosses the wire and sits in `plugins.bundle` is the **unminified** one. The honest cost of `socks` is **115 KB**, not 66 KB. Nothing refuses either — `bundle: z.string().min(1)` has no maximum (F2) — but the plan should not quote the smaller figure as though it were the shipped one.

Two smaller findings from the same run:

- **Only `net` is externalised**, and it is externalised *unprefixed*: the emitted bundle's single live import is `from"net"`, not `from"node:net"`, even though the source writes `node:net`. F4 is right about the mechanism and imprecise about the spelling.
- **`ctx.onStop` genuinely releases the port.** Measured on the running farm: with the bridge on 9902, `POST /api/plugins/proxy-manager/disable` → `curl -x` fails and an independent `net.createServer().listen(9902)` succeeds. Two consecutive `POST …/runtime/restart` cycles each rebound 9902 and served (plan 109 criterion 8, criterion 11). **There is no `POST …/runtime/stop` route** — only `restart` exists on `api/plugins.ts` today; a first attempt to test the disposer through `stop` silently 404'd and looked like a leaked socket.

### 0.3 Hypotheses — unverified, each with its probe

Written the way plan 109 §0.2 writes them: a hypothesis is not a design decision, and none of these may be quietly assumed true.

| # | Hypothesis | Probe | Gates |
|---|---|---|---|
| **H1** | A published `.enkaku` carrying `socks` verifies and loads. The verify child `import()`s the bundle and the service host `import()`s it again in the core process; both must resolve the externalised `net`/`stream`/`events`. | Step 112.1 — add the dependency, `enkaku publish`, watch it verify and activate. Record the actual bundle size. → **PASS, 2026-08-17. §0.2.1 has the numbers.** | Everything. If a bundled npm dependency cannot cross the publish path, §3.3 is wrong and the plan stops. |
| **H2** | **N concurrent tunnels in the core process do not degrade the farm.** In-process means these sockets share the event loop with every WS fan-out, every video relay, and every adb call (109 §3.2). | A load harness: 1/10/50/200 concurrent tunnels through a loopback upstream, measuring proxy throughput, core RSS, and — the number that actually matters — `/api/health` p99 latency and Wall frame intervals during the run, against the same measurements with the bridge idle. Record the result **whether or not it is comfortable**, the way 109 H3 is required to. | The default advertised ceiling, and whether a per-proxy connection cap ships enabled (§3.7). |
| **H3** | **A dead upstream is detected promptly rather than hanging.** `socks`'s `DEFAULT_TIMEOUT` is 30 000 ms, and it covers the SOCKS handshake only. A TCP-accepting-but-never-answering upstream, and an upstream that black-holes *mid-stream* after a successful handshake, are two different failures and only the first is covered. | Three fixtures: a refusing upstream, an accepting-but-silent upstream, and one that accepts, completes the handshake, and then drops all traffic. Measure time-to-error at the client for each. | §3.7's per-connection deadline and idle timeout, and whether the plan needs its own read-idle timer on top of `socks`'s. |
| **H4** | **A device sees a clean failure when a bridge is stopped mid-tunnel**, rather than a hang. Destroying a socket sends RST/FIN; whether an Android HTTP client surfaces that as a prompt error or as a long stall is not something we can assert from here. | Requires 109.9 + 109.10. `adb reverse` a running bridge to a device, start a long download from an app, stop the proxy, and watch what the app reports and how long it takes. | Nothing structural — it changes the wording of the stop confirmation, and whether "Force stop" needs a warning. |
| **H5** | `adb reverse` works over **wireless** adb, not only USB. Inherited unchanged from plan 109's H1, which passed over USB and deliberately left wireless untested (proving it needs `adb tcpip`, which restarts adbd and drops the USB connection on a device that was serving the owner's running core). | Plan 109's own §7 smoke, run once on a device that is not in use. | Whether §3.9's device path claims USB only or both. |

### 0.3.1 H2 — RESULT: **no measurable degradation, at any concurrency reached**

Measured 2026-08-17 on the maintainer's machine (macOS arm64, 10 cores, Bun 1.3.14), against the throwaway core on :7791 with the bridge on 127.0.0.1:9902 tunnelling through a loopback SOCKS5 upstream to a loopback target. Each row is a 6 s window; `/api/health` is sampled every 20 ms from a separate process and the percentiles are over ~290 samples. Recorded exactly as measured, comfortable or not.

| tunnels | proxy req/s | `/api/health` p50 | p99 | max | core RSS | errors |
|---:|---:|---:|---:|---:|---:|---:|
| 0 (idle baseline) | — | 1.62 ms | 5.56 ms | 18.37 ms | 122 MB | 0 |
| 1 | 17 739 | 0.35 ms | 1.32 ms | 2.06 ms | 110 MB | 0 |
| 10 | 67 028 | 0.46 ms | 1.72 ms | 2.41 ms | 106 MB | 0 |
| 50 | 68 635 | 0.72 ms | 3.19 ms | 3.38 ms | 117 MB | 0 |
| 200 | 72 740 | 0.77 ms | 3.17 ms | 3.95 ms | 141 MB | 0 |
| 500 | 70 618 | 0.83 ms | 6.44 ms | 8.41 ms | 191 MB | 0 |
| 1 000 | 71 702 | 0.82 ms | 5.20 ms | 7.99 ms | 196 MB | 0 |
| 2 000 | 72 868 | 0.81 ms | 2.52 ms | 2.90 ms | 200 MB | 0 |
| 0 (baseline again) | — | 2.02 ms | 5.73 ms | 7.42 ms | 194 MB | 0 |

**Read this carefully, because the obvious reading is wrong.** `/api/health` is *faster* under load than at idle. That is not the bridge helping the core; it is the sampler's own process being warm — at idle it sleeps 20 ms between samples and pays a cold path each time. What the table does support is the only claim that matters: **the p99 never leaves the idle baseline's own range, at any concurrency up to 2 000 tunnels saturating the event loop at ~72 000 req/s.** There is no knee.

**What was NOT measured, and must not be inferred:** Wall frame intervals. The hypothesis names them and they need a device streaming; the only device attached was the owner's, in use, and taking it over to run a load test was not worth it. So this table says the HTTP control plane is unaffected; it says nothing about screencast under load, and that gap is the reason `maxConnections` still ships enabled.

**Therefore `maxConnections` defaults to 256, and the reasoning is memory and file descriptors rather than latency** (criterion 20). RSS rises from ~100 MB idle to ~200 MB at 2 000 tunnels — and *not* linearly (500 tunnels already costs ~90 MB of it; the next 1 500 cost ~9 MB), so it is mostly allocator high-water, exactly as plan 109's own H2 found. Each tunnel is two file descriptors. 256 tunnels is therefore ≈ 512 fds and ≈ 13 MB for one proxy: comfortably inside any sane `ulimit -n`, eight times more than a single residential upstream account would sustain, and far below anything measured to degrade. It is per record and an operator can raise it to 10 000. **It is a bound on a runaway client, not a defence against a measured cliff, and it should be described that way.**

### 0.3.2 H3 — RESULT: three different failures, and the read-idle timer is **required**

Measured at the client, through the real bridge, with the shipped 10 s dial deadline:

| fixture | time-to-error at the client | what the client saw | code |
|---|---:|---|---|
| refusing (nothing listening) | **10 ms** | `HTTP 502` | `E_PROXY_UPSTREAM_UNREACHABLE` |
| accepting-but-silent | **10 002 ms** | `HTTP 502` | `E_PROXY_UPSTREAM_TIMEOUT` |
| black-holing, idle timer at 2 000 ms | **2 014 ms** | connection reset | — (relay teardown) |
| black-holing, **no idle timer** | **45 004 ms** — i.e. never; that is the client's own abort | client timeout | never detected |

**The question the hypothesis asks is answered yes: a read-idle timer on top of `socks`'s handshake timeout is necessary, not belt-and-braces.** `socks`'s timeout is disarmed the moment the SOCKS reply arrives, so an upstream that completes the handshake and then drops everything is, to the dialler, a healthy tunnel — forever. Nothing else in the stack detects it.

Three decisions follow, and they are in the code:

- **The dial deadline is 10 s, not `socks`'s 30 s default** (`DEFAULT_DIAL_TIMEOUT_MS`). Row 2 shows the deadline is honoured to the millisecond and is ours; leaving it unset would have made an app on a phone wait 30 s for a dead proxy.
- **The idle timer defaults to 10 minutes** (`DEFAULT_IDLE_MS`), not to something close to the 2 s used in the fixture. It is a **stuck** detector, not an activity one: a CONNECT tunnel carrying a long-poll or an idle SSH session is legitimately silent for minutes, and a short timer would be a bug that only appears in production.
- **A `SocksClientError` carries no `code` at all.** *(measured: `Object.keys(err)` is `["options"]`; the message for a refused upstream is `"connect ECONNREFUSED 127.0.0.1:63242"`.)* A first classifier that only read `err.code` labelled every refusal as the generic `E_PROXY_UPSTREAM_DIAL`. It now reads the system code out of the message too.
- **…and `err.options` is the whole `SocksClientOptions`, `password` included.** Anything that logged the error object, or `JSON.stringify`'d it, would put the upstream password in a file. Nothing from `socks` is ever re-thrown; a `ProxyError` is built from `.message` alone and scrubbed. `dial-socks5.test.ts` asserts both halves — that `JSON.stringify(theirs)` contains the password and `JSON.stringify(ours)` does not.

---

## 1. Goals

1. **The separate desktop app is not needed.** A proxy is created, edited, started, stopped and deleted from the farm's own UI, and the farm is where it runs.
2. **No new binary is downloaded, pinned, or redistributed.** The upstream dial comes from an npm dependency inside the plugin's own bundle (§3.2, §3.3).
3. **CRUD over proxy definitions**, extending the catalogue the pack already stores rather than replacing it, with a migration for the rows already on disk.
4. **A declared protocol matrix.** Which listen/upstream combinations work is written down, and an unsupported one is refused **at validation with a named code**, never at connect time.
5. **Start, stop, restart, per proxy**, with a stated answer for what happens to connections that are in flight when a stop arrives.
6. **Logs — all, and per proxy** — with an explicit, defensible list of what is recorded and what is deliberately not.
7. **A proxy binds to `127.0.0.1` and the plan says what changes if it does not.**
8. **The screen extends the pack's existing three tabs on tier C**, reusing `@enkaku/ui`'s behaviour layer rather than hand-writing a fourth copy of `api()`.
9. **A password never appears in a log line, a list, a hint, or an error message** — and the one place the current store violates that (F12) is fixed rather than documented around.
10. **Once plan 109's reachability steps land, a device can dial a bridge**, and the Assignments tab's standing "this is a note, not a route" caveat becomes narrower and more precise rather than being quietly deleted.

## 2. Non-goals

- **Shipping `gost`, or any other binary.** Refused in §3.1 with its cost written out.
- **Routing a device's traffic.** A proxy an app can be pointed at is not a route an app cannot escape. That is the `network` driver layer's job (spec §7.9), the only non-bypassable engine is `vpn-helper`, and no plugin can reach either. §3.12 keeps the two apart in the product's own words.
- **An HTTPS (TLS-terminating) listener.** Refused at validation. It needs a certificate, a certificate needs a lifecycle, and the farm has no per-plugin certificate story.
- **UDP.** `adb reverse` is TCP-only (109 §3.4 limit 1), and SOCKS5 `UDP ASSOCIATE` is refused at the listener with the RFC's own "command not supported" reply.
- **Proxy chaining** (a bridge whose upstream is another local bridge). It works by accident because a bridge is an ordinary proxy; it is not tested, not documented as supported, and not given UI.
- **A rotation pool, or automatic failover between upstreams.** One record, one upstream. §9 Q5 asks whether the owner wants more.
- **Listener-side authentication, and binding off loopback.** Refused together in §3.9, because the second is only safe with the first. §9 Q2 asks whether to build them.
- **A per-plugin SQLite database.** §3.5 explains why KV is still right, and 109.13 is optional and sequenced last in its own plan anyway.

## 3. Context and design decisions

### 3.1 No `gost` binary — and this is a cost decision, not a preference

`gost` is an excellent tool and the owner's line is exactly right for what it does. Bringing it into the farm would nonetheless mean:

- **A Toolchain Manager entry.** Every binary this product ships is downloaded on first run and sha256-verified per platform and architecture — that is the machinery adb and scrcpy-server already use, and it is not optional for a new one. macOS × {arm64, x64}, Linux × {arm64, x64}, Windows × x64 is five artefacts to pin, and five to re-pin on every upstream release.
- **A `LICENSES.md` redistribution entry.** The repo keeps a deliberate audit of what it does and does not redistribute (adb is downloaded, never shipped, precisely so that audit stays short). A Go binary is a new row with a new obligation.
- **A second process lifecycle to supervise, per proxy.** Spawn, watch, restart on crash, kill on stop, reap on core shutdown, and reconcile after a core restart that left orphans behind. The repo has exactly one long-lived child-process supervisor today — the job runner — and it is not small.

Against that, plan 109 §3.3 has already ruled that **listeners belong to the plugin**, with `ctx.onStop` as the cleanup path. A child process per proxy is a second answer to a question the platform has already answered, and the two would not agree: `ctx.onStop` closes a socket the plugin holds; it cannot reap a process the plugin forked.

The probe (§0.2) says the alternative is forty lines. So: **no binary.**

### 3.2 `socks` for the upstream dial; our own listener

This is not "not invented here" applied selectively — the split follows from where the plugin-specific behaviour actually lives.

Everything the owner asked for — per-proxy logs, start and stop, connection counts, a state per record, a drain on stop — is **listener-side**. A framework that owns the listener owns exactly the surface `ctx.reportListener` and `ctx.onStop` need to reach, and would have to be fought for each one. Meanwhile the genuinely fiddly part, the one worth a dependency, is the **upstream SOCKS5 handshake**: greeting, method negotiation, RFC 1929 username/password sub-negotiation, the request with its three address types, and the reply codes. That is precisely what `socks` does, and it is what the probe exercised against a real auth-demanding server.

So:

| side | who | why |
|---|---|---|
| listener (`http`, `socks5`) | ours | every per-proxy behaviour attaches here |
| upstream dial (`socks5`) | `socks` | the handshake is the fiddly part and the only part |
| upstream dial (`http`) | ours | `CONNECT host:port` + read one status line. Adding a second dependency for that would be worse than the fifteen lines it costs |

**F20 changes plan 109 §4.7's own sketch, and this is worth stating plainly.** That sketch uses `Bun.listen`. `SocksClient.createConnection` returns a `node:net.Socket`, and a `Bun.listen` socket is not a Node stream — it has no `.pipe()`, so pairing them means hand-writing backpressure between two socket kinds in the one place a bug is a silent memory leak under load. The probe used `node:net.createServer` on both ends and `a.pipe(b); b.pipe(a)` worked. **This plan uses `node:net.createServer`.**

The cost of that choice, stated rather than discovered: we lose `SocketListener.stop(closeActiveConnections)` — one call that both stops accepting and kills live sockets — and must track live sockets in a `Set` ourselves. The supervisor needs that `Set` anyway, for the connection count and for the drain in §3.7, so the cost is close to zero and the alternative was not.

### 3.3 The bundle can carry npm dependencies — verified, with the number

F1 and F2 are the load-bearing findings and they were re-checked rather than trusted: `Bun.build` is called with no `external`, the CLI's own comment says it bundles everything, and nothing on the publish → stage → verify → activate path looks at the bundle's size or at what it imports. F4 says `node:*` builtins are left as live imports and resolved by whatever Bun runtime loads the file, which for a service is the core process itself (F6).

Measured (§0.2): **66 KB minified, 115 KB unminified, 18 modules** — and **115 KB is the figure that matters**, because `enkaku publish` calls `Bun.build` with no `minify`, so the unminified bundle is what crosses the wire (§0.2.1). For context, `maxUiBytes` — the one byte budget that does exist anywhere near a plugin — is 8 MiB, and it does not apply to the script bundle at all.

`socks` is MIT, pure JavaScript, and pulls in two small pure-JS packages. Adding it is one line in `plugins/proxy-manager/package.json`; there is no manifest field for runtime dependencies and none is needed.

**H1 is nonetheless a real hypothesis and 112.1 is its probe.** "Nothing in the code refuses it" is not the same claim as "we published one and it ran." The first step of this plan is to close that gap before anything is built on top of it.

### 3.4 The protocol matrix

The record names a **listen** side and an **upstream** side. They are independent modules, so the matrix is a product, not a list of special cases.

| listen ↓ / upstream → | `socks5` | `http` | `https` |
|---|---|---|---|
| **`http`** | **ships** — the owner's own case | **ships** | refused — `E_PROXY_UPSTREAM_UNSUPPORTED` |
| **`socks5`** | **ships** | **ships** | refused — `E_PROXY_UPSTREAM_UNSUPPORTED` |
| **`https`** | refused — `E_PROXY_LISTEN_UNSUPPORTED` | same | same |

Four combinations ship. Two refusals, both **at validation, by name, before a record is stored** — never at connect time, where the operator would learn about it as a mysterious 502 in an app on a phone.

- **`https` as a listen protocol** means terminating TLS on the bridge, which needs a certificate the farm has no way to issue, install, or rotate for a plugin. The refusal message says exactly that and points at the loopback binding (§3.9) as the reason it is not the gap it sounds like: a proxy on `127.0.0.1` has no network segment to be eavesdropped on.
- **`https` as an upstream protocol** means an HTTP proxy reached over TLS. It is implementable — one `tls.connect` instead of one `net.connect` before the same `CONNECT` exchange — and it is refused in v1 only because no case for it has been named and an untested code path that claims to carry credentials is worse than an honest refusal. §9 Q6 asks.
- **A SOCKS5 listener ships even though the owner's case does not need it**, for one reason: §3.9's device path. An app on a phone that is going to be pointed at a bridge is far more likely to speak SOCKS5 than the HTTP proxy protocol, and the `vpn-helper` engine that the network layer will eventually use is itself a SOCKS5 client. Shipping only the HTTP listener would make the payoff of folding this into the farm unreachable, which is the whole point of the plan.
- Inside the SOCKS5 listener, **`BIND` and `UDP ASSOCIATE` are refused with reply code X'07' (command not supported)** — the RFC's own answer, not a dropped connection. `BIND` has no meaning for a bridge; UDP cannot cross `adb reverse` at all (109 §3.4 limit 1).

The existing `PROXY_KINDS = ['http', 'https', 'socks5']` is reused as the **upstream** vocabulary, unchanged, so the stored `kind` on every shipped row migrates without interpretation (§4.3). A row whose `kind` is `https` migrates to a record that is stored and listed and **refuses to start**, naming the reason on its own row — never dropped, never silently rewritten to something the operator did not choose.

### 3.5 Storage: still KV, and the runtime state is not stored at all

The brief asked this honestly, so here is the honest answer: **KV, not `ctx.db`.**

- **`ctx.db` does not exist** (F8, and plan 109's own step 109.13 is optional, sequenced last, and has an unanswered §9 Q3 about its size cap). Building this plan on it would make the plan un-startable for a reason that has nothing to do with proxies.
- **The query this feature actually runs is list-by-prefix.** A catalogue of tens of records, read whole, rendered as a table, filtered client-side by a search box that already exists. No join, no ordering by value, no "which rows match Y". That is the exact shape KV's `list({ prefix })` answers in one call, and it is the shape plan 108 §3.1 chose KV for.
- **Quota headroom is fine and can be stated numerically** (F14): `maxValueBytes` is 65 536 and a proxy record is a few hundred bytes; `maxEntriesPerNamespace` is 1 000 and this design uses two keys per proxy, so the catalogue caps at ~500 proxies. If an operator ever reaches that, the error is a named `E_KV_QUOTA_EXCEEDED` on create, not a silent truncation. Say the number in the docs rather than pretending it is unbounded.

**The decision that actually matters here is the opposite one: runtime state is never written to KV.**

A running proxy has a state (`stopped | starting | running | stopping | failed`), an uptime, a live connection count, a total connection count, a bytes-transferred figure, and a last error. **None of it is persisted.** It lives in the supervisor's in-memory map and it is gone when the core restarts — which is correct, because *the listener is gone when the core restarts too*. A persisted `running` that survives a crash is a lie the moment it is read.

This is the same hazard plan 106 §5 step 106.7 named and refused when it kept an in-flight `provisioning` state in memory rather than writing it to `devices.preparation`: two writers, one fact, and a stale row left behind by a crash mid-operation.

What **is** persisted is **intent**: an `enabled: boolean` on the record, meaning "this proxy should be listening". On boot the supervisor starts every enabled record. The difference between intent and observation is then a real, visible thing — a record that says `enabled` and observes `failed` is the interesting row on the screen — which is the declared-vs-observed discipline the network layer already established (plan 33) and the one that makes a status honest instead of decorative.

### 3.6 The record, and why it is two keys

The pack stores `{ label, kind, host, port, notes }` under `proxy:<id>` in its **global** namespace, on plan 108 §3.1's own rule (*if forgetting the device should forget the fact, it is device-scoped*) — a proxy is a fact about the network, not about a handset. That stays.

What changes is that the record grows a listen side, an upstream credential, and an intent flag; and the credential cannot live in the same value as the rest. F11 is why: a secret KV row reads back as `value: null` from `list()` and from every HTTP path, so a record stored whole as a secret would render as an empty table row. A record stored whole in the clear would put the password on the wire to the browser.

So, two keys per proxy:

| key | secret | contents | who reads it |
|---|---|---|---|
| `proxy:<id>` | no | label, listen, upstream (host, port, proto, **username**), enabled, notes, logDestinations | the screen, via `list({ prefix: 'proxy:' })`; the service, via `get()` |
| `proxy-secret:<id>` | **yes** | `{ password }` | **only** the service, in-process, via `ctx.storage.global.get()` |

`'proxy-secret:'` deliberately does not start with `'proxy:'`, so the catalogue's existing prefix list picks up records and never credentials — a property of the strings, not of a filter someone has to remember to write. Both are valid KV keys under `/^[A-Za-z0-9._:-]+$/`.

**The username stays in the clear, and that is a judgement call with a real objection.** A catalogue that cannot show which account a proxy authenticates as is not a catalogue — it is a list of hostnames. But the owner's own example, `country-id-rxxxxxxx`, shows a username that encodes the exit country and a sticky-session identifier, which is half a credential and arguably an identity. §9 Q1 puts that to the owner rather than deciding it here. Whatever the answer, the *password* is secret and the split above does not change.

### 3.7 Start, stop, restart — and what a live tunnel gets

Per-proxy lifecycle, using the same five words plan 109 already uses for a service (`packages/protocol/src/plugin-service.ts`), with the same rule: **`starting` is never worded as `running`.**

```
stopped ──start──> starting ──listening──> running
   ^                   │                      │
   │                   └──bind failed────> failed
   │                                          │
   └──── stopped <── stopping <──stop─────────┘
```

**Start** binds the listener. The failure everyone hits is `EADDRINUSE`, and it must produce a named, actionable error on that row — not a stack trace and not a generic "failed". `ctx.isPortFree` (109.4) is a nicety here, not a requirement: a pre-check is racy anyway, and the plugin has to handle the bind error correctly regardless. Use it when it exists, to give a better message *before* the attempt; never rely on it as the guard.

**Stop is two phases, and this is where plan 109's criterion 9 has to be read carefully.** That criterion says *the core never force-closes a socket it does not own*. These sockets belong to the plugin. The criterion constrains the core; it does not forbid the plugin from closing its own connections — it is what makes the plugin **responsible** for closing them.

1. **Drain.** `server.close()` — stop accepting; the listener's port is released immediately. Existing tunnels keep running. The proxy reads `stopping`, with a live count of what is left.
2. **Close.** After `drainMs` (default 10 000, per proxy), destroy whatever is still open. The proxy reads `stopped`.

**Force stop** is a separate, named action that skips phase 1 — because a drain on a proxy carrying a long download is a ten-second wait an operator sometimes does not want, and burying that behind the same button would make Stop feel broken.

**`ctx.onStop` does not drain, and this is forced by the code rather than chosen.** `runtime-host.ts`'s `DISPOSER_TIMEOUT_MS` is **5 000 ms for every disposer combined** (F7), after which the host logs a warn naming the plugin and marks it `stopping` rather than `stopped`. A 10 s drain inside a disposer therefore cannot succeed: it would blow the budget, earn a warn line, and leave the plugin in `stopping` for nothing. So the disposer destroys immediately. A core shutdown or a plugin reload is not a graceful drain window, and pretending it is costs the budget and buys nothing.

**What a client sees when a tunnel is destroyed is a TCP RST or FIN mid-response, and there is no in-band way to say more.** An HTTP proxy has no channel to tell a client already inside a `CONNECT` tunnel that the proxy is going away. An app on a device sees a dropped connection. H4 measures how promptly, because "dropped" and "hangs for ninety seconds" are very different experiences and the wording of the stop confirmation should reflect whichever is true.

**Restart** is stop-then-start under one lock, so nothing interleaves — the same shape `RuntimeHost.reload` already uses.

**A per-proxy concurrent-connection cap exists** (`maxConnections`, default from H2's measurement). This is in-process (109 §3.2): a proxy that accepts unbounded connections is a proxy that can starve the WS fan-out and the video relay of the same event loop. The default is written after H2 is run, not guessed before it, and a connection refused by the cap is logged with its own reason rather than dropped.

### 3.8 Logs — one stream, filtered; and a deliberate list of what is not recorded

**Per-proxy logs are a filter over one stream, not separate streams.**

Plan 109 R3 established the shape — a bounded in-memory ring, a rotated file, a WS broadcast, and an honest `truncated` flag — and 109.8 builds it per plugin. N rings for N proxies would mean core memory that scales with a list an operator edits, and it would mean a deleted proxy takes its own history with it at exactly the moment someone wants to know why it was deleted. So: **one ring, every line tagged `proxy=<id>`** (or untagged, for supervisor lines that belong to no single proxy), and the per-proxy view is the same ring with a predicate.

The cost, stated: a busy proxy evicts a quiet one's lines. The screen says so — "the last N lines across all proxies" — and R3's `truncated` flag is what keeps that honest rather than looking like "this proxy did nothing". If it bites, the follow-up is a server-side filter on 109.8's own route; v1 filters client-side over the fetched page plus the live `plugin.log` stream, so this plan does not have to widen an interface in a plan that is still being built.

**What a log line contains — and this is the part that needs a decision rather than a default.**

A proxy that logs every request URL is a surveillance record of whatever it carries. The operator is also the person who owns the traffic, so this is not a privacy problem in the usual sense; it is a *default* problem. A log that quietly accumulates a browsing history of every device on the farm, in a rotated file on disk, is not something an operator should have to discover.

At the default level, `info`, a line records:

- the proxy id and a monotonic connection number
- the event: `accepted`, `upstream connected`, `closed`, `refused`
- for `closed`: duration, bytes up, bytes down
- for `refused`: the reason, and the **destination port** (443, 80, 8080)
- never a host, never a path, never a query string, never a header, never a byte of payload, never the upstream password

A destination **port** is not a browsing record — it distinguishes "TLS to something" from "plain HTTP to something" and that is all, and without it a refusal is nearly undebuggable. A destination **host** is a browsing record, and it is recorded only when the record's own `logDestinations` switch is on. That switch is per proxy, defaults to `false`, and its description in the form says in plain words what turning it on means: *this records which hosts the traffic through this proxy reaches, for as long as it stays on.*

On top of that, `ctx.log` output should pass through the value-based redactor F15 describes — except that **it does not today**, because `runtime-logs.ts` does not exist and `plugin-context.ts` currently defaults `emitLog` to the plain core logger with no redaction at all. This plan does not build 109.8; it states the dependency, and criterion 6.13 requires that the password never reaches a log line **by construction** (it is never passed to a log call) rather than by relying on a redactor that is not wired up. Defence in depth is the redactor's job once it exists; correctness is this plugin's job now.

### 3.9 Binding, exposure, and the open relay

**The default bind is `127.0.0.1`, and in v1 it is the only permitted bind.**

An HTTP or SOCKS5 proxy with no authentication of its own, reachable off-host, is an **open relay**. Anyone who can route a packet to it can send traffic through the operator's upstream account: billed to them, attributed to them, and — for a residential or mobile proxy sold by the gigabyte — expensive within minutes. This is not a theoretical hardening note; it is the single most common way a self-hosted proxy tool becomes someone else's problem.

So `bindHost` is validated to `127.0.0.1` or `::1`, and anything else is refused with `E_PROXY_BIND_NOT_LOOPBACK`, whose message names the two legitimate paths instead:

- **A device** does not need an off-host bind. `exposeToDevice` (below) gives the phone a `127.0.0.1:<port>` **on the phone**, tunnelled over the adb connection that already exists. Nothing is opened on the network.
- **A remote human** uses an SSH or WireGuard tunnel, the same as for any other loopback service.

If the owner does want an off-host bind later, the design is not mysterious — it is **listener-side authentication** (HTTP proxy `407 Proxy Authentication Required` and SOCKS5 RFC 1929 are both standard) with the bind permitted only when auth is configured. §9 Q2 asks whether to build it; the pair ships together or not at all, because the second without the first is the failure this paragraph exists to prevent.

**Device reachability is where folding this into the farm actually pays, and it should be said plainly.**

The separate desktop app could not do this at all. A phone cannot dial the operator's laptop's loopback. Plan 109 §3.4's `exposeToDevice` is exactly the missing hop, and F17 records that its substrate — `adb reverse` — **passed on real hardware over USB** (109 H1), so this is a real integration rather than a speculative one:

```ts
const addr = await ctx.exposeToDevice({ port: proxy.listen.port, deviceId })
// → { host: '127.0.0.1', port: 47001 }   ← valid ON THAT DEVICE
```

The plugin writes that address into the device-scoped `assigned` key the Assignments tab already writes, and the tab gains a real, copyable address per device. The platform picks the hop count (one for a core-attached device, two for a node-attached one), allocates the device-side port, and tears the chain down on device disconnect, plugin stop, reload and shutdown.

Two limits from 109 §3.4 carry straight through and must be in the pack's own docs, not only here:

1. **TCP only** — so the SOCKS5 listener refuses `UDP ASSOCIATE`, and a UDP-based app is simply not reachable this way.
2. **An exposed port is reachable by every app on that device**, not only the one under test, because `adb reverse` opens it on the device's shared loopback. For a device under test that is arguably the point; it is also exactly why §3.9's loopback rule and §9 Q2's listener auth belong to the same question.

### 3.10 Credentials

Storage is §3.6's two-key split, encrypted by the store's existing AEAD box (F10). What that box actually claims is worth repeating verbatim from its own source rather than paraphrased upward: it is **not a KMS**; the key sits at `<dataDir>/secrets.key` next to `enkaku.db`, and anyone who can read the data directory can read both. The honest claim is "not readable by grepping the database", and this plan does not upgrade it.

Redaction, then, in four places, each with a mechanism rather than an intention:

| where | how |
|---|---|
| the UI list | structural — `list()` never decrypts and every HTTP path redacts (F11). The screen **cannot** show it, whatever anyone writes |
| the UI form | the password field renders empty on edit with the placeholder *"unchanged"*; submitting it empty leaves the stored secret alone, and only a non-empty value writes. There is no "reveal" affordance and no round-trip through the browser |
| a log line | never passed to a log call, by construction (§3.8). The value-based redactor (F15) is defence in depth once 109.8 wires it, not the primary defence |
| an error message | the upstream dialler's errors are re-worded before they leave the service. `socks` raises `Socks5 Authentication failed`, which is safe; but a hand-built error must never interpolate the credential, and the test for that asserts the literal password string is absent from every thrown message |
| **the KV hint** | **broken today (F12), fixed by step 112.2.** `secretHint` puts `${first 7}…${last 4}` of the plaintext on the row and hands it to anyone with `plugin.data`. Eleven characters of a proxy password is a disclosure, and this plan is the first thing in the repo to put a real credential in KV |

Step 112.2 adds `hint?: boolean` (default `true`, so nothing that exists today changes) to `KvSetOptions`, the `KvCall` wire shape, and the `PUT /:name/data/entry` body, and the plugin writes its credential with `hint: false`. Roughly ten lines across three files. It is a core change inside a plugin plan, which is worth naming rather than smuggling — but the alternative is a plugin plan that documents a credential leak as acceptable, and that is worse.

### 3.11 The UI — tier C, extending the three tabs

The pack is already tier C with `Catalogue · Assignments · Runs`, keeps `tab` and `q` as two independent URL keys through `setParams`' patch semantics, and ships its own stylesheet. All of that stays; this plan adds to it.

| tab | change |
|---|---|
| **Catalogue** | a state cell per row (the five words from §3.7, with `starting` never rendered as `running`), live connection count, Start/Stop/Restart, and a per-row failure reason when the state is `failed`. The Add/Edit dialog grows the listen side, the upstream side, the password field (§3.10), `enabled`, and `logDestinations` with its own plain-words description |
| **Assignments** | unchanged in shape. Gains the device-side address once 112.11 lands, and until then keeps its existing standing note verbatim |
| **Runs** | unchanged |
| **Logs** *(new)* | one stream with a proxy filter — a `Select` of the catalogue plus "All" — fetch-then-subscribe, `truncated` shown. The selection goes in the URL as `?proxy=`, a third independent key beside `tab` and `q`, which is free because the patch semantics already make each key ignorant of the others |

**What the pack must not hand-write** (F18): `api()`, a `farm()` helper, `coreBase()`, an empty panel, a "could not load" panel, a loading skeleton, a confirm dialog, a relative-time formatter, or its own Zod. All nine are in `@enkaku/ui`, and the pack already deleted its own copies of most of them in step 111.10. Two things it must **not** reach for because they are deliberately absent: `toast` (use `useAction`, which is where the toasts live) and `PageHeader` (the host renders one above every plugin view; a second is a bug).

**The honesty banner changes, and it is not deleted.** `BANNER_NOT_BUILT` currently says nothing on the screen contacts a proxy, which stops being true the moment 112.7 lands. It is **replaced** with a narrower sentence that is still true — that this screen runs a proxy on the farm's own machine which an app can be pointed at, and that it does not route any device's traffic — declared in `src/shared.ts` exactly as now, so the manifest description and the screen cannot drift into disagreeing. `index.test.ts` asserts both halves reference the same constants, and that test is extended rather than relaxed.

`docs/design.md`'s rule applies without exception here: **a degraded or partial state is never worded as the full one.** A proxy that is `starting` says `starting`. A proxy assigned to a device says the device *can reach* it, never that the device *is using* it.

### 3.12 What this plan does not make true

Worth its own section, because a screen that grows Start and Stop buttons is exactly the moment it starts looking finished.

After this plan, the farm can run a local proxy and a device can dial it. The farm still cannot make an app *use* it. Pointing traffic at a proxy on Android means either the app's own settings, a per-app configuration, or a VPN-level tunnel the app cannot bypass — and the last one is `vpn-helper` in the `network` driver layer (spec §7.9).

**Narrowed 2026-08-18 by plan 114 step 114.10, because this section made two claims that later stopped being true.** It said the Assignments tab's standing note *"survives this plan verbatim"*, and it said `vpn-helper` was a layer *"which no plugin can reach and which the owner has temporarily removed"*. Neither holds now, and quietly rewriting the paragraph as if it had always said something else is exactly the drift this section exists to catch, so what changed is recorded instead:

- **The layer was never removed.** Plan 114 §0.2 checked the code rather than the sentence — drivers exported, descriptors served through `GET /api/registry`, nine routes mounted, both Studio surfaces rendering, no removal commit anywhere. The removal was stated and never executed, and plan 114 has since extended the layer with two more engines. The same stale aside in `docs/plans/109-m74-plugin-runtime.md:5` was amended in the same step.
- **A plugin can now reach the layer — through one door only.** Plan 114 step 114.9 gave this pack `device.network.set`/`.get` (`packages/core/src/capability/device-network.ts`), which calls the extracted body of `PUT /api/devices/:id/network` — the same handler, the same lock, the same audited device event, under a `plugin:proxy-manager` principal, with the device's own panel reporting *set by proxy-manager*. It still holds no adb, no shell and no settings write of its own.
- **Three clauses of the standing note are now false, and `plugins/proxy-manager/src/shared.ts` names which**: *"nothing reads it"*, *"the device's traffic is unchanged"*, and *"which no plugin can reach today"*. Apply reads the assignment, the farm applies it, and the plugin reaches the layer.

**What survives, and it is the load-bearing half: saving an assignment still changes nothing on any phone.** Apply is a separate, deliberate press (plan 114 §9 Q6 — explicit Apply, never implicit). And what this pack's Apply can reach is only the *advisory* rung: a bridge binds loopback, so a device pointed at it is being **asked** to use a proxy, and an app with its own networking can ignore that. This pack must never word the advisory rung as the enforcing one. The replacement wording lives in `shared.ts` as `APPLY_INTENT_SENTENCE` and `APPLY_RUNG_SENTENCE`, declared once so the manifest an operator reads in the plugin list and the banner they read on the screen cannot drift into two different claims.

---

## 4. Technical design

### 4.1 Files

```
plugins/proxy-manager/
  package.json                    + "socks": "^2.8.9"
  src/
    shared.ts                     ~ the copy constants: the banner replaced, new ones for the new tab
    record.ts                     ~ ProxyRecordSchema v2, the two-key split, the migration reader
    index.ts                      ~ definePlugin gains `service: defineService({ setup })`
    service/
      supervisor.ts               NEW — the per-proxy state machine, start/stop/restart, drain, counters   ← Ships
      listen-http.ts              NEW — CONNECT and absolute-form (§0.2's finding, both forms)
      listen-socks5.ts            NEW — RFC 1928 + 1929 server; BIND/UDP ASSOCIATE → X'07'
      dial-socks5.ts              NEW — SocksClient, with a deadline
      dial-http.ts                NEW — CONNECT to an upstream HTTP proxy
      relay.ts                    NEW — the bidirectional pipe, byte counters, teardown
      logbook.ts                  NEW — the tagged log line vocabulary, and what is never in one
      handlers.ts                 NEW — ctx.onRequest: list, start, stop, restart, logs   [109.6]
      expose.ts                   NEW — ctx.exposeToDevice per assignment                 [109.10]
    ui/
      index.tsx                   ~ a fourth tab
      parts/api.ts                ~ the new wire shapes
      parts/catalogue.tsx         ~ state, controls, the widened dialog
      parts/logs.tsx              NEW — the log tab
      parts/assignments.tsx       ~ the device-side address                               [109.10]
    index.test.ts                 ~ extended; the copy-drift assertions kept
    service/*.test.ts             NEW

packages/core/src/kv/store.ts     + hint?: boolean on KvSetOptions (step 112.2)
packages/core/src/api/plugins.ts  + hint on the DataWriteBody
packages/protocol/src/api/kv.ts   + hint on the wire
packages/session/src/runner/ipc.ts + hint on KvCallSchema
```

### 4.2 The record

```ts
export const ProxyListenSchema = z.object({
  /** `https` is accepted by the enum and refused by `validateRecord` — see §3.4. */
  proto: z.enum(['http', 'socks5', 'https']).default('http'),
  /** Loopback only in v1 (§3.9). Anything else → E_PROXY_BIND_NOT_LOOPBACK. */
  bindHost: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
})

export const ProxyUpstreamSchema = z.object({
  /** Reuses PROXY_KINDS unchanged, so every shipped row migrates without interpretation. */
  proto: z.enum(PROXY_KINDS).default('socks5'),
  host: z.string().min(1).max(200),
  port: z.number().int().min(1).max(65535),
  /** In the clear, deliberately, and questioned in §9 Q1. */
  username: z.string().max(200).default(''),
})

export const ProxyRecordSchema = z.object({
  label: z.string().min(1).max(80),
  listen: ProxyListenSchema,
  upstream: ProxyUpstreamSchema,
  /** INTENT, not observation (§3.5). The supervisor starts every enabled record at boot. */
  enabled: z.boolean().default(false),
  /** Off by default. Its own description says what turning it on records (§3.8). */
  logDestinations: z.boolean().default(false),
  maxConnections: z.number().int().min(1).max(10_000).default(/* 256, derived from H2 — §0.3.1 */ 256),
  drainMs: z.number().int().min(0).max(120_000).default(10_000),
  notes: z.string().max(300).default(''),
})

/** The other key. Written with `secret: true` and `hint: false` (§3.10). */
export const ProxySecretSchema = z.object({ password: z.string().max(400) })
```

`validateRecord(record)` is the one function that decides whether a record may run, and it is called at **write** time by the screen's own handler and again at **start** time by the supervisor — never only at start:

| code | when |
|---|---|
| `E_PROXY_LISTEN_UNSUPPORTED` | `listen.proto === 'https'` |
| `E_PROXY_UPSTREAM_UNSUPPORTED` | `upstream.proto === 'https'` |
| `E_PROXY_BIND_NOT_LOOPBACK` | `listen.bindHost ∉ {127.0.0.1, ::1}` |
| `E_PROXY_PORT_CONFLICT` | another enabled record in this catalogue already claims `listen.port` |

### 4.3 Migration of the rows already on disk

The shipped shape is `{ label, kind, host, port, notes }`, where `kind` describes the **upstream** ("the transport this proxy speaks"). It maps cleanly:

```
{ label, kind, host, port, notes }
  → { label,
      listen:   { proto: 'http', bindHost: '127.0.0.1', port: <unassigned> },
      upstream: { proto: kind, host, port, username: '' },
      enabled: false, logDestinations: false, notes }
```

Three properties this migration must have:

1. **It is a read-time upgrade, not a rewrite pass.** `readProxy` already reads defensively (an operator with `kv.manage` can put anything under `proxy:`), so an old-shaped value is upgraded on read and only written back when the operator next saves that row. No boot-time loop over the namespace, no partial-write hazard.
2. **`enabled: false` always.** A migration must never start a listener nobody asked to start.
3. **`listen.port` is genuinely absent, and the row says so.** There is no correct guess — the old record described an upstream and named no local port. The row renders with a "needs a local port" state and a disabled Start, which is a precondition and not an error (plan 59's own rule). A `kind: 'https'` row additionally renders its `E_PROXY_UPSTREAM_UNSUPPORTED` reason and stays unstartable.

### 4.4 The bridge

Shapes only; the probe is the reference implementation and its forty lines are the honest size.

```ts
export interface Upstream {
  /** Resolves to a connected node:net.Socket already tunnelled to `dest`. Rejects with a coded error. */
  connect(dest: { host: string; port: number }, signal: AbortSignal): Promise<net.Socket>
}
// dial-socks5.ts → SocksClient.createConnection({ proxy: {…, type: 5, userId, password}, command: 'connect', destination, timeout })
// dial-http.ts   → net.connect, write `CONNECT host:port`, read one status line, assert 2xx

export interface Listener {
  /** Already listening when this resolves; rejects on EADDRINUSE with a named error. */
  readonly port: number
  /** Stop accepting. Live sockets are untouched — the supervisor owns the drain (§3.7). */
  close(): Promise<void>
  /** Every live socket pair, for the count and for phase 2 of the stop. */
  readonly live: ReadonlySet<Conn>
}
```

`listen-http.ts` handles **both** request forms, and this is a criterion rather than an implementation detail:

- `CONNECT host:port HTTP/1.1` → dial upstream, reply `200 Connection Established`, pipe.
- `<METHOD> http://host[:port]/path HTTP/1.1` → dial upstream, **rewrite the request line to origin-form**, replay the rest of the head, pipe.
- anything else → `405`.

`relay.ts` is `a.pipe(b); b.pipe(a)` plus byte counters and one teardown path — which is exactly what F20's choice of `node:net` on both ends buys, and exactly what would have had to be hand-written with `Bun.listen`.

### 4.5 The service

```ts
export default definePlugin({
  id: 'proxy-manager',
  version: '0.3.0',
  // …
  service: defineService({
    permissions: [],          // ctx.farm is NOT on this plan's critical path — see below
    async setup(ctx) {
      const sup = createSupervisor(ctx)
      ctx.onStop(() => sup.destroyAll())   // immediate, no drain — the 5 s budget (§3.7)
      await sup.startEnabled()
      // [109.4] sup.onListenerChange(l => ctx.reportListener({ id, port, proto, deviceReachable: true }))
      // [109.6] ctx.onRequest('proxies', handlers.list) … start/stop/restart/logs
      // [109.10] ctx.onEvent('device.connected', e => expose.reconcile(e.deviceId))
    },
  }),
})
```

**`permissions: []` is deliberate and worth stating**, because it removes 109.3 from this plan's critical path. The screen reads devices through `GET /api/plugins/:name/data/scan` from the browser with the operator's own session — which is what the Assignments tab already does — so the service never needs `ctx.farm.call('device.list')`. The one place that changes is 112.11, where `expose.ts` needs to resolve a device; if that turns out to need a capability, it is declared then, in the step that needs it, and shown at install.

### 4.6 What the screen calls

Every route below is `ctx.onRequest` (109.6), mounted by the core at `/api/plugins/proxy-manager/http/*`, with the core's auth, TLS, CORS, rate limiting and audit applying unchanged. **Nothing here opens a raw port to serve a UI** — plan 109 §3.7 names that as the trap, and it would bypass all five.

| method + path | purpose |
|---|---|
| `GET  …/http/proxies` | one row per record: the persisted record joined with the supervisor's live state, count, uptime, last error |
| `POST …/http/proxies/:id/start` | |
| `POST …/http/proxies/:id/stop` | body `{ force?: boolean }` — force skips the drain (§3.7) |
| `POST …/http/proxies/:id/restart` | |
| `GET  …/http/logs?cursor=` | the ring page + `truncated`, filtered client-side by `proxy` in v1 (§3.8) |

CRUD itself stays on the existing `plugin.data` doors (`PUT`/`DELETE …/data/entry`), which already audit every write as `plugin.data.set` / `plugin.data.delete` and take the namespace from the URL path server-side. There is no reason to build a second write path, and 00-overview §4.3 forbids the weaker parallel one.

**Before 109.6 exists there is an obvious shortcut, and it must be refused rather than built:** the screen could write `enabled: true` into KV and the service could poll its own namespace every couple of seconds. That is a weaker parallel path that would have to be deleted the week 109.6 lands, and a `list()` over the namespace on every tick is a real cost in the core's event loop for a feature whose proper door is one step away.

---

## 5. Implementation steps

**Ordered so that no step is claimed buildable before its substrate exists.** The gate column names the plan 109 step required. 109.1 and 109.2 have landed (F7); everything else in that column is unbuilt as of this writing.

| step | gate |
|---|---|
| 112.1 – 112.7 | 109.2 (landed) |
| 112.8 | 109.8 |
| 112.9 – 112.10 | 109.6 |
| 112.11 | 109.9 + 109.10 (themselves gated on H1, which passed over USB) |

**112.1 — `socks`, and a proof it survives the publish path (H1). — DONE (2026-08-17).** Add `"socks": "^2.8.9"` to `plugins/proxy-manager/package.json`. Import `SocksClient` from the pack's entry, `enkaku publish`, and watch it stage, verify, and activate. Record the real bundle size in this document beside §0.2's 66 KB estimate. **If H1 fails, stop here** — §3.3 is wrong and the plan needs a different answer, not a workaround. *Result:* a published `.enkaku` carrying an npm dependency, loaded by the core, with the number written down.

**112.2 — the KV write path stops leaking a hint (F12). — NOT BUILT, and the pack refuses to store a credential until it is.** `plugins/proxy-manager/src/index.test.ts` asserts against the core's own source that `KvSetOptions` has no `hint` field and that `secretHint` is still called unconditionally — with both controls — so it goes red the day this lands and cannot be forgotten. See §9 Q7 for what the leak actually measures.
 `hint?: boolean` (default `true`) on `KvSetOptions`, `KvCallSchema`, the `KvApi` client, and `PUT /:name/data/entry`'s body; `store.ts` skips `secretHint` when it is `false`. Nothing that exists today changes behaviour. A test asserts a `hint: false` secret row has `hint === null` on every read path including the HTTP one. *Result:* a credential can be stored without eleven of its characters being handed to anyone with `plugin.data`.

**112.3 — the record. — DONE (2026-08-17).** `ProxyRecordSchema` v2, `ProxySecretSchema`, the `proxy-secret:` key, `validateRecord` with its four coded refusals, and the read-time migration of the shipped shape (§4.3) with its three properties. `readProxy`/`writeProxy` stay the single funnel `index.test.ts` runs a value through. *Result:* the catalogue renders old rows and new rows, an `https` upstream is refused by name and still listed, and a migrated row says it needs a local port rather than guessing one.

**112.4 — the upstream dialers. — DONE (2026-08-17); H3's numbers are in §0.3.2.** `dial-socks5.ts` (SocksClient, explicit `timeout`, credentials read from the secret key in-process) and `dial-http.ts` (`CONNECT`, one status line, 2xx or a coded error). Run H3's three fixtures here and write the measured time-to-error into this document — including whether a read-idle timer on top of `socks`'s handshake timeout is actually needed. *Result:* a dialer that fails a dead upstream in a stated number of seconds, and an error message with no credential in it.

**112.5 — the HTTP listener. — DONE (2026-08-17).** `CONNECT` **and** absolute-form, with the request-line rewrite. Two tests, never one. *Result:* Bun's own `fetch({ proxy })` reaches an `http://` target and an `https://` target through the same bridge.

**112.6 — the SOCKS5 listener. — DONE (2026-08-17).** RFC 1928 greeting and method negotiation, RFC 1929 username/password *(accepting no-auth in v1, since the bind is loopback — §9 Q2)*, all three address types, and `BIND`/`UDP ASSOCIATE` refused with reply X'07'. *Result:* `curl --socks5-hostname` reaches a target through the bridge, and a `UDP ASSOCIATE` gets a well-formed refusal rather than a dropped socket.

**112.7 — the supervisor. — DONE (2026-08-17); H2's numbers are in §0.3.1 and set `maxConnections` to 256.** The five-state machine, `enabled` honoured at boot, start with a named `EADDRINUSE`, two-phase stop with `drainMs`, force stop, restart under a lock, the live-socket `Set`, per-proxy counters, `maxConnections`, and the `ctx.onStop` disposer that destroys immediately (§3.7's 5 s reasoning in a comment, not only here). Run **H2** and record the numbers whether or not they are comfortable; set `maxConnections`' default from them. *Result:* a proxy the operator can start and stop, whose state is never persisted and whose intent always is.

**112.8 — logs.** *(gate: 109.8)* The tagged line vocabulary, the `logDestinations` switch and its wording, and the assertion that a password never reaches a log call by construction. *Result:* one stream, tagged per proxy, with a written-down list of what is not in it.

**112.9 — the handlers.** *(gate: 109.6)* The five `ctx.onRequest` routes in §4.6, each with its declared permission. *Result:* the screen can start and stop a proxy through the core's own authenticated, audited door.

**112.10 — the screen.** *(gate: 109.6)* Catalogue state cell, controls, failure reason, the widened dialog with its password field and its `logDestinations` description; the Logs tab with its `?proxy=` key; the banner replaced with its narrower true sentence in `shared.ts`; `index.test.ts`'s copy-drift assertions extended, not relaxed. *Result:* the owner's ask, met on one screen.

**112.11 — device reachability.** *(gate: 109.9 + 109.10)* `expose.ts`; the Assignments tab gains a real device-side address; the standing note narrows to exactly what stops being true and no further. Run **H4** and let the answer set the wording of the stop confirmation. *Result:* a phone can dial a bridge — the thing the separate desktop app could never do.

**112.12 — documentation and the corrections this plan owes.** The pack README (what runs where, the loopback rule and why, the quota numbers from §3.5, `adb reverse`'s "every app on the device" limit). `docs/spec.md` §11.6, or a `DIV-` row saying why not. **Correct plan 109 §3.3's "the port itself is an ordinary plugin setting"** — there is no `ctx.settings` (F9), and a port here is a field on a record, not a farm setting. **Correct plan 109 §4.7's worked example** to `node:net` (F20), so the next plugin author does not discover the missing `.pipe()` the hard way. File F13 (`increment` un-secrets a key) as a hotfix in plan 96.

---

## 6. Acceptance criteria

1. A published `.enkaku` carrying `socks` stages, verifies, activates, and its service loads — with the measured bundle size recorded in §0.2 beside the estimate.
2. A KV entry written with `secret: true, hint: false` has `hint === null` on the store read, the `/api/kv` read, and the `/api/plugins/:name/data` read. Every existing caller's behaviour is byte-identical.
3. Every shipped `{ label, kind, host, port, notes }` row renders in the catalogue after the upgrade, `enabled: false`, with "needs a local port" and a disabled Start — never a guessed port, never a dropped row.
4. **A CONNECT request** through an `http` listener with a `socks5` upstream reaches an https target, with username/password auth on the upstream.
5. **An absolute-form request** through the same listener reaches a plain-http target. Criterion 4 passing while this fails is the exact bug §0.2 found, so both are required and neither substitutes for the other.
6. `listen.proto: 'https'`, `upstream.proto: 'https'`, a non-loopback `bindHost`, and a duplicate `listen.port` are each refused **at write** with their own code from §4.2 — and the same check runs again at start, so a record edited around the UI still cannot bind.
7. A SOCKS5 listener serves `CONNECT` for IPv4, IPv6 and domain address types, and refuses `BIND` and `UDP ASSOCIATE` with reply code X'07'.
8. Starting a proxy whose port is taken produces a named, actionable error on that row — not a stack trace, not a generic failure.
9. **Stop drains**: the port is released immediately, live tunnels survive up to `drainMs`, the row reads `stopping` with a live count, and then `stopped`. **Force stop** skips the drain. `starting` is never rendered as `running`, anywhere.
10. `ctx.onStop` destroys immediately and completes well inside the host's 5 s total disposer budget — asserted by a test, because the failure mode is a `warn` and a plugin stuck in `stopping`, both of which look like something else.
11. After two consecutive plugin reloads, every proxy's port is bindable again (plan 109 criterion 8, applied to this plugin's own sockets).
12. Runtime state is **not** in KV: a test asserts that no key in the namespace holds a state, a count, an uptime, or a last error, and that `enabled` is the only thing a restart restores.
13. **The password never appears** in: a `list()` result, any HTTP response, any log line, any thrown error message, or a KV hint. Asserted by searching the literal secret string across each of those surfaces in a test, not by review.
14. With `logDestinations: false` (the default) no destination **host** appears in any log line; with it on, it does. A destination **port** appears in a refusal line in both cases.
15. The Logs tab shows one stream with a working per-proxy filter, an honest `truncated` indication, and a `?proxy=` URL key that survives a reload alongside `tab` and `q`.
16. The screen hand-writes none of: `api()`, `coreBase()`, an empty state, an error state, a loading state, a confirm dialog, a relative-time formatter, its own Zod, its own toast, or a `PageHeader`.
17. `BANNER_NOT_BUILT` is **replaced**, not deleted, by a sentence that is still true after 112.7; `shared.ts` remains the one place it is declared, and `index.test.ts` still proves both halves reference it.
18. `exposeToDevice` returns an address a process on the device can actually dial, and the Assignments tab shows it. *(112.11)*
19. The exposure chain is torn down on revoke, device disconnect, proxy stop, plugin stop, plugin reload and core shutdown, and re-issued after a reconnect without operator action. *(112.11)*
20. H2's and H3's measurements are recorded in this document whether or not they are comfortable; `maxConnections`' shipped default is derived from H2 rather than guessed.
21. Plan 109 §3.3's `ctx.settings` sentence and §4.7's `Bun.listen` example are corrected in the same commit as 112.12; F13 is filed in plan 96.
22. `bun run typecheck`, `bun run --cwd plugins/proxy-manager test` (the pack sits outside `bunfig.toml`'s `[test] root = "packages"` and is its own CI invocation), and the specific core test files 112.2 touches are green. `bash scripts/check-plan-status.sh` exits 0.

## 7. Test plan

**Unit — the record** (`plugins/proxy-manager/src/record.test.ts`): the v2 schema round-trip through `writeProxy`/`readProxy`; the read-time migration of the shipped shape including the `https` upstream case; `validateRecord`'s four codes; `proxy-secret:` never matching a `proxy:` prefix list.

**Unit — the dialers** (`service/dial-*.test.ts`): against the probe's own minimal SOCKS5 server fixture, promoted from the scratchpad into the pack's test tree — a real RFC 1928 + 1929 server with username/password, because a mock proves the easy half. H3's three failure fixtures (refusing, silent, black-holing) with their measured time-to-error asserted as bounds. One test asserts the literal password is absent from every thrown message.

**Unit — the listeners** (`service/listen-*.test.ts`): the HTTP listener against `fetch({ proxy })` for both an `http://` target (absolute-form) and an `https://` target (CONNECT), plus a `405` for a bare `GET /`. The SOCKS5 listener for all three address types, and `BIND`/`UDP ASSOCIATE` asserted to answer X'07' rather than closing.

**Unit — the supervisor** (`service/supervisor.test.ts`): the state machine including `starting`; `EADDRINUSE` naming the port; the drain (a live tunnel survives, the port frees immediately, `stopping` then `stopped`); force stop; `maxConnections`; two reloads with no port leak; and the disposer finishing inside a 5 s budget with a fake clock.

**Unit — the logbook** (`service/logbook.test.ts`): the negative assertions are the point — a fixture connection to `https://secret.example/private?token=abc` produces log lines containing none of `secret.example`, `/private`, `token`, or the password, at the default level; with `logDestinations: true` the host appears and the path still does not.

**Core** (`packages/core/src/kv/store.test.ts`, `api/plugins.test.ts`): step 112.2's `hint: false` on every read path, and an explicit assertion that omitting the option is unchanged from today.

**Plugin UI** (`plugins/proxy-manager/src/index.test.ts`, extended): the copy-drift assertions kept and widened to the replaced banner and the new tab's constants.

**Manual smoke — the owner's own case, end to end**

```bash
bun run dev ; bun run dev:studio
bun run --cwd plugins/proxy-manager publish:farm

# Studio → Plugins → Proxy manager → Catalogue → Add
#   listen  : http  127.0.0.1  9902
#   upstream: socks5  <real host>:<port>  user/pass
#   → Start.  The row reads `running`.

curl -x http://127.0.0.1:9902 https://api.ipify.org      # CONNECT path
curl -x http://127.0.0.1:9902 http://api.ipify.org       # absolute-form path — the one that failed first
# both print the UPSTREAM's address, not the machine's

# → Logs tab: two connections, no host, no path.  Flip logDestinations on, repeat, hosts appear.
# → Stop with a `curl --limit-rate` download in flight: the port frees at once, the row reads
#   `stopping` with 1 live, then `stopped` after drainMs.

ps -Ao pid=,command= | grep -i "[o]penpf"     # nothing but your own shell
```

**Manual smoke — the device path** *(112.11, and gated on 109's H1 which passed over USB)*

```bash
# with a device attached and a bridge running on 127.0.0.1:9902
# → Assignments tab: assign the proxy to the device; it shows 127.0.0.1:<devicePort>
adb shell curl -s -m 5 -x http://127.0.0.1:<devicePort> https://api.ipify.org
# expect the upstream's address, from the phone
```

## 8. Risks and mitigations

| risk | mitigation |
|---|---|
| **H1 fails and a bundled npm dependency does not survive the publish path.** | It is step 112.1, before anything is built on it, and the instruction is to stop rather than work around it. F1/F2/F4 make failure unlikely; they do not make it impossible, and "we read the code" is not "we ran it". |
| **In-process means a proxy under load competes with the farm's own event loop** (109 §3.2). Not mitigable away — it is inherent to the owner's chosen isolation model. | H2 measures it against the numbers that matter (`/api/health` p99, Wall frame intervals), `maxConnections` ships with a default derived from that measurement, and the finding is recorded whether or not it is comfortable. |
| **A synchronous bug in this plugin freezes the whole farm** — no try/catch anywhere catches an infinite loop, an OOM, or a native crash (109 §3.2). | Cannot be mitigated in this plan. It is why the bridge is deliberately small, why the fiddly handshake is a well-used dependency rather than ours, and why 109's error budget and `isolation: 'process'` escape hatch exist. Named in the pack's own README, not only here. |
| **An open relay.** The single most expensive way this feature goes wrong. | Loopback-only, refused at validation by name, with the message naming the two legitimate alternatives. Off-host binding and listener auth are refused together (§3.9) so the unsafe half cannot ship alone. |
| **A log that quietly becomes a browsing history.** | Destination hosts are off by default, behind a per-proxy switch whose description says what it does. Ports and outcomes are on, because a refusal with neither is undebuggable and a port is not a browsing record. |
| **A password reaches a screen, a log, or a hint.** | Four mechanisms rather than four intentions (§3.10), one of which required fixing the store (112.2). Criterion 13 searches for the literal string across every surface rather than trusting review. |
| **A drain that never ends, holding a port hostage.** | `drainMs` is bounded and per record; phase 2 destroys unconditionally; the disposer path does not drain at all. |
| **Stopping a proxy strands a device mid-download with a long stall rather than a clean error.** | H4 measures it on real hardware; whatever it says becomes the wording of the stop confirmation. A guess here would be a guess about someone else's TCP stack. |
| **This plan is written against plan 109 steps that do not exist and may change shape.** | Every step names its gate; §5's table is the first thing in that section; steps 112.1–112.7 need only what has already landed, so the engine can be built and tested before the UI's substrate exists. If 109.6 or 109.8 arrives in a different shape, 112.8–112.10 are re-planned and 112.1–112.7 are not. |
| **The screen starts looking finished before it is.** | §3.12 exists for exactly this, criterion 17 makes the banner a test rather than an intention, and the Assignments note narrows only where something specific becomes true. |
| **F13's `increment` un-secrets a key** — not this plan's bug, but this plan's namespace would be the first to hold a real credential. | Nothing here increments; filed in plan 96 in step 112.12 so it is someone's problem rather than nobody's. |

## 9. Open questions

**Q1 — is the upstream username a secret?**
§3.6 stores it in the clear so the catalogue can say which account a proxy authenticates as. But the owner's own example, `country-id-rxxxxxxx`, encodes an exit country and a sticky-session identifier, which is closer to an identity than to a label. Storing it as a secret means the catalogue can only show it as a hint or not at all; storing it in the clear means it appears on every screen anyone with `plugin.data` can open. **Recommendation: clear, truncated in the table, full in the edit dialog** — but this is the owner's traffic and their call.

**Q2 — off-host binding and listener authentication: build them, or keep refusing?**
They ship together or not at all (§3.9). Building them means HTTP `407` and SOCKS5 RFC 1929 on the listen side, a second credential per record, and a validation rule that permits a non-loopback bind only when auth is set. Not building them means a proxy is reachable from the farm's own machine and from a device over `adb reverse`, and from nowhere else. **Recommendation: keep refusing for v1** — the device path is the interesting one and it does not need an off-host bind.

**Q3 — one proxy per device, or several?**
The pack's device-scoped `assigned` key holds one value, so many devices → one proxy works naturally and one device → several proxies is not expressible. Several would mean a keyed set per device and a UI that says which is which. **Recommendation: one, until a case appears** — but worth confirming, because it is cheaper to decide now than to migrate the key later.

**Q4 — what happens to a running proxy when its record is edited?**
Restarting automatically is convenient and drops every live tunnel without warning. Showing "restart required" is honest and leaves a proxy running with settings that no longer match what the screen says. **Recommendation: restart automatically only when the edit touches the listen side (where the running listener is genuinely wrong), and show "restart to apply" for upstream and logging changes** — but it is a real trade and the owner uses this daily.

**Q5 — does a proxy need a health check, and where does it run?**
The pack's `check` member exists precisely as a placeholder for this, and making it real is the obvious next thing. But **F16 is a trap**: under container isolation a job child runs with `--network=none`, so a `check` script that dials a proxy would fail on network-less grounds and report it as a dead upstream. A health check therefore belongs in the **service** — a periodic dial with a recorded verdict per record — and the `check` member should either be removed or rewritten to ask the service rather than to dial. Which of those, and whether a periodic check is wanted at all, is the owner's.

**Q6 — an `https` upstream (an HTTP proxy reached over TLS)?**
Refused in v1 with a name (§3.4). It is one `tls.connect` away from working. It is refused only because nobody has asked for it, and an untested path that carries credentials is worse than an honest refusal. If the owner has such a proxy, it is a small step and it should be added to the matrix rather than left as a surprise.

---

### Corrections found while building steps 112.1 and 112.3–112.7 (2026-08-17)

Recorded here rather than repainted into §0/§3/§4, on plan 109 §9's own precedent. Each one is something this document asserted and the code refused.

**Q7 — F12's "eleven characters" is wrong for the shape this plan actually stores, and the real number is a reason the shape must not change.**
`store.ts` hints the **JSON**, not the value, when the value is not a string: `secretHint(typeof value === 'string' ? value : json)`. Measured against the running farm by writing `{"password":"Sup3rSecretUpstreamPassword"}` with `secret: true` — the row came back with **`hint: '{"passw…rd"}'`**, i.e. the last two characters of the password plus punctuation. Storing the password as a **bare string** would have leaked `Sup3rSe…word`: its first seven characters and its last four, which *is* F12's eleven. So §3.6's object-with-one-field is not a formality — it is the difference between a two-character leak and an eleven-character one, and `ProxySecretSchema` must stay an object. **None of this makes the gap acceptable**: 112.2 is still required, the pack still writes no credential, and the dialog still has no password field (`CREDENTIAL_NOT_STORED`).

**Q8 — §4.4 types `Listener.close()` as `Promise<void>`; it cannot be one.**
Node's `server.close()` releases the listening socket before it returns and invokes its callback only when the **last connection** has gone. Awaiting it would be awaiting the drain — which is the supervisor's job, has its own bounded timer, and would never resolve for a proxy carrying a long download. Worse, `ctx.onStop`'s whole budget is 5 s for every disposer combined. **Built as `close(): void`**, with `destroyLive(): void` as the second phase.

**Q9 — the probe's forty lines have two bugs that only appear off loopback, and both are fixed in `listen-http.ts`.**
(a) It reads `client.once('data')` and parses whatever turned up, which fails on a head split across TCP segments — a request with many headers, a slow client, or a client that writes the request line and the headers separately. The listener accumulates to `\r\n\r\n`, bounded at 64 KiB, and there is a test that writes the request line in two pieces. (b) On the CONNECT path it drops everything the client sent **after** `\r\n\r\n` in the same segment. Both listeners now hand that remainder back through `open({ leftover })`. §0.2 should say the probe is a sketch of the shape, not a reference implementation.

**Q10 — `unshift` needs an explicit `pause()` first, and getting it wrong is silent.**
Removing the last `'data'` listener does **not** take a stream out of flowing mode, so an `unshift` is re-emitted immediately, to nobody, and discarded. The consequence is that `Upstream.connect` returns a socket that may be **paused with bytes already buffered**; `pipe()` resumes it, so `createRelay` is fine, but a caller that attached a bare `on('data')` would get nothing. Documented on the interface, and `dial-http.test.ts` calls `resume()` and says why — it failed exactly this way first.

**Q11 — `net` and `node:net` are two different types in this workspace, and only one direction is assignable.**
`socks`'s typings pin `@types/node@^20` and declare `SocksClientEstablishedEvent.socket` as the **`net`** flavour; our `node:net` resolves to the newer set `@types/bun` brings, which has `getTypeOfService`/`setTypeOfService`. `node:net`.Socket → `net`.Socket compiles; the reverse does not. Every interface in `src/service/` is therefore typed against `BridgeSocket = import('net').Socket`, the narrower flavour both satisfy — the alternative was an `as`-cast, which 00-overview §4 forbids.

**Q12 — `net.Server` has no event methods at all in this workspace's types, and it is an upstream bug, not a `tsgo` one.**
`server.on('error', …)` is `error TS2339: Property 'on' does not exist on type 'Server'`, reproduced identically under TypeScript **7.0.2** and TypeScript **5.9.3**. `@types/node@26.1.2`'s `net.d.ts` writes `class Server implements EventEmitter` (which contributes nothing) and merges the methods in via `interface Server extends InternalEventEmitter<ServerEventMap>` — whose base it imports as `from "node:events"`, where `InternalEventEmitter` is **not exported**; it lives in `global { namespace NodeJS { … } }`. `skipLibCheck`, which this workspace needs, hides the error that would have said so. `net.Socket` is unaffected because `@types/node` copies the signatures into it by hand. Worked around with a three-signature module augmentation in `src/service/socket.ts`, which is a legal merge and disappears the day upstream fixes the import. **Anyone else in this repo who reaches for a `net.Server` will hit this.**

**Q13 — there is no `unreportListener`, so a stopped bridge's port stays on the Plugins page until the plugin reloads.**
`ctx.reportListener` replaces a report with the same id and there is no way to withdraw one (plan 109 step 109.4). The supervisor reports on start — which is the fact at that moment, and is what gives the core's unload backstop something to bind-test — and a proxy stopped afterwards leaves a stale row. Harmless for the backstop (it bind-tests a free port and passes) but wrong on screen. **Filed for plan 109**: `ctx.reportListener` needs a withdrawal, or `ReportedListener` needs an `open: boolean`.

**Q14 — `validateRecord` is four refusals *and* one precondition, and conflating them would misreport a migrated row.**
§4.2's table has four codes. A migrated row's missing local port is a fifth thing and it is **not** a refusal: the row is perfectly storable and simply cannot start (§4.3 property 3, plan 59's rule). Built as `validateProxyRecord` returning `{ code, kind: 'refusal' | 'precondition', message }[]`, with `E_PROXY_PORT_UNASSIGNED` as the one precondition, plus `isStorableRecord` (refusals only) and `isStartableRecord` (both). The function is named `validateProxyRecord`, not `validateRecord`, because it lives in `shared.ts` beside `readProxyRecord`/`writeProxyRecord` — all three are called from the browser half, the service and `record.ts`, and a bare `validateRecord` there would be ambiguous.

**Q15 — the record logic could not live in `record.ts`, and this is the same reasoning plan 111 already applied to the copy.**
§4.1 puts `ProxyRecordSchema`, the migration and `validateRecord` in `record.ts`. But `record.ts` imports `zod` and `@enkaku/sdk`, and the **screen** has to run the same migration and the same refusals — importing it from the browser half would inline a schema library and a server SDK into `ui/index.js`. So the logic is in `shared.ts` (which imports nothing) and `record.ts` holds the Zod declaration and re-exports it. One consequence worth stating: `record.ts` **is** now bundled into the pack the core runs, which its own header used to say it was not.

**Q16 — `ProxyListenSchema.default({})` does not compile.** Zod 4's `.default()` takes the schema's **output**, so an empty object is a type error even though every field inside has a default of its own. Spelled out instead. Same family as plan 109 §9 Q18: an authoring type is `z.input`, a default is the output.
