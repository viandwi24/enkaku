import { z } from 'zod'

/**
 * The command console's shared shapes (plan 93 §4.3, step 93.4) — a fleet
 * command's target, its member/run statuses, and the wire projection of a
 * member and its output. This is the reconciliation both `command-console/
 * store.ts` (step 93.2) and `command-console/runner.ts` (step 93.3) flagged
 * in their own doc comments: each declared an identical shape LOCALLY
 * because this directory was off limits to them, on the explicit
 * understanding that "whichever later step builds the protocol package's
 * own copy reconciles the two." This file is that copy; `store.ts` and
 * `runner.ts` now import from here and re-export the same names so neither
 * file's own public surface changed shape for its existing callers/tests.
 */

/** `{deviceIds} | {clusterId} | {tags}` — what the operator asked for, before resolution (plan 93 §3.4, §4.3). */
export const CommandTargetSchema = z.union([
  z.object({ deviceIds: z.array(z.string()).min(1) }),
  z.object({ clusterId: z.string().min(1) }),
  z.object({ tags: z.array(z.string()).min(1) }),
])
export type CommandTarget = z.infer<typeof CommandTargetSchema>

/** `pending → running → ok | failed | skipped | cancelled` (plan 93 §3.4). `skipped` is a first-class outcome, not an absence. */
export const COMMAND_MEMBER_STATUSES = ['pending', 'running', 'ok', 'failed', 'skipped', 'cancelled'] as const
export const CommandMemberStatusSchema = z.enum(COMMAND_MEMBER_STATUSES)
export type CommandMemberStatus = z.infer<typeof CommandMemberStatusSchema>

/** Derived from member counts, never incremented (plan 93 §3.4, §4.5's `computeCommandRunStatus`). */
export const COMMAND_RUN_STATUSES = ['running', 'awaiting-continue', 'ok', 'failed', 'cancelled'] as const
export const CommandRunStatusSchema = z.enum(COMMAND_RUN_STATUSES)
export type CommandRunStatus = z.infer<typeof CommandRunStatusSchema>

/**
 * The wire projection of a member (plan 93 §3.6, §4.3) — deliberately
 * narrower than the store's own `CommandRunMemberInfo`: NO `stdout`/`stderr`
 * ever travels this way. Full output is fetched over HTTP, per device, on
 * demand (`GET /api/command-runs/:id/members/:deviceId/output`).
 */
export const CommandMemberSchema = z.object({
  deviceId: z.string(),
  seq: z.number().int(),
  stageIndex: z.number().int(),
  status: CommandMemberStatusSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  outputHash: z.string().nullable(),
  truncated: z.boolean(),
  /** `checkInputAllowed`'s own code + message, verbatim (plan 93 §3.8). Null unless `status === 'skipped'`. */
  skip: z.object({ code: z.string(), message: z.string() }).nullable(),
  error: z.string().nullable(),
})
export type CommandMember = z.infer<typeof CommandMemberSchema>

/** The body, carried ONCE per distinct output hash (plan 93 §3.6, §4.3). */
export const CommandOutputSchema = z.object({
  hash: z.string(),
  stdoutPreview: z.string(),
  stderrPreview: z.string(),
  previewTruncated: z.boolean(),
})
export type CommandOutput = z.infer<typeof CommandOutputSchema>

/** Per-run status rollup (plan 93 §3.4, §4.3). */
export const CommandCountsSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  running: z.number().int(),
  ok: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  cancelled: z.number().int(),
})
export type CommandCounts = z.infer<typeof CommandCountsSchema>
