/**
 * There is no `defineScript` (plan 110 §3.1, §4.2, criterion 6). A script
 * cannot exist outside a plugin, so the only authoring entry point is
 * `definePlugin` below and the only script shape an author writes is a
 * `PluginMemberScript`. `ScriptDefinition` is still exported as a TYPE — it is
 * what a member BECOMES once `definePlugin` stamps the plugin's version onto
 * it, and it is what the runner receives.
 *
 * `enkaku init <name>` scaffolds the whole thing; `enkaku publish` refuses an
 * entry whose default export is not a `definePlugin()` result.
 */
export type {
  ScriptDefinition,
  ResultValue,
  ScriptContext,
  ScriptError,
  ScriptLogger,
  DeviceApi,
  ArtifactApi,
  WaitForOptions,
  GestureEasing,
  ScriptTypeResult,
  KvApi,
  KvListItem,
  KvListResult,
  KvSetOptions,
  JobsApi,
  JobsListResult,
  TriggerInput,
  TriggerResult,
} from './types'
export { definePlugin, isPlugin } from './plugin'
export type { PluginDefinition, PluginMemberScript, Plugin } from './plugin'
/**
 * Plan 109 (M74 — the plugin runtime), steps 109.1–109.2. One context, many
 * entry points: `PluginContext` is what a script handler AND a core-side
 * handler both receive, so a plugin's own helper works from either unchanged.
 * `ScriptContext` extends it, so that is checked by the compiler rather than
 * held by convention.
 *
 * `defineService` (step 109.2, renamed from 109.1's `defineRuntime` — plan 109
 * §9 Q7, settled by the owner) declares the plugin's long-lived half. It is
 * `service` and not `runtime` because a plugin MEMBER's `runtime` is already
 * plan 98's `RuntimeEnvelope`, and two keys one level apart sharing a word
 * while meaning unrelated things is a permanent trap in a published type.
 */
export { defineService, isService, isFarmEventOfType } from './runtime'
export type {
  PluginContext,
  PluginServiceContext,
  PluginStorage,
  PluginKv,
  FarmApi,
  PluginService,
  PluginServiceInput,
  PluginServiceDeclaration,
  ServiceSetup,
  /** Reset data — the cleanup hook an operator's Reset runs before the delete. */
  ServiceResetData,
  FarmEvent,
  FarmEventType,
  // Step 109.6 — the three handler families a service registers.
  PluginRequest,
  PluginResponse,
  PluginRequestHandler,
  PluginSocket,
  PluginSocketHandlers,
  PluginSocketHandler,
  PluginQueryRequest,
  PluginQueryHandler,
  // Step 109.7 — the inbound webhook family, and `ctx.webhooks`.
  PluginWebhookRequest,
  PluginWebhookHandler,
  PluginWebhookApi,
  // Step 109.8 — a plugin reading its own service log.
  PluginLogApi,
} from './runtime'
export {
  KEYCODES,
  type Selector,
  type UiNode,
  type Point,
  type KeyCode,
  type JobStatus,
  type JobSummary,
  type RuntimeEnvelope,
} from '@enkaku/protocol'
/**
 * The parameter vocabulary's authoring helper (plan 95 §3.2, §4.1) — `ui`
 * itself, plus the hint TYPES only. Never the vocabulary's runtime constants
 * (`PARAM_KINDS`, `DURATION_UNITS`, `PARAM_SOURCES`, `ParamHintsSchema`,
 * `readHints`): a script's build-time import allowlist is `@enkaku/sdk` and
 * `zod` only (F9, `packages/core/src/scripts/build.ts`), never
 * `@enkaku/protocol` directly, so this is the one door the vocabulary is
 * reachable through. `ui()` is a typed identity function — the compile-time
 * checking happens at the author's own call site, not inside this package.
 */
export { ui } from '@enkaku/protocol'
export type { ParamKind, DurationUnit, ParamSource, ShowWhen, ParamHints, UiSpec } from '@enkaku/protocol'

// Plan 94 (M59 — the action recorder), step 94.1. `defineRecording` compiles
// a `RecordingDoc` (`@enkaku/protocol`) into an ordinary `ScriptDefinition`
// (§3.1, §4.3). Step 94.2 landed the `DeviceApi` verbs and the
// `ScriptDefinition.timing` field the interpreter needs directly on the
// canonical types (`./types.ts`) — see `define-recording.ts`'s header
// comment — so there is no more file-scoped `RecordingDevice` type to export.
export { defineRecording, type DefineRecordingDeps } from './define-recording'
