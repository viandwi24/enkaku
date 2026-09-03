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
  # This script's own source quotes every removed name as a grep pattern
  # string, which would otherwise match itself on every run.
  --exclude=check-dead-code.sh
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
# `radius-card`/`rounded-card` were dead when plan 201 ran and are ALIVE after
# plan 204: the design handoff defines a 14px card radius, so `--radius-card`
# has a real definition in `packages/ui/src/theme.css` and the sdk scaffold and
# README use `rounded-card` again. Narrowed at the 201-into-204 merge
# (plan 200 §8.5). `destructive-foreground` is still dead.
gone  tokens        "destructive-foreground" "${CODE[@]}"
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

# labelling.ts carried three raw control bytes (0x00, 0x1f, 0x7f) inside a
# regex character class, which made `grep` skip the file as binary (docs/mvp/13 B.2).
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
