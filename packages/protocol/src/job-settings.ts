import { z } from 'zod'

/**
 * The runtime job-hygiene shape (plan 35, plan 36, plan 74, plan 81, plan 97,
 * plan 98) - unchanged in field names and defaults by plan 212, which only
 * moved it OUT of `FarmSettingsSchema` (its visible/advanced fields now live
 * at `FarmSettings.jobRunner`/`FarmSettings.advanced`, and its
 * never-shown-in-Studio fields are constants in
 * `packages/core/src/config/constants.ts`). `daemon.ts`'s `jobConstants()`
 * helper reconstructs one of these from the farm's current settings, so the
 * job runner and workflow orchestrator (plan 211's own shape) never see a
 * change. No `ui()` here any more - nothing renders this as a form.
 */
/**
 * Session hygiene between jobs (plan 35 §4.1): what to reset on a device
 * before every job runs, so two jobs on one device stop inheriting each
 * other's application state. `resetPolicy` is one of four escalating levels
 * (plan 35 §3.3); `retry` is added by plan 36 to this same block, so the
 * shape here is deliberately a container rather than a flat set of fields.
 */
export const JobSettingsSchema = z
  .object({
    // `resetPolicy`/`resetTimeoutMs`/`resetStrict` are a maximal consecutive
    // run of `group: 'Reset'` (plan 95 §3.5, §5 step 95.4) — `retry` right
    // after them is already its own card (an object, K7), so it needs no
    // group of its own.
    resetPolicy: z
      .enum(['none', 'home', 'declared', 'aggressive'])
      .default('home')
      .describe(
        'What to reset on a device before each job. "home" returns to the launcher; "declared" also stops the packages a script declares; "aggressive" stops every non-system app.',
      )
      .meta({ title: 'Reset before each job', group: 'Reset' }),
    resetTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(15_000)
      .describe('Budget for the pre-job reset. Exceeding it logs a warning and the job continues.')
      .meta({ title: 'Reset timeout (ms)', kind: 'duration', unit: 'ms', group: 'Reset' }),
    resetStrict: z
      .boolean()
      .default(false)
      .describe('Fail the job when its pre-job reset fails, instead of warning and continuing.')
      .meta({ title: 'Fail on reset error', group: 'Reset' }),
    /**
     * Retry classification and backoff (plan 36 §4.2): infra failures (device
     * lost, adb timeout) draw from `maxInfraAttempts`, a budget separate from
     * `ScriptDefinition.retries` (§3.4) — a farm problem must never spend an
     * author's own retry count.
     */
    retry: z
      .object({
        maxInfraAttempts: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(2)
          .describe("Extra attempts allowed when a job fails for infrastructure reasons (device lost, adb timeout). Separate from a script's own retries.")
          .meta({ title: 'Infrastructure retries', kind: 'count' }),
        backoffBaseMs: z
          .number()
          .int()
          .min(100)
          .max(60_000)
          .default(2_000)
          .describe('First backoff delay; it doubles each infrastructure retry, with jitter.')
          .meta({ title: 'Retry backoff base (ms)', kind: 'duration', unit: 'ms' }),
        backoffMaxMs: z
          .number()
          .int()
          .min(1_000)
          .max(300_000)
          .default(30_000)
          .describe('Upper bound on the backoff delay.')
          .meta({ title: 'Retry backoff cap (ms)', kind: 'duration', unit: 'ms' }),
        timeoutIsInfra: z
          .boolean()
          .default(false)
          .describe('Treat a job timeout as an infrastructure failure rather than a script failure.')
          .meta({ title: 'Timeouts count as infrastructure' }),
        rebindOnInfra: z
          .boolean()
          .default(true)
          .describe('On an infrastructure failure, let a batch member move to another eligible device.')
          .meta({ title: 'Move batch members after infrastructure failures' }),
      })
      .default({ maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true })
      .meta({
        title: 'Retry classification',
        description: "Infrastructure failures retry with backoff, separately from a script's own retry budget.",
      }),
    /**
     * Crash detection's opt-in job failure (plan 37 §3.4). Three escalating
     * levels, defaulting to the middle one: a blanket "any crash fails the
     * job" would fail every run on a farm phone with one flaky OEM service,
     * so `declared` — matching only the script's own target package(s) — is
     * the default, and `ignore` restores pre-plan-37 behaviour exactly
     * (crashes are still recorded as `app.crashed` events either way; this
     * setting only controls whether one can fail a *job*).
     */
    crashPolicy: z
      .enum(['ignore', 'declared', 'any'])
      .default('declared')
      .describe(
        'Whether an application crash can fail a running job. "ignore" only records the event; "declared" fails the job when the script\'s own target package crashes; "any" fails it on any non-system crash.',
      )
      .meta({ title: 'Fail jobs on app crash' }),
    /**
     * Plan 74 §3.1, §4.1 — replaces the hard-coded `DEFAULT_TIMEOUT_MS`
     * (`job-runner.ts`, 300_000) that appeared in no settings screen, no
     * config file, and no environment variable. A script's own
     * `ScriptDefinition.timeout` still wins whenever it declares one; this is
     * only what applies when it does not.
     */
    defaultTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(86_400_000)
      .default(3_600_000)
      .describe("How long a job may run before it is killed, when its script does not declare its own timeout. A script's own `timeout` always wins.")
      .meta({ title: 'Default job timeout (ms)', kind: 'duration', unit: 'ms', group: 'Timeouts' }),
    /**
     * Plan 74 §3.2 — raising `defaultTimeoutMs` from the old 5-minute
     * hard-code to 60 minutes makes the pre-`ready` window twelve times
     * looser: the run timer used to be the only backstop for a child that
     * never starts. This is the real, short backstop for exactly that case,
     * armed at spawn and cleared the moment `ready` arrives — separate from
     * the run timeout, and classified as infrastructure (plan 36), never the
     * script's fault.
     */
    startupTimeoutMs: z
      .number()
      .int()
      .min(5_000)
      .max(600_000)
      .default(60_000)
      .describe("How long a job's process has to start and report ready before it is treated as broken. Separate from the run timeout.")
      .meta({ title: 'Job startup timeout (ms)', kind: 'duration', unit: 'ms', group: 'Timeouts' }),
    /**
     * Plan 74 §3.3 — off by default (`null`, no ceiling) because the user's
     * instruction is explicit: a script's own timeout has priority. Setting
     * this clamps a script's request, and the clamp is ALWAYS logged, naming
     * the script and both numbers — a job that dies early for an unexplained
     * reason is worse than one that runs long.
     */
    maxTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(86_400_000)
      .nullable()
      .default(null)
      .describe("An optional ceiling on what a script may request. Null means no ceiling — a script's own timeout is honoured however long. A clamp is logged, never silent.")
      .meta({ title: 'Maximum job timeout (ms)', kind: 'duration', unit: 'ms', group: 'Timeouts' }),
    /**
     * The script runtime envelope's memory field (plan 98 §3.5, §4.3) —
     * `defaultMaxRssBytes`/`maxRssBytes` mirrors `defaultTimeoutMs`/
     * `maxTimeoutMs`'s exact "offered, and off" shape (F7): both byte
     * fields default to `null` (no limit anywhere) so a farm that sets
     * neither and runs scripts that declare nothing sees no change at all.
     * `resolveRuntime` (`../runtime-envelope.ts`) is the one place these are
     * combined with a script's own `runtime.maxRssBytes` and a per-job
     * override. LIVE, fully enforced end to end (plan 98, step 98.3
     * "Measure before limiting" — status: implemented): the child
     * self-reports RSS on every sample (`packages/session/src/runner/
     * child-entry.ts`'s `rss` message), and `packages/session/src/runner/
     * job-runner.ts`'s `checkMemoryBreach` compares it against the resolved
     * `maxRssBytes` and calls `doAbort('memory', …)` once a sample reaches
     * the limit under `enforce: 'kill'` (a `warn` fires first, at 80% of the
     * limit, so a kill is never unexplained). `enforcement: 'sampled'` on the
     * two byte fields is not decoration: a memory breach is caught on the
     * NEXT sample interval, not prevented (§3.5) — the badge next to the
     * input in Studio reflects that honestly, not "unenforced."
     */
    memory: z
      .object({
        defaultMaxRssBytes: z
          .number()
          .int()
          .min(67_108_864)
          .max(17_179_869_184)
          .nullable()
          .default(null)
          .describe("The memory limit a job gets when its script does not declare its own `runtime.maxRssBytes`. Null means no default — the job runs with no memory limit at all.")
          .meta({ title: 'Default job memory limit', kind: 'bytes', group: 'Memory', enforcement: 'sampled' }),
        maxRssBytes: z
          .number()
          .int()
          .min(67_108_864)
          .max(17_179_869_184)
          .nullable()
          .default(null)
          .describe('An optional ceiling on what a script or a job override may request. Null means no ceiling. A clamp is logged, never silent — the same rule `job.maxTimeoutMs` already follows.')
          .meta({ title: 'Maximum job memory limit', kind: 'bytes', group: 'Memory', enforcement: 'sampled' }),
        enforce: z
          .enum(['kill', 'warn', 'off'])
          .default('kill')
          .describe('What happens on a memory breach, once a limit is in effect for that job. "kill" SIGKILLs immediately, no grace period. "warn" logs and lets the job continue. "off" does nothing.')
          .meta(
            {
              title: 'On a memory breach',
              group: 'Memory',
              labels: { kill: 'Kill the job', warn: 'Log a warning and continue', off: 'Do nothing' },
            },
          ),
        sampleIntervalMs: z
          .number()
          .int()
          .min(250)
          .max(30_000)
          .default(2_000)
          .describe('How often a running job reports its own memory use, when a limit is in effect. A breach is caught within one interval, not instantly.')
          .meta({ title: 'Memory sample interval (ms)', kind: 'duration', unit: 'ms', group: 'Memory', advanced: true }),
      })
      .default({ defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 })
      .meta({
        title: 'Memory',
        description: "A job's memory limit, and what happens when it is breached (plan 98). Enforced by sampling, not prevented — nothing here is wired to a kill until plan 98's own limit step lands.",
      }),
    /**
     * Bounds on `ctx.jobs.trigger()` (plan 81 §3.2) — the mechanism, not
     * guidance, that stops a runaway chain: every bound is a refusal
     * (`E_TRIGGER_TOO_DEEP` / `E_TRIGGER_CHAIN_FULL` / `E_TRIGGER_FAN_OUT`),
     * never a silent drop, and every check fails CLOSED — no parse failure,
     * timeout, or missing row may produce a deeper or longer chain (plan 67
     * §3.6's precedent, applied here).
     */
    trigger: z
      .object({
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(5)
          .describe('How many links a trigger chain may have. A job that triggers a job that triggers a job... is refused past this depth.')
          .meta({ title: 'Maximum trigger depth', kind: 'count' }),
        maxPerChain: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .default(200)
          .describe("The most jobs one chain may ever contain, counted from its root — the bound that actually stops a self-triggering script, since a chain that keeps re-rooting itself would otherwise never hit the depth limit.")
          .meta({ title: 'Maximum jobs per chain', kind: 'count' }),
        maxPerJob: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .default(10)
          .describe('How many jobs a single job may directly trigger, so one script cannot queue a thousand jobs in a loop.')
          .meta({ title: 'Maximum jobs triggered by one job', kind: 'count' }),
      })
      .default({ maxDepth: 5, maxPerChain: 200, maxPerJob: 10 })
      .meta({
        title: 'Job triggering',
        description: "Bounds on a running script's own ctx.jobs.trigger() calls — every one is a refusal a script sees as a throw, never a silent drop.",
      }),
    /**
     * Plan 97 §3.4, §4.1, §4.9 — the written size bound on a job's result,
     * measured in the CHILD before it ever crosses IPC (F10, F11). The
     * default matches `kv.maxValueBytes` exactly (plan 79) — the other place
     * a script persists structured JSON — on the stated principle "64 KiB is
     * what a script may hand the database as a value; anything larger is a
     * file" (§3.4). Raising it does not raise `kv.maxValueBytes`, and the
     * reverse: the two are equal by convention, not by a shared reference,
     * because an operator may reasonably need to widen one without the
     * other.
     */
    maxResultBytes: z
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(65_536)
      .describe('Largest result a script may return, in bytes. Larger output belongs in an artifact, not the result column.')
      .meta({ title: 'Max result size', kind: 'bytes', group: 'Jobs' }),
    /**
     * Plan 97 §3.7, §4.9 — the coalescing interval for `ctx.progress()`: at
     * most one push per interval, last value wins, never persisted. Not a
     * result — §3.7's own rule ("a result is a commitment; a progress is an
     * observation") is why this lives beside `maxResultBytes` rather than
     * inside a "streaming" concept this plan deliberately does not build.
     */
    progressIntervalMs: z
      .number()
      .int()
      .min(250)
      .max(10_000)
      .default(1_000)
      .describe('How often a running job may push a live progress snapshot.')
      .meta({ title: 'Progress interval', kind: 'duration', unit: 'ms', group: 'Jobs' }),
  })
  .default({
    resetPolicy: 'home',
    resetTimeoutMs: 15_000,
    resetStrict: false,
    retry: { maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true },
    crashPolicy: 'declared',
    defaultTimeoutMs: 3_600_000,
    startupTimeoutMs: 60_000,
    maxTimeoutMs: null,
    memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 },
    trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
    maxResultBytes: 65_536,
    progressIntervalMs: 1_000,
  })
  .meta({
    title: 'Jobs',
    description: 'Session hygiene between jobs — what gets cleaned up on a device before each run.',
  })
export type JobSettings = z.infer<typeof JobSettingsSchema>
