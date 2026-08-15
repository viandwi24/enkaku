import { useState } from 'react'
import { afterEach, describe, expect, test } from 'bun:test'
import { compileWorkflowParams, type WorkflowParam } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { planForm } from '@/components/schema-form/plan'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'

/** `SchemaForm` is CONTROLLED (`RunScriptDialog.tsx`'s own usage) — its default-seeding effect calls `onChange`, but nothing re-renders the field until the CALLER feeds that back as a new `value` prop. This mirrors that real usage instead of a stateless pass-through that would never actually observe the seeded defaults. */
function ControlledForm({ schema }: { schema: JsonSchemaNode }) {
  const [value, setValue] = useState<unknown>(undefined)
  return <SchemaForm schema={schema} value={value} onChange={setValue} />
}

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * Step 99.2's own status note left this half of its acceptance criterion
 * unproven from `packages/protocol` alone — proving it would have meant
 * depending on Studio from the protocol package, the wrong direction. Step
 * 99.9's brief asks THIS package to close it: `compileWorkflowParams`'s
 * output must reach a real `SchemaForm`, `planForm()` must plan EVERY field
 * to a real control (never the `json` fallback), and `applyDefaults` must
 * seed a defaulted field before first paint. All three are asserted below
 * against the REAL functions, not stand-ins.
 */

const params: WorkflowParam[] = [
  { name: 'keyword', type: 'string', required: true, title: 'Search keyword', description: 'What to search for.' },
  { name: 'videos', type: 'integer', required: false, default: 30, title: 'Videos', hints: { kind: 'count' } },
  { name: 'chance', type: 'number', required: false, default: 0.5, title: 'Chance', min: 0, max: 1, hints: { kind: 'chance' } },
  { name: 'enabled', type: 'boolean', required: false, default: true, title: 'Enabled' },
  { name: 'tags', type: 'stringList', required: false, default: ['a', 'b'], title: 'Tags' },
  { name: 'range', type: 'numberPair', required: false, default: [1, 10], title: 'Range' },
]

describe('compileWorkflowParams → planForm → SchemaForm (closing step 99.2\'s deferred half)', () => {
  test('every declared field plans to a real control, never the json fallback', () => {
    const schema = compileWorkflowParams(params)
    expect(schema).not.toBeNull()
    const fields = planForm(schema as unknown as JsonSchemaNode)
    expect(fields).toHaveLength(params.length)
    for (const field of fields) {
      expect(field.plan.control).not.toBe('json')
    }
    // Spot-check that the SHAPES land where plan 95's own precedence table says they should.
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f.plan]))
    expect(byPath.keyword?.control).toBe('text')
    expect(byPath.videos?.control).toBe('number')
    expect(byPath.chance?.control).toBe('number')
    expect((byPath.chance as { kind?: string })?.kind).toBe('chance')
    expect(byPath.enabled?.control).toBe('toggle')
    expect(byPath.tags?.control).toBe('list')
    expect(byPath.range?.control).toBe('pair')
  })

  test('a real SchemaForm renders every field, and applyDefaults seeds a defaulted field before the operator touches anything', async () => {
    const schema = compileWorkflowParams(params) as unknown as JsonSchemaNode
    const { findByLabelText, findByRole, queryByText } = renderWithApi(<ControlledForm schema={schema} />, {})

    // Seeded from the schema's own defaults on first paint — no click, no
    // keystroke — exactly the property `RunScriptDialog.test.tsx` already
    // pins for a hand-written script's own paramsSchema, proven here for a
    // WORKFLOW's compiled one.
    const videos = (await findByLabelText('Videos')) as HTMLInputElement
    expect(videos.value).toBe('30')
    // `chance` renders as a Radix `Slider` (`ChanceControl.tsx`) — its thumb,
    // not a native form element, is what carries the value, so this reads
    // `aria-valuenow` rather than `getByLabelText` (which Radix's own root
    // element is not "labelable" enough for, per the HTML spec).
    const chance = await findByRole('slider')
    expect(chance.getAttribute('aria-valuenow')).toBe('50')
    // A boolean renders as a Radix `Switch` (`role="switch"`), not a native checkbox.
    const enabled = await findByRole('switch')
    expect(enabled.getAttribute('aria-checked')).toBe('true')

    // `keyword` has no default — it stays present as a field, not silently
    // dropped, and is never routed to the `json` escape hatch (asserted
    // above already; here, concretely, as an actual rendered textbox).
    const keyword = await findByLabelText('Search keyword')
    expect(keyword.tagName).toBe('INPUT')

    // Never the row-16/row-13 fallback text this repo's own vocabulary uses
    // for "this parameter's type is not one the form can draw" / "this
    // parameter can take several different shapes".
    expect(queryByText(/this parameter/)).toBeNull()
  })
})
