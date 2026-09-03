import { toJsonSchema } from '@enkaku/protocol'
import { CAPABILITY_REFUSAL_CODES } from '@enkaku/protocol'
import type { CapabilityRegistry } from '../capability/registry'

/**
 * `GET /api/openapi.json` (plan 63 §4.5, acceptance #10) — generated at
 * BOOT from the same registry map every other surface reads, never
 * committed to the repo (§4.5: "a generated file in git is a file that
 * will disagree with its generator"). One `POST /api/v1/cap/{id}` path per
 * entry, literally — not a templated `{id}` parameter — so each
 * capability's own request/response schema is visible in the document
 * without a client resolving a variable first.
 */

interface OpenApiDocument {
  openapi: '3.1.0'
  info: { title: string; version: string; description: string }
  paths: Record<string, unknown>
  components: { schemas: Record<string, unknown> }
}

const REFUSAL_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['ok', 'error'],
  properties: {
    ok: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: `One of ${CAPABILITY_REFUSAL_CODES.join(', ')}, or a capability-specific domain code.` },
        message: { type: 'string' },
        details: {},
      },
    },
  },
} as const

export function buildOpenApiDocument(registry: CapabilityRegistry, version: string): OpenApiDocument {
  const paths: Record<string, unknown> = {}

  for (const cap of registry.all()) {
    const inputSchema = toJsonSchema(cap.input)
    const outputSchema = toJsonSchema(cap.output)
    paths[`/api/v1/cap/${cap.id}`] = {
      post: {
        operationId: cap.id,
        summary: cap.description.split('. ')[0] ?? cap.id,
        description: cap.description,
        'x-permission': cap.permission,
        'x-activity': cap.activity ?? null,
        'x-deadline-ms': cap.deadline,
        'x-effect': cap.effect,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: inputSchema } },
        },
        responses: {
          '200': {
            description: 'The capability ran and returned a typed result.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'output'],
                  properties: { ok: { const: true }, output: outputSchema },
                },
              },
            },
          },
          '400': { description: 'Bad input, or a domain refusal.', content: { 'application/json': { schema: REFUSAL_RESPONSE_SCHEMA } } },
          '403': { description: 'Missing permission or device grant.', content: { 'application/json': { schema: REFUSAL_RESPONSE_SCHEMA } } },
          '404': { description: 'The referenced resource does not exist.', content: { 'application/json': { schema: REFUSAL_RESPONSE_SCHEMA } } },
          '409': { description: 'Conflicts with another live activity, or the device/job is not in a usable state.', content: { 'application/json': { schema: REFUSAL_RESPONSE_SCHEMA } } },
          '504': { description: 'Exceeded the capability\'s deadline.', content: { 'application/json': { schema: REFUSAL_RESPONSE_SCHEMA } } },
        },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Enkaku Capability API',
      version,
      description: 'Generated from the capability registry (plan 63) — every path here is also reachable through MCP and the agent tool list, with identical behaviour.',
    },
    paths,
    components: { schemas: { CapabilityRefusal: REFUSAL_RESPONSE_SCHEMA } },
  }
}
