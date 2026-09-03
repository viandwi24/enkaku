import { z } from 'zod'

/**
 * The agent chat protocol (plan 66 §3.1, §3.4, §4.1) — threads, runs, and
 * append-only messages, streamed over the EXISTING `/ws` (Studio is a
 * static export; there is no route handler for an SSE-over-BFF transport).
 *
 * `CLAUDE.md`'s rule shapes every message here: `/ws` has NO SNAPSHOT
 * REPLAY. Attaching to a run is `GET /api/v1/threads/:id/messages?after=`
 * for history, then the SSE stream (`GET /api/v1/threads/:id/stream`,
 * `packages/core/src/api/agent-chat-stream.ts`) for live updates from that point —
 * never a subscribe that replays. Messages carry a monotonic `seq` within
 * their thread (enforced unique by `(threadId, seq)` in
 * `packages/core/src/db/schema.ts`) so a client can detect a gap between
 * the fetch and the subscription and re-fetch, rather than rendering a hole.
 */

export const AgentMessageRoleSchema = z.enum(['user', 'assistant', 'tool', 'system'])
export type AgentMessageRole = z.infer<typeof AgentMessageRoleSchema>

export const AgentTextBlockSchema = z.object({ type: z.literal('text'), text: z.string() })
export const AgentThinkingBlockSchema = z.object({ type: z.literal('thinking'), text: z.string() })
export const AgentToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

/** The four media types a blob may hold (plan 70 §3.5) — decided by sniffing magic bytes, never a declared `Content-Type` or a filename. */
export const AgentImageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export type AgentImageMediaType = z.infer<typeof AgentImageMediaTypeSchema>

/**
 * A reference to a content-addressed blob (plan 70 §3.4, §4.2) — never the
 * base64 bytes themselves, which live once in `agent_blobs` and are
 * rebuilt for the provider only at request-assembly time. Carries
 * `width`/`height` so §3.6's per-request image budget can be reasoned about
 * without decoding anything.
 */
export const AgentImageRefSchema = z.object({
  type: z.literal('image'),
  blobId: z.string(),
  mediaType: AgentImageMediaTypeSchema,
  bytes: z.number().int(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
})
export type AgentImageRef = z.infer<typeof AgentImageRefSchema>

/** A `tool_result`'s own content is a list of blocks now — text and/or one or more images (plan 70 §3.2), never a bare string. */
export const ToolResultContentSchema = z.discriminatedUnion('type', [AgentTextBlockSchema, AgentImageRefSchema])
export type ToolResultContent = z.infer<typeof ToolResultContentSchema>

export const AgentToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.array(ToolResultContentSchema),
  isError: z.boolean().optional(),
})
/** One content block of an appended message — text, thinking, a tool call, a tool result, or (plan 70 §3.5) an image a PERSON attached. */
export const AgentContentBlockSchema = z.discriminatedUnion('type', [
  AgentTextBlockSchema,
  AgentThinkingBlockSchema,
  AgentToolUseBlockSchema,
  AgentToolResultBlockSchema,
  AgentImageRefSchema,
])
export type AgentContentBlock = z.infer<typeof AgentContentBlockSchema>

/** One append-only turn (plan 66 §3.1, §4.1) — user, assistant, tool, or system. */
export const AgentMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  runId: z.string().nullable(),
  /** Monotonic within the thread — the client's gap detector (§3.4). */
  seq: z.number().int(),
  role: AgentMessageRoleSchema,
  content: z.array(AgentContentBlockSchema),
  createdAt: z.number().int(),
})
export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const AgentRunStatusSchema = z.enum(['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'])
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>

/** Why a run ended (plan 66 §3.2, §3.8) — every budget fails closed with its own named reason. */
export const AgentStopReasonSchema = z.enum(['done', 'max-steps', 'max-seconds', 'max-tokens', 'loop-detected', 'cancelled', 'error'])
export type AgentStopReason = z.infer<typeof AgentStopReasonSchema>

