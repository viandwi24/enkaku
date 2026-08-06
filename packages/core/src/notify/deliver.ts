import { signWebhookBody, webhookSignatureHeader } from './webhook'

/**
 * One HTTP attempt at delivering a webhook (plan 68 §4.4) — signed per §3.4,
 * bounded by `timeoutMs` via `AbortController` so a hanging receiver cannot
 * block the caller forever. `notify/service.ts` is what turns this into
 * "three attempts with backoff" (§3.4, §4.4); this function only ever makes
 * ONE call.
 */

export interface DeliveryAttemptResult {
  ok: boolean
  status?: number
  error?: string
}

export interface AttemptDeliveryDeps {
  fetch?: typeof fetch
  /** Unix seconds — injectable so a signature test can assert an exact value. */
  now?: () => number
}

export async function attemptWebhookDelivery(url: string, body: string, secret: string | null, deps: AttemptDeliveryDeps = {}, timeoutMs = 10_000): Promise<DeliveryAttemptResult> {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret) {
    const sig = signWebhookBody(body, secret, now())
    headers['X-Enkaku-Signature'] = webhookSignatureHeader(sig)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
