import type { AnyCoreCapability } from '../../capability/types'
import { automationPlugin } from './automation'
import { deviceAppsPlugin } from './device-apps'
import { deviceControlPlugin } from './device-control'
import { deviceFilesPlugin } from './device-files'
import { deviceInspectPlugin } from './device-inspect'
import { fleetPlugin } from './fleet'
import { notifyPlugin } from './notify'
import { orchestrationPlugin } from './orchestration'
import { skillsPlugin } from './skills'
import type { AgentPlugin, PluginBuildCtx, PluginCommand } from './types'
import { workspacePlugin } from './workspace'

export { defineAgentPlugin, type AgentPlugin, type PluginBuildCtx, type PluginCommand } from './types'

/**
 * THE plugin registry (plan 77 §3.5, §3.6, §4.3) — the single glanceable list of the agent's
 * feature groupings. Order matters: prompt sections are assembled in ARRAY ORDER
 * (`assembleSystemPrompt` below), and this is also the order §3.6's table lists them in.
 *
 * Every capability id here already exists in the real capability registry
 * (`capability/index.ts`'s `buildCoreCapabilityRegistry`) — a plugin does not create a second
 * source of capabilities, it GROUPS the existing ones for the prompt and for readability (plan 77
 * §3.5's own framing: "Plan 63's registry has the boot-time duplicate check... What it lacks is the
 * grouping"). An agent's actual authority to call a capability still comes from its own `tools:
 * string[]` (Plan 65) intersected with the run tree's authority (Plan 67) — unchanged by this file.
 */
export const AGENT_PLUGINS: readonly AgentPlugin[] = [
  deviceControlPlugin,
  deviceInspectPlugin,
  deviceAppsPlugin,
  deviceFilesPlugin,
  fleetPlugin,
  workspacePlugin,
  skillsPlugin,
  automationPlugin,
  orchestrationPlugin,
  notifyPlugin,
]

interface PluginAssembly {
  /** Every plugin's capabilities, keyed by id — the fail-fast merge itself (criterion 7). */
  byId: Map<string, AnyCoreCapability>
  /** Which plugin owns a given capability id — the OWNER map the duplicate check needs to name
   * both plugins, and `assembleSystemPrompt` needs to decide which sections apply. */
  ownerOf: Map<string, string>
  /** A plugin's own capability ids, in the order `tools()` returned them. */
  capabilityIdsByPlugin: Map<string, string[]>
}

/**
 * Fail-fast merge plus boot-time dry run (plan 77 §3.5, §4.3, criteria 7 and 8) — ported from
 * upstream's `plugins/index.ts` `mergeToolSets`/the bottom-of-file boot call, adapted to merge
 * CAPABILITIES rather than a raw `ToolSet`. A plugin that throws while building its capabilities,
 * or a capability id two plugins both claim, fails HERE — at whoever calls this (which
 * `ASSEMBLY` below does at module load, i.e. at boot, exactly like upstream) — never at the first
 * chat that happens to reach the colliding tool.
 */
export function assemblePlugins(plugins: readonly AgentPlugin[], build: PluginBuildCtx): PluginAssembly {
  const byId = new Map<string, AnyCoreCapability>()
  const ownerOf = new Map<string, string>()
  const capabilityIdsByPlugin = new Map<string, string[]>()

  for (const plugin of plugins) {
    let caps: AnyCoreCapability[]
    try {
      caps = plugin.tools(build)
    } catch (err) {
      throw new Error(`agent plugin "${plugin.id}" threw while building its capabilities at boot: ${err instanceof Error ? err.message : String(err)}`)
    }
    capabilityIdsByPlugin.set(plugin.id, caps.map((cap) => cap.id))
    for (const cap of caps) {
      const prev = ownerOf.get(cap.id)
      if (prev) {
        throw new Error(`agent plugin merge: duplicate capability id "${cap.id}" declared by both plugin "${prev}" and plugin "${plugin.id}"`)
      }
      ownerOf.set(cap.id, plugin.id)
      byId.set(cap.id, cap)
    }
  }

  return { byId, ownerOf, capabilityIdsByPlugin }
}

const BOOT_BUILD: PluginBuildCtx = {}

/**
 * Runs at module load — importing this file IS the boot-time dry run (criterion 8), exactly like
 * upstream's own top-level `mergeToolSets(...)` call. `agent/runner.ts` imports `assembleSystemPrompt`
 * below for every run it builds, and `daemon.ts` imports `agent/runner.ts` at process boot, so a
 * throwing plugin or a duplicate id fails the real boot — this is not a pattern that only works in
 * a test file that happens to import the module.
 */
const ASSEMBLY = assemblePlugins(AGENT_PLUGINS, BOOT_BUILD)

export interface PluginPromptSection {
  pluginId: string
  prompt: string
}

/**
 * The system prompt's plugin sections, in REGISTRY ORDER, filtered to plugins the caller holds at
 * least one capability of (plan 77 §4.5, criterion 12). Every `plugin.prompt` is a static string
 * (criterion 9), so for the SAME `availableCapabilityIds` this is byte-identical run to run — which
 * is what keeps Plan 65 §3.4's cache prefix stable (criterion 13).
 */
export function pluginPromptSections(availableCapabilityIds: ReadonlySet<string>): PluginPromptSection[] {
  const sections: PluginPromptSection[] = []
  for (const plugin of AGENT_PLUGINS) {
    if (plugin.prompt.length === 0) continue
    const ownCapIds = ASSEMBLY.capabilityIdsByPlugin.get(plugin.id) ?? []
    if (ownCapIds.some((id) => availableCapabilityIds.has(id))) {
      sections.push({ pluginId: plugin.id, prompt: plugin.prompt })
    }
  }
  return sections
}

/**
 * Assembles the final system prompt (plan 77 §4.5): the agent's own instructions, then every
 * enabled plugin's section, in registry order. Pure string concatenation — nothing here is
 * time-varying, so the result is deterministic for the same inputs (criteria 9, 13).
 */
export function assembleSystemPrompt(ownPrompt: string, availableCapabilityIds: ReadonlySet<string>): string {
  const sections = pluginPromptSections(availableCapabilityIds).map((s) => s.prompt)
  return [ownPrompt, ...sections].filter((s) => s.length > 0).join('\n\n')
}

/** Every capability any plugin declares, deduplicated — exported for tests and for a future
 * Studio surface that wants to show "which plugin does this tool belong to". Not consumed by the
 * loop itself: an agent's actual tool set still comes from its own `tools: string[]` (Plan 65). */
export function assembledPluginCapabilities(): AnyCoreCapability[] {
  return [...ASSEMBLY.byId.values()]
}

/** Which plugin owns a given capability id, if any — `undefined` for a capability no plugin groups. */
export function pluginIdForCapabilityId(capabilityId: string): string | undefined {
  return ASSEMBLY.ownerOf.get(capabilityId)
}

/**
 * Plan 78 §3.6, §4.2 — the assembled slash-command list `GET /api/v1/agent-commands` returns, in
 * registry order. No plugin populates `commands` yet (plan 77 §9 open question 2 — "expected to
 * stay inert until Plan 78 gives it a composer"), so this returns `[]` today; a plugin adding one
 * later needs no route or Studio change to appear (criterion 8).
 */
export function allPluginCommands(): PluginCommand[] {
  return AGENT_PLUGINS.flatMap((plugin) => plugin.commands ?? [])
}
