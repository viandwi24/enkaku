import { z } from 'zod'
import { CommandCountsSchema, CommandMemberSchema, CommandOutputSchema, CommandRunStatusSchema } from '../command/target'

/**
 * The command console's live WS surface (plan 93 §3.17, §4.3, step 93.4) —
 * events only. `POST /api/command-runs` (`api/command-runs.ts`) is the ONLY
 * way to start a run, including for N = 1 from the console; a client that
 * wants to watch one live sends `command.subscribe` after `GET`-ing the run
 * (`/ws` has no snapshot replay, spec §13).
 *
 * Subscriber-scoped, deliberately unlike `transfer.progress`/`transfer.done`
 * (plan 93 §0 finding F27, closed for THIS surface here): a fleet command's
 * output can contain anything a device prints, so `packages/core/src/server/
 * ws-handlers.ts`'s `commandTargets(runId)` fans these out only to
 * connections that sent `command.subscribe` for that run, never farm-wide.
 */

// ---- server -> client ----

/** Every member exists as `pending` from this first frame (plan 93 §3.5) — never a blank screen while a run drains. */
export const CommandStartedMessage = z.object({
  type: z.literal('command.started'),
  payload: z.object({
    runId: z.string(),
    cmd: z.string(),
    /** 1 = unstaged, 2 = a `stageFirstN` run (plan 93 §3.7). */
    stages: z.number().int(),
    members: z.array(CommandMemberSchema),
    counts: CommandCountsSchema,
  }),
})

/** Coalesced at most every 250ms, carrying only the deltas since the last tick (plan 93 §3.5, H2) — never one frame per member transition. */
export const CommandProgressMessage = z.object({
  type: z.literal('command.progress'),
  payload: z.object({ runId: z.string(), counts: CommandCountsSchema, changed: z.array(CommandMemberSchema) }),
})

/** Pushed once per DISTINCT output hash (plan 93 §3.6) — never once per device. */
export const CommandOutputMessage = z.object({
  type: z.literal('command.output'),
  payload: z.object({ runId: z.string(), output: CommandOutputSchema }),
})

/** A staged run entering (or leaving) `awaiting-continue` (plan 93 §3.7). */
export const CommandStageMessage = z.object({
  type: z.literal('command.stage'),
  payload: z.object({ runId: z.string(), stage: z.number().int(), of: z.number().int(), awaitingContinue: z.boolean() }),
})

export const CommandFinishedMessage = z.object({
  type: z.literal('command.finished'),
  payload: z.object({ runId: z.string(), status: CommandRunStatusSchema, counts: CommandCountsSchema, durationMs: z.number() }),
})

// ---- client -> server ----

export const CommandSubscribeMessage = z.object({
  type: z.literal('command.subscribe'),
  payload: z.object({ runId: z.string() }),
})

export const CommandUnsubscribeMessage = z.object({
  type: z.literal('command.unsubscribe'),
  payload: z.object({ runId: z.string() }),
})
