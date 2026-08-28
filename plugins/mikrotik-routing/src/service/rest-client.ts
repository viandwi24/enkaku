import { messageOf, scrubSecrets, MikrotikRestError } from './errors'

/**
 * The REST client — basic auth, a configurable timeout, a TLS toggle, and a
 * base URL, per plan 122 §4.1/§4.9. Everything vendor-specific about
 * RouterOS is confined to this file and `router-driver.ts` (§4.1's own
 * argument for the `RouterDriver` seam): nothing above this layer knows the
 * words `src-address`, `lookup-only-in-table`, or `/rest/`.
 */

export interface MikrotikRestConfig {
  /**
   * Host, or host:port — no scheme. The scheme is derived from `tls` so an
   * operator cannot accidentally paste `https://` into a field that also has
   * its own TLS toggle and end up with two disagreeing sources of truth.
   */
  baseUrl: string
  username: string
  /** Never logged, never put in an error message — see `errors.ts`'s header. */
  password: string
  tls: boolean
  timeoutMs: number
}

/** `GET`/`PUT`/`PATCH`/`DELETE` verbs this client actually sends — the four `/routing/rule` supports (§4.1). */
export type RestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export class MikrotikRestClient {
  constructor(private readonly config: MikrotikRestConfig) {}

  /**
   * `path` starts with `/`, e.g. `/routing/rule` or `/routing/rule/*6` — the
   * plan's own evidence (§4.1) that a RouterOS `.id`'s leading `*` needs no
   * URL-encoding, so this never encodes the path segment itself.
   */
  private urlFor(path: string): string {
    const scheme = this.config.tls ? 'https' : 'http'
    return `${scheme}://${this.config.baseUrl}/rest${path}`
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`, 'utf8').toString('base64')}`
  }

  /**
   * One request, parsed. Never throws a raw `fetch`/library error — every
   * failure becomes a `MikrotikRestError` with a kind a caller (`doctor()`
   * above all) can branch on, and with the router password scrubbed from the
   * message as defence in depth (`errors.ts`'s header explains why the
   * primary defence is that nothing here ever interpolates it in the first
   * place).
   *
   * Returns `undefined` for an empty body (RouterOS's own `DELETE` response,
   * per the plan's evidence) rather than throwing a parse error over having
   * nothing to parse.
   */
  async request(method: RestMethod, path: string, body?: unknown): Promise<unknown> {
    const url = this.urlFor(path)
    const secrets = [this.config.password]
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader(),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError'
      const message = timedOut
        ? `the router did not answer ${method} ${path} within ${this.config.timeoutMs} ms`
        : `could not reach the router at ${this.config.baseUrl}: ${scrubSecrets(messageOf(err), secrets)}`
      throw new MikrotikRestError('network', message)
    }

    if (response.status === 401) {
      throw new MikrotikRestError('auth', `the router refused the configured credentials for ${method} ${path} (401)`, 401)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new MikrotikRestError(
        'http',
        `the router answered ${method} ${path} with HTTP ${response.status}${text ? `: ${scrubSecrets(text.slice(0, 300), secrets)}` : ''}`,
        response.status,
      )
    }

    const raw = await response.text().catch((err: unknown) => {
      throw new MikrotikRestError('network', `could not read the router's response to ${method} ${path}: ${scrubSecrets(messageOf(err), secrets)}`)
    })
    if (raw.length === 0) return undefined
    try {
      return JSON.parse(raw)
    } catch (err) {
      throw new MikrotikRestError('parse', `the router's response to ${method} ${path} was not valid JSON: ${scrubSecrets(messageOf(err), secrets)}`)
    }
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path)
  }

  /**
   * Plan 134 (M99) §4.4 — added for `/ping`, RouterOS's one REST endpoint that
   * DOES something rather than reading or writing a record. Kept off the
   * write-shaped verbs above deliberately: nothing this client `post`s may
   * change router state, and the only caller sends ICMP.
   */
  post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', path, body)
  }

  put(path: string, body: unknown): Promise<unknown> {
    return this.request('PUT', path, body)
  }

  patch(path: string, body: unknown): Promise<unknown> {
    return this.request('PATCH', path, body)
  }

  delete(path: string): Promise<unknown> {
    return this.request('DELETE', path)
  }
}
