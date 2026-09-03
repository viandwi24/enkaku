import { Hono } from 'hono'
import { createUIMessageStreamResponse } from 'ai'
import {
  AgentCommandsResponseSchema,
  ApprovalDecisionInputSchema,
  ApprovalResponseSchema,
  ApprovalsResponseSchema,
  CreateThreadInputSchema,
  ListThreadsResponseSchema,
  PostThreadMessageInputSchema,
  RunResponseSchema,
  ThreadDeletePreviewResponseSchema,
  ThreadDeleteResponseSchema,
  ThreadMessagesResponseSchema,
  ThreadResponseSchema,
  TreeResponseSchema,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { AgentRunner } from '../agent/runner'
import type { ThreadStore } from '../agent/thread/store'
import type { ApprovalStore } from '../agent/approval/store'
import { allPluginCommands } from '../agent/plugins'
import { approvalResolvedMessage, type AgentWsHandler } from '../server/ws-handlers-agent'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'
import { createAgentChatStream } from './agent-chat-stream'

/**
 * The agent chat REST surface (plan 66 §4.4): `POST /threads`,
 * `GET /threads/:id/messages?after=` (the fetch half of fetch-then-
 * subscribe, §3.4), `POST /threads/:id/messages` (starts a run),
 * `GET /runs/:id`, `POST /runs/:id/cancel`, `POST /approvals/:id`.
 *
 * Reading is `agent.view`; every action that TALKS to an agent (create a
 * thread, post a message, cancel a run, decide an approval) is `agent.run`
 * — deliberately not `agent.manage`, which governs the agent RECORD, not
 * operating an already-configured one (§4.4's own note, `auth/acl.ts`).
 */
export function createThreadRoutes(deps: { runner: AgentRunner; threads: ThreadStore; approvals: ApprovalStore; agentWs: AgentWsHandler; audit: AuditLogger }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { runner, threads, approvals, agentWs, audit } = deps

  app.get('/threads', requirePermission('agent.view'), (c) => {
    const agentId = c.req.query('agentId')
    return typedJson(c, ListThreadsResponseSchema, { threads: threads.listThreads(agentId ? { agentId } : undefined) })
  })

  // Plan 78 §3.6 — the ported composer's slash-command popover reads this instead of the plugin
  // registry knowing anything about a UI: a plugin's `commands` (plan 77 §4.3, inert until now)
  // appears here with no route change (criterion 8). `agent.view` — reading the assembled list is
  // not itself an action against any one agent.
  app.get('/agent-commands', requirePermission('agent.view'), (c) => typedJson(c, AgentCommandsResponseSchema, { commands: allPluginCommands() }))

  app.post('/threads', requirePermission('agent.run'), async (c) => {
    const body = CreateThreadInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const user = c.get('user')
    const thread = runner.createThread({
      agentId: body.data.agentId,
      title: body.data.title ?? null,
      deviceScope: body.data.deviceScope ?? null,
      createdBy: user?.id ?? null,
    })
    audit.record({ userId: user?.id ?? null, action: 'agent.thread.create', target: thread.id, meta: { agentId: thread.agentId } })
    return typedJson(c, ThreadResponseSchema, { thread }, 201)
  })

  app.get('/threads/:id', requirePermission('agent.view'), (c) => {
    const thread = threads.getThread(c.req.param('id'))
    if (!thread) throw new EnkakuError('thread_not_found', `no such thread: ${c.req.param('id')}`)
    return typedJson(c, ThreadResponseSchema, { thread })
  })

  // Plan 83 §3.6, §4.3 — read BEFORE a delete is confirmed, so the confirm dialog can name exactly
  // how many messages and runs are at stake (criterion 16) with the SAME count `deleteThread` itself
  // returns (never a second, possibly-stale computation).
  app.get('/threads/:id/delete-preview', requirePermission('agent.run'), (c) => {
    const counts = threads.countsForThread(c.req.param('id'))
    return typedJson(c, ThreadDeletePreviewResponseSchema, { counts })
  })

  // Plan 83 §3.6, §4.3 — deletes a thread and everything that points at it (runs, messages,
  // approvals, tree nodes) in one transaction. Refused, not force-killed, while a run is still
  // active — `deleteThread` throws `E_THREAD_RUN_ACTIVE` (mapped to 409 below), and the thread
  // survives intact (criterion 15). Blobs are deliberately untouched (§3.6).
  app.delete('/threads/:id', requirePermission('agent.run'), (c) => {
    const id = c.req.param('id')
    const counts = threads.deleteThread(id)
    audit.record({ userId: c.get('user')?.id ?? null, action: 'agent.thread.delete', target: id, meta: counts })
    return typedJson(c, ThreadDeleteResponseSchema, { deleted: true, counts })
  })

  // The fetch half of fetch-then-subscribe (plan 66 §3.4) — a client GETs history, THEN attaches
  // to the SSE stream (`agent-chat-stream.ts`). `/ws` itself never replays a snapshot (CLAUDE.md).
  app.get('/threads/:id/messages', requirePermission('agent.view'), (c) => {
    const id = c.req.param('id')
    const afterRaw = c.req.query('after')
    const after = afterRaw !== undefined ? Number(afterRaw) : undefined
    if (after !== undefined && !Number.isFinite(after)) throw new EnkakuError('E_BAD_REQUEST', 'after must be a number')
    const messages = threads.listMessages(id, after !== undefined ? { after } : undefined)
    return typedJson(c, ThreadMessagesResponseSchema, { messages })
  })

  app.post('/threads/:id/messages', requirePermission('agent.run'), async (c) => {
    const id = c.req.param('id')
    const body = PostThreadMessageInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const user = c.get('user')
    const run = runner.postMessage(id, body.data.text, user?.id ?? null, body.data.attachments)
    audit.record({ userId: user?.id ?? null, action: 'agent.thread.message', target: id, meta: { runId: run.id } })
    return typedJson(c, RunResponseSchema, { run }, 201)
  })

  // Plan 78 §4.3 — the ported `ai-elements` composer's transport. `useChat`'s `fetch` transport (NOT
  // `EventSource`, which cannot set the auth header — plan 78 §3.4) posts here and streams the
  // response back as AI SDK `UIMessageChunk`s. Behind the scenes this is the SAME `runner.postMessage`
  // the plain REST endpoint above uses (identical approval/activity/tree/budget path — see
  // `agent-chat-stream.ts`'s own header comment for why `agentUIResponse()` cannot be used directly).
  app.post('/threads/:id/chat', requirePermission('agent.run'), async (c) => {
    const id = c.req.param('id')
    const body = PostThreadMessageInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const user = c.get('user')
    const stream = createAgentChatStream({
      agentWs,
      threadId: id,
      signal: c.req.raw.signal,
      start: () => {
        const run = runner.postMessage(id, body.data.text, user?.id ?? null, body.data.attachments)
        audit.record({ userId: user?.id ?? null, action: 'agent.thread.message', target: id, meta: { runId: run.id } })
        return run
      },
    })
    return createUIMessageStreamResponse({ stream })
  })

  app.get('/runs/:id', requirePermission('agent.view'), (c) => {
    const run = threads.getRun(c.req.param('id'))
    if (!run) throw new EnkakuError('run_not_found', `no such run: ${c.req.param('id')}`)
    return typedJson(c, RunResponseSchema, { run })
  })

  app.get('/runs/:id/approvals', requirePermission('agent.view'), (c) => {
    const id = c.req.param('id')
    threads.mustGetRun(id)
    return typedJson(c, ApprovalsResponseSchema, { approvals: approvals.listForRun(id) })
  })

  // Plan 67 §4.4, §4.5 — the flat node list Studio's tree view reconstructs client-side.
  app.get('/runs/:id/tree', requirePermission('agent.view'), (c) => {
    const id = c.req.param('id')
    threads.mustGetRun(id)
    return typedJson(c, TreeResponseSchema, runner.getTree(id))
  })

  app.post('/runs/:id/cancel', requirePermission('agent.run'), (c) => {
    const id = c.req.param('id')
    const user = c.get('user')
    runner.cancelRun(id, user?.id ?? null)
    audit.record({ userId: user?.id ?? null, action: 'agent.run.cancel', target: id, meta: {} })
    // `cancelRun` above already throws `run_not_found` if `id` does not resolve, so `getRun` here
    // is guaranteed non-null in practice — this mirrors `GET /runs/:id`'s own explicit check so
    // `typedJson`'s non-nullable `RunResponseSchema` (correctly) still requires it to be proven.
    const run = threads.getRun(id)
    if (!run) throw new EnkakuError('run_not_found', `no such run: ${id}`)
    return typedJson(c, RunResponseSchema, { run })
  })

  app.post('/approvals/:id', requirePermission('agent.run'), async (c) => {
    const id = c.req.param('id')
    const body = ApprovalDecisionInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const user = c.get('user')
    const approval = runner.decideApproval(id, body.data.decision, user?.id ?? null)
    // Broadcast immediately — a decision should be visible the moment it is RECORDED, not only
    // once the run gets around to acting on it (which the run also re-emits when it does).
    agentWs.publishRaw(approval.threadId, approvalResolvedMessage(approval))
    audit.record({ userId: user?.id ?? null, action: 'agent.approval.decide', target: id, meta: { decision: body.data.decision } })
    return typedJson(c, ApprovalResponseSchema, { approval })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status =
        err.code === 'thread_not_found' || err.code === 'run_not_found' || err.code === 'approval_not_found' || err.code === 'agent_not_found'
          ? 404
          : err.code === 'E_ALREADY_DECIDED' || err.code === 'E_THREAD_RUN_ACTIVE'
            ? 409
            : ['E_BAD_REQUEST', 'E_AGENT_DISABLED', 'E_NO_CONNECTOR', 'E_NO_CREDENTIAL'].includes(err.code)
              ? 400
              : 500
      return c.json(err.toJSON(), status as 400)
    }
    throw err
  })

  return app
}
