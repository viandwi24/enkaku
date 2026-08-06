import { Hono } from 'hono'
import { z } from 'zod'
import { toJsonSchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { createCapabilityContext, invoke, type CapabilityContextDeps } from '../capability'
import type { CapabilityRegistry } from '../capability/registry'
import type { AuditLogger } from '../auth/audit'

/**
 * MCP over the existing HTTP server at `/mcp` (plan 63 §4.4), authenticated
 * by the SAME session cookie/bearer token every other route uses
 * (`authMiddleware` runs on `/api/*`; this mounts alongside it in
 * `daemon.ts` with the same middleware applied). `tools/list` returns the
 * registry filtered by the caller's permissions and grants (the SAME
 * `registry.visibleTo` `GET /api/v1/cap` uses); `tools/call` goes through
 * `invoke` with no bypass — the third surface reading the one door.
 *
 * No MCP SDK dependency: this is a minimal hand-written JSON-RPC 2.0
 * responder over a single POST, which is a valid (non-streaming) response
 * mode of MCP's Streamable HTTP transport. `resources`/`prompts` are not
 * implemented (plan §4.4: "an empty capability list is a valid MCP server,
 * and inventing resources before anything consumes them is speculative").
 */

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

const ToolsCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
})

const PROTOCOL_VERSION = '2025-06-18'

export interface McpServerDeps {
  registry: CapabilityRegistry
  contextDeps: CapabilityContextDeps
  audit?: AuditLogger
  serverVersion: string
}

interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}
interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string }
}

export function createMcpServer(deps: McpServerDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.post('/', async (c) => {
    const body = JsonRpcRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      const failure: JsonRpcFailure = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC request' } }
      return c.json(failure, 400)
    }
    const { id, method, params } = body.data
    const respId = id ?? null

    const user = c.get('user')
    const ctx = createCapabilityContext(deps.contextDeps, user ? { id: user.id, role: user.role } : null)

    if (method === 'initialize') {
      const result: JsonRpcSuccess = {
        jsonrpc: '2.0',
        id: respId,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'enkaku-core', version: deps.serverVersion },
        },
      }
      return c.json(result)
    }

    if (method === 'tools/list') {
      const tools = deps.registry.visibleTo(ctx).map((cap) => ({
        name: cap.id,
        description: cap.description,
        inputSchema: toJsonSchema(cap.input),
      }))
      const result: JsonRpcSuccess = { jsonrpc: '2.0', id: respId, result: { tools } }
      return c.json(result)
    }

    if (method === 'tools/call') {
      const parsedParams = ToolsCallParamsSchema.safeParse(params)
      if (!parsedParams.success) {
        const failure: JsonRpcFailure = { jsonrpc: '2.0', id: respId, error: { code: -32602, message: 'invalid params: expected { name, arguments }' } }
        return c.json(failure, 400)
      }
      const cap = deps.registry.get(parsedParams.data.name)
      if (!cap) {
        const failure: JsonRpcFailure = { jsonrpc: '2.0', id: respId, error: { code: -32601, message: `no such tool: ${parsedParams.data.name}` } }
        return c.json(failure, 404)
      }
      // `tools/call` goes through the SAME `invoke` as REST — every one of
      // the six checks (§3.4), no bypass (plan 63 §4.4, acceptance #11).
      const outcome = await invoke(cap, ctx, parsedParams.data.arguments ?? {}, { audit: deps.audit })
      const result: JsonRpcSuccess = {
        jsonrpc: '2.0',
        id: respId,
        result: {
          content: [{ type: 'text', text: JSON.stringify(outcome.ok ? outcome.output : outcome.error) }],
          structuredContent: outcome.ok ? outcome.output : { error: outcome.error },
          isError: !outcome.ok,
        },
      }
      return c.json(result)
    }

    const failure: JsonRpcFailure = { jsonrpc: '2.0', id: respId, error: { code: -32601, message: `unknown method: ${method}` } }
    return c.json(failure, 400)
  })

  return app
}
