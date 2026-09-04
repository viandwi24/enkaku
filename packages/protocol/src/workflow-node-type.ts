import { z } from 'zod'
import { IconNameSchema } from './plugin-surface'
import { WorkflowParamNameSchema } from './workflow-params'

/**
 * How a script member presents itself in the flow editor's palette and on
 * the canvas (plan 303 §4.2, plan 300 D6). Presentation and filing ONLY:
 * nothing here changes how the member executes (plan 300 D7 — a plugin node
 * runs in the SAME child process a script already runs in), and nothing
 * here can add an output (plan 300 D8, G5) — a plugin node has exactly one
 * success edge and one failure edge, the same as every `kind: 'script'`
 * node has always had, and this descriptor has no field that could widen
 * that.
 */
export const NodeCategorySchema = z.enum(['device', 'inspect', 'input', 'data', 'network', 'other'])
export type NodeCategory = z.infer<typeof NodeCategorySchema>

export const WorkflowNodeDescriptorSchema = z
  .object({
    category: NodeCategorySchema.default('other'),
    /** One of `ICON_NAMES` (`plugin-surface.ts`) — the SAME allowlist a plugin nav entry uses. No second icon vocabulary. */
    icon: IconNameSchema.default('box'),
    /** Up to 3 param names rendered under the node's title on the canvas, so a node reads without being opened. */
    summary: z.array(WorkflowParamNameSchema).max(3).default([]),
    /** Search terms beyond title and description (plan 300 P3). */
    keywords: z.array(z.string().max(24)).max(8).default([]),
  })
  .strict()
export type WorkflowNodeDescriptor = z.infer<typeof WorkflowNodeDescriptorSchema>
/** The descriptor as an AUTHOR writes it — every defaulted field optional, the shape `PluginMemberScript.node?` is typed against in `@enkaku/sdk`. */
export type WorkflowNodeDescriptorInput = z.input<typeof WorkflowNodeDescriptorSchema>
