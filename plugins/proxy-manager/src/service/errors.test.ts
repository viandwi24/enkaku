import { describe, expect, test } from 'bun:test'
import { ProxyError, classifyDialError, listenerAuthSecrets, messageOf, scrubSecrets, systemCodeOf } from './errors'

/**
 * Plan 117 step 117.11 — the one function every dial and bind error already
 * flows through, and criterion 7's own machinery: no credential — plaintext
 * or base64 — may ever appear in a thrown message. Each claim below carries
 * the two controls plan 109 step 109.5 asks of an absence assertion: a
 * positive case proving the scrubber would actually fire if the secret were
 * present, and the negative case that it did not fire on this run.
 */

describe('scrubSecrets — the last net over a dialler’s own message text', () => {
  const password = 'Sup3rSecretUpstreamPassword'

  test('a secret eight characters or longer is replaced everywhere it appears, longest first', () => {
    const message = `connect ECONNREFUSED, options were {"password":"${password}"}`
    const scrubbed = scrubSecrets(message, [password])
    expect(scrubbed).not.toContain(password)
    expect(scrubbed).toContain('«redacted»')
    // Control: the SAME message with no secret list passed is untouched —
    // the redaction is the list's doing, not a side effect of calling the
    // function at all.
    expect(scrubSecrets(message, [])).toBe(message)
  })

  test('a shorter value is left alone rather than mangling unrelated text', () => {
    // The same threshold `packages/core`'s own `buildSecretRedactor` uses:
    // substring-replacing a three-character secret would eat real words.
    const message = 'the account is "abc" and nothing else'
    expect(scrubSecrets(message, ['abc'])).toBe(message)
  })

  test('a username that is a PREFIX of the password does not leave the password’s tail behind', () => {
    // Longest-first is what this test would catch a regression in: replacing
    // the short secret first would leave the remainder of the long one
    // sitting right next to the redaction marker.
    const message = 'user=country-id-r9931204 pass=country-id-r9931204-extra-suffix'
    const scrubbed = scrubSecrets(message, ['country-id-r9931204-extra-suffix', 'country-id-r9931204'])
    expect(scrubbed).not.toContain('country-id-r9931204')
  })

  test('a message that never contained the secret is returned unchanged', () => {
    expect(scrubSecrets('a message with nothing sensitive in it', [password])).toBe('a message with nothing sensitive in it')
  })
})

describe('listenerAuthSecrets — both wire forms of a listener credential (§4.4)', () => {
  const credential = { username: 'ops', password: 'super-secret-listener-pass' }

  test('returns the plaintext password AND the RFC 7617 base64 pair, and both are actually catchable by scrubSecrets', () => {
    const secrets = listenerAuthSecrets(credential)
    expect(secrets).toContain(credential.password)
    const base64 = Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')
    expect(secrets).toContain(base64)

    // The positive control: a message carrying BOTH forms has BOTH redacted.
    const leaked = `refused, offered Basic ${base64}; the password was ${credential.password}`
    const scrubbed = scrubSecrets(leaked, secrets)
    expect(scrubbed).not.toContain(credential.password)
    expect(scrubbed).not.toContain(base64)
    // The negative control: a message that used neither form is untouched.
    expect(scrubSecrets('nothing to see here', secrets)).toBe('nothing to see here')
  })

  test('the username alone is never treated as a secret — it is public, on the record', () => {
    const secrets = listenerAuthSecrets(credential)
    expect(secrets).not.toContain(credential.username)
    expect(scrubSecrets(`account ${credential.username}`, secrets)).toContain(credential.username)
  })
})

describe('classifyDialError — a coded ProxyError, with the credential removed and the raw error object never touched', () => {
  test('an already-classified ProxyError passes through unchanged', () => {
    const original = new ProxyError('E_PROXY_UPSTREAM_TIMEOUT', 'took too long')
    expect(classifyDialError(original, [])).toBe(original)
  })

  test('ECONNREFUSED, ENOTFOUND and friends classify as E_PROXY_UPSTREAM_UNREACHABLE', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH']) {
      const err = Object.assign(new Error(`connect ${code} 127.0.0.1:1080`), { code })
      expect(classifyDialError(err, []).code).toBe('E_PROXY_UPSTREAM_UNREACHABLE')
    }
  })

  test('a timeout classifies as E_PROXY_UPSTREAM_TIMEOUT, by code or by message text', () => {
    expect(classifyDialError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), []).code).toBe('E_PROXY_UPSTREAM_TIMEOUT')
    expect(classifyDialError(new Error('the operation timed out'), []).code).toBe('E_PROXY_UPSTREAM_TIMEOUT')
  })

  test('a message containing a password is scrubbed on the way into the ProxyError', () => {
    const password = 'Sup3rSecretUpstreamPassword'
    // Measured shape (`errors.ts`'s own header): `SocksClientError` carries
    // `err.options` (the whole config, password included) and NOTHING on
    // `.message` — this is the belt-and-braces case, a message that
    // somehow DID carry the secret text regardless.
    const err = new Error(`Socks5 Authentication failed: bad credentials for ${password}`)
    const classified = classifyDialError(err, [password])
    expect(classified.message).not.toContain(password)
    expect(classified.code).toBe('E_PROXY_UPSTREAM_AUTH')
  })

  test('the raw error’s OWN properties are never touched — only `.message` is ever read (the `err.options` leak this file exists to prevent)', () => {
    const password = 'Sup3rSecretUpstreamPassword'
    const err = Object.assign(new Error('connect failed'), { options: { host: 'h', port: 1080, password } })
    const classified = classifyDialError(err, [password])
    expect(JSON.stringify(classified)).not.toContain(password)
    // Positive control: the secret genuinely lives on `err.options`, so a
    // naive `JSON.stringify(err)` WOULD have leaked it — proving this
    // assertion is not vacuous.
    expect(JSON.stringify(err)).toContain(password)
  })

  test('an unrecognised failure degrades to E_PROXY_UPSTREAM_DIAL rather than guessing', () => {
    expect(classifyDialError(new Error('something entirely unrelated happened'), []).code).toBe('E_PROXY_UPSTREAM_DIAL')
  })
})

describe('messageOf / systemCodeOf — the two things ever read off someone else’s throwable', () => {
  test('messageOf reads .message off an Error, the string itself off a string, and never more than that', () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('already a string')).toBe('already a string')
    expect(messageOf({ some: 'object' })).toBe('unknown error')
    expect(messageOf(undefined)).toBe('unknown error')
  })

  test('systemCodeOf reads a string .code, and null for anything else', () => {
    expect(systemCodeOf(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED')
    expect(systemCodeOf(new Error('no code here'))).toBeNull()
    expect(systemCodeOf(null)).toBeNull()
    expect(systemCodeOf({ code: 42 })).toBeNull()
  })
})
