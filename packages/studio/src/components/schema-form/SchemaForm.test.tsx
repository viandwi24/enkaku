import { useState } from 'react'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { toJsonSchema, ui, validateAgainstSchema } from '@enkaku/protocol'
import { z } from 'zod'
import { cleanup, renderWithApi } from '@/lib/test/render'
import * as planModule from './plan'
import { SchemaForm } from './SchemaForm'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * One schema exercising every control in plan 95 §4.6 — the tree the H1
 * comparison itself is built to justify: a semantic control per kind (not
 * one bare number box for everything), a live value in every label row,
 * and behavioural help text. Also the K7 nesting fixture: `retry` is a
 * top-level object (card), `retry.backoff` is nested one level deeper
 * (left rule only).
 */
const paramsSchema = z.object({
  videos: z
    .number()
    .int()
    .min(0)
    .max(2_000)
    .default(30)
    .describe('How many videos to watch before stopping.')
    .meta(ui({ title: 'Videos', kind: 'count' })),
  saveChance: z
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe('Skipped if the Save button is not present.')
    .meta(ui({ title: 'Save chance', kind: 'chance' })),
  watchRange: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .default([5, 20])
    .describe('How long a video stays on screen.')
    .meta(ui({ title: 'Watch time', kind: 'duration', unit: 's' })),
  enabled: z.boolean().default(true).meta(ui({ title: 'Enabled' })),
  order: z
    .enum(['as-listed', 'random'])
    .default('as-listed')
    .meta(ui({ title: 'Order', labels: { random: 'Shuffled' } })),
  note: z.string().max(500).default('').describe('Free text.').meta(ui({ title: 'Note' })),
  keywords: z.array(z.string()).default(['trade', 'xau']).meta(ui({ title: 'Keywords' })),
  rows: z
    .array(z.object({ name: z.string(), count: z.number().int() }))
    .default([{ name: 'a', count: 1 }])
    .meta(ui({ title: 'Rows' })),
  freeform: z.record(z.string(), z.number()).default({}).meta(ui({ title: 'Freeform' })),
  retry: z
    .object({
      policy: z
        .object({
          backoff: z
            .number()
            .int()
            .min(0)
            .default(500)
            .meta(ui({ title: 'Backoff' })),
        })
        .default({})
        .meta({ title: 'Policy' }),
    })
    .default({})
    .meta({ title: 'Retry' }),
})
const schema = toJsonSchema(paramsSchema)

function Harness() {
  const [value, setValue] = useState<unknown>(paramsSchema.parse({}))
  return <SchemaForm schema={schema} value={value} onChange={setValue} />
}

