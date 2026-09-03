import { z } from 'zod'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.8.
 *
 * **`subject` is the one member `job.log` has no equivalent of**, and it is
 * what makes a per-subject view a predicate rather than a second stream. Plan
 * 112 (the proxy manager) needs "logs all, and logs per proxy" from one
 * plugin; N rings for N proxies would be core memory that scales with a list
 * an operator edits, and a deleted proxy would take its own history with it at
 * exactly the moment someone wanted to know why it was deleted. So there is
 * one ring per plugin, every line optionally tagged, and the HTTP page
 * carries the tag.
 *
 * A plugin sets it by passing a `subject` string in the ordinary `fields` bag
 * (`ctx.log.info('accepted', { subject: 'proxy:abc', conn: 12 })`); the core
 * lifts it out. That keeps `ctx.log`'s signature identical on both hosts — a
 * script handler and a service handler call the same four methods with the
 * same two arguments — instead of giving the service a logger the job child
 * cannot have.
 */

/** One retained line, as `GET /api/plugins/:name/runtime/logs` serves it. */
export const PluginLogLineSchema = z.object({
  seq: z.number().int(),
  ts: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  subject: z.string().nullable(),
  msg: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
})
export type PluginLogLine = z.infer<typeof PluginLogLineSchema>

/**
 * A page of retained lines.
 *
 * `truncated` is R3's honest flag and it means one specific thing: **lines
 * this reader will never see were dropped from the ring.** It is not "the
 * plugin has been quiet" and it is not "there is more to fetch" — `nextSeq` is
 * that. Without it a busy plugin's log reads as a plugin that started late.
 */
export const PluginLogPageSchema = z.object({
  plugin: z.string(),
  lines: z.array(PluginLogLineSchema),
  truncated: z.boolean(),
  /** The `seq` to pass as `?cursor=` next time — the highest retained, or the caller's own cursor when nothing new arrived. */
  nextSeq: z.number().int(),
  /** Echoed so a client can tell a filtered page from an empty plugin. */
  subject: z.string().nullable(),
})
export type PluginLogPage = z.infer<typeof PluginLogPageSchema>
