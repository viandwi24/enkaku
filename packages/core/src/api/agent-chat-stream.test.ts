import { describe, expect, test } from 'bun:test'
import type { AgentRun, ServerMessage } from '@enkaku/protocol'
import type { ServerWebSocket } from 'bun'
import { createAgentChatStream } from './agent-chat-stream'

/**
 * Proves the bridge documented in `agent-chat-stream.ts`'s own header comment: Enkaku's EXISTING
 * `agentWs`-broadcast events (the exact `ServerMessage`s a real WebSocket subscriber receives over
 * `/ws` today) become AI SDK `UIMessageChunk`s a `useChat` `fetch` transport can consume — with no
 * real network call, no real run, and no real WS connection (the hard constraint this whole plan
 * runs under).
 */

function fakeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    threadId: 'thread-1',
    status: 'running',
    stopReason: null,
    errorClass: null,
    error: null,
    steps: 0,
    usage: null,
    startedAt: 1000,
    finishedAt: null,
    parentRunId: null,
    rootRunId: 'run-1',
    depth: 1,
    awaited: false,
    deviceGrantsOverride: null,
    ...overrides,
  }
}

/** A fake `AgentWsHandler` slice: `subscribe` captures the relay object the route hands it, exactly like a real `ws-handlers-agent.ts` subscriber list would, so the test can call `.send()` on it directly to simulate a broadcast. */
function fakeAgentWs() {
  let captured: ServerWebSocket<unknown> | null = null
  let unsubscribed = false
  return {
    handler: {
      subscribe: (ws: ServerWebSocket<unknown>) => {
        captured = ws
      },
      unsubscribe: () => {
        unsubscribed = true
      },
    },
    send(msg: ServerMessage) {
      if (!captured) throw new Error('nothing subscribed yet')
      ;(captured as unknown as { send: (data: string) => void }).send(JSON.stringify(msg))
    },
    get wasUnsubscribed() {
      return unsubscribed
    },
  }
}

/** Reads every chunk until the stream closes — every test below drives it to a close (an explicit `agent.run.finished`, an abort, or a run already finished when `start()` returns), so this never hangs. */
async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader()
  const chunks: unknown[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  reader.releaseLock()
  return chunks
}

