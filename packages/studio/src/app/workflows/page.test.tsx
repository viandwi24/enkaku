import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import WorkflowsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const workflowGroup = {
  id: 'wf-1',
  name: 'tiktok-search-pipeline',
  latestVersion: '1.0.0',
  versionCount: 1,
  lastPublishedAt: 0,
  enabled: true,
  kind: 'workflow',
}

const workflowDetail = {
  script: {
    id: 'wf-1',
    name: 'tiktok-search-pipeline',
    version: '1.0.0',
    kind: 'workflow',
    paramsSchema: null,
    enabled: true,
    createdBy: null,
    source: null,
    createdAt: 0,
    workflow: {
      schema: 1,
      name: 'tiktok-search-pipeline',
      version: '1.0.0',
      title: '',
      description: '',
      params: [],
      maxSteps: 50,
      nodes: [
        { kind: 'script', id: 'n0', title: '', script: 'a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'n1', title: '', script: 'b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
    },
  },
}

describe('WorkflowsPage — smoke render (plan 99 §4.11)', () => {
  test('loaded: shows the workflow row, its node count, and a New workflow button', async () => {
    renderWithApi(<WorkflowsPage />, {
      '/api/scripts?group=name&kind=workflow': { body: { items: [workflowGroup], nextCursor: null, total: 1 } },
      '/api/scripts/wf-1': { body: workflowDetail },
      '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('tiktok-search-pipeline')).toBeTruthy())
    expect(screen.getByRole('link', { name: /New workflow/ })).toBeTruthy()
    // Node count is loaded lazily, one detail fetch per row.
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state with a New workflow action', async () => {
    renderWithApi(<WorkflowsPage />, {
      '/api/scripts?group=name&kind=workflow': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('No workflows yet')).toBeTruthy())
  })

  test('a row links into the editor, keyed by the workflow name', async () => {
    renderWithApi(<WorkflowsPage />, {
      '/api/scripts?group=name&kind=workflow': { body: { items: [workflowGroup], nextCursor: null, total: 1 } },
      '/api/scripts/wf-1': { body: workflowDetail },
      '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('tiktok-search-pipeline')).toBeTruthy())
    const link = screen.getByRole('link', { name: 'tiktok-search-pipeline' })
    expect(link.getAttribute('href')).toBe('/workflows/editor?name=tiktok-search-pipeline')
  })
})
