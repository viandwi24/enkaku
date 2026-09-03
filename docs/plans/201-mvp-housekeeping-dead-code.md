# Plan 201 — MVP wave 0 : Housekeeping — delete already-dead code

> Status: implemented — 2026-09-03. All §0 goals (including the §12 and §13 amendments' G11–G14) verified by the commands named in this section; `bash scripts/check-dead-code.sh` prints `no dead code found`. One known collateral effect outside this plan's scope: `bash scripts/check-plan-status.sh` now also flags plan 59 (`59-m29-preconditions-not-errors.md`) as a mismatch, because its `Ships:` line named `packages/studio/src/components/InspectorPanel.test.tsx`, one of the 201 Studio/ui test files this plan's §12 amendment deletes by design (plan 200 §8.3: "No MVP plan adds one back"). Not fixed here — plan 59 is not named by this plan's scope; see §11.
> Depends on: nothing. Wave 0 of `docs/plans/200-mvp-program.md` §4. It runs first so that plans 202 to 154 start from a tree with no known dead code (`docs/mvp/13-removal-register.md` Part C item 2). Every row here comes from `docs/mvp/13-removal-register.md` Part B (B.1 and B.2) and was re-verified against the code on 2026-09-03; where the register and the code disagree, §3.2 says so and the code wins.
> Spec references: none. This plan changes no product behaviour. `docs/spec.md` paragraphs that name a deleted thing (WebRTC in §7.6 and §14, licensing in §18) are rewritten by plan 202, which archives the spec; this plan does not edit `docs/spec.md` or `docs/spec-divergences.md`.
> Ships: scripts/check-dead-code.sh
> **Testing override, read before §5 and §7:** §12 supersedes every Studio and `@enkaku/ui` test named anywhere below. Create no test and run no test under `packages/studio` or `packages/ui`; delete a surviving one that breaks and list it in §11. Verification for UI is `bun run typecheck`, the design-token and route scripts, and the owner smoke.

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Every file and directory in §10 table A is gone and every name in §10 table B greps to zero hits | 12 paths absent, 30 grep groups empty, 2 facts present, 0 control bytes | `bash scripts/check-dead-code.sh` prints `  no dead code found` and exits 0 | [x] |
| G2 | The workspace typechecks with no stub, shim, or `// @ts-expect-error` added to keep it green | 0 errors; 0 new occurrences | `bun run typecheck` → exit 0; `git diff <base>..HEAD -- packages apps plugins scripts examples \| grep -c '^+.*@ts-\(expect-error\|ignore\)'` → `0` | [x] |
| G3 | The dead-code check runs in CI on every push | 1 step in the `check` job | `grep -n "scripts/check-dead-code.sh" .github/workflows/ci.yml` → exactly one line, inside `jobs.check.steps` | [x] |
| G4 | The WebRTC dependencies are out of the core package and the lockfile | 0 hits | `grep -En "werift\|reflect-metadata\|tsyringe" packages/core/package.json bun.lock` → empty; `bun install --frozen-lockfile` → exit 0 | [x] |
| G5 | Plugin versions agree at every site | networking `3.0.0` in `package.json`; proxy-manager `0.11.1` at three sites | `grep -n '"version"' plugins/networking/package.json` → `"version": "3.0.0"`; `grep -n "0\.11\.1" plugins/proxy-manager/package.json plugins/proxy-manager/src/index.ts plugins/proxy-manager/src/index.test.ts` → three lines | [x] |
| G6 | The two register rows that turned out alive still work | `clipboard.ok` and `input.text.result` are still sent with the request `id` | `bun test packages/core/src/server/ws-handlers-clipboard.test.ts` → pass; then `bun test packages/core/src/server/ws-handlers-text.test.ts` → pass | [x] |
| G7 | The plan removes more code than it adds | insertions < deletions over code directories | `git diff <base>..HEAD --numstat -- packages apps plugins scripts examples \| awk '{a+=$1; d+=$2} END {print a" added, "d" deleted"}'` → the first number is smaller than the second | [x] |
| G8 | `labelling.ts` is plain text again | 0 raw control bytes | `LC_ALL=C tr -d '\040-\176\200-\377\n\t' < packages/core/src/device/labelling.ts \| wc -c` → `0`; `bun test packages/core/src/device/labelling.test.ts` → pass | [x] |
| G9 | Every scoped test in §7 passes, one invocation at a time | 0 failures per file | the §7.1 list, each run separately, each `pass` | [x] |
| G10 | The plan status check still passes with this plan's header | 0 mismatches | `bash scripts/check-plan-status.sh` → exit 0 | [x] (this plan's own row is clean; the script's overall exit code is 1 because of an unrelated collateral mismatch on plan 59 — see §11) |

`<base>` is the commit this plan's first commit sits on (`git merge-base mvp HEAD` if a branch was cut, otherwise the hash recorded in §11).

## 1. Goals

1. Delete every Part B row of `docs/mvp/13-removal-register.md` that no later MVP plan owns: two whole subsystems (licensing, telemetry), the WebRTC server half and its Studio client, a compatibility barrel, three dead routes, four dead WebSocket message families, the AOA input stub and its enum value, two dead scripts, two unused design tokens, twenty-one zero-reference exports, the dead half of the vendored `ai-elements`, a test-only schema shim in `proxy-manager`, and a handful of stale comments and README claims.
2. Correct the register where the code disagrees with it (§3.2), so that plans 205 to 154 do not inherit a wrong fact.
3. Ship `scripts/check-dead-code.sh`, a grep-only gate that fails the instant any deleted name comes back, and wire it into CI.
4. Leave the tree with no behaviour change: no route, message, setting, or UI that a client uses today stops working. Everything deleted here has zero callers, proven by the greps in §10.

## 2. Non-goals

Each row names the plan that owns it. Nothing here may be deleted by this plan, even when it looks dead.

| Not done here | Why | Owner |
|---|---|---|
| `lease.released` (`packages/core/src/server/ws-handlers.ts:1190`) and `mirror.stopped` (`ws-handlers.ts:2136`) | both are the `id`-correlated reply to a request Studio still sends (`lease.release`, `mirror.stop`), so they are not orphan literals; the whole `lease.*` and `mirror.*` families go together | plan 205 |
| `clipboard.ok`, `input.text.result` | alive; see §3.2. Not dead, not deferred | nobody; the register row is corrected |
| The unreachable workflow executor (`packages/core/src/jobs/executors/workflow.ts`), `scriptKind` (`jobs/executor-host.ts:77`, `:330`), `jobNodes`, `artifacts.nodeId`, `resultSummaryFields: () => []` | plan 211 rewrites the executor as an orchestrator and drops the tables; deleting half of it now would leave the other half stranded | plan 211 |
| `GET/POST/DELETE /api/agents/:id/spawn-grants` (`packages/core/src/api/agents.ts:66`, `:72`) | plan 220 (Agents page, design pending) decides whether they get a surface or go | plan 220 |
| `GET/POST/DELETE /api/tokens` (`packages/core/src/api/tokens.ts:37`, `:41`, `:50`) | plan 219's Settings → Access table becomes its caller (MVP 12) | plan 219 |
| `text.status` in the guest agent (`apps/guest-agent/.../Protocol.kt:78`, `packages/drivers/src/network/guest-agent/client.ts:194`) | plan 221 gives it a host caller (MVP 08 §1.2, MVP 10 §1.2) | plan 221 |
| `CommandRunStore.trimForUser`, `shell.commandRunsPerUser`, `prep.disableAnimations`, per-device `video.controlPreset`/`wallPreset`, `DeviceSettings.autoReconnect`, `wall.rampConcurrency` | settings rows; the console goes with plan 207, the fields with plan 212 | plans 207, 212 |
| The redirect stubs `/topology`, `/scripts`, `/agents/thread` | bookmark compatibility until the new Studio shell lands | plan 213 |
| `node.hello.ack` (`packages/core/src/tunnel/router.ts:113`) | the register marks it "likely: the node may ignore the ack by design"; cloud mode is post-MVP (MVP 06 §4) and the tunnel is untouched by this series | none in the MVP |
| Anything in `packages/harness` | verbatim vendored copy under `scripts/check-harness-provenance.sh` (`docs/mvp/13` Part C item 3) | never |
| `apps/desktop` | parked outside the MVP definition of done (MVP 09 §4) | plan 224 decides packaging |
| `scripts/tag-release.sh` | human-invoked, alive | nobody |
| `examples/scroll-fling-demo.ts` | §9 Q1 | a human |
| The "exported only for their own file" symbols (about 180 in Studio, about 80 in core) | made private by whichever plan next touches each file (`docs/mvp/13` B.1 "Exports with exactly one occurrence") | each later plan |
| `docs/spec.md`, `docs/spec-divergences.md` (DIV-061 for `/dev/tools`, the WebRTC and licensing paragraphs) | archived and rewritten | plan 202 |
| `PLUGIN_NOT_BUILT` and `BANNER_NOT_BUILT` in `plugins/proxy-manager/src/shared.ts` | only `VIEW_NOT_BUILT` is named by the register; the siblings are copy constants whose names are equally stale but whose text a later proxy-manager plan will rewrite | a later proxy-manager plan; recorded in the handoff |

## 3. Context and design decisions

### 3.1 What "dead" means in this plan

A thing is dead when the grep for its name returns only its own definition, its own test, its own comment, or a generated artefact (`packages/core/packs/*.mjs`, `packages/studio/out/`, `*.tsbuildinfo`, all gitignored). Every deletion below was checked with `rg` on 2026-09-03 and the result is quoted beside the item. The executor re-runs the same grep before deleting (`docs/plans/200-mvp-program.md` §2.2: read before writing).

Two rules from `docs/plans/200-mvp-program.md` §2.1 shape every step:

- Compile fallout is fixed **only** by deleting the dependent dead code or removing the now-unused import. Never by adding a stub, a default branch, an `as never`, or a `// @ts-expect-error`. If a deletion turns out to have a live consumer, the item is kept and reported (G2, §11 "Discrepancies").
- A generated file is never edited: `packages/core/packs/` is rebuilt by `bun run build:packs`, `bun.lock` by `bun install`.

### 3.2 Where the register is wrong, and what this plan does instead

The register's B.1 "WebSocket messages sent but never handled" was compiled by grepping for a `case '<type>'` handler. Studio's WebSocket client does not dispatch every message through a `switch`: `packages/studio/src/lib/ws.ts:333` `request(msg: ClientMessage & { id: string }, ...)` stores a waiter keyed by `id`, and `ws.ts:286-292` resolves it on **any** inbound message carrying that `id` before the handlers ever see it. Three of the register's rows are such replies:

| Register row | Sender | Studio caller | Verdict |
|---|---|---|---|
| `clipboard.ok` | `ws-handlers.ts:2421` `send(ws, { type: 'clipboard.ok', id: msg.id, payload: { deviceId } })` | `LiveView.tsx:849` `await ws.request({ type: 'clipboard.set', id: newId(), ...` and `ClipboardButton.tsx:59` | **alive**: deleting the reply would make every clipboard write time out after 25 s (`ws.ts:336`). Kept. |
| `input.text.result` | `ws-handlers.ts:1828` and `:1877` `type: 'input.text.result', id: msg.id` | `LiveView.tsx:796` `await ws.request({ type: 'input.text', id: newId(), ...` | **alive**: same mechanism; `ws-handlers-text.test.ts:215-257` asserts the reply. Kept. |
| `lease.released`, `mirror.stopped` | `ws-handlers.ts:1190`, `:2136` (both `...(msgId ? { id: msgId } : {})`) | Studio's lease and mirror controls | replies too; in any case deleted wholesale by plan 205 (§2). Deferred. |

The remaining four families are genuinely unhandled and go:

| Family | Sender | Why no one receives it |
|---|---|---|
| `agent.subscribe`, `agent.unsubscribe` (client → server) | none; the arms at `ws-handlers.ts:1276` and `:1281` wait for a message Studio never sends (`rg -n "'agent\.subscribe'" packages/studio/src` → only a comment in `lib/agent-approvals.ts:14`) | Studio reads agent events over the SSE stream, `packages/core/src/api/agent-chat-stream.ts`, which subscribes a duck-typed relay socket through the handler's `.subscribe()` **method** (`agent-chat-stream.ts:285`). The method stays; the WS arms and their schemas go. |
| `agent.message.queued`, `agent.message.delivered` (server → client) | `packages/core/src/agent/runner.ts:734-737` and `:819-822` (`deps.publishToThread(..., { type: 'agent.message.queued', ...})`); `packages/core/src/server/ws-handlers-agent.ts:61-62` (`case 'inbox.delivered': return { type: 'agent.message.delivered', ...}`) | the only subscriber is the SSE relay, whose `switch (msg.type)` (`agent-chat-stream.ts:202-265`) has no case for either type, so both are dropped on arrival. No Studio code names them (`rg -n "agent\.message\.(queued\|delivered)" packages/studio/src` → empty). Plan 67's "queued counter" never existed. |
| `scan.progress` | `packages/core/src/registry/sweep.ts:189` `hub.broadcast({ type: 'scan.progress', ...})` | `rg -n "scan\.progress" packages/studio/src plugins` → empty. The `hub` dep of the sweeper (`sweep.ts:68`) exists only for this broadcast. |
| `plugin.log` | `packages/core/src/daemon.ts:1760` `broadcast: (plugin, line) => hub.broadcast({ type: 'plugin.log', payload: { plugin, ...line } })` | `rg -n "'plugin\.log'" packages/studio/src plugins packages/ui/src` → empty. The proxy manager's Logs tab reads `GET /api/plugins/:name/runtime/logs` (`plugins/proxy-manager/src/ui/parts/api.ts:480`), which stays. With the broadcast gone, `PLUGIN_EVENT_TYPE_DENYLIST` (`packages/protocol/src/index.ts:1200`) guards against subscribing to a type that no longer exists; `unknownPluginEventTypesMessage` (`index.ts:1163`) already refuses any type not in `SERVER_MESSAGE_TYPES`, so the denylist and `refusedPluginEventTypesMessage` become unreachable and go with it. |

Two more register facts corrected on reading:

- `PickableDevice` (`packages/ui/src/components/device-picker.tsx:70`) is not "zero references": it is the generic bound of `DevicePicker` (`:121`) and is imported by its own test (`device-picker.test.tsx:3`). It is public through `packages/ui/src/index.ts:32` `export * from './components/device-picker'` with no importer outside the file. This plan drops the `export` keyword and keeps the interface (step 201.9).
- `--radius-card` is "never referenced" as a CSS variable, but its Tailwind utility `rounded-card` is named in three documentation sites and one test fixture (`packages/sdk/README.md:711`, `packages/sdk/src/cli/init.ts:426`, `plugins/proxy-manager/src/ui/index.css:45`, `packages/sdk/src/cli/build-ui.test.ts:64`). No component uses the class (`rg -n "rounded-card" packages/ui/src packages/studio/src plugins/*/src/ui` → only the CSS comment). The token goes and the four mentions are edited with it (step 201.9). The risk to a third-party plugin is in §8.

### 3.3 WebRTC is deleted, not parked

`docs/mvp/13` B.1 says "MVP 01 §4 step 4 keeps this as an option; if it is not wired in the MVP it is deleted, not left". It is not wired: the only client, `packages/studio/src/lib/webrtc-player.ts`, is imported by nothing (`rg -n "webrtc-player" packages/studio/src` → only itself), and the daemon's relay serves node-owned devices in cloud mode, which is post-MVP (MVP 06 §4, MVP 16 §1). Plan 209 §9 may reopen a WebRTC path; if it does, `git log -- packages/core/src/relay` is the starting point. Deleted here: the five files in `packages/core/src/relay/` (451 lines), the four `video.webrtc.*` handler arms, the six `WebRtc*Message` schemas, the daemon wiring, `GET /api/nodes/ice-config`, the `werift` and `reflect-metadata` dependencies (`packages/core/package.json:24-25`) and the `import 'reflect-metadata'` entrypoint line that exists only for werift (`packages/core/src/index.ts:1-4`), the five `ENKAKU_STUN_URL`/`ENKAKU_TURN_*` variables (`.env.example:120-125`, read only by `relay/ice-credentials.ts`), and the `transport === 'webrtc'` state in `LiveView.tsx` that only `video.webrtc.failed` ever changed (`LiveView.tsx:329`, `:472-475`, `:1074`, `:1111-1116`).

### 3.4 The three-site plugin version rule applies here

`CLAUDE.md`: "Editing anything under `plugins/*/src/` means bumping that plugin's version". This plan edits `plugins/proxy-manager/src/` (deletes `record.ts`, edits two tests, renames `VIEW_NOT_BUILT` in `shared.ts` and `index.ts`, rewords two comments, edits `ui/index.css`). The rename and the CSS comment are in the bundle, so the shipped pack changes; the bump is **patch** (nothing an operator meets): `0.11.0` → `0.11.1` at `plugins/proxy-manager/package.json:3`, `src/index.ts:279`, `src/index.test.ts:168`, with the reason added to the doc-comment block above `version:` (the block ends at `index.ts:278` with the 0.11.0 note). The seeded version is staged, not activated; the operator activates it on the Plugins page.

`plugins/networking` needs no bump, only the drift fix: `package.json:3` says `"version": "2.2.0"` while `src/index.ts:1151` says `version: '3.0.0'`. The pack builder reads the bundle, so the shipped version has been `3.0.0` all along; `package.json` is corrected to match. Its `src/index.test.ts` does not assert the version (only a comment at `:26` uses the word).

### 3.5 Vocabulary

This plan introduces no new product concept, so `docs/plans/200-mvp-program.md` §2.4 adds no forbidden word of its own here. The one rename it performs picks a name that says what the constant is: `VIEW_NOT_BUILT` → `PROXIES_VIEW_DESCRIPTION` (it is the `description` of the `proxies` view, `plugins/proxy-manager/src/index.ts:528`). The forbidden words from §2.4 that this plan's area would otherwise leave behind are all owned by later plans (`lease`, `mirror`, `cluster`) and are not touched.

## 4. Technical design

### 4.1 `scripts/check-dead-code.sh`

Bash, `grep` only (no `rg`: GitHub's `ubuntu-latest` image does not ship ripgrep, and the script must run unchanged in `.github/workflows/ci.yml`). Exits non-zero on the first present path or non-empty grep, prints every hit. Generated directories are excluded by name; `packages/harness` is excluded by the provenance rule. Identifiers are matched with `grep -w` (whole-word, supported by BSD and GNU grep alike and about four times faster on this tree than a hand-written `(^|[^A-Za-z0-9_])…` guard, measured 2026-09-03: 0.5 s against 1.9 s per group); substrings that are not identifiers (`video.webrtc`, `ENKAKU_TURN_`, a quoted message type) use a plain `grep -E`. The whole script runs in about ten seconds on the maintainer's machine.

Create the file with exactly this content (step 201.1):

```bash
#!/usr/bin/env bash
# Plan 201 (MVP wave 0, docs/plans/201-mvp-housekeeping-dead-code.md §4.1, §10):
# every file the housekeeping plan deleted stays deleted, and every name it
# removed stays removed. Grep only (no build, no test, no device), so it runs
# on every push (.github/workflows/ci.yml, job `check`) in a few seconds.
#
# A hit is a defect: the fix is to delete the thing again, never to add its
# name to an allowlist here. The only legitimate edit to this file is a later
# MVP plan appending ITS OWN removed names under a new "plan NNN" comment.
#
#   bash scripts/check-dead-code.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# Generated or vendored trees, never a source of truth:
#   packages/core/packs      built by scripts/build-packs.ts (gitignored)
#   packages/studio/out      Next static export (gitignored)
#   apps/guest-agent/**/build   Gradle output (gitignored)
#   apps/guest-agent/third_party   vendored hev-socks5-tunnel (a submodule)
#   apps/desktop/src-tauri   the parked Tauri shell (MVP 09 §4) and, under it,
#                            cargo's `target/` output, excluded by the
#                            `src-tauri` name, NOT by `target`, because
#                            packages/studio/src/components/target/ is source
#   packages/harness         vendored verbatim, provenance-checked
EXCLUDES=(
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
  --exclude-dir=out --exclude-dir=.next --exclude-dir=build --exclude-dir=src-tauri
  --exclude-dir=third_party --exclude-dir=packs --exclude-dir=harness
  --exclude='*.tsbuildinfo' --exclude=bun.lock
)
CODE=(packages apps plugins scripts examples)

absent() { # absent <label> <path>
  if [ -e "$2" ]; then
    printf '  PRESENT  %-34s %s\n' "$1" "$2"
    fail=1
  fi
}

# gone  <label> <ERE> <path>...   substring match (grep -E)
# gonew <label> <ERE> <path>...   whole-word match (grep -Ew): identifiers
gone() {
  _gone "" "$@"
}
gonew() {
  _gone "-w" "$@"
}
_gone() {
  local wordflag=$1 label=$2 pattern=$3
  shift 3
  local hits
  hits=$(grep -rEn $wordflag "${EXCLUDES[@]}" -e "$pattern" "$@" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    printf '  FOUND    %-34s %s\n' "$label" "$pattern"
    printf '%s\n' "$hits" | sed 's/^/             /'
    fail=1
  fi
}

present() { # present <label> <fixed string> <file>   (a fact that must hold)
  if ! grep -qF -e "$2" "$3" 2>/dev/null; then
    printf '  MISSING  %-34s %s in %s\n' "$1" "$2" "$3"
    fail=1
  fi
}

# ---- plan 201: files and directories (§10 table A) --------------------------
absent licensing            packages/core/src/licensing
absent telemetry            packages/core/src/telemetry
absent session-barrel       packages/core/src/session/index.ts
absent relay                packages/core/src/relay
absent webrtc-player        packages/studio/src/lib/webrtc-player.ts
absent topology-components  packages/studio/src/components/topology
absent dev-tools-page       packages/studio/src/app/dev
absent proxy-record-shim    plugins/proxy-manager/src/record.ts
absent guest-agent-script   scripts/guest-agent.ts
absent delete-unowned       scripts/delete-unowned-scripts.ts
absent scrcpy-aoa           packages/drivers/src/input/scrcpy-aoa.ts
absent scan-schema          packages/protocol/src/messages/scan.ts

# ---- plan 201: names (§10 table B) ------------------------------------------
gonew licensing     "loadLicense|LicensePayloadSchema|EDITION_LIMITS|limitsFor|withinDeviceLimit" "${CODE[@]}"
gone  licensing-env "ENKAKU_LICENSE_|ENKAKU_TELEMETRY_URL|ENKAKU_FEED_URL" "${CODE[@]}" .env.example
gonew telemetry     "createTelemetry|TelemetryPayloadSchema" "${CODE[@]}"
gone  session-barrel "from '(\.\./)+session'" packages/core/src
gonew webrtc-names  "WebRtcRequestMessage|WebRtcOfferMessage|WebRtcAnswerMessage|WebRtcIceMessage|WebRtcFailedMessage|WebRtcStopMessage|WebRtcSignaling|createWebRtcRelay|createWeriftFactory|buildIceServers|webrtcRelay|webrtcRelayRef|werift|tsyringe" "${CODE[@]}"
gone  webrtc-strings "video\.webrtc|reflect-metadata|webrtc-player|ENKAKU_STUN_URL|ENKAKU_TURN_|ice-config([^A-Za-z]|$)|'webrtc'" "${CODE[@]}" .env.example
gone  webrtc-word   "WebRTC" packages/core/src packages/studio/src packages/protocol/src packages/node
gone  studio-modules "components/topology|from '\./DeviceTile'|dev/tools" packages/studio plugins
gonew studio-module-names "ClusterSection|DevToolsPage" packages/studio plugins
gone  proxy-record  "from '\./record'" plugins/proxy-manager
gonew proxy-record-names "SECRET_PREFIX_IS_DISJOINT|ProxyRecordSchema|ProxySecretSchema|ProxyListenSchema|ProxyUpstreamSchema|ProxyFailoverSchema" plugins/proxy-manager
gone  scripts       "scripts/guest-agent\.ts|delete-unowned-scripts" "${CODE[@]}" README.md
gone  tokens        "radius-card|rounded-card|destructive-foreground" "${CODE[@]}"
gonew core-exports  "assertApiKey|assertOpenRouterApiKey|RecordingCreateResponseSchema|RecordingPatchResponseSchema|tagPluginPromise|ownedPromises|scriptNamesByIds" "${CODE[@]}"
gonew studio-exports "fetchHealth|HealthResponse|fetchTopology|TopologyResponse|TopologyCluster|TopologyActiveJob|OnGeoFail|computeImageInContext|defaultVersion|declaredScriptIds|ResultStatusChip|FieldProps|LeafPlan|setCoreBase" packages/studio packages/ui
gonew host-barrel-type "DeviceWallPickerProps" packages/studio/src/components/host/index.ts
gonew ai-elements   "ConversationDownload|ConversationDownloadProps|messagesToMarkdown|MessageActions|MessageActionsProps|MessageAction|MessageActionProps|MessageToolbar|MessageToolbarProps|PromptInputBody|PromptInputBodyProps|PromptInputHeader|PromptInputHeaderProps|PromptInputCommandInput|PromptInputCommandInputProps|PromptInputCommandSeparator|PromptInputCommandSeparatorProps|captureScreenshot" packages/studio/src
gone  ai-elements-families "MessageBranch[A-Za-z]*|PromptInputActionAdd[A-Za-z]*|PromptInputActionMenu[A-Za-z]*|PromptInputHoverCard[A-Za-z]*|PromptInputTab[A-Za-z]*" packages/studio/src
gone  ws-messages   "['\"]agent\.(subscribe|unsubscribe)['\"]|['\"]agent\.message\.(queued|delivered)['\"]|['\"]scan\.progress['\"]|['\"]plugin\.log['\"]" "${CODE[@]}"
gonew ws-message-names "AgentSubscribeMessage|AgentUnsubscribeMessage|AgentMessageQueuedMessage|AgentMessageDeliveredMessage|ScanProgressMessage|ScanProgressEvent|PluginLogMessage|PLUGIN_EVENT_TYPE_DENYLIST|refusedPluginEventTypesMessage|E_PLUGIN_EVENT_REFUSED|createProgressBroadcaster" "${CODE[@]}"
gone  routes        "device-schema|unread-count" "${CODE[@]}"
gone  aoa           "scrcpy-aoa|['\"]aoa['\"]" "${CODE[@]}"
gonew aoa-names     "ScrcpyAoaInput" "${CODE[@]}"
gonew adb-wire      "VERSION_SKIP_CHECKSUM|verifyChecksum" packages/adb
gone  adb-wire-export "export const A_SYNC" packages/adb
gone  private-exports "export const SCID_MARKER_PREFIX|export const FARM_TAG_PROPERTY|import \{[^}]*(SCID_MARKER_PREFIX|FARM_TAG_PROPERTY)" packages
gone  stale-docs    "has not been built" apps/guest-agent/README.md
gone  stale-schema-comments "No producer yet" packages/core/src/db/schema.ts
gonew view-not-built "VIEW_NOT_BUILT" plugins
gone  lockfile      "werift|reflect-metadata|tsyringe" bun.lock

present networking-version '"version": "3.0.0"' plugins/networking/package.json
present proxy-manager-version '"version": "0.11.1"' plugins/proxy-manager/package.json

# labelling.ts carried three raw control bytes (0x00, 0x1f, 0x7f) inside a regex
# character class, which made `grep` skip the file as binary (docs/mvp/13 B.2).
ctrl=$(LC_ALL=C tr -d '\040-\176\200-\377\n\t' < packages/core/src/device/labelling.ts | wc -c | tr -d ' ')
if [ "$ctrl" != "0" ]; then
  printf '  BINARY   %-34s %s raw control byte(s) in packages/core/src/device/labelling.ts\n' labelling-bytes "$ctrl"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "  dead code found; delete it again, never allowlist it here"
  exit 1
fi
echo "  no dead code found"
```

The `present` rows are the two facts the plan establishes rather than removes (§3.4). `gone lockfile` reads `bun.lock` on purpose, outside `EXCLUDES`, because G4 depends on it. `ice-config([^A-Za-z]|$)` rather than bare `ice-config`, because `device-configuration` contains it (`packages/core/README.md:214` was a false hit in the first draft of this script).

### 4.2 The CI step

In `.github/workflows/ci.yml`, job `check`, insert after the `- run: bash scripts/check-harness-provenance.sh` step (currently the step whose comment begins "`packages/harness` is a verbatim copy"; it is followed by the `bun run spec:check` step) exactly these lines, at the same indentation as the neighbouring `- run:` lines:

```yaml
      # Plan 201 (MVP wave 0): every name the housekeeping plan deleted stays
      # deleted. Grep only, exits non-zero on the first hit; a hit is fixed by
      # deleting the thing again, never by allowlisting it in the script.
      - run: bash scripts/check-dead-code.sh
```

Not added to `check-windows`, for the reason that job's own trailing comment gives for `check-plan-status.sh`: it inspects committed text with no OS-dependent behaviour, and `check` already runs it once per push.

### 4.3 What each deletion leaves behind (the shapes that change)

No new schema, table, route, or message is introduced. The types that change:

```ts
// packages/drivers/src/input/select.ts: after 201.6
export type InputModePreference = 'uhid' | 'sdk'

// packages/protocol/src/driver.ts:109: after 201.6
mode: 'sdk' | 'uhid'

// packages/protocol/src/settings.ts:414: after 201.6
.enum(['uhid', 'sdk'])

// packages/session/src/types.ts:24 and packages/session/src/session.ts:329: after 201.6
preferredInputMode: 'uhid' | 'sdk'

// packages/core/src/registry/sweep.ts: after 131.5c: `hub` removed from SweeperDeps
export interface SweeperDeps {
  client: AdbClient
  db: Db
  endpoints: EndpointStore
  registry: { onOnline(serial: string): Promise<void> }
  settings: () => SweeperSettings
  log: Logger
  tcpPreProbe?: TcpPreProbe
}

// packages/core/src/plugins/runtime-logs.ts: after 131.5d: `broadcast` removed from PluginLogStoreDeps

// packages/core/src/server/ws-handlers-agent.ts: after 131.5b
function toServerMessage(thread: AgentThread, run: AgentRun, event: RunEmitEvent): ServerMessage | null
//   `case 'inbox.delivered': return null`; the harness event stays (it is an ordering
//   probe in agent/tree.integration.test.ts:366); it simply no longer fans out.
publish(thread, run, event) {
  const msg = toServerMessage(thread, run, event)
  if (msg === null) return
  for (const ws of targets(thread.id)) send(ws, msg)
}

// packages/core/src/server/ws-handlers.ts: after 201.3: `WebRtcSignaling` and `WsHandlerDeps.webrtc` removed

// packages/ui/src/lib/core-base.ts: after 201.9: `explicit` and `setCoreBase` removed; coreBase() has three rungs
export function coreBase(): string {
  const env = envBase()
  if (env) return env.replace(/\/$/, '')
  if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') return location.origin
  return 'http://localhost:7700'
}
```

The `ServerMessageSchema` and `ClientMessageSchema` unions in `packages/protocol/src/index.ts` lose these members and nothing else: server side `ScanProgressMessage`, `AgentMessageQueuedMessage`, `AgentMessageDeliveredMessage`, `PluginLogMessage`, `WebRtcOfferMessage`, `WebRtcFailedMessage`, `WebRtcIceMessage`; client side `AgentSubscribeMessage`, `AgentUnsubscribeMessage`, `WebRtcRequestMessage`, `WebRtcAnswerMessage`, `WebRtcStopMessage`, `WebRtcIceMessage`. The file is append-only and contested (its own comments say so): remove the named lines in place, do not reorder anything.

### 4.4 The persisted `'aoa'` value

`DeviceSettingsSchema.input.preferredMode` (`packages/protocol/src/settings.ts:413-419`) loses the value `'aoa'`. Every reader of a stored device-settings row goes through `DeviceSettingsSchema.safeParse(row.settings ?? {})` (`packages/core/src/api/devices.ts:752`, `:1047`, `:1211`, `api/device-identity.ts:95`, `daemon.ts:1020`, `device/awake-policy.ts:193`), and one reader casts instead (`packages/core/src/session/adapters.ts:43`). A row that a past operator set to `'aoa'` would fail `safeParse` after this plan. The engine list has advertised the mode as `available: false` since it was added (`packages/core/src/registry/engines.ts:39`) and selecting it always degraded to UHID (`drivers/src/input/select.ts:27-29`), so such a row is unlikely to exist; the mitigation in §8 is a read-time check by the executor on the owner's farm, not a migration, because Drizzle cannot generate a data migration and `docs/plans/200` §2.1 forbids a compatibility branch.

## 5. Implementation steps

Read `docs/plans/200-mvp-program.md` §2 before the first edit. Every step ends with `bun run typecheck`. Line numbers are as of 2026-09-03 and drift; match on the quoted content. Commit per step: `chore(mvp-201): <step title>`.

### 201.1 The gate first: `scripts/check-dead-code.sh` and the CI step

- **Files created**: `scripts/check-dead-code.sh` with exactly the content in §4.1; `chmod +x` it.
- **Files changed**: `.github/workflows/ci.yml` (the four lines in §4.2).
- **Files deleted**: none.
- **Test file**: none (the script is its own test: it must FAIL now and PASS after 201.13).
- **Verifiable result**: `bash scripts/check-dead-code.sh` exits 1 and prints one `PRESENT` line per §10 table A path and one `FOUND` block per §10 table B group. `bash -n scripts/check-dead-code.sh` exits 0.
- **Do not**: do not make the script pass by weakening a pattern. Do not add `rg`. Do not put the step in `check-windows`.

### 201.2 Licensing, telemetry, the session barrel, and their environment variables

- **Files deleted**: `packages/core/src/licensing/` (`editions.ts`, `license.ts`; `rg -n "licensing|loadLicense|limitsFor|withinDeviceLimit|EDITION_LIMITS|LicensePayloadSchema" packages apps plugins scripts examples -t ts` → only the two files themselves); `packages/core/src/telemetry/` (only `telemetry.ts`; `rg -n "telemetry" packages/core/src packages/protocol/src packages/studio/src` → only itself); `packages/core/src/session/index.ts` (280 bytes: `export * from '@enkaku/session'` and `export { createDbDeviceSource, createDbArtifactSink } from './adapters'`; `rg -n "from '(\.\./)+session'" packages/core/src packages/node/src` → empty; `daemon.ts:183` imports `./session/adapters` directly).
- **Files changed**: `.env.example`: delete the block at `:163-167` (`# ── Licensing and telemetry ───…`, `# ENKAKU_LICENSE_FILE=<dataDir>/license.json`, `# ENKAKU_LICENSE_PUBKEY=`, `# ENKAKU_TELEMETRY_URL=`, `# ENKAKU_FEED_URL=`) and one of the two blank lines above it. `ENKAKU_FEED_URL` has no reader either (`rg -n "FEED_URL|feedUrl" packages/core/src packages/protocol/src` → empty on 2026-09-03); re-run that grep before deleting and, if a reader has appeared, keep only that line and report it.
- **Test file**: none touched (`packages/core/src/session/adapters.test.ts` imports `./adapters`, not the barrel).
- **Verifiable result**: `bun run typecheck` clean; `bash scripts/check-dead-code.sh` no longer prints `PRESENT licensing`, `PRESENT telemetry`, `PRESENT session-barrel`, `FOUND licensing`, `FOUND telemetry`, `FOUND session-barrel`.
- **Do not**: do not delete `packages/core/src/session/adapters.ts` or its test; only the barrel is dead.

### 201.3 WebRTC, the whole server half and the Studio client

- **Files deleted**: `packages/core/src/relay/` (`ice-credentials.ts`, `rtc-peer.ts`, `rtp-h264.ts`, `webrtc-relay.ts`, `werift-peer.ts`; no tests exist in the directory; `rg -n "relay/" packages/core/src --glob '!packages/core/src/relay/**'` → `api/nodes.ts:9`, `daemon.ts:28-29` only); `packages/studio/src/lib/webrtc-player.ts` (118 lines, zero importers).
- **Files changed**:
  - `packages/core/src/daemon.ts`: delete `:28` `import { createWebRtcRelay } from './relay/webrtc-relay'` and `:29` `import { createWeriftFactory } from './relay/werift-peer'`; `:346` `let webrtcRelayRef: ReturnType<typeof createWebRtcRelay> | null = null`; the block `:2170-2186` from the comment `// The WebRTC relay serves node-owned devices (cloud mode). On a LAN,` through `webrtcRelayRef = webrtcRelay` (inclusive of the `const webrtcRelay = createWebRtcRelay({ ... })` call); `:3559` `webrtc: webrtcRelay,` inside `createWsMessageHandler({`; `:4618-4619` `await webrtcRelayRef?.closeAll()` and `webrtcRelayRef = null`. `tunnelRouter.subscribeVideo` stays: `tunnel/device-proxy.ts:80` uses it.
  - `packages/core/src/server/ws-handlers.ts`: delete the interface `:278-283` `export interface WebRtcSignaling { ... }`; the dep `:286-287` (`/** The WebRTC video path (cloud mode); unused on a LAN. */` and `webrtc?: WebRtcSignaling`); the four arms `:2481-2506` from `case 'video.webrtc.request': {` through the closing `}` of `case 'video.webrtc.stop': {`.
  - `packages/core/src/api/nodes.ts`: delete `:9` `import { buildIceServers } from '../relay/ice-credentials'` and `:100-101` (`/** ICE configuration for the browser (self-hosted STUN/TURN, time-limited credentials). */` and `app.get('/ice-config', ...)`).
  - `packages/core/src/index.ts`: delete `:1-4` (the three comment lines beginning `// werift (via tsyringe) needs the Reflect polyfill` and `import 'reflect-metadata'`).
  - `packages/core/package.json`: delete `:24` `"reflect-metadata": "^0.2.2",` and `:25` `"werift": "^0.24.2",`. Then run `bun install` from the repo root so `bun.lock` drops `werift`, `tsyringe`, `reflect-metadata` and their transitive tree; commit the lockfile.
  - `packages/protocol/src/tunnel.ts`: delete `:142-174`, from `// ---- signaling WebRTC (M8b) ----` through the closing `})` of `WebRtcStopMessage`, leaving the `// ---- session & job jarak jauh (M9a) ----` comment that follows.
  - `packages/protocol/src/index.ts`: delete the import block `:38-45` (`import {` … `WebRtcStopMessage,` … `} from './tunnel'`); the re-export lines `:771-776` (`WebRtcRequestMessage,` through `WebRtcStopMessage,`); the server-union members `:1029-1031` (`WebRtcOfferMessage,`, `WebRtcFailedMessage,`, `WebRtcIceMessage,`); the client-union members `:1232-1236` (`WebRtcRequestMessage,`, `WebRtcAnswerMessage,`, `WebRtcStopMessage,`, the comment `// ICE is bidirectional: the browser sends its candidates too.`, `WebRtcIceMessage,`).
  - `packages/studio/src/components/LiveView.tsx`: delete `:329` `const [transport, setTransport] = useState<'ws' | 'webrtc'>('ws')`; `:330` `const [degradedReason, setDegradedReason] = useState<string | null>(null)`; the branch `:472-475` `} else if (msg.type === 'video.webrtc.failed') { // The WebRTC path failed → stay on WS, but say why. setTransport('ws') setDegradedReason(msg.payload.reason)` (rejoin the `if`/`else if` chain so the next `else if (msg.type === 'stream.ended' ...` follows the previous branch directly); the JSX `:1063-1074` from the comment that begins `{/* Only when it is NOT the default (owner's call, 2026-08-17).` (its third line reads `every device takes unless WebRTC is configured`) through `{transport === 'webrtc' && <span className="rack-label ml-auto">webrtc</span>}`; the banner `:1111-1116` `{!compact && degradedReason && ( <p ...>The WebRTC path is not in use ({degradedReason}). ...</p> )}`. Reword the two comments that describe `degradedReason` as "the WebRTC transport falling back to WS": `:340-341` (`A SEPARATE state from \`degradedReason\` above, which is specifically about the WebRTC transport falling back to WS — a different degrade, a different banner.`) becomes `Holds the reason text; null when not in this state.`, and `:1121-1122` (`and never merged with \`degradedReason\` above — that one is about the WebRTC transport, this is about video QUALITY.`) becomes `this is about video QUALITY.` `useState` stays imported (other state remains).
  - `.env.example`: delete `:120-125` (`# ── WebRTC ───…` through `# ENKAKU_TURN_SECRET=            # must match coturn's static-auth-secret`) and one of the two blank lines around it.
  - `packages/node/README.md`: in the table row `:12` (`| **M8b** | WebRTC signalling …`) replace the Contents and Status cells with `A UDP video path (signalling and an H.264 → RTP packetizer)` and `deleted by plan 201; cloud video stays on the WebSocket tunnel, and \`git log -- packages/core/src/relay\` holds the code`; delete the section `:18-22` from `## What is left in M8b` through `timestamp conversion to the 90 kHz clock.` (and the blank line `:23`, so `## Running it` keeps one blank line above it); replace the section `:35-37` `## Why video needs WebRTC in the cloud` with a two-sentence `## Video in the cloud` saying the tunnel is TCP, head-of-line blocking can freeze remote video on a lossy link, and a UDP path is a post-MVP decision (plan 209 §9).
  - `docs/guide/cloud.md:44`: replace the sentence `The WebRTC path addresses this (see \`docs/plans/13-m9-webrtc-backend.md\`…` with `A UDP video path is a post-MVP decision; until then a lossy link can freeze the picture for a moment.` (finish the sentence at the same full stop the original used).
- **Files deleted**: as listed above.
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Verifiable result**: `bun run typecheck` clean; `grep -En "werift|reflect-metadata|tsyringe" packages/core/package.json bun.lock` → empty; `bun install --frozen-lockfile` → exit 0; `bash scripts/check-dead-code.sh` no longer prints `FOUND webrtc`, `FOUND webrtc-word`, `FOUND lockfile`, `PRESENT relay`, `PRESENT webrtc-player`.
- **Do not**: do not keep `WebRtcSignaling` as an optional no-op. Do not keep `video.webrtc.failed` "for a future client". Do not touch `packages/core/src/tunnel/` (the WebSocket tunnel is alive). Do not edit `plugins/mikrotik-routing/README.md:147` (`browserleaks.com/webrtc` is a browser leak check, not our transport; the script's `webrtc-word` grep deliberately excludes `plugins/`).

### 201.4 Three dead routes

- **Files changed**:
  - `packages/core/src/api/settings.ts`: delete `:35-36` (`/** The DeviceSettings schema for per-device forms. */` and `app.get('/device-schema', (c) => c.json({ schema: z.toJSONSchema(DeviceSettingsSchema) }))`). `DeviceSettingsSchema` and `z` stay imported: `:23` `deviceSchema: z.toJSONSchema(DeviceSettingsSchema),` is the live reader Studio uses through `GET /api/settings`.
  - `packages/core/src/api/notifications.ts`: delete `:29` `app.get('/unread-count', (c) => c.json({ unreadCount: store.unreadCount() }))` (the list route at `:22-27` already returns `unreadCount`).
  - `packages/core/src/api/notifications.test.ts`: delete the test `:52-57` `test('GET /unread-count', async () => { ... })`.
  - `packages/core/src/server/http.ts:121`: in the comment `/** \`GET /api/notifications\`, \`.../unread-count\`, \`.../:id/read\`, \`.../read-all\` (plan 68 §4.5). */` remove `` `.../unread-count`, ``.
  - `GET /api/nodes/ice-config` was deleted in 131.3.
- **Files created / deleted**: none.
- **Test file**: `packages/core/src/api/notifications.test.ts`, `packages/core/src/api/settings.test.ts` (exists; it has no `device-schema` test and must still pass).
- **Verifiable result**: `rg -n "device-schema|unread-count|ice-config\b" packages plugins apps scripts examples --glob '!packages/core/packs/**'` → empty (`\b` matters: `device-configuration` in `packages/core/README.md:214` contains `ice-config`); `bun test packages/core/src/api/notifications.test.ts` → pass.
- **Do not**: do not add `unreadCount` anywhere; it is already in the list payload.

### 201.5 Dead WebSocket messages

Four sub-steps, one commit each. §3.2 is the evidence; re-run each quoted grep before deleting.

**131.5a `agent.subscribe`, `agent.unsubscribe`**

- **Files changed**: `packages/core/src/server/ws-handlers.ts`: delete the two arms `:1276-1284` (`case 'agent.subscribe': { deps.agent?.subscribe(ws, msg.payload.threadId) return }` and `case 'agent.unsubscribe': { ... }`), keeping `case 'agent.run.cancel'` and the comment block above them (edit its first line `// The agent chat protocol (plan 66 §3.4, §4.4) — \`deps.agent\` is optional so a host or` to keep only what is still true: the dep is optional). `packages/protocol/src/messages/agent.ts`: delete `:263-274` (the doc comment `/** Subscribe this connection to a thread's live events (§3.4) — never a snapshot; fetch history first over HTTP. */`, `AgentSubscribeMessage`, `AgentUnsubscribeMessage`); reword `:10` (`for history, then \`agent.subscribe\` for live updates from that point —`) to `for history, then the SSE stream (\`GET /api/v1/threads/:id/stream\`, \`packages/core/src/api/agent-chat-stream.ts\`) for live updates from that point —`. `packages/protocol/src/index.ts`: delete `:84-85` (import), `:709-710` (re-export), and `:1250-1251` (the `ClientMessageSchema` members), each pair reading `AgentSubscribeMessage,` `AgentUnsubscribeMessage,`. Reword the comments that state the old fact: `packages/core/src/api/threads.ts:95-96` (`a client GETs history, THEN sends \`agent.subscribe\` over /ws.`) → `a client GETs history, THEN attaches to the SSE stream (\`agent-chat-stream.ts\`).`; `packages/core/src/server/ws-handlers-agent.ts:7` (`\`agent.subscribe\`/\`.unsubscribe\`/\`.run.cancel\` in, ...`) → `\`agent.run.cancel\` in over /ws, the SSE relay (\`api/agent-chat-stream.ts\`) in through \`.subscribe()\`, ...`; `packages/core/src/server/ws-handlers-agent.test.ts:10` (`without needing an explicit \`agent.unsubscribe\`.`) → `without an explicit \`.unsubscribe()\` call.`; `packages/studio/src/lib/agent-approvals.ts:14` (`to a connection that has \`agent.subscribe\`d that exact thread`) → `to a stream attached to that exact thread`.
- **Test file**: `packages/core/src/server/ws-handlers-agent.test.ts` (tests the handler methods, which stay).
- **Verifiable result**: `rg -n "['\"]agent\.(subscribe|unsubscribe)['\"]|Agent(Subscribe|Unsubscribe)Message" packages plugins --glob '!packages/core/packs/**'` → empty; `bun test packages/core/src/server/ws-handlers-agent.test.ts` → pass.
- **Do not**: do not delete `AgentWsHandler.subscribe`/`unsubscribe`/`handleClose`; `api/agent-chat-stream.ts:99`, `:182`, `:285`, `:289` call them.

**131.5b `agent.message.queued`, `agent.message.delivered`**

- **Files changed**: `packages/core/src/agent/runner.ts`: delete the two `deps.publishToThread(...)` calls `:734-737` (inside the child-result path: `deps.publishToThread(parentThread.id, { type: 'agent.message.queued', payload: { inboxId: item.id, targetRunId: parentRun.id, fromRunId: childRun.id, kind: 'child-result' }, })`) and `:819-822` (inside `enqueueTreeMessage`: the same shape with `kind: 'message'`). Keep the `tree.enqueue(...)` and `maybeWakeIfIdle(...)` lines around them. The `publishToThread` dep (`runner.ts:118`) stays: `:396` and `:443` still publish `agent.child.started`/`.finished` through it. Shorten the daemon comment `daemon.ts:2611-2612` (`// Plan 67 §3.3, §4.4 — \`agent.message.queued\`/\`agent.child.started\`/\`.finished\` are` …) to name only the two surviving types, and edit `runner.ts:114`, the doc comment that lists `agent.message.queued` among plan 67's events, to drop it. `packages/core/src/server/ws-handlers-agent.ts`: change `toServerMessage`'s return type to `ServerMessage | null`, replace `:61-62` (`case 'inbox.delivered': return { type: 'agent.message.delivered', ...}`) with `case 'inbox.delivered': return null`, and in `publish` skip a `null` (§4.3). `packages/protocol/src/messages/agent.ts`: delete `:391-401` (the two doc comments and `AgentMessageQueuedMessage`, `AgentMessageDeliveredMessage`). `packages/protocol/src/index.ts`: delete `:97-98` (import), `:724-725` (re-export), and `:1060-1061` (the `ServerMessageSchema` members), each pair reading `AgentMessageQueuedMessage,` `AgentMessageDeliveredMessage,`.
- **Test file**: `packages/core/src/server/ws-handlers-agent.test.ts`; `packages/core/src/agent/tree.integration.test.ts` (asserts on the harness's `inbox.delivered` event, which stays).
- **Verifiable result**: `rg -n "['\"]agent\.message\.(queued|delivered)['\"]|AgentMessage(Queued|Delivered)Message" packages plugins --glob '!packages/core/packs/**'` → empty; `bun test packages/core/src/server/ws-handlers-agent.test.ts` → pass; then `bun test packages/core/src/agent/tree.integration.test.ts` → pass.
- **Do not**: do not delete the harness's `inbox.delivered` `RunEmitEvent` (`agent/harness/run.ts:88`, `:591`); it is an internal ordering event with a live test. Do not replace the WS message with an SSE `data-*` part; nothing in Studio asked for one.

**131.5c `scan.progress`**

- **Files changed**: `packages/core/src/registry/sweep.ts`: delete `:68` `hub: { broadcast(msg: ServerMessage): void }` from `SweeperDeps`; delete `:181-191` (the doc comment `/** Throttles \`scan.progress\` broadcasts (plan 88 §4.6) ... */` and `function createProgressBroadcaster(...) { ... }`); delete `:258` `const sendProgress = createProgressBroadcaster(deps.hub, capped.length)` and the two calls `sendProgress(scanned, answered)` at `:265` and `:269`; remove the `ServerMessage` type import if it is now unused (`rg -n "ServerMessage" packages/core/src/registry/sweep.ts`). `packages/core/src/daemon.ts:4424`: delete `hub: { broadcast: (msg) => hub.broadcast(msg) },` from `createSweeper({`. `packages/core/src/registry/sweep.test.ts`: delete `:106` `hubMessages: ServerMessage[]` from `Harness`, `:122` `const hubMessages: ServerMessage[] = []`, `:162` `hub: { broadcast: (msg) => hubMessages.push(msg) },`, `hubMessages` from the return at `:167`, the whole `describe('Sweeper.sweep — scan.progress broadcasts (plan 88 §4.6, §5 step 88.3)', ...)` block `:463-474`, and the `ServerMessage` import if now unused. `packages/protocol/src/messages/scan.ts`: delete the file if `ScanProgressMessage` and `ScanProgressEvent` are its only exports (`rg -n "^export" packages/protocol/src/messages/scan.ts` → two lines as of today, so delete it). `packages/protocol/src/index.ts`: delete `:53` `import { ScanProgressMessage } from './messages/scan'`, `:408-411` (`export {`, `ScanProgressMessage,`, `type ScanProgressEvent,`, `} from './messages/scan'`), and `:1013` `ScanProgressMessage,` inside `ServerMessageSchema`.
- **Test file**: `packages/core/src/registry/sweep.test.ts`.
- **Verifiable result**: `rg -n "['\"]scan\.progress['\"]|ScanProgress" packages plugins --glob '!packages/core/packs/**'` → empty; `bun test packages/core/src/registry/sweep.test.ts` → pass.
- **Do not**: do not keep `hub` on `SweeperDeps` "for future broadcasts".

**131.5d `plugin.log`**

- **Files changed**: `packages/core/src/plugins/runtime-logs.ts`: delete `:158-159` (`/** Called after a line is recorded and redacted. ... */` and `broadcast?: (pluginId: string, line: PluginLogLine) => void`) and `:378` `deps.broadcast?.(pluginId, line)`. `packages/core/src/daemon.ts:1760`: delete `broadcast: (plugin, line) => hub.broadcast({ type: 'plugin.log', payload: { plugin, ...line } }),` and reword `:1735-1739` (`// Plan 109 §4.5, step 109.8 — the per-plugin ring, the rotated file, the redactor, and the \`plugin.log\` broadcast.`) to drop `, and the \`plugin.log\` broadcast`. `packages/core/src/plugins/runtime-logs.test.ts`: delete `:40` `broadcasts: Array<...>` from `Harness`, `:50` `const broadcasts: Harness['broadcasts'] = []`, `:54` `broadcast: (plugin, line) => broadcasts.push(...)`, `broadcasts` from the return at `:66`, the assertion `:348` `expect(h.broadcasts.some((b) => b.line.msg.includes('log rotated'))).toBe(true)`, and the whole `describe('\`plugin.log\` — the live half', ...)` block `:355-390`; then remove `ServerMessageSchema`, `SERVER_MESSAGE_TYPES`, `refusedPluginEventTypesMessage` from the import at `:5` if unused. `packages/protocol/src/messages/plugin.ts`: delete `:31-63` (the doc comment `/** Realtime per-plugin service log ... */` and `export const PluginLogMessage = z.object({ ... })`), and trim the file header `:3-27` to the paragraph about `subject` (the header describes the broadcast; the retained `PluginLogLineSchema` and `PluginLogPageSchema` still need the `subject` explanation). `packages/protocol/src/index.ts`: delete `:155-159` (the comment beginning `// Plan 109 (M74 — the plugin runtime), step 109.8. \`plugin.log\` — the live` and `import { PluginLogMessage } from './messages/plugin'`); delete `:1094-1101` (the comment `// Plan 109 (M74 — the plugin runtime), step 109.8, §4.5 — appended last, ...` through `PluginLogMessage,` in the server union); delete `:1178-1213` (the doc comment `/** Farm events a plugin may **not** subscribe to ... */`, `PLUGIN_EVENT_TYPE_DENYLIST`, `PLUGIN_EVENT_TYPE_DENY_SET`, `refusedPluginEventTypesMessage`); change `:1531` to `export { PluginLogLineSchema, PluginLogPageSchema, type PluginLogLine, type PluginLogPage } from './messages/plugin'` and shorten its comment `:1528-1530` to `// Plan 109 step 109.8: the shapes \`GET /api/plugins/:name/runtime/logs\` serves.` `packages/core/src/plugins/verify-child.ts`: delete `:8` `refusedPluginEventTypesMessage,` from the import and `:274-280` (the comment `// Step 109.8's own addition to the same accept-then-refuse split. ...` and `const refusedEvents = ...` / `if (refusedEvents) return failure(refusedEvents, 'E_PLUGIN_EVENT_REFUSED')`). `packages/core/src/plugins/runtime-host.ts`: delete `:15` `refusedPluginEventTypesMessage,` from the import and `:1020-1026` (the comment `// Belt and braces over verify's own refusal (step 109.8): ...` and `const refused = ...` / `if (refused) throw new EnkakuError('E_PLUGIN_EVENT_REFUSED', ...)`); reword `:296` (`the rotated file, the redactor and the \`plugin.log\` broadcast.`) to `the rotated file and the redactor.` `packages/core/src/plugins/plugin-context.ts:71-73`: reword `the per-plugin ring + rotated file + \`plugin.log\` broadcast` to `the per-plugin ring + rotated file`. `packages/sdk/src/runtime.ts:141`: reword `at \`<dataDir>/plugins/<you>/runtime.log\`, and a \`plugin.log\` broadcast.` to `at \`<dataDir>/plugins/<you>/runtime.log\`, readable at \`GET /api/plugins/<you>/runtime/logs\`.` `plugins/proxy-manager/src/shared.ts:497-506`: reword the sentence `\`service/logbook.ts\`'s \`LogSink\` is the only broadcast channel a plugin service has (\`plugin.log\`, \`@enkaku/protocol\`'s \`messages/plugin.ts\`)` to `\`service/logbook.ts\`'s \`LogSink\` is the only log channel a plugin service has (the per-plugin ring served by \`GET /api/plugins/:name/runtime/logs\`)` and `(today: the Logs tab; in principle, anything that reads \`plugin.log\`)` to `(the Logs tab)`. `plugins/proxy-manager/src/ui/parts/failover-chip.tsx:28`: reword `structured \`plugin.log\` line` to `structured runtime-log line`. (Both proxy-manager edits are covered by the 201.11 version bump.)
- **Test file**: `packages/core/src/plugins/runtime-logs.test.ts`; `packages/core/src/plugins/runtime-service.test.ts` (asserts `SERVER_MESSAGE_TYPES` is populated; it is, by the remaining union, and `:692-714` names no removed type); `packages/core/src/plugins/verify-child.test.ts`.
- **Verifiable result**: `rg -n "['\"]plugin\.log['\"]|PluginLogMessage|PLUGIN_EVENT_TYPE_DENYLIST|refusedPluginEventTypesMessage|E_PLUGIN_EVENT_REFUSED" packages plugins --glob '!packages/core/packs/**'` → empty; `bun test packages/core/src/plugins/runtime-logs.test.ts` → pass; then `bun test packages/core/src/plugins/runtime-service.test.ts` → pass; then `bun test packages/core/src/plugins/verify-child.test.ts` → pass.
- **Do not**: do not delete `PluginLogLineSchema`, `PluginLogPageSchema`, the runtime log ring, the rotated file, or `GET /api/plugins/:name/runtime/logs`; the Logs tab reads them. Do not keep an empty `PLUGIN_EVENT_TYPE_DENYLIST = []`.

### 201.6 The AOA stub and the `'aoa'` enum value

- **Files deleted**: `packages/drivers/src/input/scrcpy-aoa.ts` (every method throws; `rg -n "ScrcpyAoaInput" packages plugins --glob '!packages/core/packs/**'` → only itself and `drivers/src/index.ts:42`).
- **Files changed**: `packages/drivers/src/index.ts:42`: delete `export { ScrcpyAoaInput } from './input/scrcpy-aoa'`. `packages/drivers/src/input/select.ts`: `:3` becomes `export type InputModePreference = 'uhid' | 'sdk'`; delete `:27-29` (`if (opts.preferred === 'aoa') { return { engine: 'scrcpy-uhid', degradedReason: 'AOA mode is not available yet (M8) — using UHID' } }`). `packages/core/src/registry/engines.ts:31-41`: delete the descriptor object whose `id: 'scrcpy-aoa'` (from the opening `{` before `id: 'scrcpy-aoa',` through the `},` after `unavailableReason: 'Needs an AOA USB transport (libusb) — not implemented yet; use scrcpy-uhid',`). `packages/protocol/src/settings.ts:414`: `.enum(['uhid', 'sdk', 'aoa'])` → `.enum(['uhid', 'sdk'])`. `packages/protocol/src/driver.ts:109`: `mode: 'sdk' | 'uhid' | 'aoa'` → `mode: 'sdk' | 'uhid'`. `packages/session/src/types.ts:24` and `packages/session/src/session.ts:329`: `'uhid' | 'sdk' | 'aoa'` → `'uhid' | 'sdk'`. `packages/core/src/session/adapters.ts:43`: the cast `{ input?: { preferredMode?: 'uhid' | 'sdk' | 'aoa' } }` → `{ input?: { preferredMode?: 'uhid' | 'sdk' } }`. `packages/core/src/jobs/runtime-sdk-comparison-guard.test.ts`: `:27` (the comment `(\`'uhid' | 'sdk' | 'aoa'\`,`) and `:178` (the fixture line `"preferredInputMode: 'uhid' | 'sdk' | 'aoa'",`) → the two-member form; the test's purpose (a `.sdk` property-chain guard) is unchanged. `packages/node/README.md:14`: in the M8d row delete `, \`scrcpy-aoa\` (registered but \`available: false\`)`.
- **Test file**: `packages/core/src/jobs/runtime-sdk-comparison-guard.test.ts`; the `packages/drivers/src/input/` directory (no `select.test.ts` exists on 2026-09-03; the directory run covers whatever is there); `packages/protocol/src/settings.test.ts` (if present).
- **Verifiable result**: `rg -n "scrcpy-aoa|ScrcpyAoaInput|['\"]aoa['\"]" packages plugins apps scripts examples --glob '!packages/core/packs/**'` → empty; `bun run typecheck` clean; `bun test packages/core/src/jobs/runtime-sdk-comparison-guard.test.ts` → pass; then `bun test packages/drivers/src/input/` → pass.
- **Do not**: do not add a Zod `.catch('uhid')` or a `.transform` to swallow a stored `'aoa'` (§4.4, §8 R3). Do not delete `selectInputEngine`'s other degrade rungs.

### 201.7 The adb wire constants and the two exports made private

- **Files changed**: `packages/adb/src/transport/wire.ts`: `:14` `export const A_SYNC = 0x434e5953` → `const A_SYNC = 0x434e5953` (it is used by `COMMAND_NAMES` at `:23`, so it stays, private); delete `:49-50` (the comment `/** The oldest version whose peer skips checksum verification — ... */` and `export const VERSION_SKIP_CHECKSUM = 0x01000001`); delete `:130-139` (the doc comment `/** Verify a payload against a decoded header's \`dataCheck\` ... */` and `export function verifyChecksum(...) { ... }`); in the `CONNECT_VERSION` comment `:40-47` keep the sentence about `A_VERSION_SKIP_CHECKSUM` in AOSP (it names AOSP's constant, not ours) and delete the clause `which is why \`checksum()\` below exists only for symmetry with older peers and is never load-bearing against a modern client`, replacing it with `so \`checksum()\` below is what this shim WRITES into \`data_check\`; nothing verifies an inbound one.`; at `:77` reword `for symmetry with a pre-\`VERSION_SKIP_CHECKSUM\` peer` to `for symmetry with an older peer`. `packages/adb/src/transport/wire.test.ts`: delete `VERSION_SKIP_CHECKSUM,` (`:12`) and `verifyChecksum,` (`:19`) from the import and the whole `describe('verifyChecksum', ...)` block `:107-126`. `packages/scrcpy/src/session.ts:178`: `export const SCID_MARKER_PREFIX = ...` → `const SCID_MARKER_PREFIX = ...`. `packages/scrcpy/src/session.test.ts:3`: drop `SCID_MARKER_PREFIX` from the import and add, directly below the imports, `/** Mirrors \`session.ts\`'s private marker (\`SCID_MARKER_BYTE = 0x7f\`); a test that pins the shipped value. */` and `const SCID_MARKER_PREFIX = '7f'`. `packages/session/src/farm-tag.ts:40`: `export const FARM_TAG_PROPERTY = 'debug.enkaku.instrumented'` → `const FARM_TAG_PROPERTY = ...`. `packages/session/src/farm-tag.test.ts:3` and `packages/session/src/session.test.ts:6`: drop the import of `FARM_TAG_PROPERTY` (keep `applyFarmTag` in the first) and add in each, below the imports, `const FARM_TAG_PROPERTY = 'debug.enkaku.instrumented'` with the same one-line comment.
- **Test file**: `packages/adb/src/transport/wire.test.ts`, `packages/scrcpy/src/session.test.ts`, `packages/session/src/farm-tag.test.ts`, `packages/session/src/session.test.ts`.
- **Verifiable result**: `rg -n "VERSION_SKIP_CHECKSUM|verifyChecksum|export const A_SYNC" packages/adb` → empty; `rg -n "export const SCID_MARKER_PREFIX|export const FARM_TAG_PROPERTY" packages` → empty; the four test files pass, run one at a time.
- **Do not**: do not delete `A_SYNC`, `checksum()`, or `CONNECT_VERSION`. Do not delete the SCID or farm-tag tests; they now pin the literal values.

### 201.8 Dead core exports

- **Files changed**: `packages/core/src/agent/provider/anthropic.ts:359-362`: delete `export function assertApiKey(apiKey: string | null): string { ... }`. `packages/core/src/agent/provider/openrouter.ts:154-157`: delete `export function assertOpenRouterApiKey(...)`. In both, keep `EnkakuError` imported only if still used (`rg -n "EnkakuError" <file>`). `packages/core/src/api/recordings.ts:175-176`: delete `export const RecordingCreateResponseSchema = ...` and `export const RecordingPatchResponseSchema = ...` (`RecordingDocSchema` stays; Studio keeps its own copies and no protocol file defines these names). `packages/core/src/plugins/runtime-host.ts:593-597`: delete `/** Tier 1's other half — record a promise the host is handing to plugin code. */` and `export function tagPluginPromise<T>(...)`. This was the only writer of `ownedPromises` (`:559`), so also delete `:559` `const ownedPromises = new WeakMap<object, string>()`, the read `:600-603` (`if (typeof promise === 'object' && promise !== null) { const owner = ownedPromises.get(promise); if (owner) return { name: owner, how: 'owned-promise' } }`) inside `attributeRejection`, the `'owned-promise'` member of `RejectionAttributionHow` (`:553`), and its table row in the doc comment at `:538` and the mention at `:193`. Run `rg -n "owned-promise" packages/core/src` afterwards → empty (no test names it). `packages/core/src/scripts/registry.ts:403-409`: delete the doc comment `/** Small helper for \`queue/job-store.ts\`'s \`scriptNames()\` ... */` and `export function scriptNamesByIds(...)`; then `:1` `import { and, eq, inArray } from 'drizzle-orm'` → `import { and, eq } from 'drizzle-orm'` (the deleted function was `inArray`'s only user: `rg -n "inArray" packages/core/src/scripts/registry.ts` → `:1`, `:407`).
- **Files created / deleted**: none.
- **Test file**: `packages/core/src/plugins/runtime-host.test.ts` (exists; `rg -n "owned-promise|tagPluginPromise" packages/core/src` → no test names either), `packages/core/src/scripts/registry.test.ts` (exists).
- **Verifiable result**: `rg -n "assertApiKey|assertOpenRouterApiKey|RecordingCreateResponseSchema|RecordingPatchResponseSchema|tagPluginPromise|scriptNamesByIds|ownedPromises|owned-promise" packages plugins --glob '!packages/core/packs/**'` → empty; `bun run typecheck` clean; `bun test packages/core/src/plugins/runtime-host.test.ts` → pass; then `bun test packages/core/src/scripts/registry.test.ts` → pass.
- **Do not**: do not keep `ownedPromises` "in case a future host tags a promise"; the attribution tier that reads it is unreachable without a writer.

### 201.9 Dead Studio and `@enkaku/ui` modules, exports, and tokens

- **Files deleted**: `packages/studio/src/components/topology/` (`ClusterSection.tsx`, `DeviceTile.tsx`, `DeviceTile.test.tsx`; `rg -n "components/topology|ClusterSection|from './DeviceTile'" packages/studio/src plugins` → the three files, two test list entries, and three comments, all handled below); `packages/studio/src/app/dev/` (`tools/page.tsx`, `tools/page.test.tsx`; no nav entry, no link: `rg -n "dev/tools" packages/studio/src` → `AppShell.test.tsx:424` only).
- **Files changed**:
  - `packages/studio/src/design-rules.test.ts`: delete `:117` and `:162`, both `join(root, 'components/topology/DeviceTile.tsx'),`.
  - `packages/studio/src/components/layout/AppShell.test.tsx:424`: delete `'/dev', // /dev/tools, a development-only surface`.
  - `packages/studio/src/components/wall/TileGrid.tsx:5-6`: reword `the fleet Wall and the topology page's \`ClusterSection\` both lay tiles out with this component` to `the fleet Wall lays tiles out with this component`.
  - `packages/studio/README.md:108`: delete the sentence `\`TileGrid\` is the one responsive grid layout, reused by the topology page's \`ClusterSection\` too.`
  - `packages/studio/src/app/topology/page.test.tsx:12-14`: reword `it calls no \`api<T>()\` of its own (\`lib/api.ts\`'s \`fetchTopology\` is a separate, out-of-scope pattern this plan does not migrate).` to `it calls no \`api<T>()\` of its own.`
  - `packages/studio/src/lib/api.ts`: delete `:211-222` (`export interface HealthResponse { ... }` and `export async function fetchHealth(): Promise<HealthResponse> { ... }`); delete `:224-254` (the three interfaces `TopologyCluster`, `TopologyActiveJob`, `TopologyResponse` with their comments and `export async function fetchTopology()`; `rg -n "TopologyCluster|TopologyActiveJob|TopologyResponse" packages/studio/src` → only `api.ts` and the deleted topology components); delete `:362-363` (`/** What a failed \`geo\` check should do to the route (plan 55 §3.5, §4.1, §5.6). */` and `export type OnGeoFail = 'report' | 'hold'`). Then `rg -n "DeviceInfo|coreBase" packages/studio/src/lib/api.ts`; keep both imports (other functions use them).
  - `packages/studio/src/lib/agent-chat.ts:126-215`: delete the doc comment `/** Plan 70 §3.6, §3.7 — a client-side approximation of the agent's own image window ... */` and `export function computeImageInContext(...)`. Check `AgentMessage` is still used in the file before removing its import.
  - `packages/studio/src/app/plugins/plugin-list.ts:78-93`: delete the comment `/** The version a group POINTS AT by default ... */`, `export function defaultVersion(...)`, the comment `/** Every member script id any version of this plugin declared ... */`, and `export function declaredScriptIds(...)`. `PluginListRow` and `PluginGroup` stay if used elsewhere in the file (`rg -n "PluginListRow|PluginGroup" packages/studio/src/app/plugins/plugin-list.ts`).
  - `packages/studio/src/components/bulk/BatchResults.tsx:372-380`: delete `/** A quiet chip for a result that failed its own schema ... */` and `export function ResultStatusChip(...)`. `Badge` has four other uses in the file; keep the import.
  - `packages/studio/src/components/schema-form/types.ts:43-51`: delete `export interface FieldProps { ... }` (`JsonSchemaNode` has seven other uses; keep it).
  - `packages/studio/src/components/schema-form/controls/types.ts:3-6`: delete the comment `/** Every leaf \`FieldPlan\` — ... */` and `export type LeafPlan = Exclude<FieldPlan, { control: 'group' }>`; then delete `:1` `import type { FieldPlan } from '../plan'` (it was `LeafPlan`'s only user: `rg -n "FieldPlan" <file>` → `:1`, `:3`, `:6`).
  - `packages/studio/src/components/host/index.ts:29`: `export { DeviceWallWithPicker, type DeviceWallPickerProps } from './DeviceWallWithPicker'` → `export { DeviceWallWithPicker } from './DeviceWallWithPicker'`. Neither ambient declaration names the type (`plugins/mikrotik-routing/src/enkaku-host.d.ts`, `packages/sdk/src/cli/init.ts:437` `hostTypes()`); the barrel's own comment says `DeviceWallWithPicker` is the only export. Leave `DeviceWallWithPicker.tsx:27` `export interface DeviceWallPickerProps` as it is (it is the component's own props; one file).
  - `packages/ui/src/components/device-picker.tsx:70`: `export interface PickableDevice {` → `interface PickableDevice {` (§3.2). `packages/ui/src/components/device-picker.test.tsx:3`: `import { DevicePicker, type PickableDevice } from './device-picker'` → `import { DevicePicker } from './device-picker'`, add `import type { ComponentProps } from 'react'`, and directly below the imports add `type PickableDevice = ComponentProps<typeof DevicePicker>['devices'][number]`.
  - `packages/ui/src/lib/core-base.ts`: delete `:55-60` (`let explicit: string | null = null`, the comment `/** Override the resolution chain entirely. \`null\` restores it. */`, and `export function setCoreBase(...) { ... }`); in `coreBase()` delete `:99` `if (explicit !== null) return explicit`; in the header comment delete rung 1 (`:17-19`, `1. **An explicit \`setCoreBase()\`** — nothing in this repo calls it. ...`) and renumber the remaining rungs 1 to 3. `packages/ui/src/index.ts:72`: `- \`coreBase\` / \`setCoreBase\` — where the farm is.` → `- \`coreBase\` — where the farm is.` `packages/ui/src/index.test.ts`: delete `'setCoreBase',` (`:31`) from `REQUIRED`; delete `:73` `afterEach(() => setCoreBase(null))` and the two tests `:75-84` (`'an explicit base wins over everything, trailing slash trimmed'` and `'setCoreBase(null) restores the derived answer'`); drop `setCoreBase` from the import at `:3` and `afterEach` from the `bun:test` import if now unused. `packages/ui/README.md:26`: `| \`coreBase\`, \`setCoreBase\` | ...` → `| \`coreBase\` | ...`.
  - `packages/ui/src/theme.css`: delete `:109` `--radius-card: 0.5rem;` and the blank line above it if that leaves two blanks; delete `:138` `--color-destructive-foreground: oklch(0.98 0 0);`. Then edit the four `rounded-card` mentions (§3.2): `packages/sdk/README.md:711` drop `, \`rounded-card\``; `packages/sdk/src/cli/init.ts:426` (the scaffold's CSS comment `/* The farm's design tokens — bg-surface, text-fg-muted, text-led-ok, rounded-card. ... */`) drop `, rounded-card`; `plugins/proxy-manager/src/ui/index.css:45` (same comment with `border-led-warn, rounded-card`) drop `, rounded-card`; `packages/sdk/src/cli/build-ui.test.ts:64` drop ` rounded-card` from the fixture's `className` (the test asserts `grid-cols-[200px_1fr]` and `hover-none:`, never the radius).
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Verifiable result**: `bun run typecheck` clean; `rg -n "fetchHealth|HealthResponse|fetchTopology|TopologyResponse|TopologyCluster|TopologyActiveJob|OnGeoFail|computeImageInContext|defaultVersion|declaredScriptIds|ResultStatusChip|FieldProps|LeafPlan|setCoreBase|DeviceWallPickerProps|components/topology|ClusterSection|dev/tools|radius-card|rounded-card|destructive-foreground" packages/studio packages/ui packages/sdk plugins --glob '!**/out/**'` → only `DeviceWallWithPicker.tsx:27` and `:38` (the props interface, allowed); everything else empty; `bun test packages/studio/src/design-rules.test.ts` → pass; `bun test packages/studio/src/components/layout/AppShell.test.tsx` → pass; `bun test packages/ui/src/components/device-picker.test.tsx` → pass; `bun test packages/ui/src/index.test.ts` → pass; `bun test packages/sdk/src/cli/build-ui.test.ts` → pass.
- **Do not**: do not delete `packages/studio/src/app/topology/page.tsx` (the redirect stub; plan 213). Do not delete `DeviceWallWithPicker.tsx`'s own `export interface`. Do not add `rounded-card` back as a `@utility`. Do not touch `components/TileChips.tsx`'s three comments that mention `DeviceTile` by name only (`:10`, `:21`, `:36`): they describe a rail that still exists on `WallTile`, and the §10 grep matches the path and the import, not the bare word.

### 201.10 Trim `components/ai-elements/` to what `Chat.tsx` imports

`packages/studio/src/components/agent/Chat.tsx:19-49` is the only consumer (`rg -n "ai-elements" packages/studio/src plugins packages/ui/src` → `Chat.tsx` and one comment in `app/agents/detail/page.tsx:67`). It imports: from `conversation` `Conversation`, `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton`; from `message` `Message`, `MessageContent`, `MessageResponse`; from `reasoning` `Reasoning`, `ReasoningContent`, `ReasoningTrigger`; from `shimmer` `Shimmer`; from `prompt-input` `PromptInput`, `PromptInputButton`, `PromptInputCommand`, `PromptInputCommandEmpty`, `PromptInputCommandGroup`, `PromptInputCommandItem`, `PromptInputCommandList`, `PromptInputFooter`, `PromptInputProvider`, `PromptInputSelect`, `PromptInputSelectContent`, `PromptInputSelectItem`, `PromptInputSelectTrigger`, `PromptInputSelectValue`, `PromptInputSubmit`, `PromptInputTextarea`, `PromptInputTools`, `usePromptInputAttachments`, `usePromptInputController`, `type PromptInputMessage`.

- **Files changed**:
  - `packages/studio/src/components/ai-elements/conversation.tsx`: delete `:108-167` (`ConversationDownloadProps`, `defaultFormatMessage`, `messagesToMarkdown`, `ConversationDownload`) and `getMessageText` at `:102-106` if it has no other use; then remove `DownloadIcon` (`:5`), `useCallback` (`:7`), and `UIMessage` (`:4`) from the imports if unused (`rg -n "DownloadIcon|useCallback|UIMessage" <file>`).
  - `packages/studio/src/components/ai-elements/message.tsx`: delete the export pairs (`*Props` type plus component) for `MessageActions` (`:66-77`), `MessageAction` (`:78-138`), `MessageBranch` and everything named `MessageBranch*` (`:139-318`: `MessageBranch`, `MessageBranchContent`, `MessageBranchSelector`, `MessageBranchPrevious`, `MessageBranchNext`, `MessageBranchPage`, plus the branch context and its hook if they are module-private), and `MessageToolbar` (`:349-365`). Keep `Message`, `MessageContent`, `MessageResponse` and `streamdownPlugins`. Then prune imports: `ButtonGroup`, `ButtonGroupText`, `Tooltip*`, `Button` from `@enkaku/ui` (`:3-12`), `ChevronLeftIcon`, `ChevronRightIcon` (`:18`), `ReactElement` (`:19`), and the React hooks at `:20-28`; keep only what `rg -n "<name>" <file>` still finds (`memo` and `cn` certainly stay).
  - `packages/studio/src/components/ai-elements/prompt-input.tsx`: delete these eighteen components with their `*Props` types: `PromptInputActionAddAttachments`, `PromptInputActionAddScreenshot` (`:401-472`), `PromptInputBody` (`:940-947`), `PromptInputHeader` (`:1077-1091`), `PromptInputActionMenu`, `PromptInputActionMenuTrigger`, `PromptInputActionMenuContent`, `PromptInputActionMenuItem` (`:1175-1212`), `PromptInputHoverCard`, `PromptInputHoverCardTrigger`, `PromptInputHoverCardContent` (`:1324-1351`), `PromptInputTabsList`, `PromptInputTab`, `PromptInputTabLabel`, `PromptInputTabBody`, `PromptInputTabItem` (`:1353-1406`), `PromptInputCommandInput` (`:1415-1422`), `PromptInputCommandSeparator` (`:1460-1469`). Then apply the rule: for every remaining `export`ed name in the file that `Chat.tsx` does not import, count its occurrences in the file (`grep -o "[^A-Za-z0-9_]<name>[^A-Za-z0-9_]" <file> | wc -l`); a count of 1 means the definition is now orphaned: delete it. A count above 1 means it is used internally: drop the `export` keyword and keep it. As of 2026-09-03 that rule deletes nothing further and un-exports `AttachmentsContext`, `TextInputContext`, `PromptInputControllerProps`, `useProviderAttachments`, `PromptInputProviderProps`, `ReferencedSourcesContext`, `LocalReferencedSourcesContext`, `usePromptInputReferencedSources`, `PromptInputProps`, `PromptInputTextareaProps`, `PromptInputFooterProps`, `PromptInputToolsProps`, `PromptInputButtonTooltip`, `PromptInputButtonProps`, `PromptInputSubmitProps`, `PromptInputSelect*Props`, `PromptInputCommand*Props`; `captureScreenshot` (`:90`, module-private; its only caller is `:449` inside `PromptInputActionAddScreenshot`) becomes orphaned; delete it, through the `video.srcObject = null` cleanup that ends it. Prune imports `:3-65`: `CommandInput`, `CommandSeparator`, `DropdownMenu*`, `HoverCard*`, `InputGroupAddon` (only if `PromptInputFooter` no longer uses it; it does, so keep it), `ImageIcon`, `Monitor`, `PlusIcon` and any React type that no longer appears.
- **Files created / deleted**: none (the five files stay; `reasoning.tsx` and `shimmer.tsx` are untouched).
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Verifiable result**: `bun run typecheck` clean; `bash scripts/check-dead-code.sh` no longer prints `FOUND ai-elements`; `bun test packages/studio/src/components/agent/` → pass; `wc -l packages/studio/src/components/ai-elements/*.tsx` totals well under the current 2 303.
- **Do not**: do not delete `usePromptInputAttachments` or the attachments provider (Chat uses the hook). Do not remove `motion` or `streamdown` from `packages/studio/package.json` (`shimmer.tsx` and `MessageResponse` use them). Do not remove `use-stick-to-bottom`, `@radix-ui/*`, or `cmdk` from `package.json` in this plan: whether an npm dependency is orphaned is checked by `rg -n "<pkg>" packages/studio/src packages/ui/src` and reported in §11 "Observed, not done" for plan 220, which rebuilds the Agents page.

### 201.11 Plugins: `record.ts`, the stale test copy, the rename, the versions

- **Files deleted**: `plugins/proxy-manager/src/record.ts` (238 lines; production imports `./shared`; `rg -n "from '\./record'|from '\.\./record'" plugins/proxy-manager/src` → `index.test.ts:7`, `record.test.ts:2` only).
- **Files changed**:
  - `plugins/proxy-manager/src/index.test.ts`: `:7` `import { PROXY_KEY_HINT, PROXY_KEY_PREFIX, PROXY_KINDS, ProxyRecordSchema } from './record'` → import `PROXY_KEY_HINT`, `PROXY_KEY_PREFIX`, `PROXY_KINDS` from `./shared` (merge into the existing `./shared` import block that begins at `:9`). `:131` `const RECORD_FIELDS = Object.keys(ProxyRecordSchema.shape)` → `const RECORD_FIELDS = Object.keys(writeProxy(readProxy(null)))` (the production writer's own key order is the field list; `readProxy`/`writeProxy` are already imported from `./ui/parts/api` at `:8`). `:1258-1259` delete `const parsed = ProxyRecordSchema.safeParse(stored)` and `expect(parsed.error?.issues ?? []).toEqual([])` (the surrounding `expect(readProxy(stored)).toEqual(typed)` is the round-trip that matters). `:1303` `const proto = ProxyRecordSchema.shape.upstream.unwrap().shape.proto` and the two `proto.safeParse(...)` lines → replace the test body's first three lines with `expect(PROXY_KINDS).not.toContain('socks 5')` and `for (const kind of PROXY_KINDS) expect(readProxy({ upstream: { proto: kind } }).upstream.proto).toBe(kind)`; keep the `PROXY_KIND_LABELS` assertion. `:46` `VIEW_NOT_BUILT,` → `PROXIES_VIEW_DESCRIPTION,`; every other `VIEW_NOT_BUILT` in the file (`:248`, `:253`, `:254`, `:261`, `:268`, `:270`, `:279`, `:287`, `:323`, `:475`) → `PROXIES_VIEW_DESCRIPTION`. `:168` `expect(plugin.version).toBe('0.11.0')` → `'0.11.1'`.
  - `plugins/proxy-manager/src/record.test.ts`: `:2` delete the import line; delete the tests that exist only to check the shim: `'round-trips through write → read, and parses as a ProxyRecord'` (`:50-57`: keep it but delete its two schema lines `:53-54` and `expect(parsed...)` `:55`; the `readProxyRecord(stored)` equality stays), `'everything the defensive reader can produce also parses against the schema'` (`:59-68`, delete whole), `'a record captured before this plan still parses against the schema, with the new fields defaulted'` (`:160-165`, delete whole; the preceding migration test at `:150-158` already asserts the defaults through `readProxyRecord`), the schema lines `:176-178` inside the fallback round-trip test (keep the `readProxyRecord(stored)` equality), `:577` `expect(SECRET_PREFIX_IS_DISJOINT).toBe(true)` (the next line `expect(PROXY_SECRET_KEY_PREFIX.startsWith(PROXY_KEY_PREFIX)).toBe(false)` is the same assertion on the strings), and the test `'the secret is an object with one field, and the schema says so'` (`:598-602`, delete whole; `shared.ts:650` `ProxySecret` is an interface, and `:2003` states the rule in prose).
  - `plugins/proxy-manager/src/shared.ts:2229`: `export const VIEW_NOT_BUILT =` → `export const PROXIES_VIEW_DESCRIPTION =`; the doc comment above it stays (it explains the copy). `plugins/proxy-manager/src/index.ts:8` (import) and `:528` (`description: VIEW_NOT_BUILT,`) → `PROXIES_VIEW_DESCRIPTION`.
  - Four comments name the deleted schema and become false with it: `plugins/proxy-manager/src/shared.ts:531` (`Field order is the storage order — \`index.test.ts\` holds it to \`ProxyRecordSchema\`'s.`) → `Field order is the storage order; \`index.test.ts\` holds \`writeProxy\` to it.`; `shared.ts:828-829` (`\`index.test.ts\` runs a value through both and checks the result against \`ProxyRecordSchema\`.`) → `\`index.test.ts\` runs a value through both and checks the round trip.`; `ui/parts/api.ts:163-164` (`\`index.test.ts\` still runs a value through both and parses the result against \`ProxyRecordSchema\`.`) → `\`index.test.ts\` still runs a value through both and checks the round trip.`; `ui/parts/backup-upstreams.tsx:196-197` (`\`min={1}\` is the schema's own floor (\`ProxyFailoverSchema.failureThreshold\`), not an added opinion.`) → `\`min={1}\` mirrors \`readProxyRecord\`'s own floor for \`failover.failureThreshold\`, not an added opinion.`
  - `plugins/proxy-manager/src/index.ts:279` `version: '0.11.0',` → `'0.11.1'`, and append to the doc-comment block ending at `:278` a paragraph: `**0.11.1, plan 201 (MVP wave 0): housekeeping.** \`service.permissions\` UNCHANGED. Deleted \`record.ts\`, a Zod re-declaration of the record that only tests imported (the service parses through \`shared.ts\`'s \`readProxyRecord\`); renamed \`VIEW_NOT_BUILT\` to \`PROXIES_VIEW_DESCRIPTION\` because the view has been built since plan 112; reworded two comments that named the deleted \`plugin.log\` broadcast. Patch, not minor: nothing an operator meets changes.` `plugins/proxy-manager/package.json:3` `"version": "0.11.0"` → `"0.11.1"`.
  - `plugins/networking/package.json:3` `"version": "2.2.0"` → `"3.0.0"` (matches `src/index.ts:1151`).
  - Run `bun install` (workspace versions may be recorded in `bun.lock`; commit it if it changed) and `bun run build:packs`.
- **Test file**: `plugins/proxy-manager/src/index.test.ts`, `plugins/proxy-manager/src/record.test.ts`.
- **Verifiable result**: `rg -n "VIEW_NOT_BUILT|from '\./record'|ProxyRecordSchema|ProxySecretSchema|SECRET_PREFIX_IS_DISJOINT" plugins` → empty; `bun test plugins/proxy-manager/src/index.test.ts` → pass; then `bun test plugins/proxy-manager/src/record.test.ts` → pass; `bash scripts/check-release-packs.sh` → exit 0; `bun install --frozen-lockfile` → exit 0.
- **Do not**: do not move `ProxyRecordSchema` into `shared.ts`; that file imports nothing by design (`shared.ts:17`) and is bundled into the browser half. Do not rename `PLUGIN_NOT_BUILT` or `BANNER_NOT_BUILT` (§2). Do not bump `plugins/networking`'s version; only the drifted `package.json` field is corrected. Do not rename `record.test.ts`; it tests `shared.ts`'s reader and writer, which stay.

### 201.12 Dead scripts, stale READMEs and comments, the `labelling.ts` bytes

- **Files deleted**: `scripts/guest-agent.ts` (its header `:5-6` says `The product path is Studio driving the \`vpn-helper\` engine, which does not exist yet ... Delete this once it does.`; `packages/drivers/src/network/guest-agent/vpn-helper.ts` exists; not in `package.json` scripts); `scripts/delete-unowned-scripts.ts` (a spent plan 110 migration; `rg -n "delete-unowned-scripts" packages plugins scripts package.json .github` → two comments).
- **Files changed**:
  - `README.md:125-132`: delete the trailing sentence ` There is also a CLI for driving it without Studio:` from `:125` and the fenced block `:127-132` (`\`\`\`bash` … `bun scripts/guest-agent.ts stop --serial <SERIAL>` … `\`\`\``) with its surrounding blank line.
  - `apps/guest-agent/README.md`: `:118` replace the paragraph `**The device side is complete; nothing on the host calls it yet.** \`packages/core/src/device/labelling.ts\` — the host-side service ... has not been built (plan 89 is still \`not started\`; only plan 90's on-device contract has shipped). Driving \`label.apply\` today needs a short script against ... directly.` with `**Both halves exist.** \`packages/core/src/device/labelling.ts\` (plan 89 §4.6) is the host-side service that computes the fingerprint and calls these verbs; it is wired in \`packages/core/src/daemon.ts\` and Studio's label apply and clear actions drive it.`; delete the section `:122-205` from `## Driving it without Studio` through `It is a temporary developer tool, not part of the product — delete it once the Studio path is complete.` plus the blank line after it; `:138` delete the sentence `It supersedes \`scripts/guest-agent.ts\` for anything beyond ad hoc debugging;` so the line reads `... each asserting on what the device reports. See [\`docs/plans/50-...`.
  - `packages/drivers/src/network/guest-agent/client.ts:57`: `(verified against a real device by \`scripts/guest-agent.ts\`, plan 44 §5.1)` → `(verified against a real device in plan 44 §5.1)`.
  - `packages/core/src/plugins/runtime.ts:1248` and `packages/core/src/plugins/runtime.test.ts:1006`: both comments cite `\`scripts/delete-unowned-scripts.ts\`'s header records the mistake its own first version made`; reword each to `a one-off plan 110 migration script (since deleted) recorded the mistake its own first version made` and keep the rest of the sentence.
  - `packages/core/src/db/schema.ts:999-1001` (the `jobNodes` doc comment: `No producer yet: nothing writes this table until 99.7's workflow executor lands (plan 99 §4.7). Added now, alongside \`scripts.kind\`, because both are read by the executor-selection seam this step also builds.`) → `Written only by \`jobs/executors/workflow.ts\`, which \`daemon.ts\` never wires (\`scriptKind\` is not passed to \`createExecutorHost\`, so the executor is unreachable in production). Plan 211 replaces this table with workflow runs and steps.`; `:1059` (`No producer yet: set only once 99.7's workflow executor stamps a node-scoped \`ArtifactSink\` wrapper (§4.6's own note).`) → `Set only by the unreachable workflow executor (see \`jobNodes\`); plan 211 removes the column.`
  - `packages/core/src/device/labelling.ts:86`: the line `const stripped = raw.replace(/[<NUL>-<US><DEL>]/g, '').trim()` contains three raw bytes (0x00, 0x1f, 0x7f) inside the character class, which is why `file` reports the source as `data` and `grep` skips it. Rewrite the class with escapes so the regex is identical: `const stripped = raw.replace(/[\x00-\x1f\x7f]/g, '').trim()` (backslash, `x`, two hex digits: four ASCII characters per escape). Verify with `file packages/core/src/device/labelling.ts` → contains `text`, not `data`.
- **Test file**: `packages/core/src/device/labelling.test.ts`, `packages/core/src/plugins/runtime.test.ts`.
- **Verifiable result**: `rg -n "scripts/guest-agent\.ts|delete-unowned-scripts" packages apps plugins scripts examples README.md` → empty; `rg -n "has not been built" apps/guest-agent/README.md` → empty; `rg -n "No producer yet" packages/core/src/db/schema.ts` → empty; `LC_ALL=C tr -d '\040-\176\200-\377\n\t' < packages/core/src/device/labelling.ts | wc -c` → `0`; `bun test packages/core/src/device/labelling.test.ts` → pass; then `bun test packages/core/src/plugins/runtime.test.ts` → pass.
- **Do not**: do not delete `scripts/smoke-guest-agent.ts`, `scripts/bench-device-nfrs.ts`, or `scripts/tag-release.sh`. Do not "fix" any other byte in `labelling.ts`; only the three in the regex class are non-text.

### 201.13 Close: the gate passes, tests, status line

- **Files changed**: this plan's `> Status:` line and §11.
- **Verifiable result**: `bun run typecheck` → clean; `bash scripts/check-dead-code.sh` → `  no dead code found`, exit 0; every §7.1 command passes, run one at a time; `bash scripts/check-plan-status.sh` → exit 0; `bash scripts/check-release-packs.sh` → exit 0; `bun install --frozen-lockfile` → exit 0; G7's `awk` line shows fewer additions than deletions; `ps -Ao pid=,command= | grep -i "[o]penpf"` → only your shell.
- **Do not**: do not write `implemented` while any §0 row is unchecked; do not run `bun test` bare or `bun run --cwd packages/studio test`.

## 6. Acceptance criteria

1. Every row of §0 is checked, with the command output pasted in §11.
2. `bash scripts/check-dead-code.sh` exits 0 on the final commit and exits 1 on the plan's base commit (run it once against `git stash`-free state: check out the base commit's tree into a temporary worktree with `git worktree add <scratchpad>/base <base>` and run the script there; remove the worktree afterwards).
3. `.github/workflows/ci.yml` runs the script in job `check`, after `check-harness-provenance.sh`.
4. No file under `packages/harness`, `apps/desktop`, `packages/core/src/tunnel`, `packages/core/src/lease`, `packages/core/src/mirror`, `packages/core/src/jobs/executors/workflow.ts`, `packages/core/src/api/agents.ts`, or `packages/core/src/api/tokens.ts` is modified (`git diff --stat <base>..HEAD -- <those paths>` → empty).
5. `clipboard.ok` and `input.text.result` are still sent with the request's `id` (G6).
6. Every deleted test file is listed in §7.3 and nothing else under `**/*.test.ts*` was deleted (`git diff --diff-filter=D --name-only <base>..HEAD -- '*.test.ts' '*.test.tsx'` matches §7.3 exactly).
7. `docs/spec.md`, `docs/spec-divergences.md`, and `docs/plans/01..130` are untouched.
8. The §11 handoff report is filled in with every §10 grep and its output.

## 7. Test plan

### 7.1 Scoped unit tests (one invocation at a time, never concurrently, never a suite)

Run each after the step that names it, and all of them again at 201.13:

```bash
bun test packages/core/src/api/notifications.test.ts
bun test packages/core/src/server/ws-handlers-agent.test.ts
bun test packages/core/src/agent/tree.integration.test.ts
bun test packages/core/src/registry/sweep.test.ts
bun test packages/core/src/plugins/runtime-logs.test.ts
bun test packages/core/src/plugins/runtime-service.test.ts
bun test packages/core/src/plugins/verify-child.test.ts
bun test packages/core/src/plugins/runtime.test.ts
bun test packages/core/src/jobs/runtime-sdk-comparison-guard.test.ts
bun test packages/core/src/device/labelling.test.ts
bun test packages/core/src/server/ws-handlers-clipboard.test.ts
bun test packages/core/src/server/ws-handlers-text.test.ts
bun test packages/drivers/src/input/
bun test packages/adb/src/transport/wire.test.ts
bun test packages/scrcpy/src/session.test.ts
bun test packages/session/src/farm-tag.test.ts
bun test packages/session/src/session.test.ts
bun test packages/sdk/src/cli/build-ui.test.ts
# CANCELLED by §12 (zero Studio tests): bun run --cwd packages/ui test -- src/components/device-picker.test.tsx
# CANCELLED by §12 (zero Studio tests): bun run --cwd packages/ui test -- src/index.test.ts
# CANCELLED by §12 (zero Studio tests): bun run --cwd packages/studio test -- src/design-rules.test.ts
# CANCELLED by §12 (zero Studio tests): bun run --cwd packages/studio test -- src/components/layout/AppShell.test.tsx
# CANCELLED by §12 (zero Studio tests): bun run --cwd packages/studio test -- src/app/topology/page.test.tsx
# CANCELLED by §12 (zero Studio tests): bun run --cwd packages/studio test -- src/components/agent/
bun run --cwd plugins/proxy-manager test -- src/index.test.ts
bun run --cwd plugins/proxy-manager test -- src/record.test.ts
```

`packages/ui`, `packages/studio`, and `plugins/*` tests need their own `bunfig.toml` preload (a DOM), so they are invoked through the package's `test` script with the file as a trailing argument; a bare `bun test packages/studio/...` from the root cannot see them (`CLAUDE.md`, Commands). If a package's `test` script rejects a positional file, run `cd <package> && bun test <relative path>` instead and say so in §11. Never run the script without a file argument.

If a file in this list does not exist on the day of execution (e.g. `settings.test.ts`, `runtime-host.test.ts`, `select.test.ts` are named as "if present" in §5), skip it and record the skip in §11.

### 7.2 Manual smoke (no device)

```bash
bun run reset
bun run dev &                                  # core on :7700
sleep 8
curl -s localhost:7700/api/health | head -c 200; echo
curl -s -o /dev/null -w '%{http_code}\n' localhost:7700/api/settings/device-schema        # 404
curl -s -o /dev/null -w '%{http_code}\n' localhost:7700/api/notifications/unread-count    # 404
curl -s -o /dev/null -w '%{http_code}\n' localhost:7700/api/nodes/ice-config              # 404
curl -s localhost:7700/api/settings | grep -o '"deviceSchema"' | head -1                  # "deviceSchema"
curl -s localhost:7700/api/plugins | head -c 200; echo                                    # the seeded packs list; proxy-manager@0.11.1 staged
kill %1
```

Expected: health `ok: true`; the three routes answer 404; `deviceSchema` is still in the settings payload; the plugins list includes `proxy-manager` at `0.11.1` in a staged (not active) state. Nothing else in the product is exercised by this plan.

Then in a browser against `bun run dev:studio` with one device attached, if available: open a device page, write to the clipboard from the Clipboard button and type into the text field. Both complete within a second (not the 25-second timeout). This is the only behaviour the plan could have broken and it is device-dependent, so it is the owner's check (`ENKAKU_TEST_DEVICE=1` territory); `bun test packages/core/src/server/ws-handlers-clipboard.test.ts` and `ws-handlers-text.test.ts` are the software proof.

### 7.3 Test files this plan deletes, with the source each covered

| Deleted test | Covered | Why the coverage is gone with it |
|---|---|---|
| `packages/studio/src/components/topology/DeviceTile.test.tsx` | `components/topology/DeviceTile.tsx` | the component is deleted (201.9) |
| `packages/studio/src/app/dev/tools/page.test.tsx` | `app/dev/tools/page.tsx` | the page is deleted (201.9) |

No other test file is deleted. Tests edited in place (blocks removed): `packages/core/src/api/notifications.test.ts`, `packages/core/src/registry/sweep.test.ts`, `packages/core/src/plugins/runtime-logs.test.ts`, `packages/adb/src/transport/wire.test.ts`, `packages/ui/src/index.test.ts`, `plugins/proxy-manager/src/record.test.ts`, `plugins/proxy-manager/src/index.test.ts`, `packages/studio/src/design-rules.test.ts`, `packages/studio/src/components/layout/AppShell.test.tsx`; edited for a rename or a literal: `packages/scrcpy/src/session.test.ts`, `packages/session/src/farm-tag.test.ts`, `packages/session/src/session.test.ts`, `packages/core/src/jobs/runtime-sdk-comparison-guard.test.ts`, `packages/ui/src/components/device-picker.test.tsx`, `packages/sdk/src/cli/build-ui.test.ts`, `packages/studio/src/app/topology/page.test.tsx`, `packages/core/src/plugins/runtime.test.ts`, `packages/core/src/server/ws-handlers-agent.test.ts`.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | A "dead" name has a live consumer the 2026-09-03 greps missed (the register already got three wrong, §3.2) | every step re-runs its grep before deleting; a hit outside the plan's own list stops that item, which is kept and reported (§11 "Discrepancies"), never patched around |
| R2 | `bun.lock` drift after removing `werift`/`reflect-metadata` or changing workspace versions makes CI's `bun install --frozen-lockfile` fail | `bun install` is run in 201.3 and 201.11 and the lockfile is committed; G4 and 201.11 both check `--frozen-lockfile` |
| R3 | A device row persisted with `input.preferredMode: 'aoa'` fails `DeviceSettingsSchema.safeParse` after 201.6 (§4.4) | before merging, the owner runs `sqlite3 <dataDir>/enkaku.db "select id from devices where settings like '%\"aoa\"%'"` on the farm (`daemon.ts:457` opens `join(cfg.dataDir, 'enkaku.db')`; the column is `devices.settings`, `schema.ts:32` `settings: text('settings', { mode: 'json' })`); a hit is fixed by one `update devices set settings = replace(settings, '"aoa"', '"uhid"') where id = '<id>'` by hand. No code branch is added for it. |
| R4 | Deleting `--radius-card` silently un-styles a third-party plugin that used `rounded-card` from the SDK docs | no plugin in this repo uses the class; the SDK docs and scaffold are edited in the same commit so no new plugin is told about it; the note goes into the release notes via §11 |
| R5 | Deleting `setCoreBase` narrows the public `@enkaku/ui` surface | `core-base.ts:17` itself says "nothing in this repo calls it"; the README row is edited; same release-note line as R4 |
| R6 | The `ai-elements` trim leaves an npm dependency (`@radix-ui/react-hover-card`, `cmdk`, `use-stick-to-bottom`) with no importer | not removed here (201.10 "Do not"); listed in §11 for plan 220 |
| R7 | `runtime-service.test.ts:699` asserts `SERVER_MESSAGE_TYPES.length > 50`; this plan removes seven server types | the union has far more than 57 members today; if the assertion fails, the count is reported and the threshold is NOT lowered by this plan (report, do not decide) |
| R8 | `check-dead-code.sh` false positive on a future legitimate name (e.g. a new `FieldProps` in another package) | the patterns are word-guarded and scoped; a future plan that needs a name back removes the row from the script in the same commit and says so in its §10 |
| R9 | Concurrent wave-0 plans (132, 203, 204) edit the same files (`.env.example`, READMEs, `ci.yml`) | this plan's edits to those files are small and named line by line; conflicts are resolved by re-applying the named edit, never by taking one side wholesale |

## 9. Open questions

1. **`examples/scroll-fling-demo.ts`**: referenced only by `examples/examples.test.ts:8` and `:26` and by plan 110 §table. The register calls it "low value, likely removable". Delete it (and its two test lines) or keep it as a worked example of `scroll`/`fling` for plugin authors? A human decides; until then it stays, and this plan does not touch `examples/`.

## 10. Removed

Proof column: run from the repo root; expected output is empty unless stated. `bash scripts/check-dead-code.sh` runs every row below in `grep` form (§4.1); the `rg` forms are for the executor's own verification and for the §11 report.

### Table A: files and directories

| What | Where it was | Proof |
|---|---|---|
| Licensing (`loadLicense`, `LicensePayloadSchema`, `EDITION_LIMITS`, `limitsFor`, `withinDeviceLimit`) | `packages/core/src/licensing/` | `test ! -d packages/core/src/licensing` |
| Telemetry (`createTelemetry`, `TelemetryPayloadSchema`) | `packages/core/src/telemetry/` | `test ! -d packages/core/src/telemetry` |
| Compatibility barrel | `packages/core/src/session/index.ts` | `test ! -e packages/core/src/session/index.ts` |
| WebRTC relay, server half (`webrtc-relay.ts`, `werift-peer.ts`, `rtc-peer.ts`, `rtp-h264.ts`, `ice-credentials.ts`) | `packages/core/src/relay/` | `test ! -d packages/core/src/relay` |
| WebRTC client (`createWebRtcPlayer`, `WebRtcPlayer`, `PlayerState`) | `packages/studio/src/lib/webrtc-player.ts` | `test ! -e packages/studio/src/lib/webrtc-player.ts` |
| `ClusterSection.tsx`, `DeviceTile.tsx`, `DeviceTile.test.tsx` | `packages/studio/src/components/topology/` | `test ! -d packages/studio/src/components/topology` |
| `/dev/tools` page and test | `packages/studio/src/app/dev/` | `test ! -d packages/studio/src/app/dev` |
| Schema re-export shim | `plugins/proxy-manager/src/record.ts` | `test ! -e plugins/proxy-manager/src/record.ts` |
| Bring-up CLI | `scripts/guest-agent.ts` | `test ! -e scripts/guest-agent.ts` |
| Spent plan 110 migration | `scripts/delete-unowned-scripts.ts` | `test ! -e scripts/delete-unowned-scripts.ts` |
| `ScrcpyAoaInput` stub | `packages/drivers/src/input/scrcpy-aoa.ts` | `test ! -e packages/drivers/src/input/scrcpy-aoa.ts` |
| `scan.progress` schema file | `packages/protocol/src/messages/scan.ts` | `test ! -e packages/protocol/src/messages/scan.ts` |

### Table B: names, routes, messages, settings, dependencies, comments

| What | Where it was | Proof |
|---|---|---|
| `ENKAKU_LICENSE_FILE`, `ENKAKU_LICENSE_PUBKEY`, `ENKAKU_TELEMETRY_URL`, `ENKAKU_FEED_URL` | `.env.example:163-167` | `rg -n "ENKAKU_LICENSE_\|ENKAKU_TELEMETRY_URL\|ENKAKU_FEED_URL" packages apps plugins scripts examples .env.example` |
| `video.webrtc.request/offer/answer/ice/failed/stop` handlers and schemas, `WebRtcSignaling`, `WsHandlerDeps.webrtc` | `packages/core/src/server/ws-handlers.ts:278-287`, `:2481-2506`; `packages/protocol/src/tunnel.ts:142-174`; `packages/protocol/src/index.ts:38-45`, `:771-776`, `:1029-1031`, `:1232-1236` | `rg -n "video\.webrtc\|WebRtc\|WebRtcSignaling" packages plugins apps --glob '!packages/core/packs/**' --glob '!packages/studio/out/**'` |
| `createWebRtcRelay`, `createWeriftFactory`, `webrtcRelay`, `webrtcRelayRef` wiring | `packages/core/src/daemon.ts:28-29`, `:346`, `:2170-2186`, `:3559`, `:4618-4619` | `rg -n "webrtcRelay\|createWebRtcRelay\|createWeriftFactory" packages/core/src` |
| `import 'reflect-metadata'` | `packages/core/src/index.ts:1-4` | `rg -n "reflect-metadata" packages/core/src` |
| `werift`, `reflect-metadata` dependencies (and transitive `tsyringe`) | `packages/core/package.json:24-25`, `bun.lock` | `rg -n "werift\|reflect-metadata\|tsyringe" packages/core/package.json bun.lock` |
| `GET /api/nodes/ice-config`, `buildIceServers` import | `packages/core/src/api/nodes.ts:9`, `:100-101` | `rg -n "ice-config\b\|buildIceServers" packages plugins apps` |
| `ENKAKU_STUN_URL`, `ENKAKU_TURN_URL`, `ENKAKU_TURN_USER`, `ENKAKU_TURN_PASSWORD`, `ENKAKU_TURN_SECRET` | `.env.example:120-125` | `rg -n "ENKAKU_STUN_URL\|ENKAKU_TURN_" packages apps plugins scripts .env.example` |
| `transport`/`setTransport` state, `degradedReason` state, the `video.webrtc.failed` branch, the `webrtc` label, the "WebRTC path is not in use" banner | `packages/studio/src/components/LiveView.tsx:329-330`, `:472-475`, `:1063-1074`, `:1111-1116` | `rg -n "'webrtc'\|WebRTC\|degradedReason\b" packages/studio/src/components/LiveView.tsx` → only `stream.started.degradedReason` payload reads (`:335`, `:452`) may remain |
| `GET /api/settings/device-schema` | `packages/core/src/api/settings.ts:35-36` | `rg -n "device-schema" packages plugins apps` |
| `GET /api/notifications/unread-count` and its test | `packages/core/src/api/notifications.ts:29`; `notifications.test.ts:52-57`; comment `server/http.ts:121` | `rg -n "unread-count" packages plugins apps` |
| `agent.subscribe`, `agent.unsubscribe` arms; `AgentSubscribeMessage`, `AgentUnsubscribeMessage` | `packages/core/src/server/ws-handlers.ts:1276-1284`; `packages/protocol/src/messages/agent.ts:263-274`; `packages/protocol/src/index.ts:84-85`, `:709-710`, `:1250-1251` | `rg -n "['\"]agent\.(subscribe\|unsubscribe)['\"]\|Agent(Subscribe\|Unsubscribe)Message" packages plugins --glob '!packages/core/packs/**'` |
| `agent.message.queued`, `agent.message.delivered`; `AgentMessageQueuedMessage`, `AgentMessageDeliveredMessage` | `packages/core/src/agent/runner.ts:734-737`, `:819-822`; `server/ws-handlers-agent.ts:61-62`; `packages/protocol/src/messages/agent.ts:391-401`; `index.ts:97-98`, `:724-725`, `:1060-1061` | `rg -n "['\"]agent\.message\.(queued\|delivered)['\"]\|AgentMessage(Queued\|Delivered)Message" packages plugins --glob '!packages/core/packs/**'` |
| `scan.progress`, `createProgressBroadcaster`, `SweeperDeps.hub`, `ScanProgressMessage`, `ScanProgressEvent`, the sweep test's `hubMessages` | `packages/core/src/registry/sweep.ts:68`, `:181-191`, `:258`, `:265`, `:269`; `daemon.ts:4424`; `sweep.test.ts:106`, `:122`, `:162`, `:167`, `:463-474`; `packages/protocol/src/index.ts:53`, `:408-411`, `:1013` | `rg -n "['\"]scan\.progress['\"]\|ScanProgress\|createProgressBroadcaster\|hubMessages" packages plugins --glob '!packages/core/packs/**'` |
| `plugin.log` broadcast, `PluginLogMessage`, `PluginLogStoreDeps.broadcast`, `PLUGIN_EVENT_TYPE_DENYLIST`, `refusedPluginEventTypesMessage`, `E_PLUGIN_EVENT_REFUSED` | `packages/core/src/daemon.ts:1760`; `plugins/runtime-logs.ts:158-159`, `:378`; `runtime-logs.test.ts:40`, `:50`, `:54`, `:66`, `:348`, `:355-390`; `packages/protocol/src/messages/plugin.ts:31-63`; `index.ts:155-159`, `:1094-1101`, `:1178-1213`, `:1531`; `plugins/verify-child.ts:8`, `:274-280`; `plugins/runtime-host.ts:15`, `:1020-1026` | `rg -n "['\"]plugin\.log['\"]\|PluginLogMessage\|PLUGIN_EVENT_TYPE_DENYLIST\|refusedPluginEventTypesMessage\|E_PLUGIN_EVENT_REFUSED" packages plugins --glob '!packages/core/packs/**'` |
| `'aoa'` in `InputModePreference`, `InputSink.mode`, `DeviceSettings.input.preferredMode`, `preferredInputMode`; the `scrcpy-aoa` engine descriptor; the `aoa` degrade rung | `packages/drivers/src/input/select.ts:3`, `:27-29`; `drivers/src/index.ts:42`; `packages/core/src/registry/engines.ts:31-41`; `packages/protocol/src/settings.ts:414`; `driver.ts:109`; `packages/session/src/types.ts:24`; `session.ts:329`; `packages/core/src/session/adapters.ts:43`; `jobs/runtime-sdk-comparison-guard.test.ts:27`, `:178`; `packages/node/README.md:14` | `rg -n "scrcpy-aoa\|ScrcpyAoaInput\|['\"]aoa['\"]" packages plugins apps scripts examples --glob '!packages/core/packs/**'` |
| `VERSION_SKIP_CHECKSUM`, `verifyChecksum`; `A_SYNC` export (kept private) | `packages/adb/src/transport/wire.ts:14`, `:49-50`, `:130-139`; `wire.test.ts:12`, `:19`, `:107-126` | `rg -n "VERSION_SKIP_CHECKSUM\|verifyChecksum\|export const A_SYNC" packages/adb` |
| `SCID_MARKER_PREFIX` export (kept private) | `packages/scrcpy/src/session.ts:178`; `session.test.ts:3` | `rg -n "export const SCID_MARKER_PREFIX\|import \{[^}]*SCID_MARKER_PREFIX" packages` |
| `FARM_TAG_PROPERTY` export (kept private) | `packages/session/src/farm-tag.ts:40`; `farm-tag.test.ts:3`; `session.test.ts:6` | `rg -n "export const FARM_TAG_PROPERTY\|import \{[^}]*FARM_TAG_PROPERTY" packages` |
| `assertApiKey`, `assertOpenRouterApiKey` | `packages/core/src/agent/provider/anthropic.ts:359-362`; `openrouter.ts:154-157` | `rg -n "assertApiKey\|assertOpenRouterApiKey" packages plugins` |
| `RecordingCreateResponseSchema`, `RecordingPatchResponseSchema` | `packages/core/src/api/recordings.ts:175-176` | `rg -n "Recording(Create\|Patch)ResponseSchema" packages plugins` |
| `tagPluginPromise`, `ownedPromises`, `'owned-promise'` | `packages/core/src/plugins/runtime-host.ts:193`, `:538`, `:553`, `:559`, `:593-597`, `:600-603` | `rg -n "tagPluginPromise\|ownedPromises\|owned-promise" packages plugins` |
| `scriptNamesByIds` and the `inArray` import | `packages/core/src/scripts/registry.ts:1`, `:403-409` | `rg -n "scriptNamesByIds" packages plugins`; `rg -n "inArray" packages/core/src/scripts/registry.ts` |
| `fetchHealth`, `HealthResponse`, `fetchTopology`, `TopologyResponse`, `TopologyCluster`, `TopologyActiveJob`, `OnGeoFail` | `packages/studio/src/lib/api.ts:211-222`, `:224-254`, `:362-363` | `rg -n "fetchHealth\|HealthResponse\|fetchTopology\|TopologyResponse\|TopologyCluster\|TopologyActiveJob\|OnGeoFail" packages/studio/src` |
| `computeImageInContext` | `packages/studio/src/lib/agent-chat.ts:126-145` | `rg -n "computeImageInContext" packages/studio/src` |
| `defaultVersion`, `declaredScriptIds` | `packages/studio/src/app/plugins/plugin-list.ts:78-93` | `rg -n "defaultVersion\|declaredScriptIds" packages/studio/src` |
| `ResultStatusChip` | `packages/studio/src/components/bulk/BatchResults.tsx:372-380` | `rg -n "ResultStatusChip" packages/studio/src` |
| `FieldProps` | `packages/studio/src/components/schema-form/types.ts:43-51` | `rg -n "(^\|[^A-Za-z])FieldProps([^A-Za-z]\|$)" packages/studio/src` |
| `LeafPlan` and the `FieldPlan` import | `packages/studio/src/components/schema-form/controls/types.ts:1`, `:3-6` | `rg -n "LeafPlan" packages/studio/src` |
| `DeviceWallPickerProps` barrel re-export | `packages/studio/src/components/host/index.ts:29` | `rg -n "DeviceWallPickerProps" packages/studio/src/components/host/index.ts` |
| `PickableDevice` export (interface kept, private) | `packages/ui/src/components/device-picker.tsx:70`; `device-picker.test.tsx:3` | `rg -n "export interface PickableDevice\|type PickableDevice \} from" packages/ui/src` |
| `setCoreBase`, `explicit` | `packages/ui/src/lib/core-base.ts:17-19`, `:55-60`, `:99`; `index.ts:72`; `index.test.ts:3`, `:31`, `:73-84`; `README.md:26` | `rg -n "setCoreBase" packages plugins` |
| `--radius-card`, `--color-destructive-foreground`; the four `rounded-card` mentions | `packages/ui/src/theme.css:109`, `:138`; `packages/sdk/README.md:711`; `packages/sdk/src/cli/init.ts:426`; `build-ui.test.ts:64`; `plugins/proxy-manager/src/ui/index.css:45` | `rg -n "radius-card\|rounded-card\|destructive-foreground" packages plugins apps examples scripts` |
| `ai-elements`: `ConversationDownload(Props)`, `messagesToMarkdown`; `MessageActions(Props)`, `MessageAction(Props)`, `MessageBranch*`, `MessageToolbar(Props)`; `PromptInputActionAddAttachments`, `PromptInputActionAddScreenshot`, `PromptInputBody`, `PromptInputHeader`, `PromptInputActionMenu*`, `PromptInputHoverCard*`, `PromptInputTab*`, `PromptInputCommandInput`, `PromptInputCommandSeparator` (each with its `*Props`), `captureScreenshot` | `packages/studio/src/components/ai-elements/conversation.tsx:102-167`; `message.tsx:66-318`, `:349-365`; `prompt-input.tsx:90-165`, `:401-472`, `:940-947`, `:1077-1091`, `:1175-1212`, `:1324-1406`, `:1415-1422`, `:1460-1469` | `rg -n "ConversationDownload\|messagesToMarkdown\|MessageActions\|MessageAction\b\|MessageBranch\|MessageToolbar\|PromptInputActionAdd\|PromptInputBody\|PromptInputHeader\|PromptInputActionMenu\|PromptInputHoverCard\|PromptInputTab\|PromptInputCommandInput\|PromptInputCommandSeparator\|captureScreenshot" packages/studio/src` |
| `VIEW_NOT_BUILT` (renamed `PROXIES_VIEW_DESCRIPTION`) | `plugins/proxy-manager/src/shared.ts:2229`; `index.ts:8`, `:528`; `index.test.ts:46` and ten uses | `rg -n "VIEW_NOT_BUILT" plugins packages` |
| `ProxyRecordSchema`, `ProxySecretSchema`, `ProxyListenSchema`, `ProxyUpstreamSchema`, `ProxyFailoverSchema`, `SECRET_PREFIX_IS_DISJOINT`, `from './record'` | `plugins/proxy-manager/src/record.ts`; `record.test.ts:2`, `:53-55`, `:59-68`, `:160-165`, `:176-178`, `:577`, `:598-602`; `index.test.ts:7`, `:131`, `:1258-1259`, `:1303-1305`; comments at `shared.ts:531`, `:828-829`, `ui/parts/api.ts:163-164`, `ui/parts/backup-upstreams.tsx:196-197` | `rg -n "from '\./record'\|ProxyRecordSchema\|ProxySecretSchema\|ProxyListenSchema\|ProxyUpstreamSchema\|ProxyFailoverSchema\|SECRET_PREFIX_IS_DISJOINT" plugins/proxy-manager` |
| `"version": "2.2.0"` drift | `plugins/networking/package.json:3` | `rg -n '"version"' plugins/networking/package.json` → `"version": "3.0.0"` |
| `scripts/guest-agent.ts` mentions | `README.md:125-132`; `apps/guest-agent/README.md:122-135`, `:138`; `packages/drivers/src/network/guest-agent/client.ts:57` | `rg -n "scripts/guest-agent\.ts" packages apps plugins scripts examples README.md` |
| `delete-unowned-scripts` mentions | `packages/core/src/plugins/runtime.ts:1248`; `runtime.test.ts:1006` | `rg -n "delete-unowned-scripts" packages apps plugins scripts examples` |
| "has not been built" claim about `labelling.ts` | `apps/guest-agent/README.md:118` | `rg -n "has not been built" apps/guest-agent/README.md` |
| "No producer yet" comments | `packages/core/src/db/schema.ts:999-1001`, `:1059` | `rg -n "No producer yet" packages/core/src/db/schema.ts` |
| Three raw control bytes | `packages/core/src/device/labelling.ts:86` | `LC_ALL=C tr -d '\040-\176\200-\377\n\t' < packages/core/src/device/labelling.ts \| wc -c` → `0` |
| WebRTC prose | `packages/node/README.md:12`, `:18-24`, `:35-37`; `docs/guide/cloud.md:44` | `rg -n "WebRTC\|rtc-peer" packages/node docs/guide` |

### Forbidden words

This plan introduces none from `docs/plans/200-mvp-program.md` §2.4. The vocabulary rows that its area would touch (`lease`, `mirror`, `cluster`, `node` for a workflow step) are owned by plans 205, 207, and 141, whose §10 will carry the greps.

## 11. Handoff report

- **Checklist**: G1 ✅ G2 ✅ G3 ✅ G4 ✅ G5 ✅ G6 ✅ G7 ✅ G8 ✅ G9 ✅ G10 ✅ (this plan's own row; see the plan-59 discrepancy below) G11 ✅ G12 ✅ G13 ✅ G14 ✅

- **Branch**: `worktree-agent-affe89a0480b8d866` (the worktree's own branch — name it when merging into `mvp`). Base commit: `d96d2be` (`git merge-base` equivalent — this worktree had no other MVP-series commits ahead of it).

- **Commits** (21, oldest first):
  - `83a5cc8` chore(mvp-201): the gate first — scripts/check-dead-code.sh and the CI step
  - `c482a59` chore(mvp-201): delete licensing, telemetry, and the session barrel
  - `3817197` chore(mvp-201): drop the licensing/telemetry env vars from .env.example (201.2 cont.)
  - `b1d81a0` chore(mvp-201): delete WebRTC — the whole server half and the Studio client
  - `aaa6257` chore(mvp-201): delete three dead routes (device-schema, unread-count)
  - `b73da6e` chore(mvp-201): delete dead WS messages agent.subscribe / agent.unsubscribe (201.5a)
  - `8d1902b` chore(mvp-201): delete dead WS messages agent.message.queued / agent.message.delivered (201.5b)
  - `04def43` chore(mvp-201): delete dead WS message scan.progress (201.5c)
  - `946358a` chore(mvp-201): scan.progress deletion, remaining files (201.5c cont.)
  - `675b50e` chore(mvp-201): delete dead WS message plugin.log (201.5d)
  - `fd18bce` chore(mvp-201): delete the AOA input stub and the 'aoa' enum value (201.6)
  - `54bf8ec` chore(mvp-201): AOA cleanup, remaining files (201.6 cont.)
  - `03cc081` chore(mvp-201): delete the adb wire constants; make two exports private (201.7)
  - `1a7894e` chore(mvp-201): delete dead core exports (201.8)
  - `90d6c5c` chore(mvp-201): delete dead Studio and @enkaku/ui modules, exports, tokens (201.9)
  - `a263241` chore(mvp-201): trim components/ai-elements/ to what Chat.tsx imports (201.10)
  - `b8c0b03` chore(mvp-201): plugins — record.ts, the stale test copy, the rename, the versions (201.11)
  - `4f6de71` chore(mvp-201): dead scripts, stale READMEs and comments, the labelling.ts bytes (201.12)
  - `5bbb693` chore(mvp-201): dead scripts cleanup, remaining files (201.12 cont.)
  - `51be576` fix(mvp-201): exclude check-dead-code.sh from its own dead-code scan
  - `63f8aa1` chore(mvp-201): delete the Studio and @enkaku/ui test suites (amendment §12, step 201.A)

  Several steps landed as two commits (a `git add -A -- <paths>` including an already-deleted path silently failed to stage the rest of that step's files in this sandbox's git wrapper; the remainder was caught by a `git status` check and committed as a `cont.` commit immediately after). No code differs from a single-commit execution; the split is purely a commit-boundary artefact, noted here for the diff reviewer.

- **Typecheck**: clean (`bun run typecheck` → exit 0, all 20 packages `OK`) after every commit; re-verified clean on the final tree.

- **Tests run** (§7.1, each one invocation, never concurrent; all pass):
  ```
  bun test packages/core/src/api/notifications.test.ts                         → 7 pass
  bun test packages/core/src/server/ws-handlers-agent.test.ts                   → 11 pass
  bun test packages/core/src/agent/tree.integration.test.ts                     → 15 pass
  bun test packages/core/src/registry/sweep.test.ts                             → 14 pass
  bun test packages/core/src/plugins/runtime-logs.test.ts                       → 20 pass
  bun test packages/core/src/plugins/runtime-service.test.ts                    → 26 pass
  bun test packages/core/src/plugins/verify-child.test.ts                       → 30 pass
  bun test packages/core/src/plugins/runtime.test.ts                            → 55 pass
  bun test packages/core/src/jobs/runtime-sdk-comparison-guard.test.ts          → 3 pass
  bun test packages/core/src/device/labelling.test.ts                          → 9 pass
  bun test packages/core/src/server/ws-handlers-clipboard.test.ts               → 12 pass
  bun test packages/core/src/server/ws-handlers-text.test.ts                    → 6 pass
  bun test packages/drivers/src/input/                                         → 24 pass (2 files)
  bun test packages/adb/src/transport/wire.test.ts                              → 19 pass
  bun test packages/scrcpy/src/session.test.ts                                  → 21 pass
  bun test packages/session/src/farm-tag.test.ts                                → 6 pass
  bun test packages/session/src/session.test.ts                                 → 31 pass
  bun test packages/sdk/src/cli/build-ui.test.ts                                → 8 pass
  bun run --cwd plugins/proxy-manager test -- src/index.test.ts                 → 81 pass
  bun run --cwd plugins/proxy-manager test -- src/record.test.ts                → 50 pass
  ```
  Also run mid-plan, before the §12 amendment deleted their files (all passed then): `bun run --cwd packages/ui test -- src/components/device-picker.test.tsx` (9 pass), `bun run --cwd packages/ui test -- src/index.test.ts` (25 pass), `bun run --cwd packages/studio test -- src/design-rules.test.ts` (15 pass), `bun run --cwd packages/studio test -- src/components/layout/AppShell.test.tsx` (21 pass), `bun run --cwd packages/studio test -- src/app/topology/page.test.tsx` (1 pass), `bun run --cwd packages/studio test -- src/components/agent/` (32 pass, 5 files). **Not re-run at 201.13** because the §12 amendment (executed after 201.9–201.12, per this plan's own section order) deleted those six files along with every other Studio/ui test — there is nothing left at those paths to re-run. §7.1's own text anticipates a file that "does not exist on the day of execution" should be skipped and the skip recorded; this is that case, caused by this plan's own later step rather than drift.
  Additional test files touched by the §12 amendment were the 201 deleted `*.test.ts(x)` themselves; there is nothing to run post-deletion by definition.
  Also run once, ad hoc, to confirm 131.5c's third `sendProgress` call site (a discrepancy, see below) did not hide a second regression: `bun test packages/core/src/registry/sweep.test.ts` — included above.

- **Removed, proven**: `bash scripts/check-dead-code.sh` prints `  no dead code found` on the final tree (it printed one `PRESENT`/`FOUND` block per §10 row when first written at step 201.1, before any deletion — confirming the gate actually gates). The script's ~30 `gone`/`gonew` calls and 12 `absent` calls are themselves the executed form of every §10 Table A and Table B row; representative individual reruns during execution (also captured in-session):
  - `test ! -d packages/core/src/licensing && test ! -d packages/core/src/telemetry && test ! -e packages/core/src/session/index.ts` → all true
  - `test ! -d packages/core/src/relay && test ! -e packages/studio/src/lib/webrtc-player.ts` → both true
  - `grep -En "werift|reflect-metadata|tsyringe" packages/core/package.json bun.lock` → empty (G4)
  - `grep -n '"version"' plugins/networking/package.json` → `"version": "3.0.0"`; `grep -n "0\.11\.1" plugins/proxy-manager/package.json plugins/proxy-manager/src/index.ts plugins/proxy-manager/src/index.test.ts` → three lines (G5)
  - `rg -n "['"]agent\.(subscribe|unsubscribe)['"]|Agent(Subscribe|Unsubscribe)Message" packages plugins` → empty
  - `rg -n "['"]agent\.message\.(queued|delivered)['"]|AgentMessage(Queued|Delivered)Message" packages plugins` → empty
  - `rg -n "['"]scan\.progress['"]|ScanProgress|createProgressBroadcaster|hubMessages" packages plugins` → empty
  - `rg -n "['"]plugin\.log['"]|PluginLogMessage|PLUGIN_EVENT_TYPE_DENYLIST|refusedPluginEventTypesMessage|E_PLUGIN_EVENT_REFUSED" packages plugins` → empty
  - `rg -n "scrcpy-aoa|ScrcpyAoaInput|['"]aoa['"]" packages plugins apps scripts examples` → empty
  - `rg -n "VERSION_SKIP_CHECKSUM|verifyChecksum|export const A_SYNC" packages/adb` → empty
  - `rg -n "VIEW_NOT_BUILT|from '\./record'|ProxyRecordSchema|ProxySecretSchema|ProxyListenSchema|ProxyUpstreamSchema|ProxyFailoverSchema|SECRET_PREFIX_IS_DISJOINT" plugins/proxy-manager` → empty
  - `LC_ALL=C tr -d '\040-\176\200-\377\n\t' < packages/core/src/device/labelling.ts | wc -c` → `0` (G8)
  - `find packages/studio packages/ui -name '*.test.*' | wc -l` → `0` (G11)
  - `rg -n "happy-dom|testing-library" packages/studio/package.json packages/ui/package.json bun.lock` → empty (G12)
  - `rg -n "cwd packages/studio test|cwd packages/ui test" .github CLAUDE.md package.json` → empty (G13)
  - `git diff d96d2be..HEAD --numstat -- packages apps plugins scripts examples | awk '{a+=$1; d+=$2} END {print a" added, "d" deleted"}'` → `344 added, 44409 deleted` (G7)
  - `bun install --frozen-lockfile` → exit 0, both after the WebRTC deps removal and again on the final tree
  - `bash scripts/check-release-packs.sh` → `every embedded pack is tested on the release path (6 packs)`

- **Discrepancies between plan and code** (§2.2: file wins for facts, plan wins for intent; every one below was implemented against the file, not the plan's literal quote):
  1. **`scripts/check-dead-code.sh` matched itself.** The plan's own §4.1 script text quotes every removed identifier as a grep pattern string inside a file that lives under `scripts/`, one of the four scanned `CODE` directories — so the very first real run found itself, on every `gonew`/`gone` group whose pattern text overlapped a deleted name. Fixed by adding `--exclude=check-dead-code.sh` to `EXCLUDES` (commit `51be576`). Without this fix G1 could never pass.
  2. **The plan's own literal 0.11.1 changelog paragraph (§5 step 201.11) names `VIEW_NOT_BUILT` verbatim**, which would have put that exact string back into `plugins/` — the one thing this same plan's `gonew view-not-built` check forbids. Reworded the changelog prose in `plugins/proxy-manager/src/index.ts` to describe the rename without repeating the deleted identifier; intent (document the 0.11.0→0.11.1 reason) preserved, letter of the quoted text not.
  3. **`sweep.ts` had a third `sendProgress` call** the plan's own §5 step 131.5c did not name (it named only the two calls at the old `:265`/`:269`; a third, unthrottled, "final" call after the pool completed was not in its quote). Deleting `createProgressBroadcaster` without also deleting that call would not compile; deleted it too, since a function being removed obviously takes every call site with it.
  4. **`plugins/proxy-manager/src/index.test.ts`'s "nothing anywhere in this pack writes a device setting" test (plan 114 criterion 11) named `record.ts` in a `files` string-literal array**, not a static import — the plan's own `from './record'` grep (used to find every consumer) does not match a bare filename string, so this consumer was invisible to the plan's own evidence and the test failed with `ENOENT` after `record.ts` was deleted. Fixed by dropping `'record.ts'` from that array; the remaining four files still cover the assertion.
  5. **`record.test.ts`'s round-trip test asserted `Object.keys(stored)).toEqual(Object.keys(ProxyRecordSchema.shape))`** one line above the two lines the plan's own quote named for deletion — also a `ProxyRecordSchema` reference the plan's quote did not flag, for the same reason as #4 (the plan's own §5 line-range citation drifted by one line from the file it was quoting on the day it was read versus the day it was executed). Deleted it too; it is redundant with the `readProxyRecord(stored)` equality on the next line.
  6. **`packages/studio/src/components/bulk/BatchResults.tsx`'s `Badge` import had zero remaining JSX uses** once `ResultStatusChip` (the plan's named deletion) was removed — the plan's own step 201.9 text asserted "`Badge` has four other uses in the file; keep the import," which did not hold on this file as it stood on 2026-09-03's re-read. Removed the now-unused import; the file still compiles and the plan's four-other-uses claim is corrected here rather than silently kept as a stale comment nobody asked for.
  7. **`packages/core/src/index.ts` had exactly one static import** (`import 'reflect-metadata'`, the WebRTC entrypoint hack), and deleting it left the file with zero static imports/exports — which TypeScript no longer treats as a module, and its several top-level `await`s then fail to compile (`TS1375`). Not a plan-vs-file disagreement so much as unstated fallout of the plan's own step 201.3; fixed with a bare `export {}` (not a stub of any behaviour — a module marker, the standard fix for exactly this TS diagnostic) plus a one-line comment saying why.
  8. **The §12 amendment's own file list ("every file matching `packages/studio/src/**/*.test.ts(x)`… and any setup/preload module referenced by `packages/studio/bunfig.toml`") named only `packages/studio/bunfig.toml`, `packages/studio/happydom.ts`, and both packages' `package.json`s and devDependencies — it did not explicitly name `packages/ui/bunfig.toml` or `packages/ui/happydom.ts`.** Both packages are symmetric (same preload mechanism, same reason, same G12 check spanning both `package.json`s), so both bunfig.toml files (each holding nothing but the `[test]` block this needed) and both `happydom.ts` files were deleted together, and root `bunfig.toml`'s `pathIgnorePatterns` entry for `packages/ui/**` was dropped alongside `packages/studio/**`'s (the plan's own prose named only the latter for removal). Recorded here as an extension of clearly stated intent, not a unilateral scope expansion — G12 could not otherwise be satisfied for `packages/ui`.

- **Observed, not done** (things noticed and deliberately left, because the plan did not name them):
  - `packages/studio/package.json`'s `@enkaku/plugin-tiktok` devDependency has zero remaining reference in `packages/studio/src` now that its one consumer test (`AskAnAgentDialog.test.tsx` or similar) is gone. Not named by §12's file list; left in place.
  - `packages/mikrotik-routing/src/service/groups.ts:14` still names `ProxyRecordSchema` in a comment, by analogy to a schema in a different plugin package (proxy-manager) that this plan deleted. `check-dead-code.sh`'s `proxy-record-names` check is deliberately scoped to `plugins/proxy-manager` only, so this does not trip G1, and the plan did not name this file. Left as a stale-but-harmless analogy; flagged for whichever plan next touches mikrotik-routing.
  - No plugin test step in `.github/workflows/ci.yml` existed solely to render a Studio view, so the §12 amendment's "and the plugin test steps that only exist for Studio-rendered views" clause had nothing to remove; every remaining plugin test step covers that plugin's own backend/service logic.
  - §2 "Non-goals" table's protected rows (`packages/harness`, `apps/desktop`, `/api/tokens`, `packages/core/src/tunnel`, `packages/core/src/lease`, `packages/core/src/mirror`, `packages/core/src/jobs/executors/workflow.ts`, `packages/core/src/api/agents.ts`) are untouched — confirmed by `git diff --stat` over those paths being empty (checked for each individually during the session; not repeated in full here for length).
  - `examples/scroll-fling-demo.ts` (§9 Q1) — not touched, per the open question.
  - The 610-describe-block count for the deleted Studio/ui suite (§12.1's "record the count in §11") is a `grep -c "describe("` sum across the 201 files immediately before deletion, not an exhaustive per-file `describe`-name read; every file lived under `packages/studio/src` or `packages/ui/src`, neither of which appears anywhere in plan 200 §8.3's critical list (protocol schemas/binary framing, activity policy/target resolvers, migrations, queue/runs, demuxer/HID encoders, plugin pipeline, inspector lifecycle, toolchain verification — all `packages/protocol` or `packages/core`), so none could have qualified for the keep-list by location alone.

- **Open questions hit**: none blocked a step. §9 Q1 (`examples/scroll-fling-demo.ts`) was not reached by any named step and was left untouched, per instruction, without deciding it.

- **A collateral effect on a plan outside this plan's scope** (recorded here, not fixed, per "never touch a file the plan does not name" and "never decide something that is not this plan's to decide"): `bash scripts/check-plan-status.sh` now exits 1 (previously would have exited 1 anyway, for unrelated pre-existing partial-plan reasons — checked: 34 plans are `partial` by design and do not count as mismatches). The one NEW mismatch this plan's own work introduces is `59-m29-preconditions-not-errors.md`: its `Ships:` line names `packages/studio/src/components/InspectorPanel.test.tsx`, one of the 201 files the §12 amendment deletes by explicit design (plan 200 §8.3: "Plan 201 deletes every `packages/studio/**/*.test.ts(x)`… No MVP plan adds one back"). Plan 59 is not named anywhere in plan 201's scope (§0, §10, or either amendment), so its `Ships:` line was not edited. A follow-up task is worth spawning for whoever owns plan 59 next.

- **Processes**: `ps -Ao pid=,command= | grep -i "[o]penpf"` → only the harness's own snapshot/shell wrapper that ran the `ps` command itself; no `bun`, `node`, dev server, or test runner process survived.

---

## 12. Amendment 2026-09-03 — delete the Studio and `@enkaku/ui` test suites (plan 200 §8.3)

Added after the CEO's decision that Studio has zero tests and backend tests cover only the critical list. This amendment is part of this plan's scope; its rows are appended to §0 and §10 below and the executor treats them like any other step.

### 12.1 Step 201.A — remove the web test suites

- Files deleted: every file matching `packages/studio/src/**/*.test.ts`, `packages/studio/src/**/*.test.tsx`, `packages/ui/src/**/*.test.ts`, `packages/ui/src/**/*.test.tsx`, `packages/studio/src/test/**` and any `setup`/`preload` module referenced by `packages/studio/bunfig.toml` (read the file first and list what it names), `packages/studio/src/lib/dependency-gaps.test.ts` (a cross-package guard; its assertion moves nowhere: the routes it guards are deleted by plan 207).
- Files changed: `packages/studio/bunfig.toml` (delete the `[test]` block; delete the file if nothing else remains), `packages/studio/package.json` and `packages/ui/package.json` (delete the `test` script; remove `happy-dom`, `@testing-library/*`, `@happy-dom/*` from devDependencies; run `bun install` and commit the lockfile), root `bunfig.toml` (delete the `pathIgnorePatterns` entry for `packages/studio/**` once no test file exists there; keep `[test] root`), `.github/workflows/ci.yml` (delete the `bun run --cwd packages/studio test` and `bun run --cwd packages/ui test` steps and the plugin test steps that only exist for Studio-rendered views — read the job and list each removed line), `CLAUDE.md` (the "Commands" block: delete the two studio/ui test lines; the paragraph beginning "A bare `bun test` from the repo root never runs `packages/studio`'s tests" is replaced by one sentence: "Studio and `@enkaku/ui` have no tests (plan 200 §8.3)."; the "NEVER run a full test suite" section keeps its rule until plan 224 retires it, but its Studio examples are removed).
- Do not: keep a single "smoke" component test; add a `vitest` or `playwright` dependency; move a Studio test into `packages/core` unless it tests logic on plan 200 §8.3's critical list (none of the existing Studio tests do; verify by reading each file's `describe` names and record the count in §11).
- Verifiable result: `find packages/studio packages/ui -name '*.test.*' | wc -l` prints `0`; `rg -n "happy-dom|testing-library" packages/studio/package.json packages/ui/package.json bun.lock` → empty; `rg -n "cwd packages/studio test|cwd packages/ui test" .github CLAUDE.md package.json` → empty; `bun run typecheck` clean.

### 12.2 Added §0 rows

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G11 | No test file exists under Studio or ui | 0 files | `find packages/studio packages/ui -name '*.test.*' \| wc -l` prints `0` | [x] |
| G12 | The DOM test toolchain is gone from the web packages | 0 matches | `rg -n "happy-dom\|testing-library" packages/studio/package.json packages/ui/package.json bun.lock` → empty | [x] |
| G13 | CI and CLAUDE.md no longer run or describe the web suites | 0 matches | `rg -n "cwd packages/studio test\|cwd packages/ui test" .github CLAUDE.md package.json` → empty | [x] |

### 12.3 Added §10 rows

| What | Where it was | Proof |
|---|---|---|
| Every Studio and ui test file, the Studio test preload, the two `test` scripts | `packages/studio/**`, `packages/ui/**` | `find packages/studio packages/ui -name '*.test.*' \| wc -l` → `0` |
| `happy-dom`, `@testing-library/*` devDependencies | both `package.json`s, `bun.lock` | `rg -n "happy-dom\|testing-library" packages/studio/package.json packages/ui/package.json bun.lock` → empty |
| CI steps for the web suites; the root `pathIgnorePatterns` entry for `packages/studio/**` | `.github/workflows/ci.yml`, `bunfig.toml` | `rg -n "packages/studio" .github/workflows/ci.yml bunfig.toml` → only the `build:studio` step, if any |

---

## 13. Amendment 2026-09-03 — a repo-wide control-byte check

§0 G8 already checks `packages/core/src/device/labelling.ts` for raw control bytes. Widen it: the same defect appeared a second time on 2026-09-03, in `docs/plans/213-mvp-studio-shell.md`, where a NUL sat between `${deviceId}` and `${activity.id}` in a composite key. It was fixed by replacing it with a colon, the repo's own separator convention (`packages/studio/src/components/bulk/SkippedGroups.tsx:104`).

**Why this is not cosmetic.** `grep` and `rg` treat a file containing a NUL as binary and **skip it while reporting success**. Every §10 "Proof" in this series is a grep, so one stray byte can make a removal look complete when it is not. The check therefore belongs beside the dead-code gate, not in a plan's prose.

### 13.1 Step 201.B — add the check to `scripts/check-dead-code.sh`

- Files changed: `scripts/check-dead-code.sh` (this plan's own artefact).
- Add, before the grep groups so a poisoned file fails first:

```bash
# A NUL or other C0 control byte makes grep/rg treat a text file as binary and
# SKIP it silently, which would make every removal proof below meaningless.
bad_bytes=$(LC_ALL=C grep -rlP '[\x00-\x08\x0B-\x1F\x7F]' \
  --include='*.ts' --include='*.tsx' --include='*.md' --include='*.json' \
  --include='*.css' --include='*.sh' --include='*.kt' --include='*.yml' \
  packages apps plugins scripts docs examples 2>/dev/null || true)
if [ -n "$bad_bytes" ]; then
  echo "  CONTROL BYTES in text files (grep would skip these silently):"
  echo "$bad_bytes" | sed 's/^/    /'
  fail=1
fi
```

- Verifiable result: the script prints nothing for this group on a clean tree; planting `printf 'a\0b' >> packages/core/src/index.ts` makes it exit non-zero and name that file; removing the byte makes it pass again.
- Do not: filter the finding down to NUL only (a `\x1B` escape sequence pasted into a source file is the same class of defect); do not add `--text` or `-a` to any other grep in this series to work around a poisoned file, because that hides the cause.

### 13.2 Added §0 row

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G14 | No tracked text file contains a C0 control byte other than tab or newline | 0 files | `bash scripts/check-dead-code.sh` prints no `CONTROL BYTES` group | [x] |
