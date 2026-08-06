import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC-SHA256 signing for outbound webhook deliveries (plan 68 §3.4, §4.4,
 * criterion 10) — a receiver can verify who sent it, and a timestamp folded
 * into the signed material makes a replayed old delivery detectable
 * (`verifyWebhookSignature`'s `maxAgeSec` window is the receiver's own
 * choice of tolerance, not something the sender enforces).
 */

export interface WebhookSignature {
  timestamp: number
  signature: string
}

/** Signs `${timestamp}.${body}` — the timestamp is IN the signed material, not just alongside it, so a tampered timestamp also invalidates the signature. */
export function signWebhookBody(body: string, secret: string, timestamp: number = Math.floor(Date.now() / 1000)): WebhookSignature {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return { timestamp, signature: mac }
}

/** The `X-Enkaku-Signature` header value: `t=<unix seconds>,v1=<hex hmac>` — the same shape a receiver parses back with `parseWebhookSignatureHeader`. */
export function webhookSignatureHeader(sig: WebhookSignature): string {
  return `t=${sig.timestamp},v1=${sig.signature}`
}

export function parseWebhookSignatureHeader(header: string): WebhookSignature | null {
  const parts: Record<string, string> = {}
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim()
  }
  const timestamp = parts.t ? Number.parseInt(parts.t, 10) : Number.NaN
  if (!Number.isFinite(timestamp) || !parts.v1) return null
  return { timestamp, signature: parts.v1 }
}

/**
 * A receiver's verification (plan 68 §7's "a known body and secret produce
 * a known signature; a tampered body fails verification; the timestamp is
 * present and outside a window is rejectable"). Exported for this repo's
 * own webhook tests to act as "a local receiver" would, and equally usable
 * by a real external receiver written against this same scheme.
 */
export function verifyWebhookSignature(body: string, secret: string, header: string, opts?: { maxAgeSec?: number; now?: number }): boolean {
  const parsed = parseWebhookSignatureHeader(header)
  if (!parsed) return false
  const maxAgeSec = opts?.maxAgeSec ?? 300
  const now = opts?.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - parsed.timestamp) > maxAgeSec) return false
  const expected = createHmac('sha256', secret).update(`${parsed.timestamp}.${body}`).digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const gotBuf = Buffer.from(parsed.signature, 'hex')
  if (expectedBuf.length !== gotBuf.length) return false
  return timingSafeEqual(expectedBuf, gotBuf)
}
