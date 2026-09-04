import { Hono } from 'hono'
import { NodeTypesResponseSchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { PluginRuntime } from '../plugins/runtime'
import { listNodeTypes } from '../workflows/registry'
import { typedJson } from './typed-json'

/**
 * `GET /api/node-types` (plan 303 §4.3, §5 step 303.6) — the flow editor's
 * palette: six core control kinds plus every activated plugin's node
 * members, one response, both sources. `script.view` — the SAME permission
 * `GET /api/plugins` and `GET /api/scripts` already gate (plan 126 §3.4):
 * seeing what a node WOULD run is the same class of question as seeing the
 * plugin inventory, never a write.
 */
export function createNodeTypeRoutes(deps: { plugins: PluginRuntime }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/', requirePermission('script.view'), (c) => typedJson(c, NodeTypesResponseSchema, { types: listNodeTypes({ plugins: deps.plugins }) }))

  return app
}
