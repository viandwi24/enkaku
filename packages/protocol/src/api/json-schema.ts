import { z } from 'zod'

/**
 * The generic JSON Schema node the schema-driven form renderer consumes
 * (`z.toJSONSchema(...)` on the server side — spec §8, §19). Recursive by
 * nature, so this stays permissive rather than re-declaring every JSON
 * Schema keyword: the renderer does its own narrowing once the envelope has
 * confirmed "this is an object", which is the only thing worth checking at
 * the network boundary.
 */
export type JsonSchemaNode = { [key: string]: unknown }
export const JsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = z.record(z.string(), z.unknown())
