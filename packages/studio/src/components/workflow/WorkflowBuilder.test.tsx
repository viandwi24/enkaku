import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { checkWorkflow, WorkflowDocSchema, type ResolvedNodeScript, type ScriptRef } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { emptyDraft } from './model'
import type { ScriptOption } from './ScriptPicker'
import { WorkflowBuilder } from './WorkflowBuilder'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * The owner's own three real tiktok scripts (plan 99 §0 — "the plugin
 * already contains three of its four nodes"), plus a fourth, `tiktok/report`,
 * for the Report node the brief's example needs and the pack does not ship —
 * exactly the gap step 99.9's brief itself calls out.
 */
const scriptSchema = (properties: Record<string, JsonSchemaNode>, required: string[] = []): JsonSchemaNode => ({
  type: 'object',
  properties,
  required,
})

const scripts: ScriptOption[] = [
  { id: 's-scroll-140', name: 'tiktok/auto-scroll', version: '1.4.0', enabled: true, paramsSchema: scriptSchema({ videos: { type: 'integer', title: 'Videos', default: 30 } }) },
  { id: 's-scroll-130', name: 'tiktok/auto-scroll', version: '1.3.0', enabled: true, paramsSchema: scriptSchema({ videos: { type: 'integer', title: 'Videos', default: 30 } }) },
  { id: 's-search-140', name: 'tiktok/searched-follow', version: '1.4.0', enabled: true, paramsSchema: scriptSchema({ keyword: { type: 'string', title: 'Search keyword' } }, ['keyword']) },
  { id: 's-report-100', name: 'tiktok/report', version: '1.0.0', enabled: true, paramsSchema: scriptSchema({ summary: { type: 'array', title: 'Summary', items: { type: 'object', properties: {} } } }, ['summary']) },
]

/** A faithful, in-test stand-in for the REAL server route (`packages/core/src/api/workflows.ts`'s `resolveDocRefs` + `checkWorkflow` call) — every referenced ref resolves to an ordinary `kind: 'script'` entry with no declared output schema, matching the honest state of the farm today (plan 99 §0.2 assumption A1 has not landed). Using the REAL `checkWorkflow` here, not a canned response, is what makes the assertions below a genuine proof rather than a fabricated one. */
function resolveRefs(doc: { nodes: readonly { kind: string; script?: string }[]; onFail?: { script: string } }): Map<ScriptRef, ResolvedNodeScript> {
  const resolved = new Map<ScriptRef, ResolvedNodeScript>()
  const add = (ref: string) => {
    const at = ref.lastIndexOf('@')
    // `timeoutMs: null` — "unknown", the sanctioned reading for a caller not
    // wiring plan 98's `runtime.timeoutMs` through (this stand-in's own doc
    // comment); no `budget` is passed to `checkWorkflow` below either, so
    // check 7 is skipped outright and this value is never even consulted.
    resolved.set(ref as ScriptRef, { name: ref.slice(0, at), version: ref.slice(at + 1), kind: 'script', paramsSchema: null, outputSchema: null, timeoutMs: null })
  }
  for (const n of doc.nodes) if (n.kind === 'script' && n.script) add(n.script)
  if (doc.onFail) add(doc.onFail.script)
  return resolved
}

async function openAndPick(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.click(trigger)
  const listbox = await screen.findByRole('listbox')
  fireEvent.click(within(listbox).getByRole('option', { name: optionName }))
}

