import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EnkakuError } from '../util/errors'

/**
 * A managed self-signed certificate for `tls.mode: 'self'`.
 *
 * Before this, `self` meant "I have already made a certificate somewhere and
 * here are its two paths" — `assertTlsPolicy` refused to boot without both.
 * So the shortest honest way to serve a farm over HTTPS on a LAN was a
 * remembered `openssl req -x509 …` incantation plus four environment
 * variables, re-run by hand every time it expired, and the owner was
 * carrying exactly that (2026-09-05). `self` now means what it reads like:
 * Enkaku owns the certificate. Point `certPath`/`keyPath` at your own files
 * and nothing here runs — that path is unchanged.
 *
 * This is deliberately NOT a certificate authority, and not a substitute for
 * one. A self-signed certificate encrypts the connection and nothing more:
 * every browser will warn, and it proves no identity. It is the right tool
 * for a farm on a trusted LAN and the wrong tool for anything reachable from
 * the internet, which is what `tls.mode: 'external'` (a real proxy with a
 * real certificate) is for.
 */

/** Where a managed pair lives. Its own directory, so `enkaku reset` can name it without touching anything else. */
export const TLS_DIR = 'tls'
export const SELF_SIGNED_CERT = 'self-signed.crt'
export const SELF_SIGNED_KEY = 'self-signed.key'

/**
 * 825 days — the CA/Browser Forum's cap on a publicly-trusted leaf, and the
 * longest validity Safari and Chrome accept without complaining about the
 * duration itself (they complain about the self-signing regardless). Longer
 * would not be "more convenient", it would be a certificate those browsers
 * reject for a second, more confusing reason.
 */
const VALIDITY_DAYS = 825

/**
 * Regenerate this long before expiry rather than on the day. A farm that
 * only gets restarted monthly would otherwise be able to boot on a
 * certificate with hours left on it.
 */
const RENEW_WITHIN_DAYS = 30

export interface SelfSignedPaths {
  certPath: string
  keyPath: string
}

export function selfSignedPaths(dataDir: string): SelfSignedPaths {
  return {
    certPath: join(dataDir, TLS_DIR, SELF_SIGNED_CERT),
    keyPath: join(dataDir, TLS_DIR, SELF_SIGNED_KEY),
  }
}

/**
 * The subject alternative names the certificate must carry.
 *
 * A browser has ignored the Common Name since 2017: a certificate without a
 * matching SAN entry fails with `ERR_CERT_COMMON_NAME_INVALID` no matter
 * what its CN says. `0.0.0.0` is a bind address, never an address anything
 * connects TO, so it is expanded rather than copied: binding to every
 * interface means the operator will reach the farm on some LAN address this
 * process cannot know, so the loopback names are what the certificate can
 * honestly cover, plus whatever `extraNames` the caller supplies.
 */
