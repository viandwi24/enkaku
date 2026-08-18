import { describe, expect, test } from 'bun:test'
import { desc, eq } from 'drizzle-orm'
import { auditLog, devices } from '../db/schema'
import { makeRouteHarness, type RouteHarness } from './route-service.fixture'

/**
 * `POST /api/devices/:id/network/credential/reveal` — the audited read-back of a
 * device's stored upstream password.
 *
 * The three properties worth proving here are not "it returns the password".
 * They are:
 *
 * 1. **The password is only ever on THIS route.** `GET /:id/network` is what the
 *    device panel polls, and the assertion that it carries no plaintext (and no
 *    ciphertext either) is what makes the reveal's audit row meaningful — a
 *    password already streaming past on a poll would make "who read it" an
 *    unanswerable question no matter what this route records.
 * 2. **Every request writes exactly one audit row, refusals included.** A log
 *    that only records the grants answers the easy half of the question.
 * 3. **No row anywhere carries the secret.** Not the response's neighbours, not
 *    the audit `meta`, not a log line.
 */

/** Seeds a device whose persisted route names a stored credential, and returns the harness. */
async function withStoredCredential(
  h: RouteHarness,
  opts: { deviceId: string; name: string; username?: string; secret: string },
): Promise<void> {
  h.seed(opts.deviceId)
  const created = await h.app.request('/network/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: opts.name, ...(opts.username ? { username: opts.username } : {}), secret: opts.secret }),
  })
  expect(created.status).toBe(201)
  h.db
    .update(devices)
    .set({
      networkRoute: {
        config: { engine: 'vpn-helper', host: 'proxy.example', port: 1080, udpMode: 'udp', credentialRef: opts.name },
        enabled: true,
        failClosed: true,
      },
    })
    .where(eq(devices.id, opts.deviceId))
    .run()
}

function revealRows(h: RouteHarness): Array<{ userId: string | null; target: string | null; meta: Record<string, unknown> }> {
  return h.db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.at))
    .all()
    .filter((r) => r.action === 'device.network.credential.reveal')
    .map((r) => ({ userId: r.userId, target: r.target, meta: (r.meta ?? {}) as Record<string, unknown> }))
}

describe('reveal — the happy path', () => {
  test('an admin gets the plaintext back, and exactly one audit row names them, the device and the credential', async () => {
    const h = makeRouteHarness()
    await withStoredCredential(h, { deviceId: 'd1', name: 'soax-1', username: 'package-123-sessionid-abc', secret: 'sekrit-pw' })

    const res = await h.app.request('/d1/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(200)
    // Never cached: `no-store`, not `no-cache` — the latter permits storing the body and
    // revalidating it, which for this body means writing a password to a disk cache.
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.credentialRef).toBe('soax-1')
    expect(body.username).toBe('package-123-sessionid-abc')
    expect(body.password).toBe('sekrit-pw')
    expect(typeof body.revealedAt).toBe('number')

    const rows = revealRows(h)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.userId).toBe('u1')
    expect(rows[0]!.target).toBe('d1')
    expect(rows[0]!.meta.outcome).toBe('revealed')
    expect(rows[0]!.meta.credentialRef).toBe('soax-1')
    expect(rows[0]!.meta.hasUsername).toBe(true)
    // The row says a credential was revealed and which one it was. It must never say WHAT it was —
    // an audit log is read by more people than the response body ever is.
    expect(JSON.stringify(rows[0]!.meta)).not.toContain('sekrit-pw')
    expect(JSON.stringify(rows[0]!.meta)).not.toContain('package-123-sessionid-abc')
  })

  test('a credential stored with no username reveals a null username rather than omitting the field', async () => {
    const h = makeRouteHarness()
    await withStoredCredential(h, { deviceId: 'd2', name: 'pw-only', secret: 'just-a-password' })

    const res = await h.app.request('/d2/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.username).toBeNull()
    expect(body.password).toBe('just-a-password')
    expect(revealRows(h)[0]!.meta.hasUsername).toBe(false)
  })

  test('two reveals write two rows — the count is the point, so it is never deduplicated', async () => {
    const h = makeRouteHarness()
    await withStoredCredential(h, { deviceId: 'd3', name: 'c3', secret: 'pw' })
    await h.app.request('/d3/network/credential/reveal', { method: 'POST' })
    await h.app.request('/d3/network/credential/reveal', { method: 'POST' })
    expect(revealRows(h)).toHaveLength(2)
  })
})

describe('reveal — the gate', () => {
  test('an operator is refused, and the refusal is audited exactly like a grant is', async () => {
    const h = makeRouteHarness({ user: { id: 'op1', email: 'op@test', role: 'operator' } })
    await withStoredCredential(h, { deviceId: 'd4', name: 'c4', secret: 'pw' })

    const res = await h.app.request('/d4/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('auth.forbidden')
    // The refusal explains itself rather than reading as a bug — `device.network` (which this
    // operator HAS) sets a route; it does not take the account back out of the farm.
    expect(body.error.message).toContain('admin')
    expect(JSON.stringify(body)).not.toContain('pw')

    const rows = revealRows(h)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.userId).toBe('op1')
    expect(rows[0]!.target).toBe('d4')
    expect(rows[0]!.meta.outcome).toBe('forbidden')
    expect(rows[0]!.meta.role).toBe('operator')
    // A refusal must never name the credential it refused to hand over — that is a read of the
    // route the caller was just told they may not read.
    expect(rows[0]!.meta.credentialRef).toBeUndefined()
  })

  test('no session at all is refused and audited with a null actor', async () => {
    // No credential is created here on purpose: with no session there is nothing to create one
    // with, and the gate refuses before the route is ever read — which is itself the assertion.
    const h = makeRouteHarness({ user: null })
    h.seed('d5')
    h.db
      .update(devices)
      .set({
        networkRoute: {
          config: { engine: 'vpn-helper', host: 'proxy.example', port: 1080, udpMode: 'udp', credentialRef: 'c5' },
          enabled: true,
        },
      })
      .where(eq(devices.id, 'd5'))
      .run()

    const res = await h.app.request('/d5/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(403)
    const rows = revealRows(h)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.userId).toBeNull()
    expect(rows[0]!.meta.outcome).toBe('forbidden')
  })
})