describe('WorkflowBuilder — the owner\'s example, built with no JSON typed anywhere (plan 99 §5 step 99.9)', () => {
  test('Validate reports exactly the two @latest warnings and nothing else', async () => {
    let published: { id: string; name: string; version: string } | null = null

    const { apiMock } = renderWithApi(
      <WorkflowBuilder initialDraft={emptyDraft()} scripts={scripts} onPublished={(s) => (published = s)} />,
      {
        '/api/workflows/validate': async ({ body }) => {
          const doc = (body as { doc: unknown }).doc
          const parsed = WorkflowDocSchema.safeParse(doc)
          if (!parsed.success) return { body: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: 'E_WORKFLOW_INVALID', message: i.message, severity: 'error' })) }
          return { body: checkWorkflow(parsed.data, resolveRefs(parsed.data)) }
        },
        '/api/workflows': async ({ body }) => {
          const doc = (body as { doc: { name: string; version: string } }).doc
          return { status: 201, body: { script: { id: 'wf-1', name: doc.name, version: doc.version } } }
        },
      },
    )

    // --- Doc-level fields --------------------------------------------------
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'tiktok-search-pipeline' } })

    // --- Add nodes: scroll1, search1, scroll2, gate, report ----------------
    const addScript = () => fireEvent.click(screen.getByRole('button', { name: /Script node/ }))
    addScript()
    addScript()
    addScript()
    fireEvent.click(screen.getByRole('button', { name: /^Gate$/ }))
    addScript()

    const card = (i: number) => within(screen.getByTestId(`node-card-${i}`))
    expect(screen.getAllByTestId(/node-card-/)).toHaveLength(5)

    // Node 0 — Scroll FYP (warm-up): auto-scroll, version left at "latest".
    fireEvent.change(card(0).getByLabelText('Node title'), { target: { value: 'Scroll FYP (warm-up)' } })
    await openAndPick(card(0).getByRole('combobox', { name: 'Script' }), 'tiktok/auto-scroll')

    // Node 1 — Search Keywords & Scroll Posts: searched-follow, PINNED to 1.4.0.
    fireEvent.change(card(1).getByLabelText('Node title'), { target: { value: 'Search Keywords & Scroll Posts' } })
    await openAndPick(card(1).getByRole('combobox', { name: 'Script' }), 'tiktok/searched-follow')
    await openAndPick(card(1).getByRole('combobox', { name: 'Version' }), '1.4.0')
    // The required "keyword" binding has no default — Promote is offered and used,
    // exercising §3.8's whole point ("the path of least resistance").
    fireEvent.click(card(1).getByRole('button', { name: 'Promote' }))

    // Node 2 — Scroll FYP again: auto-scroll, version left at "latest" too
    // (the SECOND `@latest` reference — this and node 0 are the two warnings).
    fireEvent.change(card(2).getByLabelText('Node title'), { target: { value: 'Scroll FYP again' } })
    await openAndPick(card(2).getByRole('combobox', { name: 'Script' }), 'tiktok/auto-scroll')

    // Node 3 — the gate, evaluating the WORKFLOW PARAMETER Promote just created
    // (never an earlier node's output — see this file's module doc on why that
    // keeps the finding count to exactly two).
    fireEvent.change(card(3).getByLabelText('Node title'), { target: { value: 'Enough matches?' } })
    await openAndPick(card(3).getByRole('combobox', { name: 'Comparison' }), 'is not empty')
    await openAndPick(card(3).getByRole('combobox', { name: 'Value source' }), 'Workflow parameter')
    await openAndPick(card(3).getByRole('combobox', { name: 'Workflow parameter' }), 'Search keyword')

    // Node 4 — Report: report@1.0.0 (pinned), bound to the whole run summary.
    fireEvent.change(card(4).getByLabelText('Node title'), { target: { value: 'Report' } })
    await openAndPick(card(4).getByRole('combobox', { name: 'Script' }), 'tiktok/report')
    await openAndPick(card(4).getByRole('combobox', { name: 'Version' }), '1.0.0')
    await openAndPick(card(4).getByRole('combobox', { name: 'Value source' }), 'The whole run summary')

    // --- Not one <textarea> in the whole editor holds anything but prose ---
    const textareas = screen.getAllByRole('textbox').filter((el) => el.tagName === 'TEXTAREA')
    for (const t of textareas) {
      expect((t as HTMLTextAreaElement).value.trim().startsWith('{')).toBe(false)
      expect((t as HTMLTextAreaElement).value.trim().startsWith('[')).toBe(false)
    }

    // --- Validate ------------------------------------------------------------
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    await waitFor(() => expect(screen.getByText(/2 warnings/)).toBeTruthy())

    // The document actually sent is a real, schema-valid WorkflowDoc — no
    // hand-typed JSON produced it, the UI did.
    const validateCall = apiMock.calls.find((c) => c.path === '/api/workflows/validate')
    expect(validateCall).toBeTruthy()
    const sentDoc = (validateCall!.body as { doc: unknown }).doc
    const parsedSent = WorkflowDocSchema.parse(sentDoc)
    expect(parsedSent.name).toBe('tiktok-search-pipeline')
    expect(parsedSent.nodes.map((n) => n.id).length).toBe(5)
    expect(parsedSent.nodes[0]).toMatchObject({ kind: 'script', script: 'tiktok/auto-scroll@latest' })
    expect(parsedSent.nodes[1]).toMatchObject({ kind: 'script', script: 'tiktok/searched-follow@1.4.0' })
    expect((parsedSent.nodes[1] as { params: Record<string, unknown> }).params.keyword).toEqual({ param: 'keyword' })
    expect(parsedSent.nodes[2]).toMatchObject({ kind: 'script', script: 'tiktok/auto-scroll@latest' })
    expect(parsedSent.nodes[3]).toMatchObject({ kind: 'gate' })
    expect((parsedSent.nodes[3] as { when: unknown }).when).toEqual({ left: { param: 'keyword' }, op: 'notEmpty' })
    expect(parsedSent.nodes[4]).toMatchObject({ kind: 'script', script: 'tiktok/report@1.0.0' })
    expect((parsedSent.nodes[4] as { params: Record<string, unknown> }).params.summary).toEqual({ run: 'summary' })
    expect(parsedSent.params).toEqual([expect.objectContaining({ name: 'keyword', type: 'string', required: true, title: 'Search keyword' })])

    // Exactly two findings, both W_WORKFLOW_LATEST_REF warnings — never a
    // loop, never an unchecked-binding warning, because nothing in this
    // document binds to an earlier node's OUTPUT.
    const allFindings = screen.getAllByTestId('finding')
    expect(allFindings).toHaveLength(2)
    for (const f of allFindings) {
      expect(f.dataset.severity).toBe('warning')
      expect(f.textContent).toContain('resolves to whatever is newest')
    }
    expect(card(0).getAllByTestId('finding')).toHaveLength(1)
    expect(card(2).getAllByTestId('finding')).toHaveLength(1)
    expect(card(1).queryAllByTestId('finding')).toHaveLength(0)
    expect(card(3).queryAllByTestId('finding')).toHaveLength(0)
    expect(card(4).queryAllByTestId('finding')).toHaveLength(0)

    // --- Publish -------------------------------------------------------------
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(published).toEqual({ id: 'wf-1', name: 'tiktok-search-pipeline', version: '1.0.0' }))
  })
})
