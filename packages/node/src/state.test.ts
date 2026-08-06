import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, type NodeState } from './state'

const freshDir = () => mkdtempSync(join(tmpdir(), 'enkaku-node-state-'))

/**
 * Plan 61 §3.3, §7: `node.json`/`agent.json` resolution. A node upgraded in
 * place must keep its credential — it must not re-enroll and must not appear
 * as a second row in the control plane's node list.
 */
describe('loadState (plan 61 §3.3) — node.json / agent.json resolution', () => {
  test('neither file present → null (the caller enrolls)', async () => {
    const dir = freshDir()
    const state = await loadState(dir)
    expect(state).toBeNull()
  })

  test('only agent.json present → adopted and rewritten as node.json, the stale agent.json is left alone', async () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ agentId: 'agent-abc', credential: 'cred-1', controlPlaneUrl: 'http://localhost:7700' }),
    )

    const state = await loadState(dir)
    expect(state).toEqual({ nodeId: 'agent-abc', credential: 'cred-1', controlPlaneUrl: 'http://localhost:7700' })

    // Rewritten as node.json...
    expect(existsSync(join(dir, 'node.json'))).toBe(true)
    // ...and the pre-rename file is untouched, never deleted.
    expect(existsSync(join(dir, 'agent.json'))).toBe(true)
  })

  test('both files present → node.json wins, agent.json is left alone rather than reconciled or deleted', async () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ agentId: 'agent-stale', credential: 'stale-cred', controlPlaneUrl: 'http://localhost:7700' }),
    )
    const fresh: NodeState = { nodeId: 'node-fresh', credential: 'fresh-cred', controlPlaneUrl: 'http://localhost:7700' }
    await saveState(dir, fresh)

    const state = await loadState(dir)
    expect(state).toEqual(fresh)
    // The stale agent.json is untouched — same content as written above.
    expect(existsSync(join(dir, 'agent.json'))).toBe(true)
  })

  test('a node.json that fails to parse is treated as absent, not thrown', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'node.json'), '{ not valid json')
    const state = await loadState(dir)
    expect(state).toBeNull()
  })
})
