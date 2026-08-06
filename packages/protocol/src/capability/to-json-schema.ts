import { z } from 'zod'

/**
 * Zod 4's native JSON Schema conversion (plan 63 §4.1) — no conversion
 * library. `draft-2020-12` is Zod 4's own default dialect and is what both
 * the Anthropic tool API (`input_schema`) and MCP's `tools/list`
 * (`inputSchema`) accept, so one dialect serves every generated surface
 * (plan 63 §3.5) without a per-surface transform.
 *
 * `unrepresentable: 'throw'` (Zod 4's own default) is deliberate, not
 * incidental: a Zod construct that cannot convert must fail LOUDLY, at the
 * registry's boot-time dry run (`@enkaku/core`'s `capability/registry.ts`,
 * acceptance #3) — never silently become an empty `{}` schema that an agent
 * discovers is useless only when it happens to call that tool.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'throw' }) as Record<string, unknown>
  // Tool-call schemas (Anthropic's `input_schema`, MCP's `inputSchema`) are a
  // bare object schema — no top-level `$schema` meta-key expected by either.
  delete out.$schema
  return out
}
