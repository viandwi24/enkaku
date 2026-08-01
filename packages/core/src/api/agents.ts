import { Hono } from 'hono'
import { z } from 'zod'
import { can } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import { buildIceServers } from '../relay/ice-credentials'
import type { AgentAuth } from '../tunnel/agent-auth'
import { EnkakuError } from '../util/errors'

const EnrollBody = z.object({ token: z.string().min(1), name: z.string().min(1), platform: z.string() })
const CreateBody = z.object({ name: z.string().min(1) })

const ERROR_STATUS: Record<string, number> = {
  'agent.invalid_token': 401,
  'auth.forbidden': 403,
}

/**
 * Manajemen agent cloud (plan 11 §4.2). Endpoint `/enroll` sengaja publik:
 * autentikasinya adalah enrollment token itu sendiri (sekali pakai), sama
 * seperti pola join-token pada orkestrator lain.
 */
export function createAgentRoutes(deps: { agentAuth: AgentAuth }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.post('/enroll', async (c) => {
    const body = EnrollBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('agent.invalid_token', 'body { token, name, platform } wajib')
    const result = deps.agentAuth.redeem(body.data.token, { name: body.data.name, platform: body.data.platform })
    return c.json(result, 201)
  })

  app.get('/', (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'butuh role admin')
    return c.json({ agents: deps.agentAuth.list() })
  })

  app.post('/', async (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'butuh role admin')
    const body = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('auth.forbidden', 'body { name } wajib')
    // Token hanya ditampilkan sekali — DB menyimpan hash-nya.
    return c.json(deps.agentAuth.createEnrollment(body.data.name), 201)
  })

  app.delete('/:id', (c) => {
    if (!can(c.get('user').role, 'user.manage')) throw new EnkakuError('auth.forbidden', 'butuh role admin')
    deps.agentAuth.disable(c.req.param('id'))
    return c.json({ ok: true })
  })

  /** Konfigurasi ICE untuk browser (STUN/TURN self-host, kredensial berjangka waktu). */
  app.get('/ice-config', (c) => c.json({ iceServers: buildIceServers(c.get('user')?.id ?? 'anon') }))

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
