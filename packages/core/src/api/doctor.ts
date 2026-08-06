import { Hono } from 'hono'
import { DoctorResponseSchema } from '@enkaku/protocol'
import { can } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import { createRealDoctorContext } from '../doctor/context'
import { runChecks } from '../doctor/run'
import type { CoreProbeResult, DoctorContext } from '../doctor/types'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = { 'auth.forbidden': 403 }

/**
 * `GET /api/doctor` (plan 41 §4.5, permission `tool.view`) — the exact same
 * checks and `--json` shape as `enkaku doctor` on the terminal, so the
 * browser and the terminal never disagree about what is wrong. The `core`
 * check is answered directly from the running daemon's own state (`coreProbe`)
 * rather than the CLI path's HTTP self-probe — we already ARE the core here.
 */
export function createDoctorRoutes(deps: { dataDir: string; coreProbe: () => Promise<CoreProbeResult> }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/', async (c) => {
    const user = c.get('user')
    if (!user || !can(user.role, 'tool.view')) {
      throw new EnkakuError('auth.forbidden', 'requires the tool.view permission')
    }
    const base = await createRealDoctorContext(deps.dataDir)
    const ctx: DoctorContext = { ...base, core: { probe: deps.coreProbe } }
    const result = await runChecks(ctx)
    return typedJson(c, DoctorResponseSchema, result)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    throw err
  })

  return app
}
