import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, type NodeState } from './state'

const freshDir = () => mkdtempSync(join(tmpdir(), 'enkaku-node-state-'))

/**
 * Plan 61's `agent.json` one-time adoption (§3.3) was removed per the dated
 * follow-up in `00-overview.md` §9 — the deadline (v0.1.7) has passed. Only
 * `node.json` is read now; a stale pre-rename `agent.json` is neither
 * adopted nor deleted, just ignored.
 */
describe('loadState — node.json only, the agent.json adoption is gone', () => {
  test('neither file present → null (the caller enrolls)', async () => {
    const dir = freshDir()
    const state = await loadState(dir)
    expect(state).toBeNull()
  })

  test('node.json present → loaded normally', async () => {
    const dir = freshDir()
    const fresh: NodeState = { nodeId: 'node-fresh', credential: 'fresh-cred', controlPlaneUrl: 'http://localhost:7700' }
    await saveState(dir, fresh)

    const state = await loadState(dir)
    expect(state).toEqual(fresh)
  })

  test('only a stale agent.json present → null, not adopted — the compatibility window has closed', async () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ agentId: 'agent-abc', credential: 'cred-1', controlPlaneUrl: 'http://localhost:7700' }),
    )

    const state = await loadState(dir)
    expect(state).toBeNull()
    // Left alone rather than deleted: nothing here should ever delete somebody's file.
    expect(existsSync(join(dir, 'agent.json'))).toBe(true)
    expect(existsSync(join(dir, 'node.json'))).toBe(false)
  })

  test('both files present → node.json wins, agent.json is left alone untouched', async () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ agentId: 'agent-stale', credential: 'stale-cred', controlPlaneUrl: 'http://localhost:7700' }),
    )
    const fresh: NodeState = { nodeId: 'node-fresh', credential: 'fresh-cred', controlPlaneUrl: 'http://localhost:7700' }
    await saveState(dir, fresh)

    const state = await loadState(dir)
    expect(state).toEqual(fresh)
    expect(existsSync(join(dir, 'agent.json'))).toBe(true)
  })

  test('a node.json that fails to parse is treated as absent, not thrown', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'node.json'), '{ not valid json')
    const state = await loadState(dir)
    expect(state).toBeNull()
  })
})
