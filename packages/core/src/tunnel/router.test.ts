import { describe, expect, test } from 'bun:test'
import type { NodeConn, TunnelRegistry } from './registry'
import { createTunnelRouter } from './router'
import type { Logger } from '../util/logger'

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  const self: Logger & { warnings: string[] } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
    child: () => self,
  }
  return self
}

function fakeWs() {
  const sent: unknown[] = []
  return {
    sent,
    ws: { send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as import('bun').ServerWebSocket<unknown>,
  }
}

function fakeRegistry(conn: NodeConn | null): TunnelRegistry {
  return {
    attach: () => {
      throw new Error('not used')
    },
    detach: () => {
      throw new Error('not used')
    },
    byNode: () => conn,
    forDevice: () => conn,
    syncDevices: () => {},
    onlineNodes: () => (conn ? [conn] : []),
  }
}

/**
 * Plan 61 §3.3, acceptance #4: a pre-rename node build still sends
 * `agent.hello`/`agent.devices`. The control plane must accept it, and the
 * ONLY observable difference from a `node.hello` is exactly one warn-level
 * log naming the node and the deprecated message — never a silent ignore,
 * never a crash, never more than one warning per hello.
 */
describe('createTunnelRouter — plan 61 §3.3 compatibility window', () => {
  test('node.hello (post-plan-61) is accepted with NO warning, and acked as node.hello.ack', () => {
    const conn: NodeConn = { nodeId: 'node-1', ws: {} as never, connectedAt: Date.now() }
    const log = fakeLogger()
    const { ws, sent } = fakeWs()
    const router = createTunnelRouter({ registry: fakeRegistry(conn), log })

    router.handleNodeMessage(
      ws,
      'node-1',
      JSON.stringify({ type: 'node.hello', payload: { nodeVersion: '0.1.0', platform: 'linux-x64', toolVersions: {} } }),
    )

    expect(log.warnings).toEqual([])
    expect(conn.version).toBe('0.1.0')
    expect(sent).toEqual([{ type: 'node.hello.ack', payload: expect.objectContaining({ nodeId: 'node-1' }) }])
  })

  test('the deprecated agent.hello is accepted, produces exactly ONE warn log naming the node, and still acks node.hello.ack', () => {
    const conn: NodeConn = { nodeId: 'node-legacy', ws: {} as never, connectedAt: Date.now() }
    const log = fakeLogger()
    const { ws, sent } = fakeWs()
    const router = createTunnelRouter({ registry: fakeRegistry(conn), log })

    router.handleNodeMessage(
      ws,
      'node-legacy',
      JSON.stringify({ type: 'agent.hello', payload: { agentVersion: '0.0.9', platform: 'darwin-arm64', toolVersions: {} } }),
    )

    expect(log.warnings).toHaveLength(1)
    expect(log.warnings[0]).toContain('node-legacy')
    expect(log.warnings[0]).toContain('agent.hello')
    // The node is accepted exactly like a node.hello — version recorded, acked.
    expect(conn.version).toBe('0.0.9')
    expect(sent).toEqual([{ type: 'node.hello.ack', payload: expect.objectContaining({ nodeId: 'node-legacy' }) }])
  })

  test('a legacy node then sending agent.devices is accepted with no additional warning (the warn is a per-hello signal, not per-message spam)', () => {
    const conn: NodeConn = { nodeId: 'node-legacy', ws: {} as never, connectedAt: Date.now() }
    const log = fakeLogger()
    const { ws } = fakeWs()
    const router = createTunnelRouter({ registry: fakeRegistry(conn), log })

    router.handleNodeMessage(
      ws,
      'node-legacy',
      JSON.stringify({ type: 'agent.hello', payload: { agentVersion: '0.0.9', platform: 'darwin-arm64', toolVersions: {} } }),
    )
    router.handleNodeMessage(ws, 'node-legacy', JSON.stringify({ type: 'agent.devices', payload: { devices: [] } }))

    expect(log.warnings).toHaveLength(1) // still just the one, from the hello
  })
})
