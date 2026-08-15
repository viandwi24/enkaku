import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import WorkflowEditorPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const scriptRow = {
  id: 's-1',
  name: 'tiktok/auto-scroll',
  version: '1.4.0',
  kind: 'script',
  paramsSchema: null,
  enabled: true,
  createdAt: 0,
  hasResult: false,
}

describe('WorkflowEditorPage — smoke render (plan 99 §5 step 99.9)', () => {
  test('no ?name= starts a blank draft, ready for "Add your first node"', async () => {
    setSearchParams({})
    renderWithApi(<WorkflowEditorPage />, {
      '/api/scripts?limit=200&kind=script': { body: { items: [scriptRow], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('New workflow')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Add your first node to get started.')).toBeTruthy())
  })

  test('?name=X loads the newest published version as the starting draft, nodes and all', async () => {
    setSearchParams({ name: 'tiktok-search-pipeline' })
    const workflowDoc = {
      schema: 1,
      name: 'tiktok-search-pipeline',
      version: '1.0.0',
      title: '',
      description: '',
      params: [],
      maxSteps: 50,
      nodes: [
        { kind: 'script', id: 'scroll1', title: 'Scroll FYP', script: 'tiktok/auto-scroll@1.4.0', params: {}, onFailure: { go: 'fail' } },
      ],
    }
    renderWithApi(<WorkflowEditorPage />, {
      '/api/scripts?limit=200&kind=script': { body: { items: [scriptRow], nextCursor: null, total: 1 } },
      '/api/workflows/tiktok-search-pipeline/versions': { body: { items: [{ id: 'wf-1', version: '1.0.0', enabled: true, createdAt: 0 }] } },
      '/api/scripts/wf-1': {
        body: { script: { id: 'wf-1', name: 'tiktok-search-pipeline', version: '1.0.0', kind: 'workflow', paramsSchema: null, enabled: true, createdAt: 0, workflow: workflowDoc } },
      },
    })
    await waitFor(() => expect(screen.getByDisplayValue('Scroll FYP')).toBeTruthy())
    // The suggested next version is the loaded one's patch bumped by one —
    // the version field stays a plain, editable Input, never applied silently.
    expect((screen.getByLabelText('Workflow version') as HTMLInputElement).value).toBe('1.0.1')
  })

  test('?name=X naming a workflow that does not exist shows a named error, not a blank editor', async () => {
    setSearchParams({ name: 'missing-workflow' })
    renderWithApi(<WorkflowEditorPage />, {
      '/api/scripts?limit=200&kind=script': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/workflows/missing-workflow/versions': { body: { items: [] } },
    })
    await waitFor(() => expect(screen.getByText(/No published version of "missing-workflow" was found/)).toBeTruthy())
  })
})