describe('createAgentChatStream (plan 78 §4.3)', () => {
  test('a text delta becomes text-start/text-delta chunks', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    ws.send({ type: 'agent.delta', payload: { runId: run.id, threadId: run.threadId, seq: 1, kind: 'text', text: 'Hello' } })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; delta?: string }[]
    expect(chunks.some((c) => c.type === 'text-start')).toBe(true)
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta === 'Hello')).toBe(true)
    expect(chunks.some((c) => c.type === 'text-end')).toBe(true)
    expect(ws.wasUnsubscribed).toBe(true)
  })

  test('a run scoped to a DIFFERENT runId is ignored — a busy thread with two subscribers never crosstalks', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun({ id: 'run-1' })
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    ws.send({ type: 'agent.delta', payload: { runId: 'run-OTHER', threadId: 'thread-1', seq: 1, kind: 'text', text: 'not mine' } })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; delta?: string }[]
    expect(chunks.some((c) => c.delta === 'not mine')).toBe(false)
  })

  test('a thinking delta becomes reasoning-start/reasoning-delta, closed by a following text delta', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    ws.send({ type: 'agent.delta', payload: { runId: run.id, threadId: run.threadId, seq: 1, kind: 'thinking', text: 'pondering' } })
    ws.send({ type: 'agent.delta', payload: { runId: run.id, threadId: run.threadId, seq: 2, kind: 'text', text: 'answer' } })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; delta?: string }[]
    const reasoningEndIdx = chunks.findIndex((c) => c.type === 'reasoning-end')
    const textStartIdx = chunks.findIndex((c) => c.type === 'text-start')
    expect(reasoningEndIdx).toBeGreaterThanOrEqual(0)
    expect(textStartIdx).toBeGreaterThan(reasoningEndIdx)
  })

  test('tool.started then tool.finished write the SAME data-toolCall id twice — a client can reconcile in place (criterion 6/7)', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    ws.send({ type: 'agent.tool.started', payload: { runId: run.id, threadId: run.threadId, callId: 'call-1', capabilityId: 'device.screenshot', input: { deviceId: 'd1' } } })
    ws.send({ type: 'agent.tool.finished', payload: { runId: run.id, threadId: run.threadId, callId: 'call-1', capabilityId: 'device.screenshot', ok: true, durationMs: 42 } })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; id?: string; data?: unknown }[]
    const toolChunks = chunks.filter((c) => c.type === 'data-toolCall')
    expect(toolChunks.length).toBe(2)
    expect(toolChunks[0]?.id).toBe('call-1')
    expect(toolChunks[1]?.id).toBe('call-1')
    expect((toolChunks[0]?.data as { status: string }).status).toBe('started')
    expect((toolChunks[1]?.data as { status: string; ok: boolean }).status).toBe('finished')
    expect((toolChunks[1]?.data as { ok: boolean }).ok).toBe(true)
    // `data-X` chunks REPLACE `.data` wholesale on the client (`@ai-sdk/react`'s own reconciliation)
    // — the `finished` write must still carry the fields `started` set, or the client loses them.
    expect((toolChunks[1]?.data as { input: unknown }).input).toEqual({ deviceId: 'd1' })
    expect((toolChunks[1]?.data as { capabilityId: string }).capabilityId).toBe('device.screenshot')
  })

  test("a persisted tool_result (role 'tool' agent.message) merges resultContent into the SAME data-toolCall id — the screenshot path, criterion 7", async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    ws.send({ type: 'agent.tool.started', payload: { runId: run.id, threadId: run.threadId, callId: 'call-1', capabilityId: 'device.screenshot', input: { deviceId: 'd1' } } })
    ws.send({ type: 'agent.tool.finished', payload: { runId: run.id, threadId: run.threadId, callId: 'call-1', capabilityId: 'device.screenshot', ok: true, durationMs: 42 } })
    ws.send({
      type: 'agent.message',
      payload: {
        message: {
          id: 'm-1',
          threadId: run.threadId,
          runId: run.id,
          seq: 3,
          role: 'tool',
          content: [{ type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'image', blobId: 'blob-1', mediaType: 'image/png', bytes: 1000 }], isError: false }],
          createdAt: 1000,
        },
      },
    })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; id?: string; data?: unknown }[]
    const toolChunks = chunks.filter((c) => c.type === 'data-toolCall' && c.id === 'call-1')
    expect(toolChunks.length).toBe(3) // started, finished, resultContent
    const last = toolChunks[toolChunks.length - 1]?.data as { resultContent: unknown; status: string; ok: boolean; input: unknown }
    expect(last.resultContent).toEqual([{ type: 'image', blobId: 'blob-1', mediaType: 'image/png', bytes: 1000 }])
    // The merge preserved everything `finished` already set, rather than replacing it.
    expect(last.status).toBe('finished')
    expect(last.ok).toBe(true)
    expect(last.input).toEqual({ deviceId: 'd1' })
  })

  test("a tool_result on a DIFFERENT run's own thread broadcast is ignored (message.runId scoping)", async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    ws.send({
      type: 'agent.message',
      payload: {
        message: { id: 'm-1', threadId: run.threadId, runId: 'run-OTHER', seq: 1, role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call-x', content: [], isError: false }], createdAt: 1000 },
      },
    })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; id?: string }[]
    expect(chunks.some((c) => c.type === 'data-toolCall' && c.id === 'call-x')).toBe(false)
  })

  test('an approval carries the EXACT untruncated input (criterion 6), preserved across resolution', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    const exactInput = { deviceId: 'd1', text: 'a very specific, exact, untruncated string that must survive the bridge byte-for-byte' }
    ws.send({ type: 'agent.approval.requested', payload: { approvalId: 'appr-1', runId: run.id, threadId: run.threadId, capabilityId: 'app.launch', input: exactInput, expiresAt: 9999 } })
    ws.send({ type: 'agent.approval.resolved', payload: { approvalId: 'appr-1', runId: run.id, threadId: run.threadId, status: 'approved', decidedBy: 'user-1' } })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; id?: string; data?: unknown }[]
    const approvalChunks = chunks.filter((c) => c.type === 'data-approval')
    expect(approvalChunks.length).toBe(2)
    expect((approvalChunks[0]?.data as { input: unknown }).input).toEqual(exactInput)
    const resolved = approvalChunks[1]?.data as { status: string; decidedBy: string; input: unknown; capabilityId: string }
    expect(resolved.status).toBe('approved')
    // Preserved from the `requested` write, not dropped by the wholesale-replace reconciliation.
    expect(resolved.input).toEqual(exactInput)
    expect(resolved.capabilityId).toBe('app.launch')
  })

  test('a child run start/finish becomes data-child chunks scoped by parentRunId', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    ws.send({ type: 'agent.child.started', payload: { parentRunId: run.id, childRunId: 'child-1', childThreadId: 'thread-2', agentId: 'agent-2', depth: 2 } })
    ws.send({ type: 'agent.child.finished', payload: { parentRunId: run.id, childRunId: 'child-1', status: 'succeeded', stopReason: 'done' } })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; id?: string; data?: unknown }[]
    const childChunks = chunks.filter((c) => c.type === 'data-child')
    expect(childChunks.length).toBe(2)
    expect(childChunks[0]?.id).toBe('child-1')
    expect((childChunks[1]?.data as { status: string }).status).toBe('succeeded')
  })

  test('a `paused` run.finished (an approval gate) does NOT close the stream — runner.ts resumes the SAME run id and this stream must still be listening', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'paused', stopReason: null, errorClass: null, usage: null } })
    expect(ws.wasUnsubscribed).toBe(false) // still open — proven by being able to send more and having them land below

    // The approval is decided; `resumeRun` launches the SAME run id again.
    ws.send({ type: 'agent.run.started', payload: { runId: run.id, threadId: run.threadId, status: 'running' } })
    ws.send({ type: 'agent.delta', payload: { runId: run.id, threadId: run.threadId, seq: 5, kind: 'text', text: 'resumed' } })
    ws.send({ type: 'agent.run.finished', payload: { runId: run.id, threadId: run.threadId, status: 'succeeded', stopReason: 'done', errorClass: null, usage: null } })

    const chunks = (await readAll(stream)) as { type: string; delta?: string; data?: { status?: string } }[]
    const runFinishedChunks = chunks.filter((c) => c.type === 'data-runFinished')
    expect(runFinishedChunks.length).toBe(2)
    expect(runFinishedChunks[0]?.data?.status).toBe('paused')
    expect(runFinishedChunks[1]?.data?.status).toBe('succeeded')
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta === 'resumed')).toBe(true)
    expect(ws.wasUnsubscribed).toBe(true)
  })

  test('a run already finished by the time start() returns still closes the stream (denied-at-once case)', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun({ status: 'failed', stopReason: 'error', error: 'no connector configured' })
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run })

    const chunks = (await readAll(stream)) as { type: string; data?: unknown }[]
    expect(chunks.some((c) => c.type === 'data-runFinished')).toBe(true)
    expect(ws.wasUnsubscribed).toBe(true)
  })

  test('an aborted request signal unsubscribes and closes the stream without a run.finished event', async () => {
    const ws = fakeAgentWs()
    const run = fakeAgentRun()
    const controller = new AbortController()
    const stream = createAgentChatStream({ agentWs: ws.handler, threadId: 'thread-1', start: () => run, signal: controller.signal })

    ws.send({ type: 'agent.delta', payload: { runId: run.id, threadId: run.threadId, seq: 1, kind: 'text', text: 'partial' } })
    controller.abort()

    await readAll(stream) // drain whatever is already enqueued; the promise resolving at all proves the stream closed
    expect(ws.wasUnsubscribed).toBe(true)
  })
})