/** Provider error classification (plan 66 §3.8). `capability` is not really an error of the run — a refused tool call becomes a `tool_result` instead. */
export const AgentErrorClassSchema = z.enum(['auth', 'rate-limit', 'overloaded', 'context-overflow', 'invalid-request', 'capability'])
export type AgentErrorClass = z.infer<typeof AgentErrorClassSchema>

export const AgentUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  costUsd: z.number().min(0).nullable(),
})
export type AgentUsage = z.infer<typeof AgentUsageSchema>

export const AgentThreadOriginSchema = z.enum(['chat', 'schedule', 'spawn'])
export type AgentThreadOrigin = z.infer<typeof AgentThreadOriginSchema>

export const AgentThreadSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string().nullable(),
  origin: AgentThreadOriginSchema,
  /**
   * Plan 68 §3.5 — whether a destructive capability reached from a run on
   * THIS thread pauses for a human (`pause`, ordinary Plan 66 behaviour) or
   * is denied at once with a truthful `tool_result` (`deny`). Set from the
   * originating schedule's own `onApprovalRequired` for a `'schedule'`
   * thread; `'pause'` for every other origin — a human in a chat is already
   * watching, so there is no "nobody will answer" case to degrade out of.
   */
  onApprovalRequired: z.enum(['pause', 'deny']),
  /**
   * Plan 73 §4.6 — set when this thread was opened from a device page ("Ask
   * an agent"): every run created in it (the opening message and every one
   * after) is narrowed to exactly these device ids, feeding the SAME
   * per-run `deviceGrantsOverride` mechanism plan 67 §4.2 built for
   * `agent.spawn`. Null for an ordinary thread — no extra narrowing beyond
   * the agent's own `deviceGrants`.
   */
  deviceScope: z.array(z.string()).nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type AgentThread = z.infer<typeof AgentThreadSchema>

export const AgentRunSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  status: AgentRunStatusSchema,
  stopReason: AgentStopReasonSchema.nullable(),
  errorClass: AgentErrorClassSchema.nullable(),
  error: z.string().nullable(),
  steps: z.number().int(),
  usage: AgentUsageSchema.nullable(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  /** Plan 67 §3.4, §4.1 — the run this one was spawned by (`agent.spawn`); null for a root. */
  parentRunId: z.string().nullable(),
  /** Plan 67 §3.6, §4.1 — the root's own id; equals `id` for a root. */
  rootRunId: z.string(),
  /** Plan 67 §3.6, §4.1 — root = 1, its children = 2, and so on. Capped (default 3). */
  depth: z.number().int(),
  /** Plan 67 §3.2, §4.1 — true while a parent is parked on this run's result (`waitFor: true`). */
  awaited: z.boolean(),
  /** Plan 67 §4.2 — `agent.spawn`'s `deviceIds`, when given: narrows THIS run's device grants below
   * the authority intersection. Null means no extra narrowing beyond the intersection itself. */
  deviceGrantsOverride: z.array(z.string()).nullable(),
})
export type AgentRun = z.infer<typeof AgentRunSchema>

/**
 * The run tree's shape, for the Studio tree view (plan 67 §4.4, §4.5) — a
 * FLAT list rather than a recursive structure (Zod's recursive schemas are
 * awkward to type-infer cleanly); the client reconstructs the tree from
 * each node's `parentRunId`. `GET /api/v1/runs/:id/tree` returns this for
 * any run in a tree, keyed off that run's `rootRunId`.
 */
export const AgentTreeNodeSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  parentRunId: z.string().nullable(),
  depth: z.number().int(),
  agentId: z.string(),
  agentName: z.string(),
  status: AgentRunStatusSchema,
  stopReason: AgentStopReasonSchema.nullable(),
  steps: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  /** Every device this run currently holds the tree's shared control lease on (plan 67 §3.7). */
  drivingDeviceIds: z.array(z.string()),
})
export type AgentTreeNode = z.infer<typeof AgentTreeNodeSchema>