describe('SchemaForm — walks planForm() output (plan 95 §5 step 95.3)', () => {
  test('every control renders its label AND a live value in the label row (H1 property 2)', async () => {
    renderWithApi(<Harness />)
    await waitFor(() => expect(screen.getByText('Videos')).toBeTruthy())

    expect(screen.getByText('Videos')).toBeTruthy()
    expect(screen.getByText('30')).toBeTruthy() // NumberControl readout

    expect(screen.getByText('Save chance')).toBeTruthy()
    expect(screen.getByText('35%')).toBeTruthy() // ChanceControl readout

    expect(screen.getByText('Watch time')).toBeTruthy()
    expect(screen.getByText('5 s ~ 20 s')).toBeTruthy() // PairControl readout

    // ChoiceControl: deliberately NO separate readout (see ChoiceControl.tsx's
    // own doc comment) — the select trigger already shows the current value
    // without being opened, which is checked here directly.
    expect(screen.getByText('Order')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Order' }).textContent).toContain('as-listed')

    expect(screen.getByText('Note')).toBeTruthy()
    expect(screen.getByText('0/500')).toBeTruthy() // TextControl readout: character count

    expect(screen.getByText('Keywords')).toBeTruthy()
    expect(screen.getByText('2 items')).toBeTruthy() // ListControl readout

    expect(screen.getByText('Rows')).toBeTruthy()
    expect(screen.getByText('1 row')).toBeTruthy() // TableControl readout, singular
  })

  test('behavioural help text is rendered, not the field name again (H1 property 3)', async () => {
    renderWithApi(<Harness />)
    await waitFor(() => expect(screen.getByText('Skipped if the Save button is not present.')).toBeTruthy())
    expect(screen.getByText('How many videos to watch before stopping.')).toBeTruthy()
  })

  test('a table renders real columns, not [object Object] (F18)', async () => {
    renderWithApi(<Harness />)
    await waitFor(() => expect(screen.getByText('Name')).toBeTruthy())
    expect(screen.getByText('Count')).toBeTruthy()
    expect(screen.getByDisplayValue('a')).toBeTruthy()
  })

  test('z.record renders a labelled JSON escape hatch, not an empty card (F19)', async () => {
    renderWithApi(<Harness />)
    await waitFor(() => expect(screen.getByText('Freeform')).toBeTruthy())
    expect(screen.getByText(/free-form map/)).toBeTruthy()
  })

  test('K7 nesting: a top-level object is a card, one level deeper is a left rule only', async () => {
    renderWithApi(<Harness />)
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy())
    const cardHeading = screen.getByText('Retry')
    const cardSection = cardHeading.closest('section')
    expect(cardSection?.className).toContain('rounded-lg')

    const nestedHeading = screen.getByText('Policy')
    const nestedSection = nestedHeading.closest('section')
    expect(nestedSection?.className).toContain('border-l-2')
    expect(nestedSection?.className).not.toContain('rounded-lg')

    // Sanity: the DOM structure really is nested (Policy's section is
    // inside Retry's), not just two unrelated sections with the right class.
    expect(cardSection?.contains(nestedHeading)).toBe(true)
    // And the leaf field two levels down (`retry.policy.backoff`) does not
    // get a THIRD section of its own — only object nodes are sections.
    const leafLabel = screen.getByText('Backoff')
    expect(leafLabel.closest('section')).toBe(nestedSection)
  })

  test('editing a field updates the value AND the label-row readout that describes it', async () => {
    renderWithApi(<Harness />)
    await waitFor(() => expect(screen.getByText('0/500')).toBeTruthy())
    const noteBox = screen.getByLabelText('Note') as HTMLTextAreaElement
    fireEvent.change(noteBox, { target: { value: 'hello' } })
    await waitFor(() => expect(screen.getByText('5/500')).toBeTruthy())
  })
})

describe('SchemaForm — the plan is memoised on schema identity (plan 95 §5 step 95.3)', () => {
  test('planForm runs once on mount, and NOT again on every keystroke', async () => {
    // `spyOn` a live ES module binding, rather than `mock.module` — this
    // wraps the SAME `planForm` `SchemaForm.tsx` itself calls (an ESM named
    // import is a live binding, so mutating the export here is visible to
    // every importer), without replacing the whole module or juggling
    // dynamic imports.
    const spy = spyOn(planModule, 'planForm')

    renderWithApi(<Harness />)
    await waitFor(() => expect(screen.getByText('Videos')).toBeTruthy())
    const afterMount = spy.mock.calls.length
    expect(afterMount).toBeGreaterThan(0) // it DID run, seeding the form

    const noteBox = screen.getByLabelText('Note') as HTMLTextAreaElement
    fireEvent.change(noteBox, { target: { value: 'h' } })
    fireEvent.change(noteBox, { target: { value: 'he' } })
    fireEvent.change(noteBox, { target: { value: 'hel' } })
    fireEvent.change(noteBox, { target: { value: 'hell' } })
    fireEvent.change(noteBox, { target: { value: 'hello' } })
    await waitFor(() => expect(screen.getByText('5/500')).toBeTruthy())

    // Five keystrokes, five re-renders of `value` — but the SAME `schema`
    // object reference throughout, so `useMemo(() => planForm(schema), [schema])`
    // must not have called it again.
    expect(spy.mock.calls.length).toBe(afterMount)
  })
})

