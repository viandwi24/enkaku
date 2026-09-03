import type { ServerWebSocket } from 'bun'
import type { AgentApproval, AgentRun, AgentThread, ServerMessage } from '@enkaku/protocol'
import type { AgentRunner, RunEmitEvent } from '../agent/runner'

/**
 * The agent chat protocol's WS half (plan 66 §3.4, §4.4) —
 * `agent.run.cancel` in over /ws, the SSE relay (`api/agent-chat-stream.ts`)
 * in through `.subscribe()`, `agent.delta`/`.message`/`.tool.*`/
 * `.approval.*`/`.run.*` out. `/ws` has NO SNAPSHOT
 * REPLAY (`CLAUDE.md`): subscribing only ever starts a live feed from the
 * moment of the call — a client fetches history over
 * `GET /api/v1/threads/:id/messages` first, exactly like every other
 * subscribe-only stream in this codebase (`log.subscribe`, `inspect.attach`).
 *
 * A thin translation layer over `AgentRunner`: this file owns WHO gets a
 * message (per-thread fan-out) and HOW an event is shaped on the wire; it
 * contains no run logic of its own.
 */

export interface AgentWsHandler {
  subscribe(ws: ServerWebSocket<unknown>, threadId: string): void
  unsubscribe(ws: ServerWebSocket<unknown>, threadId: string): void
  /** `agent.run.cancel` (plan 66 §3.7) — `cancelledBy` is this connection's user label, resolved by the caller (same pattern `lease.acquire`'s actor already uses). */
  cancelRun(runId: string, cancelledBy: string | null): void
  handleClose(ws: ServerWebSocket<unknown>): void
  /** Wired to `AgentRunner`'s `emit` — fans one event out to every connection subscribed to its thread. */
  publish(thread: AgentThread, run: AgentRun, event: RunEmitEvent): void
  publishRunStarted(thread: AgentThread, run: AgentRun): void
  publishRunFinished(thread: AgentThread, run: AgentRun): void
  /** Fans an already-built `ServerMessage` out to a thread's subscribers — used where the caller (a REST route) builds the message itself rather than going through a `RunEmitEvent` (e.g. `POST /approvals/:id` broadcasting the decision the instant it is recorded, not only once the run gets around to acting on it). */
  publishRaw(threadId: string, msg: ServerMessage): void
}

export interface AgentWsHandlerDeps {
  runner: Pick<AgentRunner, 'cancelRun'>
}

export function createAgentWsHandler(deps: AgentWsHandlerDeps): AgentWsHandler {
  const subsByThread = new Map<string, Set<ServerWebSocket<unknown>>>()
  const subsByConn = new Map<ServerWebSocket<unknown>, Set<string>>()

  const send = (ws: ServerWebSocket<unknown>, msg: ServerMessage) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg))
  }

  const targets = (threadId: string): ServerWebSocket<unknown>[] => [...(subsByThread.get(threadId) ?? [])]

  function toServerMessage(thread: AgentThread, run: AgentRun, event: RunEmitEvent): ServerMessage {
    switch (event.type) {
      case 'delta':
        return { type: 'agent.delta', payload: { runId: run.id, threadId: thread.id, seq: run.steps, kind: event.kind, text: event.text } }
      case 'message':
        return { type: 'agent.message', payload: { message: event.message } }
      case 'tool.started':
        return { type: 'agent.tool.started', payload: { runId: run.id, threadId: thread.id, callId: event.callId, capabilityId: event.capabilityId, input: event.input } }
      case 'tool.finished':
        return { type: 'agent.tool.finished', payload: { runId: run.id, threadId: thread.id, callId: event.callId, capabilityId: event.capabilityId, ok: event.ok, durationMs: event.durationMs } }
      case 'approval.requested':
        return { type: 'agent.approval.requested', payload: { approvalId: event.approvalId, runId: run.id, threadId: thread.id, capabilityId: event.capabilityId, input: event.input, expiresAt: event.expiresAt } }
      case 'approval.resolved':
        return { type: 'agent.approval.resolved', payload: { approvalId: event.approvalId, runId: run.id, threadId: thread.id, status: event.status, decidedBy: null } }
      case 'inbox.delivered':
        return { type: 'agent.message.delivered', payload: { inboxId: event.inboxId, targetRunId: run.id, fromRunId: event.fromRunId, kind: event.kind } }
    }
  }

  return {
    subscribe(ws, threadId) {
      let threadSet = subsByThread.get(threadId)
      if (!threadSet) {
        threadSet = new Set()
        subsByThread.set(threadId, threadSet)
      }
      threadSet.add(ws)
      let connSet = subsByConn.get(ws)
      if (!connSet) {
        connSet = new Set()
        subsByConn.set(ws, connSet)
      }
      connSet.add(threadId)
    },

    unsubscribe(ws, threadId) {
      subsByThread.get(threadId)?.delete(ws)
      subsByConn.get(ws)?.delete(threadId)
    },

    cancelRun(runId, cancelledBy) {
      deps.runner.cancelRun(runId, cancelledBy)
    },

    handleClose(ws) {
      const threadIds = subsByConn.get(ws)
      if (threadIds) {
        for (const threadId of threadIds) subsByThread.get(threadId)?.delete(ws)
      }
      subsByConn.delete(ws)
    },

    publish(thread, run, event) {
      const msg = toServerMessage(thread, run, event)
      for (const ws of targets(thread.id)) send(ws, msg)
    },

    publishRunStarted(thread, run) {
      const msg: ServerMessage = { type: 'agent.run.started', payload: { runId: run.id, threadId: thread.id, status: run.status } }
      for (const ws of targets(thread.id)) send(ws, msg)
    },

    publishRunFinished(thread, run) {
      const msg: ServerMessage = {
        type: 'agent.run.finished',
        payload: { runId: run.id, threadId: thread.id, status: run.status, stopReason: run.stopReason, errorClass: run.errorClass, usage: run.usage },
      }
      for (const ws of targets(thread.id)) send(ws, msg)
    },

    publishRaw(threadId, msg) {
      for (const ws of targets(threadId)) send(ws, msg)
    },
  }
}

/** Exported purely so `decideApproval`'s REST handler can broadcast the SAME `agent.approval.resolved` shape a run-driven resolution uses, without duplicating the payload construction. */
export function approvalResolvedMessage(approval: AgentApproval): ServerMessage {
  return {
    type: 'agent.approval.resolved',
    payload: { approvalId: approval.id, runId: approval.runId, threadId: approval.threadId, status: approval.status, decidedBy: approval.decidedBy },
  }
}