export const AgentTreeResponseSchema = z.object({
  rootRunId: z.string(),
  nodes: z.array(AgentTreeNodeSchema),
})
export type AgentTreeResponse = z.infer<typeof AgentTreeResponseSchema>

export const AgentApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired'])
export type AgentApprovalStatus = z.infer<typeof AgentApprovalStatusSchema>

/** A paused destructive capability call (plan 66 §3.6) — carries the EXACT input, because that is where an injected instruction becomes visible. */
export const AgentApprovalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  threadId: z.string(),
  capabilityId: z.string(),
  /** The exact `tool_use.id` this approval gates — unambiguous even when a step carries more than one gated call. */
  toolCallId: z.string(),
  input: z.unknown(),
  status: AgentApprovalStatusSchema,
  decidedBy: z.string().nullable(),
  decidedAt: z.number().int().nullable(),
  expiresAt: z.number().int(),
  createdAt: z.number().int(),
})
export type AgentApproval = z.infer<typeof AgentApprovalSchema>

/** `POST /api/v1/threads` body. */
export const CreateThreadInputSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable().optional(),
  /** Plan 73 §4.6 — "Ask an agent" from a device page: narrows every run this thread ever starts. */
  deviceScope: z.array(z.string()).min(1).optional(),
})
export type CreateThreadInput = z.infer<typeof CreateThreadInputSchema>

/**
 * `POST /api/v1/threads/:id/messages` body — starts a run. Plan 70 §3.5, §4.2:
 * a message that is only an image is legitimate ("what is wrong with this
 * screen?"), so `text` no longer requires at least one character — the
 * refinement below requires text OR at least one attachment instead.
 * `attachments` names blob ids already uploaded via `POST /api/v1/blobs`
 * (two steps rather than one multipart body, so a retried send never
 * re-uploads and the composer can show a thumbnail before sending).
 */
export const PostThreadMessageInputSchema = z
  .object({
    text: z.string().default(''),
    attachments: z.array(z.string()).max(10).optional(),
  })
  .refine((v) => v.text.trim().length > 0 || (v.attachments?.length ?? 0) > 0, {
    message: 'a message needs text, an attachment, or both',
  })
export type PostThreadMessageInput = z.infer<typeof PostThreadMessageInputSchema>

/** `POST /api/v1/approvals/:id` body. */
export const ApprovalDecisionInputSchema = z.object({
  decision: z.enum(['approve', 'deny']),
})
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>

/**
 * `POST /api/v1/blobs`'s response (plan 70 §3.5) — a person attaches an
 * image in two steps (upload, then reference the id in a message) rather
 * than one multipart body, so the composer can show a thumbnail and size
 * before anything is sent, and a retried send never re-uploads.
 */
