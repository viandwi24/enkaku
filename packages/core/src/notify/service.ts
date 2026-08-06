import type { NotificationContext, NotifySendInput, NotifySendOutput } from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'
import { attemptWebhookDelivery } from './deliver'
import type { NotificationStore } from './store'
import type { WebhookStore } from './webhook-store'

/**
 * `notify.send`'s rate limiter (plan 68 §3.4): "Rate-limited per agent
 * (default 10 per run, 100 per hour). Exceeding it is a `tool_result`
 * error, not a failed run." In-memory, exactly like `agent/runner.ts`'s
 * `deviceHolders`/queue maps — this farm is one process (00-overview §3:
 * "distributed scheduling across multiple cores" is out of scope), so
 * there is nowhere else a second counter could come from, and a restart
 * resetting the window is an acceptable, honest tradeoff for something
 * this cheap.
 */
export interface RateLimiter {
  /** Checked and recorded atomically — a caller never has to remember to call a separate `record()`. `runId` null (a human/REST/MCP caller, not from an agent run) skips the per-run half of the check. */
  checkAndRecord(agentId: string, runId: string | null): { ok: true } | { ok: false; reason: string }
}

export interface RateLimiterOptions {
  perRun?: number
  perHour?: number
  now?: () => number
}

export function createNotifyRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const perRun = opts.perRun ?? 10
  const perHour = opts.perHour ?? 100
  const now = opts.now ?? (() => Date.now())
  const runCounts = new Map<string, number>()
  const hourlyByAgent = new Map<string, number[]>()

  function pruneHourly(agentId: string): number[] {
    const cutoff = now() - 3_600_000
    const kept = (hourlyByAgent.get(agentId) ?? []).filter((t) => t > cutoff)
    hourlyByAgent.set(agentId, kept)
    return kept
  }

  return {
    checkAndRecord(agentId, runId) {
      if (runId) {
        const c = runCounts.get(runId) ?? 0
        if (c >= perRun) return { ok: false, reason: `this run has already sent ${perRun} notification(s), the per-run limit` }
      }
      const hourly = pruneHourly(agentId)
      if (hourly.length >= perHour) return { ok: false, reason: `this agent has already sent ${perHour} notification(s) in the last hour, the per-hour limit` }

      if (runId) runCounts.set(runId, (runCounts.get(runId) ?? 0) + 1)
      hourly.push(now())
      hourlyByAgent.set(agentId, hourly)
      return { ok: true }
    },
  }
}

export interface NotifySendOpts {
  /** `'agent:<id>'` | `'user:<id>'` | `'system'`. */
  source: string
  context: NotificationContext
  /** Null for a caller not acting as an agent (a human via REST/MCP) — the per-agent rate limit is skipped entirely in that case, matching "rate-limited per AGENT" (§3.4). */
  agentId: string | null
  runId: string | null
}

export interface NotifyServiceDeps {
  store: NotificationStore
  webhooks: WebhookStore
  rateLimiter: RateLimiter
  log: Logger
  /** Injectable for tests — never hits the network when a fake is supplied. */
  fetch?: typeof fetch
  /** How long the FIRST, synchronous attempt is allowed to run (plan 68 §4.4, criterion 13) — well under the capability's own 10s deadline, so a hanging receiver cannot consume it. Attempts #2/#3 (below) get the full 10s per §4.4 but run detached. */
  firstAttemptTimeoutMs?: number
  /** Backoff before retry attempts #2 and #3 — run OUTSIDE the capability's deadline (criterion 13), never awaited by `send()`. */
  retryDelaysMs?: [number, number]
  retryTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface NotifyService {
  send(input: NotifySendInput, opts: NotifySendOpts): Promise<NotifySendOutput>
}

/**
 * `notify/deliver.ts` plus `notify/store.ts` plus `notify/webhook-store.ts`,
 * assembled into the one operation `notify.send` calls (plan 68 §3.4, §4.4).
 *
 * The in-app row is written FIRST, unconditionally — before a single byte
 * is sent to any webhook (criterion 9: "writes an in-app notification even
 * when every webhook fails"). For each requested channel: an unknown or
 * disabled endpoint name is `failed` immediately, no network attempt. A
 * known, enabled endpoint gets ONE bounded, synchronous delivery attempt —
 * its outcome is what `delivered`/`failed` in the RETURN VALUE reflects, so
 * an agent gets an honest, immediate answer (§3.4's whole point — "a
 * notification tool that returns ok regardless of delivery is how an
 * on-call rotation discovers a broken webhook during an incident"). If that
 * first attempt fails, two more attempts run with backoff, fully DETACHED
 * (never awaited) — satisfying criterion 13 ("webhook delivery does not
 * consume the capability's deadline") without sacrificing an accurate
 * immediate signal for the common case (a live receiver answering quickly).
 */
export function createNotifyService(deps: NotifyServiceDeps): NotifyService {
  const firstAttemptTimeoutMs = deps.firstAttemptTimeoutMs ?? 5_000
  const retryDelaysMs = deps.retryDelaysMs ?? [2_000, 4_000]
  const retryTimeoutMs = deps.retryTimeoutMs ?? 10_000
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  function payloadFor(notificationId: string, input: NotifySendInput, context: NotificationContext, createdAt: number): string {
    return JSON.stringify({ id: notificationId, level: input.level, title: input.title, body: input.body ?? null, context, createdAt })
  }

  /** Attempts #2 and #3 — never awaited by `send()` (criterion 13). */
  async function retryInBackground(endpointId: string, url: string, body: string, secret: string | null): Promise<void> {
    for (const delayMs of retryDelaysMs) {
      await sleep(delayMs)
      const result = await attemptWebhookDelivery(url, body, secret, { fetch: deps.fetch }, retryTimeoutMs)
      if (result.ok) {
        deps.webhooks.recordDeliveryResult(endpointId, 'ok')
        return
      }
      deps.webhooks.recordDeliveryResult(endpointId, 'failed')
    }
    deps.log.warn(`webhook endpoint ${endpointId}: failed after 3 attempts (1 immediate + 2 retries)`)
  }

  async function send(input: NotifySendInput, opts: NotifySendOpts): Promise<NotifySendOutput> {
    if (opts.agentId) {
      const rl = deps.rateLimiter.checkAndRecord(opts.agentId, opts.runId)
      if (!rl.ok) throw new EnkakuError('E_RATE_LIMIT', rl.reason)
    }

    // §3.4 — written first, always.
    const notification = deps.store.create({ level: input.level, title: input.title, body: input.body ?? null, context: opts.context, source: opts.source })

    const delivered: string[] = []
    const failed: string[] = []
    const body = payloadFor(notification.id, input, opts.context, notification.createdAt)

    for (const name of input.channels ?? []) {
      const row = deps.webhooks.getRowByName(name)
      if (!row || !row.enabled) {
        failed.push(name)
        continue
      }
      const secret = deps.webhooks.resolveSecretFromRow(row)
      const result = await attemptWebhookDelivery(row.url, body, secret, { fetch: deps.fetch }, firstAttemptTimeoutMs)
      if (result.ok) {
        deps.webhooks.recordDeliveryResult(row.id, 'ok')
        delivered.push(name)
      } else {
        deps.webhooks.recordDeliveryResult(row.id, 'failed')
        failed.push(name)
        void retryInBackground(row.id, row.url, body, secret)
      }
    }

    return { notificationId: notification.id, delivered, failed }
  }

  return { send }
}
