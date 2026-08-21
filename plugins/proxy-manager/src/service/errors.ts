/**
 * Every coded failure the bridge can produce, and the one function that is
 * allowed to turn somebody else's error into one of them.
 *
 * ## Why a re-word rather than a re-throw
 *
 * A dialler's error is the single most likely place a credential leaks into
 * something a person reads (plan 112 §3.10). `socks`'s own errors are careful
 * — `Socks5 Authentication failed` says nothing — but a `SocksClientError`
 * carries an `options` property holding the whole proxy configuration,
 * **password included**, and anything that serialises an error object rather
 * than its `message` would put it in a log line. So nothing from the dialler
 * is ever re-thrown: a `ProxyError` is built fresh, from `message` only, and
 * `scrubSecrets` runs over the result as a second, independent net.
 *
 * The primary defence is that no code path interpolates a password into a
 * string. `scrubSecrets` is defence in depth for the paths we do not own — it
 * is not a licence to interpolate one and clean it up afterwards.
 */

/** The closed list. A code is operator-facing and appears on the row, so it is part of the interface. */
export const PROXY_ERROR_CODES = [
  /** The upstream refused the TCP connection outright (ECONNREFUSED, ENOTFOUND, EHOSTUNREACH). */
  'E_PROXY_UPSTREAM_UNREACHABLE',
  /** The upstream accepted TCP and then did not finish the handshake inside the deadline. */
  'E_PROXY_UPSTREAM_TIMEOUT',
  /** The upstream rejected our credentials, or demanded a method we cannot offer. */
  'E_PROXY_UPSTREAM_AUTH',
  /** The upstream spoke something we could not parse, or refused the destination. */
  'E_PROXY_UPSTREAM_PROTOCOL',
  /** Anything else that went wrong dialling the upstream. */
  'E_PROXY_UPSTREAM_DIAL',
  /** The local port is already taken — the failure everyone hits. */
  'E_PROXY_LISTEN_ADDR_IN_USE',
  /** Any other bind failure (EACCES on a privileged port, EADDRNOTAVAIL for a bind host that is not ours). */
  'E_PROXY_LISTEN_FAILED',
  /** The client spoke something this listener does not serve. */
  'E_PROXY_CLIENT_PROTOCOL',
  /**
   * Plan 117 §3.4. A `direct` upstream with `resolveThroughEgress` on could
   * not resolve the destination through the resolver bound to `bindAddress`.
   * **Thrown directly by `service/dial-direct.ts`, never through
   * `classifyDialError`, and never followed by a second lookup through the
   * host's default resolver.** A silent fallback there is the exact defect
   * this option exists to remove — see plan 117 §3.4 rule 1 and criterion 4.
   */
  'E_PROXY_DNS_EGRESS_FAILED',
  /**
   * `gost-provision.ts` was reached on a platform other than Windows — belt
   * to `upstream.ts`'s own dispatch, which is the only thing that is
   * supposed to call it and only ever does so on `win32`. Naming the
   * platform in `dialWindowsEgressBinding`'s own error keeps this one purely
   * "should be unreachable", never thrown in practice.
   */
  'E_PROXY_GOST_UNSUPPORTED_PLATFORM',
  /** `gost`'s own release zip did not contain `gost.exe` where this pack expects it — the release layout changed underneath a pinned version. */
  'E_PROXY_GOST_ARCHIVE_UNEXPECTED',
  /** The local `gost` helper process this pack spawned (Windows-only, plan 117 §12) exited, or never started, before a `direct` upstream could reach it. */
  'E_PROXY_GOST_UNAVAILABLE',
  /**
   * Plan 123 §4.2 row 4 / §4.3. `bindIsEffective()` (`./bind-probe.ts`)
   * measured that this runtime silently ignores the `direct` record's
   * `bindAddress`, and no `gost` workaround is reachable either —
   * `gost-provision.ts` refused it as `E_PROXY_GOST_UNSUPPORTED_PLATFORM`
   * (Windows-only by construction; widening it is plan 123 §9 Q4, explicitly
   * out of scope here).
   *
   * Thrown here (`upstream.ts`'s `createUpstream`, step 123.2) as a plain
   * `ProxyError` — this closed list is the dialler's own vocabulary, and
   * `createUpstream` has no way to stop a record reaching `starting`, only
   * `supervisor.ts`'s `startLocked` does. Step 123.3 is the OTHER half of
   * this code's story: `startLocked` catches this exact code specially and
   * re-runs `shared.ts`'s `validateProxyRecord` with
   * `bindWorkaroundUnavailable: true`, which is where the SAME code also
   * lives as a `PROXY_PROBLEM_CODES` entry — the pack's PRECONDITION
   * vocabulary (§3.3/§4.3), not a refusal-after-attempt. Two homes for one
   * code because two different vocabularies both need it: this file's is
   * "what the dialler threw", `shared.ts`'s is "what the record cannot yet
   * do and why".
   */
  'E_PROXY_BIND_INEFFECTIVE',
] as const