export const AgentBlobInfoSchema = z.object({
  blobId: z.string(),
  mediaType: AgentImageMediaTypeSchema,
  bytes: z.number().int(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
})
export type AgentBlobInfo = z.infer<typeof AgentBlobInfoSchema>

// ---------------------------------------------------------------------------
// WS — client → server
// ---------------------------------------------------------------------------

/** §3.7's six-step cancellation, triggered over WS (also reachable via `POST /api/v1/runs/:id/cancel`). */
export const AgentRunCancelMessage = z.object({
  type: z.literal('agent.run.cancel'),
  id: z.string().optional(),
  payload: z.object({ runId: z.string() }),
})

// ---------------------------------------------------------------------------
// WS — server → client
// ---------------------------------------------------------------------------

export const AgentRunStartedMessage = z.object({
  type: z.literal('agent.run.started'),
  payload: z.object({ runId: z.string(), threadId: z.string(), status: AgentRunStatusSchema }),
})

export const AgentRunFinishedMessage = z.object({
  type: z.literal('agent.run.finished'),
  payload: z.object({
    runId: z.string(),
    threadId: z.string(),
    status: AgentRunStatusSchema,
    stopReason: AgentStopReasonSchema.nullable(),
    errorClass: AgentErrorClassSchema.nullable(),
    usage: AgentUsageSchema.nullable(),
  }),
})

/** A text or thinking delta, arriving WHILE the model is still generating (§3.4, acceptance #5). */
export const AgentDeltaMessage = z.object({
  type: z.literal('agent.delta'),
  payload: z.object({
    runId: z.string(),
    threadId: z.string(),
    seq: z.number().int(),
    kind: z.enum(['text', 'thinking']),
    text: z.string(),
  }),
})

/** A complete appended message — the persisted record, broadcast once it is written. */
export const AgentMessageAppendedMessage = z.object({
  type: z.literal('agent.message'),
  payload: z.object({ message: AgentMessageSchema }),
})

/** Carries the input BEFORE the call runs (§3.4) — a person watching an agent tap a phone needs to see what it is about to tap, at the moment it happens. */
export const AgentToolStartedMessage = z.object({
  type: z.literal('agent.tool.started'),
  payload: z.object({
    runId: z.string(),
    threadId: z.string(),
    callId: z.string(),
    capabilityId: z.string(),
    input: z.unknown(),
  }),
})

export const AgentToolFinishedMessage = z.object({
  type: z.literal('agent.tool.finished'),
  payload: z.object({
    runId: z.string(),
    threadId: z.string(),
    callId: z.string(),
    capabilityId: z.string(),
    ok: z.boolean(),
    durationMs: z.number(),
  }),
})

/** A `destructive` capability (or one on the agent's `requiresApproval` list) paused the run (§3.6) — shows the EXACT input. */
export const AgentApprovalRequestedMessage = z.object({
  type: z.literal('agent.approval.requested'),
  payload: z.object({
    approvalId: z.string(),
    runId: z.string(),
    threadId: z.string(),
    capabilityId: z.string(),
    input: z.unknown(),
    expiresAt: z.number().int(),
  }),
})

export const AgentApprovalResolvedMessage = z.object({
  type: z.literal('agent.approval.resolved'),
  payload: z.object({
    approvalId: z.string(),
    runId: z.string(),
    threadId: z.string(),
    status: AgentApprovalStatusSchema,
    decidedBy: z.string().nullable(),
  }),
})

// ---------------------------------------------------------------------------
// Run tree (plan 67 §3.2, §3.3, §4.4) — a child starting/finishing, and a
// message's queued→delivered transition, so "sent but not yet delivered"
// (§3.3) is visible on the wire instead of looking like a lost message.
// ---------------------------------------------------------------------------

export const AgentChildStartedMessage = z.object({
  type: z.literal('agent.child.started'),
  payload: z.object({ parentRunId: z.string(), childRunId: z.string(), childThreadId: z.string(), agentId: z.string(), depth: z.number().int() }),
})

export const AgentChildFinishedMessage = z.object({
  type: z.literal('agent.child.finished'),
  payload: z.object({
    parentRunId: z.string(),
    childRunId: z.string(),
    status: AgentRunStatusSchema,
    stopReason: AgentStopReasonSchema.nullable(),
  }),
})

/** Written the instant `agent.send`/`agent.reply` append to the inbox (§3.3) — before delivery. */
export const AgentMessageQueuedMessage = z.object({
  type: z.literal('agent.message.queued'),
  payload: z.object({ inboxId: z.string(), targetRunId: z.string(), fromRunId: z.string().nullable(), kind: z.enum(['message', 'child-result']) }),
})

/** Written when the target's loop actually drains it, at its next turn boundary (§3.3). */
export const AgentMessageDeliveredMessage = z.object({
  type: z.literal('agent.message.delivered'),
  payload: z.object({ inboxId: z.string(), targetRunId: z.string(), fromRunId: z.string().nullable(), kind: z.enum(['message', 'child-result']) }),
})