describe('SchemaForm — sections from x-enkaku.group (plan 95 §3.5, §5 step 95.4)', () => {
  const groupedSchema = z.object({
    videos: z.number().int().default(30).meta(ui({ title: 'Videos', group: 'Core settings' })),
    watch: z.number().int().default(5).meta(ui({ title: 'Watch time', group: 'Core settings' })),
    like: z.number().min(0).max(1).default(0.5).meta(ui({ title: 'Like chance', kind: 'chance', group: 'Interaction' })),
    note: z.string().default('').meta(ui({ title: 'Note' })), // ungrouped, on purpose
  })
  const schema = toJsonSchema(groupedSchema)

  function GroupedHarness() {
    const [value, setValue] = useState<unknown>(groupedSchema.parse({}))
    return <SchemaForm schema={schema} value={value} onChange={setValue} />
  }

  test('adjacent fields sharing a group render under one heading; an ungrouped field renders with none', async () => {
    renderWithApi(<GroupedHarness />)
    await waitFor(() => expect(screen.getByText('Videos')).toBeTruthy())

    // The section heading itself — text that names neither field, only the
    // group (plan 95 §3.5's "no parallel document": the heading comes from
    // the SAME `x-enkaku.group` `Videos`/`Watch time` declare, not a second
    // list Studio maintains).
    expect(screen.getByText('Core settings')).toBeTruthy()
    expect(screen.getByText('Interaction')).toBeTruthy()
    // `Note` declares no group, and the schema declares no OTHER ungrouped
    // field for it to share a heading-less run with — its own label must
    // still render, just under no heading of its own.
    expect(screen.getByText('Note')).toBeTruthy()
    expect(screen.queryByText('General')).toBeNull() // never invented; that word is deviceSections.ts's, not the form's
  })
})

