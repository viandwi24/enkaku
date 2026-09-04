import { z } from 'zod'

/**
 * "Restart Enkaku" (plan 120 §3, §4) — the whole core process, not just the
 * shared adb server (`AdbRestartPreviewSchema`/`AdbRestartReportSchema` in
 * `./adb.ts`, plan 88 §3.10). Three deployment shapes need genuinely
 * different handling because a clean `process.exit()` or a self-respawn is
 * NOT safe in every one of them — see `packages/core/src/tools/supervision.ts`'s
 * own doc comment for the evidence (`docker-compose.yml`'s `restart:
 * unless-stopped`, `deploy/enkaku.service`'s `Restart=on-failure`, and the
 * complete absence of any supervisor for `bun run dev` or a bare release
 * binary).
 */
export const SupervisionModeSchema = z.enum(['docker', 'systemd', 'bare'])
export type SupervisionMode = z.infer<typeof SupervisionModeSchema>

/**
 * `GET /api/tools/app/restart-preview` — live counts fetched fresh right
 * before the confirmation dialog renders, mirroring `AdbRestartPreviewSchema`'s
 * own reasoning: the copy states THIS farm's numbers, never a generic
 * warning. `mode` is what lets Studio say what actually happens afterward —
 * "Enkaku restarts itself automatically" for `docker`/`systemd`, or the
 * verified handoff's own wording for `bare` — instead of promising a
 * guarantee the backend cannot keep.
 */
export const AppRestartPreviewSchema = z.object({
  mode: SupervisionModeSchema,
  devicesTotal: z.number(),
  /** Live sessions (wall tiles / control) that will stop. */
  sessionsActive: z.number(),
  /** Live control/command activities that will end. */
  controlled: z.number(),
  /** Jobs that will fail unless the restart is cancelled. */
  jobsRunning: z.number(),
})
export type AppRestartPreview = z.infer<typeof AppRestartPreviewSchema>

/**
 * `POST /api/tools/app/restart` — the operator-triggered restart's report.
 *
 * `outcome` is the honest half of this schema: `'verified'` is only ever
 * sent for `mode: 'bare'`, where the response is written by the ORIGINAL
 * process only after it already confirmed a freshly spawned copy answers
 * `GET /api/health` with `ok: true` — the same process that is about to
 * exit proves the replacement works before it does. `'initiated'` is what
 * `docker`/`systemd` mode always sends: for both, the report is written
 * (and the HTTP response flushed) a short beat BEFORE the process actually
 * exits, precisely because there is no way for a process to confirm its own
 * successor from inside a container about to be torn down or a unit about
 * to relaunch it — see `app-restart-control.ts`'s own doc comment for why
 * that ordering (respond, THEN exit) is deliberate and not a race.
 */
export const AppRestartReportSchema = z.object({
  mode: SupervisionModeSchema,
  outcome: z.enum(['initiated', 'verified']),
  durationMs: z.number(),
  sessionsClosed: z.number(),
  controlsEnded: z.number(),
  jobsFailed: z.array(z.string()),
})
export type AppRestartReport = z.infer<typeof AppRestartReportSchema>