export type ProxyErrorCode = (typeof PROXY_ERROR_CODES)[number]

export class ProxyError extends Error {
  readonly code: ProxyErrorCode

  constructor(code: ProxyErrorCode, message: string) {
    super(message)
    this.name = 'ProxyError'
    this.code = code
  }
}

/**
 * Replace every occurrence of a secret with a marker.
 *
 * Longest-first, so a password that contains a username does not leave the
 * username's tail behind; and short values are skipped entirely, because
 * substring-replacing a three-character secret would mangle unrelated text
 * into unreadability while proving nothing (the same threshold and the same
 * reasoning as the farm's own `buildSecretRedactor`).
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const usable = secrets.filter((s) => typeof s === 'string' && s.length >= 8).sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of usable) out = out.split(secret).join('«redacted»')
  return out
}

/**
 * The forms a listener credential (plan 117 §4.4, `service/auth.ts`) can
 * appear in outside its own `proxy-auth:<id>` KV row: plaintext, and the
 * RFC 7617 base64 an HTTP client sends it as. A library's own error text, or a
 * header echoed back into a log line, is exactly where a credential leaks into
 * something a person reads — the same reasoning this file already applies to
 * the upstream password — so both forms are scrubbed rather than only the one
 * nothing here interpolates on purpose.
 *
 * Deliberately typed as a loose shape rather than importing `ListenerCredential`
 * from `./auth`: this file is the one every dial and bind error already flows
 * through, and it stays free of a dependency on the module that owns the wire
 * formats.
 */
export function listenerAuthSecrets(credential: { username: string; password: string }): string[] {
  return [credential.password, Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')]
}

/** `message` off an unknown throwable, and nothing else off it — never `options`, never a stringified object. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'unknown error'
}

/** A Node system error's `code`, when there is one. */
export function systemCodeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** The Node system error codes that mean "the upstream is not there", in either the `code` property or the message text. */
const UNREACHABLE_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET']

/**
 * Somebody else's dial failure → one of ours, with the credential removed.
 *
 * **A `SocksClientError` carries no `code` at all** *(measured, `socks@2.8.9`,
 * 2026-08-17: `Object.keys(err)` is `["options"]`, `err.code` is `undefined`,
 * and the message for a refused upstream is
 * `"connect ECONNREFUSED 127.0.0.1:63242"`)*. So the system code has to be
 * read out of the message text as well as off the property, and a first
 * attempt that only checked `err.code` classified a refused upstream as the
 * generic `E_PROXY_UPSTREAM_DIAL` — right behaviour, useless label.
 *
 * That same measurement is why nothing here touches anything but `.message`:
 * `err.options` is the whole `SocksClientOptions`, **`password` included**.
 * Anything that logged the error object, or `JSON.stringify`'d it, would put
 * the upstream password in a file.
 *
 * The classification degrades to `E_PROXY_UPSTREAM_DIAL` rather than guessing.
 */
export function classifyDialError(err: unknown, secrets: readonly string[]): ProxyError {
  if (err instanceof ProxyError) return err
  const raw = messageOf(err)
  const message = scrubSecrets(raw, secrets)
  const system = systemCodeOf(err)
  const lower = raw.toLowerCase()

  if (UNREACHABLE_CODES.some((code) => system === code || raw.includes(code))) {
    return new ProxyError('E_PROXY_UPSTREAM_UNREACHABLE', message)
  }
  if (system === 'ETIMEDOUT' || raw.includes('ETIMEDOUT') || lower.includes('timeout') || lower.includes('timed out')) {
    return new ProxyError('E_PROXY_UPSTREAM_TIMEOUT', message)
  }
  if (lower.includes('authentication') || lower.includes('auth failed') || lower.includes('no acceptable') || lower.includes('not allowed by ruleset')) {
    return new ProxyError('E_PROXY_UPSTREAM_AUTH', message)
  }
  if (lower.includes('socks') || lower.includes('proxy') || lower.includes('unexpected') || lower.includes('malformed')) {
    return new ProxyError('E_PROXY_UPSTREAM_PROTOCOL', message)
  }
  return new ProxyError('E_PROXY_UPSTREAM_DIAL', message)
}

/** A bind failure → one of ours, naming the port. `EADDRINUSE` gets its own code because it is the failure everyone hits. */
export function classifyBindError(err: unknown, bindHost: string, port: number): ProxyError {
  const system = systemCodeOf(err)
  if (system === 'EADDRINUSE') {
    return new ProxyError(
      'E_PROXY_LISTEN_ADDR_IN_USE',
      `${bindHost}:${port} is already in use — something else on this machine is listening there. Give this proxy another port, or stop whatever holds that one.`,
    )
  }
  return new ProxyError('E_PROXY_LISTEN_FAILED', `could not bind ${bindHost}:${port}: ${messageOf(err)}${system ? ` (${system})` : ''}`)
}