describe('reveal — the refusals that are not about permission', () => {
  test('a device with no route says so, with its own code, and is audited', async () => {
    const h = makeRouteHarness()
    h.seed('d6')
    const res = await h.app.request('/d6/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('E_NO_ROUTE_CONFIG')
    expect(revealRows(h)[0]!.meta.outcome).toBe('no-route')
  })

  test('an advisory rung has no credential to reveal at all, and says why', async () => {
    const h = makeRouteHarness()
    h.seed('d7')
    h.db
      .update(devices)
      .set({ networkRoute: { config: { engine: 'adb-proxy', host: '10.0.0.2', port: 8080 }, enabled: true } })
      .where(eq(devices.id, 'd7'))
      .run()

    const res = await h.app.request('/d7/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('E_NOT_SUPPORTED')
    const row = revealRows(h)[0]!
    expect(row.meta.outcome).toBe('wrong-engine')
    expect(row.meta.engine).toBe('adb-proxy')
  })

  test('an anonymous vpn route (no stored credential) is a 404, not an empty password', async () => {
    const h = makeRouteHarness()
    h.seed('d8')
    h.db
      .update(devices)
      .set({ networkRoute: { config: { engine: 'vpn-helper', host: 'proxy.example', port: 1080, udpMode: 'udp' }, enabled: true } })
      .where(eq(devices.id, 'd8'))
      .run()

    const res = await h.app.request('/d8/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('E_CREDENTIAL_NOT_FOUND')
    expect(revealRows(h)[0]!.meta.outcome).toBe('no-credential')
  })

  test('a route naming a credential that no longer exists is reported as such, and audited', async () => {
    const h = makeRouteHarness()
    h.seed('d9')
    h.db
      .update(devices)
      .set({
        networkRoute: {
          config: { engine: 'vpn-helper', host: 'proxy.example', port: 1080, udpMode: 'udp', credentialRef: 'gone' },
          enabled: true,
        },
      })
      .where(eq(devices.id, 'd9'))
      .run()

    const res = await h.app.request('/d9/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_CREDENTIAL_NOT_FOUND')
    expect(body.error.message).toContain('no longer exists')
    const row = revealRows(h)[0]!
    expect(row.meta.outcome).toBe('unreadable')
    expect(row.meta.credentialRef).toBe('gone')
  })

  test('a device that does not exist is still one audited attempt', async () => {
    const h = makeRouteHarness()
    const res = await h.app.request('/nope/network/credential/reveal', { method: 'POST' })
    expect(res.status).toBe(404)
    const rows = revealRows(h)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.target).toBe('nope')
    expect(rows[0]!.meta.outcome).toBe('device-not-found')
  })
})

describe('the status endpoint the panel polls', () => {
  test('carries the credential NAME and USERNAME and never the password or its ciphertext', async () => {
    const h = makeRouteHarness()
    await withStoredCredential(h, { deviceId: 'd10', name: 'soax-2', username: 'package-9-sessionid-zz', secret: 'never-here' })

    const res = await h.app.request('/d10/network')
    expect(res.status).toBe(200)
    const raw = await res.text()
    const status = JSON.parse(raw) as { config: Record<string, unknown> }
    expect(status.config.credentialRef).toBe('soax-2')
    // The username IS surfaced — it is the session string that says which upstream identity this
    // phone is on, and an opaque `credentialRef` alone made every route look alike.
    expect(status.config.credentialUsername).toBe('package-9-sessionid-zz')
    expect(status.config.password).toBeUndefined()
    // Not just "the plaintext is absent": the whole `network_credentials` row must be absent, so a
    // future `...row` spread in `toConfigResponse` fails here rather than shipping a ciphertext.
    expect(raw).not.toContain('never-here')
    expect(status.config.secret).toBeUndefined()
  })

  test('polling the status never writes a reveal audit row', async () => {
    const h = makeRouteHarness()
    await withStoredCredential(h, { deviceId: 'd11', name: 'c11', username: 'u', secret: 'pw' })
    await h.app.request('/d11/network')
    await h.app.request('/d11/network')
    await h.app.request('/d11/network')
    expect(revealRows(h)).toHaveLength(0)
  })
})

describe('the log', () => {
  test('nothing the service logged while revealing contains the plaintext', async () => {
    const h = makeRouteHarness()
    await withStoredCredential(h, { deviceId: 'd12', name: 'c12', username: 'u12', secret: 'top-secret-value' })
    await h.app.request('/d12/network/credential/reveal', { method: 'POST' })
    await h.app.request('/d12/network')
    expect(h.warns.join('\n')).not.toContain('top-secret-value')
  })
})
