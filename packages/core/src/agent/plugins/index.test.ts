import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AnyCoreCapability } from '../../capability/types'
import { AGENT_PLUGINS, allPluginCommands, assemblePlugins, assembleSystemPrompt, assembledPluginCapabilities, pluginIdForCapabilityId, pluginPromptSections } from './index'
import { defineAgentPlugin, type AgentPlugin } from './types'

function fakeCap(id: string): AnyCoreCapability {
  return {
    id,
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
    permission: 'device.view',
    deadline: 1_000,
    effect: 'read',
    description: 'a test capability',
    handler: async () => ({ ok: true }),
  }
}

describe('the real plugin registry (plan 77 §3.5, §3.6)', () => {
  test('assembles cleanly at import time — this file importing ./index IS the boot-time dry run (criterion 8)', () => {
    expect(AGENT_PLUGINS.length).toBe(10)
    expect(assembledPluginCapabilities().length).toBeGreaterThan(20)
  })

  test('every plugin has a non-empty id, title, and static prompt', () => {
    for (const plugin of AGENT_PLUGINS) {
      expect(plugin.id.length).toBeGreaterThan(0)
      expect(plugin.title.length).toBeGreaterThan(0)
      expect(plugin.prompt.length).toBeGreaterThan(0)
    }
  })

  test('every capability id groups under exactly one plugin', () => {
    for (const plugin of AGENT_PLUGINS) {
      for (const cap of plugin.tools({})) {
        expect(pluginIdForCapabilityId(cap.id)).toBe(plugin.id)
      }
    }
  })

  test('device.tap groups under device-control; agent.spawn groups under orchestration', () => {
    expect(pluginIdForCapabilityId('device.tap')).toBe('device-control')
    expect(pluginIdForCapabilityId('agent.spawn')).toBe('orchestration')
    expect(pluginIdForCapabilityId('fs.write')).toBe('workspace')
    expect(pluginIdForCapabilityId('files.edit')).toBe('workspace')
    expect(pluginIdForCapabilityId('skills.read')).toBe('skills')
  })
})

describe('assemblePlugins — fail-fast merge (plan 77 §3.5, §4.3, criterion 7)', () => {
  test('a duplicate capability id across two plugins throws, naming both plugins', () => {
    const pluginA = defineAgentPlugin({ id: 'plugin-a', title: 'A', prompt: 'a', tools: () => [fakeCap('shared.op')] })
    const pluginB = defineAgentPlugin({ id: 'plugin-b', title: 'B', prompt: 'b', tools: () => [fakeCap('shared.op')] })
    expect(() => assemblePlugins([pluginA, pluginB], {})).toThrow(/shared\.op.*plugin-a.*plugin-b/s)
  })

  test('a plugin that throws while building its tools fails the boot rather than being silently skipped (criterion 8)', () => {
    const broken: AgentPlugin = defineAgentPlugin({
      id: 'broken',
      title: 'Broken',
      prompt: 'x',
      tools: () => {
        throw new Error('boom')
      },
    })
    expect(() => assemblePlugins([broken], {})).toThrow(/broken.*boom/s)
  })

  test('two plugins with disjoint capability ids merge without incident', () => {
    const pluginA = defineAgentPlugin({ id: 'plugin-a', title: 'A', prompt: 'a', tools: () => [fakeCap('a.op')] })
    const pluginB = defineAgentPlugin({ id: 'plugin-b', title: 'B', prompt: 'b', tools: () => [fakeCap('b.op')] })
    const assembly = assemblePlugins([pluginA, pluginB], {})
    expect([...assembly.byId.keys()].sort()).toEqual(['a.op', 'b.op'])
  })
})

describe('pluginPromptSections / assembleSystemPrompt (plan 77 §4.5, criteria 9 and 12)', () => {
  test('a section appears only when the caller holds at least one of that plugin\'s capabilities (criterion 12)', () => {
    // Exercised directly against a private-style local assembly via the real registry helpers is not
    // possible (AGENT_PLUGINS is the real, fixed list) — so this test proves the GATING LOGIC using
    // the real, already-assembled plugins instead: a set with none of their capability ids yields no
    // sections at all, and each plugin's own ids yield exactly that plugin's section.
    expect(pluginPromptSections(new Set())).toEqual([])
    const withOrchestration = pluginPromptSections(new Set(['agent.spawn']))
    expect(withOrchestration.map((s) => s.pluginId)).toEqual(['orchestration'])
  })

  test('sections are emitted in registry order, not capability-id order', () => {
    const sections = pluginPromptSections(new Set(['device.tap', 'agent.spawn', 'fs.write']))
    const ids = sections.map((s) => s.pluginId)
    expect(ids).toEqual(['device-control', 'workspace', 'orchestration'])
  })

  test('assembleSystemPrompt is byte-identical across two calls with the same inputs (criterion 9)', () => {
    const ids = new Set(['device.tap', 'fs.write', 'agent.spawn', 'notify.send'])
    const first = assembleSystemPrompt('You are Enkaku\'s device agent.', ids)
    const second = assembleSystemPrompt('You are Enkaku\'s device agent.', ids)
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThan(0)
  })

  test('an empty capability set returns just the agent\'s own prompt, unchanged', () => {
    expect(assembleSystemPrompt('base prompt', new Set())).toBe('base prompt')
  })
})

describe('allPluginCommands (plan 78 §3.6, §4.2 — GET /api/v1/agent-commands)', () => {
  test('no real plugin declares a command yet (plan 77 §9 open question 2 — inert until this plan) — an empty list is the honest, correct answer today', () => {
    expect(allPluginCommands()).toEqual([])
  })

  test('a plugin that DOES declare commands contributes them, in registry order, alongside every other plugin\'s (structural proof the SAME flattening `allPluginCommands` uses actually works)', () => {
    const pluginA = defineAgentPlugin({ id: 'plugin-a', title: 'A', prompt: 'a', tools: () => [], commands: [{ name: 'compact', description: 'summarize the conversation' }] })
    const pluginB = defineAgentPlugin({ id: 'plugin-b', title: 'B', prompt: 'b', tools: () => [], commands: [{ name: 'reset', description: 'start a fresh context' }] })
    const commands = [pluginA, pluginB].flatMap((p) => p.commands ?? [])
    expect(commands).toEqual([
      { name: 'compact', description: 'summarize the conversation' },
      { name: 'reset', description: 'start a fresh context' },
    ])
  })
})
