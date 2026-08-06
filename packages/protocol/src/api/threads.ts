import { z } from 'zod'
import {
  AgentApprovalSchema,
  AgentMessageSchema,
  AgentRunSchema,
  AgentThreadSchema,
  AgentTreeResponseSchema,
} from '../messages/agent'

/** `GET /api/v1/threads?agentId=` (`packages/core/src/api/threads.ts`). */
export const ListThreadsResponseSchema = z.object({ threads: z.array(AgentThreadSchema) })

/** `GET/POST /api/v1/threads(/:id)`. */
export const ThreadResponseSchema = z.object({ thread: AgentThreadSchema })

/** `GET /api/v1/threads/:id/messages`. */
export const ThreadMessagesResponseSchema = z.object({ messages: z.array(AgentMessageSchema) })

/** `GET/POST /api/v1/runs/:id`, `POST /api/v1/threads/:id/messages`, `POST /api/v1/runs/:id/cancel`. */
export const RunResponseSchema = z.object({ run: AgentRunSchema })

/** `GET /api/v1/runs/:id/approvals`. */
export const ApprovalsResponseSchema = z.object({ approvals: z.array(AgentApprovalSchema) })

/** `POST /api/v1/approvals/:id`. */
export const ApprovalResponseSchema = z.object({ approval: AgentApprovalSchema })

/**
 * `GET /api/v1/runs/:id/tree` — `c.json(runner.getTree(id))`, returned BARE
 * (no wrapper), unlike almost every other route in this file.
 */
export const TreeResponseSchema = AgentTreeResponseSchema

/**
 * `GET /api/v1/agent-commands` (plan 78 §3.6, §4.2) — the assembled slash-
 * command list every `AgentPlugin.commands` (plan 77 §4.3, declared but
 * inert until this plan gives it a composer to populate) contributes, in
 * plugin registry order. A plugin adding a command makes it appear here
 * with no route change (criterion 8).
 */
export const AgentCommandSchema = z.object({ name: z.string(), description: z.string() })
export const AgentCommandsResponseSchema = z.object({ commands: z.array(AgentCommandSchema) })
export type AgentCommand = z.infer<typeof AgentCommandSchema>

/** Plan 83 §3.6, §4.3 — how much a thread carries, read BEFORE a delete is confirmed (criterion 16)
 * and returned again as the delete's own summary, so the two numbers can never drift apart. */
export const ThreadCountsSchema = z.object({ messages: z.number().int().nonnegative(), runs: z.number().int().nonnegative() })

/** `GET /api/v1/threads/:id/delete-preview` — read-only, names what a delete would remove. */
export const ThreadDeletePreviewResponseSchema = z.object({ counts: ThreadCountsSchema })

/** `DELETE /api/v1/threads/:id` — refused (not force-killed) while a run is still active. */
export const ThreadDeleteResponseSchema = z.object({ deleted: z.literal(true), counts: ThreadCountsSchema })
