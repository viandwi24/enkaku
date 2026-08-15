import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { ui } from '@enkaku/protocol'
import { z } from 'zod'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { JsonSchemaNode } from '../schema-form/types'
import { ResultView } from './ResultView'

afterEach(cleanup)

function toResultSchema(shape: z.ZodRawShape): JsonSchemaNode {
  return JSON.parse(JSON.stringify(z.toJSONSchema(z.object(shape), { io: 'output' }))) as JsonSchemaNode
}

/**
 * `ResultView` (plan 97 §3.6, §4.8) — read-only, through `formatValue`,
 * consuming `planResult`'s plans exactly as `SchemaForm` consumes
 * `planForm`'s. No status banner lives here — those are §4.8's `page.tsx`
 * concern, layered ABOVE this component, not inside it.
 */
describe('ResultView', () => {
  test('a scalar field renders its label and its formatted value', async () => {
    const schema = toResultSchema({
      watchSeconds: z.number().meta(ui({ title: 'Time on feed', kind: 'duration', unit: 's' })),
    })
    renderWithApi(<ResultView schema={schema} value={{ watchSeconds: 2520 }} />)
    await waitFor(() => expect(screen.getByText('Time on feed')).toBeTruthy())
    expect(screen.getByText('42 min')).toBeTruthy()
  })

  test('a chance field renders as a percentage', async () => {
    const schema = toResultSchema({ matchRate: z.number().min(0).max(1).meta(ui({ title: 'Matched', kind: 'chance' })) })
    renderWithApi(<ResultView schema={schema} value={{ matchRate: 0.35 }} />)
    await waitFor(() => expect(screen.getByText('35%')).toBeTruthy())
  })

  test('a boolean field renders Yes/No', async () => {
    const schema = toResultSchema({ endedOnStall: z.boolean().default(false) })
    renderWithApi(<ResultView schema={schema} value={{ endedOnStall: true }} />)
    await waitFor(() => expect(screen.getByText('Yes')).toBeTruthy())
  })

  test('R2 — a z.record renders the value\'s own keys as rows', async () => {
    const schema = toResultSchema({ byLabel: z.record(z.string(), z.number()).meta(ui({ title: 'Videos by label' })) })
    renderWithApi(<ResultView schema={schema} value={{ byLabel: { funny: 120, dance: 80 } }} />)
    await waitFor(() => expect(screen.getByText('Videos by label')).toBeTruthy())
    expect(screen.getByText('Funny')).toBeTruthy()
    expect(screen.getByText('Dance')).toBeTruthy()
    expect(screen.getByText('120')).toBeTruthy()
  })

  test('R1 — a discriminated union renders the branch the value actually took', async () => {
    const wrapped = toResultSchema({
      ok: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), videos: z.number().int() }),
        z.object({ ok: z.literal(false), reason: z.enum(['blocked', 'logged-out', 'no-feed']) }),
      ]),
    })
    const schema = (wrapped.properties as Record<string, JsonSchemaNode>).ok as JsonSchemaNode
    renderWithApi(<ResultView schema={schema} value={{ ok: false, reason: 'blocked' }} />)
    await waitFor(() => expect(screen.getByText('Reason')).toBeTruthy())
    expect(screen.queryByText('Videos')).toBeNull()
  })

  test('R3 — a key the schema never declared is still shown, under its own heading', async () => {
    const schema = toResultSchema({ videos: z.number().int().meta(ui({ title: 'Videos', kind: 'count' })) })
    renderWithApi(<ResultView schema={schema} value={{ videos: 5, mysteryField: 'surprise' }} />)
    await waitFor(() => expect(screen.getByText('not declared by the schema')).toBeTruthy())
    expect(screen.getByText('Mystery Field')).toBeTruthy()
    expect(screen.getByText(/surprise/)).toBeTruthy()
  })

  test('K7 wrong-branch — a value matching no branch renders its reason, not a throw', async () => {
    const schema = toResultSchema({
      shape: z.union([z.object({ a: z.string() }), z.object({ b: z.string() }), z.object({ c: z.string() })]),
    })
    // None of the three branches' required keys are present — R1 finds no match.
    renderWithApi(<ResultView schema={schema} value={{ shape: { mystery: true } }} />)
    await waitFor(() => expect(screen.getByText(/this parameter can take several different shapes/)).toBeTruthy())
  })

  test('a result with no fields at all shows an explicit empty state, not a blank panel', async () => {
    renderWithApi(<ResultView schema={{ type: 'object', properties: {} }} value={{}} />)
    await waitFor(() => expect(screen.getByText('This result has no fields to show.')).toBeTruthy())
  })
})
