export { defineScript } from './define-script'
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
