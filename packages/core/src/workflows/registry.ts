import { z } from 'zod'
import { IconNameSchema, WorkflowNodeDescriptorSchema, type IconName, type JsonSchemaNode, type NodeType } from '@enkaku/protocol'
import type { PluginRuntime } from '../plugins/runtime'

/**
 * The flow editor's node catalog (plan 300 D6, plan 303 §4.3) — the seven
 * core control kinds (`set` added by plan 312 §4.6), constant, plus every
 * ACTIVATED plugin's node members, read
 * fresh off `runtime.active(name)`'s manifest on every call (the same "never
 * caches" discipline `surface-registry.ts` already documents for exactly the
 * same reason: a plugin's manifest is small, and a cache is one more thing to
 * keep in step with activate/rollback/disable).
 *
 * A plugin node is a `kind: 'script'` node whose `script` is the ACTIVE
 * version's pinned `plugin/member@version` ref (plan 303 §4.4) — never
 * `@latest`, so placing a node writes down exactly what ran, and activating a
 * newer version later never silently rewrites an existing document.
 */

/** One entry per `WORKFLOW_NODE_KINDS` member, in that order, each id namespaced the same way (plan 303 §6's acceptance criterion counts these ids). */
const CORE_NODE_TYPES: NodeType[] = [
  { id: 'core:start', source: 'core', kind: 'start', title: 'Start', description: 'Where a run begins — the one entry point of the document.', category: 'other', icon: 'play', summary: [], keywords: ['begin', 'entry'] },
  { id: 'core:script', source: 'core', kind: 'script', title: 'Script', description: 'Run a published script against the device.', category: 'other', icon: 'terminal', summary: [], keywords: ['run', 'device'] },
  { id: 'core:gate', source: 'core', kind: 'gate', title: 'Gate', description: 'A yes/no decision over data already in scope. Two edges: then, else.', category: 'other', icon: 'filter', summary: [], keywords: ['if', 'decision', 'branch'] },
  {
    id: 'core:switch',
    source: 'core',
    kind: 'switch',
    title: 'Switch',
    description: 'Conditions C -> 1 / 2 / 3, as one node. Cases are checked in order; the first match wins; falls to a default when none do.',
    category: 'other',
    icon: 'list',
    summary: [],
    keywords: ['case', 'branch', 'condition'],
  },
  { id: 'core:delay', source: 'core', kind: 'delay', title: 'Delay', description: 'A bounded, cancellable wait — costs a step, touches no device.', category: 'other', icon: 'pause', summary: [], keywords: ['wait', 'sleep', 'pause'] },
  { id: 'core:finish', source: 'core', kind: 'finish', title: 'Finish', description: 'Ends the run, succeeded or failed.', category: 'other', icon: 'check', summary: [], keywords: ['end', 'done'] },
  {
    id: 'core:set',
    source: 'core',
    kind: 'set',
    title: 'Set',
    description: 'Build new data from earlier nodes — no device involved.',
    category: 'data',
    icon: 'list',
    summary: [],
    keywords: ['data', 'assign', 'map', 'edit fields', 'json'],
  },
]

/**
 * Just enough of `plugins.manifest` to build a `NodeType` per member (plan
 * 126 §3.2's discipline, applied here): a Zod parse, never a cast, because
 * this is a JSON column written by whatever core version last activated the
 * row — `.optional()` everywhere a field might predate this plan, degrading
 * to "this member has no node" rather than a throw on the way to rendering
 * the palette.
 */
const ManifestNodeProjectionSchema = z.object({
  scripts: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        // Plan 310 §3.3 — the member's OWN icon, preferred over `node.icon`
        // below. A bare string, not `IconNameSchema`: this projection must
        // not fail (and drop the WHOLE plugin's node registry with it) over
        // one member's icon written against a shorter `ICON_NAMES` by an
        // older core. Narrowed in `listNodeTypes` below instead.
        icon: z.string().optional(),
        paramsSchema: z.unknown().optional(),
        resultSchema: z.unknown().optional(),
        node: WorkflowNodeDescriptorSchema.optional(),
      }),
    )
    .optional(),
})

function isJsonSchemaNode(value: unknown): value is JsonSchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * `GET /api/node-types` (plan 303 §4.3, §5 step 303.6). Pure aside from the
 * two `PluginRuntime` reads: never touches the database directly, never
 * throws — a plugin whose manifest no longer parses today (an old shape, a
 * corrupted row) simply contributes no node types, exactly the same
 * degrade-to-nothing discipline `surface`/`service` already follow.
 */
export function listNodeTypes(deps: { plugins: PluginRuntime }): NodeType[] {
  const out: NodeType[] = [...CORE_NODE_TYPES]

  for (const row of deps.plugins.list()) {
    if (row.status !== 'active') continue
    const active = deps.plugins.active(row.name)
    if (!active?.manifest) continue
    const parsed = ManifestNodeProjectionSchema.safeParse(active.manifest)
    if (!parsed.success) continue

    for (const s of parsed.data.scripts ?? []) {
      if (!s.node) continue
      out.push({
        id: `${row.name}/${s.id}`,
        source: 'plugin',
        kind: 'script',
        // Plan 303 §4.4 — the ACTIVE version, pinned. Never `@latest`.
        script: `${row.name}/${s.id}@${active.version}`,
        title: s.title ?? s.id,
        description: s.description ?? '',
        category: s.node.category,
        // Plan 310 §3.3 — the member's OWN icon wins; `node.icon` is a
        // fallback read for packs published before this plan (plan 312 §10
        // deletes the fallback once both shipped packs are bumped). Narrowed
        // through `IconNameSchema` here rather than trusted from the JSON
        // column — the same "validate on read, not merely on write"
        // discipline `parseScriptRuntime` states.
        icon: (() => {
          const checked = s.icon !== undefined ? IconNameSchema.safeParse(s.icon) : undefined
          return checked?.success ? (checked.data as IconName) : s.node.icon
        })(),
        summary: s.node.summary,
        keywords: s.node.keywords,
        ...(isJsonSchemaNode(s.paramsSchema) ? { paramsSchema: s.paramsSchema } : {}),
        ...(isJsonSchemaNode(s.resultSchema) ? { resultSchema: s.resultSchema } : {}),
      })
    }
  }

  return out
}
