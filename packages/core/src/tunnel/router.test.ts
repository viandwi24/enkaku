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
 * Plan 61's compatibility window (§3.3) — accepting the pre-rename
 * `agent.hello`/`agent.devices` messages with a warn-level log — was removed
 * per the dated follow-up in `00-overview.md` §9 (deadline v0.1.7, now
 * passed). Only `node.hello`/`node.devices` are recognised; the legacy
 * spellings are unknown messages like any other and are silently ignored,
 * never crash, and never ack.
 */
describe('createTunnelRouter — node.hello/node.devices only', () => {
  test('node.hello is accepted with NO warning, and acked as node.hello.ack', () => {
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

  test('the removed agent.hello is ignored — no ack, no warning, no crash, and the connection version is left untouched', () => {
    const conn: NodeConn = { nodeId: 'node-legacy', ws: {} as never, connectedAt: Date.now() }
    const log = fakeLogger()
    const { ws, sent } = fakeWs()
    const router = createTunnelRouter({ registry: fakeRegistry(conn), log })

    router.handleNodeMessage(
      ws,
      'node-legacy',
      JSON.stringify({ type: 'agent.hello', payload: { agentVersion: '0.0.9', platform: 'darwin-arm64', toolVersions: {} } }),
    )

    expect(log.warnings).toEqual([])
    expect(conn.version).toBeUndefined()
    expect(sent).toEqual([])
  })

  test('the removed agent.devices is likewise ignored, not synced', () => {
    const conn: NodeConn = { nodeId: 'node-legacy', ws: {} as never, connectedAt: Date.now() }
    const log = fakeLogger()
    const { ws } = fakeWs()
    const router = createTunnelRouter({ registry: fakeRegistry(conn), log })

    router.handleNodeMessage(ws, 'node-legacy', JSON.stringify({ type: 'agent.devices', payload: { devices: [] } }))

    expect(log.warnings).toEqual([])
  })
})
