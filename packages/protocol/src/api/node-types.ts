import { z } from 'zod'
import { JsonSchemaNodeSchema } from './json-schema'
import { ScriptRefSchema } from '../script-ref'
import { WORKFLOW_NODE_KINDS } from '../workflow'
import { NodeCategorySchema } from '../workflow-node-type'
import { IconNameSchema } from '../plugin-surface'

/**
 * `GET /api/node-types` (plan 303 §4.3) — the flow editor's palette: the six
 * core control kinds plus every ACTIVATED plugin's node members, one
 * response, both sources. `id` is `core:<kind>` for a core entry, or
 * `<plugin>/<member>` for a plugin one. `script` is present only for a
 * plugin entry — the pinned `plugin/member@version` ref the document
 * stores when this node is placed (plan 303 §4.4: never `@latest`).
 */
export const NodeTypeSchema = z.object({
  id: z.string(),
  source: z.enum(['core', 'plugin']),
  kind: z.enum(WORKFLOW_NODE_KINDS),
  script: ScriptRefSchema.optional(),
  title: z.string(),
  description: z.string(),
  category: NodeCategorySchema,
  icon: IconNameSchema,
  summary: z.array(z.string()),
  keywords: z.array(z.string()),
  paramsSchema: JsonSchemaNodeSchema.optional(),
  resultSchema: JsonSchemaNodeSchema.optional(),
})
export type NodeType = z.infer<typeof NodeTypeSchema>

export const NodeTypesResponseSchema = z.object({ types: z.array(NodeTypeSchema) })
export type NodeTypesResponse = z.infer<typeof NodeTypesResponseSchema>