export function subjectAltNames(host: string, extraNames: readonly string[] = []): string[] {
  const names = new Set<string>(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1'])
  const bindsEverything = host === '0.0.0.0' || host === '::' || host === ''
  if (!bindsEverything) names.add(isIpLiteral(host) ? `IP:${host}` : `DNS:${host}`)
  for (const name of extraNames) {
    const trimmed = name.trim()
    if (trimmed.length > 0) names.add(isIpLiteral(trimmed) ? `IP:${trimmed}` : `DNS:${trimmed}`)
  }
  return [...names]
}

function isIpLiteral(value: string): boolean {
  return /^[0-9.]+$/.test(value) || value.includes(':')
}

/** Days until the certificate at `certPath` expires, or `null` if that cannot be read. */
export async function daysUntilExpiry(certPath: string, now: Date = new Date()): Promise<number | null> {
  const proc = Bun.spawn(['openssl', 'x509', '-in', certPath, '-noout', '-enddate'], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) return null
  const match = /notAfter=(.+)/.exec(out.trim())
  if (!match) return null
  const expires = new Date(match[1]!)
  if (Number.isNaN(expires.getTime())) return null
  return Math.floor((expires.getTime() - now.getTime()) / 86_400_000)
}

/**
 * Returns the managed pair, generating it first if it is missing, unreadable
 * or close to expiry. Idempotent: a valid pair is returned untouched, so this
 * is safe to call on every boot.
 *
 * `openssl` is required and is not vendored. It ships with macOS and every
 * mainstream Linux; where it is absent the error below says exactly what to
 * run and which two variables to set, because a silent fall back to plain
 * HTTP on a config that asked for TLS is the ws-scrcpy mistake this codebase
 * names in `assertTlsPolicy` — the operator would believe they were
 * encrypted and would not be.
 */
export async function ensureSelfSignedCert(opts: {
  dataDir: string
  host: string
  extraNames?: readonly string[]
  log?: { info: (m: string) => void; warn: (m: string) => void }
  now?: Date
}): Promise<SelfSignedPaths> {
  const paths = selfSignedPaths(opts.dataDir)
  const now = opts.now ?? new Date()

  const reuse = await reusableReason(paths, now)
  if (reuse === null) return paths

  opts.log?.info(`tls: generating a self-signed certificate in ${join(opts.dataDir, TLS_DIR)} (${reuse})`)
  mkdirSync(join(opts.dataDir, TLS_DIR), { recursive: true })

  const names = subjectAltNames(opts.host, opts.extraNames)
  const proc = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      String(VALIDITY_DAYS),
      // No passphrase: the core has to read this key unattended at boot, and
      // a passphrase it stores beside the key protects nothing.
      '-nodes',
      '-keyout',
      paths.keyPath,
      '-out',
      paths.certPath,
      '-subj',
      '/CN=Enkaku farm',
      '-addext',
      `subjectAltName=${names.join(',')}`,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new EnkakuError(
      'E_TLS_SELF_SIGN_FAILED',
      `could not generate a self-signed certificate with openssl (exit ${code}). ${stderr.trim()}\n` +
        'Generate one yourself and point Enkaku at it instead:\n' +
        `  openssl req -x509 -newkey rsa:2048 -sha256 -days ${VALIDITY_DAYS} -nodes -keyout key.pem -out cert.pem -subj "/CN=Enkaku farm" -addext "subjectAltName=${names.join(',')}"\n` +
        '  ENKAKU_TLS_CERT=cert.pem ENKAKU_TLS_KEY=key.pem',
    )
  }

  // 0600 on the key. `openssl` already writes it that way on POSIX; this is
  // the belt for a umask that says otherwise, and a no-op on Windows.
  try {
    const { chmodSync } = require('node:fs') as typeof import('node:fs')
    chmodSync(paths.keyPath, 0o600)
  } catch {
    // Best-effort: a platform without POSIX modes must not fail the boot.
  }

  opts.log?.warn(
    'tls: this certificate is self-signed — it encrypts the connection but proves no identity, so every browser will warn on first visit. ' +
      'For anything reachable outside a trusted network, use tls.mode "external" behind a proxy with a real certificate.',
  )
  return paths
}

/** `null` = the pair on disk is fine; otherwise the reason it has to be replaced. */
async function reusableReason(paths: SelfSignedPaths, now: Date): Promise<string | null> {
  if (!existsSync(paths.certPath) || !existsSync(paths.keyPath)) return 'none found'
  // A zero-byte file is what a killed `openssl` leaves behind, and Bun.serve
  // fails on it much later and much less clearly than this does.
  if (statSync(paths.certPath).size === 0 || statSync(paths.keyPath).size === 0) return 'the existing pair is empty'
  const days = await daysUntilExpiry(paths.certPath, now)
  if (days === null) return 'the existing certificate could not be read'
  if (days <= RENEW_WITHIN_DAYS) return days < 0 ? `the existing certificate expired ${-days} day(s) ago` : `the existing certificate expires in ${days} day(s)`
  return null
}
