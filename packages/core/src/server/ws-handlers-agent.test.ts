import type { ServerWebSocket } from 'bun'
import { describe, expect, test } from 'bun:test'
import type { AgentApproval, AgentRun, AgentThread, ServerMessage } from '@enkaku/protocol'
import { approvalResolvedMessage, createAgentWsHandler } from './ws-handlers-agent'

/**
 * The agent chat protocol's WS half (plan 66 §3.4, §4.4, criterion 6): NO
 * snapshot replay — subscribing only ever starts a live feed; fan-out is
 * per-thread, never global; a disconnected connection stops receiving
 * without needing an explicit `agent.unsubscribe`.
 */

function fakeConn(): { ws: ServerWebSocket<unknown>; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ws = {
    readyState: 1,
    send: (raw: string | Uint8Array) => {
      if (typeof raw === 'string') sent.push(JSON.parse(raw) as ServerMessage)
    },
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

function fakeThread(id = 't1'): AgentThread {
  return { id, agentId: 'a1', title: null, origin: 'chat', onApprovalRequired: 'pause', deviceScope: null, createdBy: null, createdAt: 0, updatedAt: 0 }
}

function fakeRun(id = 'r1', threadId = 't1', overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    threadId,
    status: 'running',
    stopReason: null,
    errorClass: null,
    error: null,
    steps: 0,
    usage: null,
    startedAt: 0,
    finishedAt: null,
    parentRunId: null,
    rootRunId: id,
    depth: 1,
    awaited: false,
    deviceGrantsOverride: null,
    ...overrides,
  }
}

describe('createAgentWsHandler — subscribe/unsubscribe (plan 66 §3.4, criterion 6)', () => {
  test('subscribing does NOT replay anything — a fresh subscriber gets nothing until a new event is published', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    // Publish BEFORE subscribing — this must never reach the connection once it subscribes later.
    handler.publish(fakeThread(), fakeRun(), { type: 'delta', kind: 'text', text: 'missed this' })
    handler.subscribe(conn.ws, 't1')
    expect(conn.sent).toEqual([]) // no snapshot replay
  })

  test('a subscribed connection receives events published for its thread, in the correct wire shape', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    handler.subscribe(conn.ws, 't1')
    handler.publish(fakeThread(), fakeRun(), { type: 'delta', kind: 'text', text: 'hello' })
    expect(conn.sent).toEqual([{ type: 'agent.delta', payload: { runId: 'r1', threadId: 't1', seq: 0, kind: 'text', text: 'hello' } }])
  })

  test('a connection subscribed to a DIFFERENT thread never receives this thread\'s events', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    handler.subscribe(conn.ws, 'other-thread')
    handler.publish(fakeThread('t1'), fakeRun('r1', 't1'), { type: 'delta', kind: 'text', text: 'not for you' })
    expect(conn.sent).toEqual([])
  })

  test('unsubscribe stops delivery without a disconnect', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    handler.subscribe(conn.ws, 't1')
    handler.unsubscribe(conn.ws, 't1')
    handler.publish(fakeThread(), fakeRun(), { type: 'delta', kind: 'text', text: 'after unsubscribe' })
    expect(conn.sent).toEqual([])
  })

  test('handleClose releases every thread this connection was subscribed to', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    handler.subscribe(conn.ws, 't1')
    handler.subscribe(conn.ws, 't2')
    handler.handleClose(conn.ws)
    handler.publish(fakeThread('t1'), fakeRun('r1', 't1'), { type: 'delta', kind: 'text', text: 'x' })
    handler.publish(fakeThread('t2'), fakeRun('r2', 't2'), { type: 'delta', kind: 'text', text: 'y' })
    expect(conn.sent).toEqual([])
  })

  test('two connections subscribed to the same thread both receive the same event (fan-out)', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const a = fakeConn()
    const b = fakeConn()
    handler.subscribe(a.ws, 't1')
    handler.subscribe(b.ws, 't1')
    handler.publish(fakeThread(), fakeRun(), { type: 'delta', kind: 'text', text: 'broadcast' })
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
  })
})

describe('createAgentWsHandler — cancel forwarding', () => {
  test('cancelRun forwards to the injected runner with the exact runId and cancelledBy', () => {
    const calls: { runId: string; by: string | null }[] = []
    const handler = createAgentWsHandler({ runner: { cancelRun: (runId, by) => calls.push({ runId, by }) } })
    handler.cancelRun('r1', 'user:u1')
    expect(calls).toEqual([{ runId: 'r1', by: 'user:u1' }])
  })
})

describe('createAgentWsHandler — event shapes', () => {
  test('tool.started carries the input, tool.finished carries ok/durationMs', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    handler.subscribe(conn.ws, 't1')
    handler.publish(fakeThread(), fakeRun(), { type: 'tool.started', callId: 'c1', capabilityId: 'device.tap', input: { deviceId: 'd1' } })
    handler.publish(fakeThread(), fakeRun(), { type: 'tool.finished', callId: 'c1', capabilityId: 'device.tap', ok: true, durationMs: 42 })
    expect(conn.sent[0]).toEqual({ type: 'agent.tool.started', payload: { runId: 'r1', threadId: 't1', callId: 'c1', capabilityId: 'device.tap', input: { deviceId: 'd1' } } })
    expect(conn.sent[1]).toEqual({ type: 'agent.tool.finished', payload: { runId: 'r1', threadId: 't1', callId: 'c1', capabilityId: 'device.tap', ok: true, durationMs: 42 } })
  })

  test('approval.requested carries the exact input (plan 66 §3.6)', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    handler.subscribe(conn.ws, 't1')
    handler.publish(fakeThread(), fakeRun(), { type: 'approval.requested', approvalId: 'ap1', capabilityId: 'device.app.install', input: { path: '/x.apk' }, expiresAt: 999 })
    expect(conn.sent[0]).toEqual({
      type: 'agent.approval.requested',
      payload: { approvalId: 'ap1', runId: 'r1', threadId: 't1', capabilityId: 'device.app.install', input: { path: '/x.apk' }, expiresAt: 999 },
    })
  })

  test('publishRunStarted / publishRunFinished carry the run\'s status', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    handler.subscribe(conn.ws, 't1')
    handler.publishRunStarted(fakeThread(), fakeRun('r1', 't1', { status: 'running' }))
    handler.publishRunFinished(fakeThread(), fakeRun('r1', 't1', { status: 'succeeded', stopReason: 'done' }))
    expect(conn.sent[0]).toEqual({ type: 'agent.run.started', payload: { runId: 'r1', threadId: 't1', status: 'running' } })
    expect(conn.sent[1]).toEqual({ type: 'agent.run.finished', payload: { runId: 'r1', threadId: 't1', status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })
  })

  test('publishRaw fans an already-built message out, e.g. an approval decision broadcast immediately by the REST route', () => {
    const handler = createAgentWsHandler({ runner: { cancelRun: () => {} } })
    const conn = fakeConn()
    handler.subscribe(conn.ws, 't1')
    const approval: AgentApproval = { id: 'ap1', runId: 'r1', threadId: 't1', capabilityId: 'x', toolCallId: 'c1', input: {}, status: 'approved', decidedBy: 'user:u1', decidedAt: 1, expiresAt: 2, createdAt: 0 }
    handler.publishRaw('t1', approvalResolvedMessage(approval))
    expect(conn.sent[0]).toEqual({ type: 'agent.approval.resolved', payload: { approvalId: 'ap1', runId: 'r1', threadId: 't1', status: 'approved', decidedBy: 'user:u1' } })
  })
})
