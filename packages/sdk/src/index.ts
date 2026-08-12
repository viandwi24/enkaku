export { defineScript } from './define-script'
export type {
  ScriptDefinition,
  ScriptContext,
  ScriptError,
  ScriptLogger,
  DeviceApi,
  ArtifactApi,
  WaitForOptions,
  GestureEasing,
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
export { KEYCODES, type Selector, type UiNode, type Point, type KeyCode, type JobStatus, type JobSummary } from '@enkaku/protocol'
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