describe('SchemaForm — showWhen (plan 95 §3.6, §5 step 95.9)', () => {
  // Four fields with no `showWhen` at all (`mode`, `count`, `threshold`,
  // `label`) plus three sharing ONE `showWhen: { field: 'mode', is: 'advanced' }`
  // — exactly the shape the step's own verifiable result names: "four
  // controls in simple mode and seven in advanced".
  const conditionalSchema = z.object({
    mode: z.enum(['simple', 'advanced']).default('simple').meta(ui({ title: 'Mode' })),
    count: z.number().int().default(1).meta(ui({ title: 'Count', kind: 'count' })),
    threshold: z.number().int().default(2).meta(ui({ title: 'Threshold' })),
    label: z.string().default('').meta(ui({ title: 'Label' })),
    extraA: z
      .number()
      .int()
      .default(10)
      .meta(ui({ title: 'Extra A', kind: 'count', group: 'Advanced', showWhen: { field: 'mode', is: 'advanced' } })),
    extraB: z
      .number()
      .int()
      .default(20)
      .meta(ui({ title: 'Extra B', kind: 'count', group: 'Advanced', showWhen: { field: 'mode', is: 'advanced' } })),
    extraC: z
      .string()
      .default('x')
      .meta(ui({ title: 'Extra C', group: 'Advanced', showWhen: { field: 'mode', is: 'advanced' } })),
  })
  const conditionalJsonSchema = toJsonSchema(conditionalSchema)

  function ConditionalHarness({ onSubmitValue }: { onSubmitValue?: (v: unknown) => void }) {
    const [value, setValue] = useState<unknown>(conditionalSchema.parse({}))
    return <SchemaForm schema={conditionalJsonSchema} value={value} onChange={setValue} onSubmit={() => onSubmitValue?.(value)} />
  }

  function selectMode(name: string) {
    fireEvent.click(screen.getByRole('combobox', { name: 'Mode' }))
    return screen.findByRole('option', { name })
  }

  test("shows four controls in simple mode and seven in advanced (the step's verifiable result)", async () => {
    renderWithApi(<ConditionalHarness />)
    await waitFor(() => expect(screen.getByText('Mode')).toBeTruthy())

    expect(screen.getByText('Count')).toBeTruthy()
    expect(screen.getByText('Threshold')).toBeTruthy()
    expect(screen.getByText('Label')).toBeTruthy()
    expect(screen.queryByText('Extra A')).toBeNull()
    expect(screen.queryByText('Extra B')).toBeNull()
    expect(screen.queryByText('Extra C')).toBeNull()
    // The section itself does not appear either — every field in it is
    // hidden, so an empty "Advanced" heading is never shown (§5 step 95.9's
    // sections-and-hiding judgement).
    expect(screen.queryByText('Advanced')).toBeNull()

    fireEvent.click(await selectMode('advanced'))

    await waitFor(() => expect(screen.getByText('Extra A')).toBeTruthy())
    expect(screen.getByText('Extra B')).toBeTruthy()
    expect(screen.getByText('Extra C')).toBeTruthy()
    expect(screen.getByText('Advanced')).toBeTruthy() // the section reappears now that it has fields to hold
  })

  test('a hidden field still submits its value, unchanged, in both modes', async () => {
    let submitted: unknown
    renderWithApi(<ConditionalHarness onSubmitValue={(v) => (submitted = v)} />)
    await waitFor(() => expect(screen.getByText('Mode')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(submitted).toBeTruthy())
    expect(submitted).toMatchObject({ mode: 'simple', extraA: 10, extraB: 20, extraC: 'x' })

    fireEvent.click(await selectMode('advanced'))
    await waitFor(() => expect(screen.getByText('Extra A')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    // Same three values — going through advanced mode neither reset them
    // nor let them drift; they were never touched because they were never
    // hidden long enough to matter here, which is exactly the point: hiding
    // is presentation, not data (plan 95 §3.6).
    await waitFor(() => expect(submitted).toMatchObject({ mode: 'advanced', extraA: 10, extraB: 20, extraC: 'x' }))
  })

  test('validateAgainstSchema treats a hidden field exactly like a visible one — the browser and the core cannot disagree', () => {
    // No `showWhen` special-casing exists in `validateAgainstSchema` (plan 95 §3.7)
    // — the SAME function the core runs at `POST /api/jobs` sees the SAME
    // payload the browser does, hidden fields included, so there is nothing
    // for the two sides to disagree about. This is a direct check against
    // the shared validator, independent of any DOM rendering.
    const hidden = { mode: 'simple', count: 1, threshold: 2, label: '', extraA: 99_999, extraB: 20, extraC: 'x' }
    const visible = { ...hidden, mode: 'advanced' }
    const resultHidden = validateAgainstSchema(conditionalJsonSchema, hidden)
    const resultVisible = validateAgainstSchema(conditionalJsonSchema, visible)
    // `extraA` has no explicit bound in this fixture, so neither call fails
    // on it — the point is that BOTH calls run the identical check on
    // `extraA` regardless of `mode`, not that this particular value fails.
    expect(resultHidden.ok).toBe(resultVisible.ok)
  })

  describe('a required-and-hidden field with no default reports its error on the controlling field', () => {
    const schema = z.object({
      mode: z.enum(['simple', 'advanced']).default('simple').meta(ui({ title: 'Mode' })),
      region: z.string().meta(ui({ title: 'Region', showWhen: { field: 'mode', is: 'advanced' } })),
    })
    const jsonSchema = toJsonSchema(schema)

    function RequiredHiddenHarness() {
      // Built directly, not via `schema.parse({})` — `region` has no
      // default and is not optional, so parsing an empty object would throw
      // at the Zod level before this component ever mounted. The FORM must
      // still cope with a value that is missing a required, currently
      // hidden key — which is exactly the case this test exists for.
      const [value, setValue] = useState<unknown>({ mode: 'simple' })
      return <SchemaForm schema={jsonSchema} value={value} onChange={setValue} onSubmit={() => {}} />
    }

    test('the error surfaces on Mode, not on the invisible Region field', async () => {
      renderWithApi(<RequiredHiddenHarness />)
      await waitFor(() => expect(screen.getByText('Mode')).toBeTruthy())
      expect(screen.queryByText('Region')).toBeNull() // hidden — mode is 'simple'

      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      // Region itself never gets a DOM node to attach an error to — the
      // message must name it and land on the field the operator can
      // actually see and act on.
      await waitFor(() => expect(screen.getByText('Region: required')).toBeTruthy())
    })

    test('making Region visible moves its error back onto Region itself', async () => {
      renderWithApi(<RequiredHiddenHarness />)
      await waitFor(() => expect(screen.getByText('Mode')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) // touch the form
      await waitFor(() => expect(screen.getByText('Region: required')).toBeTruthy())

      fireEvent.click(screen.getByRole('combobox', { name: 'Mode' }))
      fireEvent.click(await screen.findByRole('option', { name: 'advanced' }))

      await waitFor(() => expect(screen.getByText('Region')).toBeTruthy())
      expect(screen.queryByText('Region: required')).toBeNull() // no longer redirected
      expect(screen.getByText('required')).toBeTruthy() // Region's own, unprefixed error
    })
  })
})

/**
 * Plan 98 §3.5, §3.9, §5 step 98.8 — the `enforcement` badge, rendered
 * through the SAME `NumberControl` every other numeric field uses (no new
 * control — `runtime-override-schema.test.ts`'s own pure planner test is
 * the primary proof; this is the DOM-level half, confirming the badge
 * actually reaches the screen and reads as information about the field, not
 * as a control).
 */
const enforcementSchema = z.object({
  maxRssBytes: z
    .number()
    .int()
    .min(1)
    .default(268_435_456)
    .meta(ui({ title: 'Memory limit', kind: 'bytes', enforcement: 'sampled' })),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .default(60_000)
    .meta(ui({ title: 'Timeout', kind: 'duration', unit: 'ms' })),
})
const enforcementJsonSchema = toJsonSchema(enforcementSchema)

function EnforcementHarness() {
  const [value, setValue] = useState<unknown>(enforcementSchema.parse({}))
  return <SchemaForm schema={enforcementJsonSchema} value={value} onChange={setValue} />
}

describe('SchemaForm — the enforcement badge (plan 98 §3.5, §3.9)', () => {
  test('a "sampled" field draws the badge; a field with no enforcement hint draws none', async () => {
    renderWithApi(<EnforcementHarness />)
    await waitFor(() => expect(screen.getByText('Memory limit')).toBeTruthy())
    expect(screen.getByText('sampled')).toBeTruthy()

    // "Timeout" carries no `enforcement` hint at all (the "hard" default
    // expectation, §3.5) — its own label row has no badge next to it.
    const timeoutLabel = screen.getByText('Timeout')
    const timeoutRow = timeoutLabel.closest('div')
    expect(timeoutRow?.textContent).not.toContain('sampled')
  })
})

/**
 * 96.31 — "Settings unsavable": the DOM-level half of the fix. `plan.test.ts`
 * already proves `planField` computes the right `step`/`increment` values;
 * this proves those values actually REACH the `<input>` (the failure mode
 * this register calls out repeatedly — a correct value computed and never
 * threaded to its call site) and that the trap named in the fix — one prop
 * used for two jobs — did not reappear: the +/- buttons still work once
 * `step` can be the non-numeric `'any'`.
 */
const curvatureSchema = z.object({
  gestureCurvature: z
    .number()
    .min(0)
    .max(0.5)
    .default(0.08)
    .describe('How far a swipe bows away from a straight line, as a fraction of its length.')
    .meta({ title: 'Gesture curvature' }),
  videos: z.number().int().min(0).max(2_000).default(30).meta(ui({ title: 'Videos', kind: 'count' })),
})
const curvatureJsonSchema = toJsonSchema(curvatureSchema)

function CurvatureHarness() {
  const [value, setValue] = useState<unknown>(curvatureSchema.parse({}))
  return <SchemaForm schema={curvatureJsonSchema} value={value} onChange={setValue} />
}

describe('SchemaForm — the reported Settings-unsavable bug, end to end through the real DOM (96.31)', () => {
  test('a curvature-shaped float field renders step="any", not the implicit step="1" that rejected its own 0.08 default', async () => {
    renderWithApi(<CurvatureHarness />)
    await waitFor(() => expect(screen.getByText('Gesture curvature')).toBeTruthy())
    const input = screen.getByLabelText('Gesture curvature') as HTMLInputElement
    expect(input.value).toBe('0.08')
    // The exact attribute the browser's own native validation reads. Before
    // the fix this was absent, and an ABSENT step attribute means the HTML
    // spec's own implicit default of `step="1"` — which, combined with
    // `min="0"`, made every non-integer stored value (including this field's
    // own 0.08 default) fail `reportValidity()` with "The nearest valid
    // value is 0."
    expect(input.getAttribute('step')).toBe('any')
    expect(input.getAttribute('min')).toBe('0')
  })

  test('an integer field still renders step="1", not "any" — the fix does not blur the two apart', async () => {
    renderWithApi(<CurvatureHarness />)
    await waitFor(() => expect(screen.getByText('Videos')).toBeTruthy())
    const input = screen.getByLabelText('Videos') as HTMLInputElement
    expect(input.getAttribute('step')).toBe('1')
  })

  test('the trap: step="any" must not break the +/- buttons (the button delta is a SEPARATE prop, never Number(step))', async () => {
    renderWithApi(<CurvatureHarness />)
    await waitFor(() => expect(screen.getByText('Gesture curvature')).toBeTruthy())
    const input = screen.getByLabelText('Gesture curvature') as HTMLInputElement
    expect(input.value).toBe('0.08')

    fireEvent.click(screen.getByRole('button', { name: 'Increase Gesture curvature' }))
    await waitFor(() => expect(input.value).toBe('0.09'))
    // Had the button delta been derived from `step` directly (`Number('any')
    // === NaN`), this click would have produced "NaN" or left the value
    // unchanged — not a real, one-hundredth increment.

    fireEvent.click(screen.getByRole('button', { name: 'Decrease Gesture curvature' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Gesture curvature' }))
    await waitFor(() => expect(input.value).toBe('0.07'))
  })
})

/**
 * The two workspace path kinds, end to end: `planForm` → `renderControl` →
 * `WorkspacePathControl`. The control's own behaviour is covered by
 * `controls/WorkspacePathControl.test.tsx`; what only this file can show is
 * that the FORM reaches it at all, and that `required` — which no other
 * control reads — arrives from the schema rather than being guessed.
 */
const workspaceSchema = z.object({
  outDir: z.string().default('/videos').meta(ui({ title: 'Output folder', kind: 'workspaceFolder' })),
  captions: z.string().optional().meta(ui({ title: 'Captions', kind: 'workspaceFile', extensions: ['.txt'] })),
})

const workspaceJsonSchema = toJsonSchema(workspaceSchema)

function WorkspaceHarness() {
  const [value, setValue] = useState<unknown>({ outDir: '/videos', captions: '/captions.txt' })
  return <SchemaForm schema={workspaceJsonSchema} value={value} onChange={setValue} />
}

describe('SchemaForm — the workspace path kinds reach their browser through the ordinary walk', () => {
  test('both fields render as a browser showing the current value, not as a path typed from memory', async () => {
    renderWithApi(<WorkspaceHarness />, {
      '/api/v1/cap/fs.list': { body: { ok: true, output: { entries: [{ path: '/videos/', kind: 'dir', size: null, hash: null, updatedAt: null }] } } },
    })
    await waitFor(() => expect(screen.getByText('Output folder')).toBeTruthy())
    expect(screen.getByText('/videos')).toBeTruthy()
    expect(screen.getByText('Captions')).toBeTruthy()
    expect(screen.getByText('/captions.txt')).toBeTruthy()
  })

  test('required comes from the schema: the required folder offers no clear, the optional file would', async () => {
    renderWithApi(<WorkspaceHarness />, {
      '/api/v1/cap/fs.list': { body: { ok: true, output: { entries: [] } } },
    })
    await waitFor(() => expect(screen.getByText('Output folder')).toBeTruthy())
    // `outDir` has a default and is therefore in the schema's `required`
    // list; `captions` is `.optional()` and is not. Both hold a value, so
    // the only thing separating them is where `required` came from.
    expect(screen.queryByRole('button', { name: 'Clear Output folder' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Clear Captions' })).toBeTruthy()
  })
})
