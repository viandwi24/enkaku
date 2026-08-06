import type { AnyCoreCapability } from '../../capability/types'

/**
 * `AgentPlugin` (plan 77 §3.5, §4.3) — ported from `bitorex-algo/packages/server/src/quant/
 * plugins/types.ts`'s `AgentPlugin`/`defineAgentPlugin` with ONE change: `tools` returns
 * `AnyCoreCapability[]`, not a raw AI SDK `ToolSet`. One feature = one plugin: its system-prompt
 * SECTION, its capabilities, and (as a declaration only, wired in Plan 78) its slash commands.
 *
 * Everything else holds: `prompt` is a STATIC string (never time-varying — Plan 65 §3.4's prompt
 * cache prefix depends on it, matching upstream's own D13.2), `tools` is pure assembly so the
 * boot-time dry run in `./index.ts` can safely call it with a stub context, and a duplicate
 * capability id across two plugins is a bug caught at boot, not at the first chat that happens to
 * reach the colliding tool.
 */

/**
 * Build-time context passed to a plugin's `tools` (plan 77 §3.5, §4.3). Upstream's shape carries a
 * live `vfs`/`session`/`projectId` because ITS tools are closures bound to per-session state.
 * Enkaku's capabilities are already fully self-contained consts — built once by `capability/*.ts`,
 * invoked later through `invoke()` with a fresh `CapabilityContext` per call — so there is nothing
 * live to hand a plugin here today. The parameter is kept, empty, so the SHAPE (and the boot-time
 * dry run in `./index.ts`) matches upstream exactly; a future plugin that genuinely needs
 * build-time state has somewhere to put it without a signature change across every plugin file.
 */
export type PluginBuildCtx = Record<string, never>

/** A slash command a plugin owns (plan 77 §4.3's "declaration only" — Plan 78 is what actually
 * types one into a composer). Kept minimal until Plan 78 gives it a use. */
export interface PluginCommand {
  name: string
  description: string
}

export interface AgentPlugin {
  /** Stable slug — greppable, never renamed casually (the same discipline upstream's D13.8 states). */
  id: string
  title: string
  /**
   * This feature's system-prompt section — a STATIC string (plan 77 §3.5, §4.5, criterion 9).
   * Nothing time-varying may appear in it: no timestamp, no live capability list, no per-agent
   * detail. `agent/plugins/index.ts`'s `assembleSystemPrompt` splices this, verbatim, into the
   * agent's own prompt, in registry order, only when the agent holds at least one of this
   * plugin's capabilities (criterion 12).
   */
  prompt: string
  /**
   * Build the feature's capabilities. MUST be pure assembly — no I/O, no randomness — so the
   * boot-time dry run (`./index.ts`) can call it with a stub context to detect a duplicate id
   * before a user ever chats (criterion 7, 8).
   */
  tools: (build: PluginBuildCtx) => AnyCoreCapability[]
  /** Slash commands this feature owns — merged fail-fast with every other plugin's, alongside the
   * capability-id check (plan 77 §4.3). Wired into a composer in Plan 78; inert until then. */
  commands?: PluginCommand[]
  /** Skill names this feature owns — informational only, exactly like upstream's D13.7; loading a
   * skill itself is `agent/harness/skills.ts`'s job, unrelated to this list. */
  skills?: string[]
}

/** Identity helper — gives a plugin definition a typed, greppable shape (plan 77 §3.5, matching
 * upstream's own `defineAgentPlugin`). */
export function defineAgentPlugin(plugin: AgentPlugin): AgentPlugin {
  return plugin
}
