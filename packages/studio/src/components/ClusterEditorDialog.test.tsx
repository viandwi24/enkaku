import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ClusterEditorDialog } from './ClusterEditorDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const cluster = {
  id: 'cluster-1',
  name: 'Jakarta',
  description: 'Regional rack',
  createdAt: 0,
  deviceCount: 1,
  usableCount: 1,
}

describe('ClusterEditorDialog — smoke render', () => {
  test('new: renders empty fields and a create button', () => {
    renderWithApi(<ClusterEditorDialog cluster="new" onClose={() => {}} onSaved={() => {}} />, {})
    expect(screen.getByText('New cluster')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create cluster' })).toBeTruthy()
  })

  test('edit: seeds the fields from the given cluster', () => {
    renderWithApi(<ClusterEditorDialog cluster={cluster} onClose={() => {}} onSaved={() => {}} />, {})
    expect(screen.getByDisplayValue('Jakarta')).toBeTruthy()
    expect(screen.getByDisplayValue('Regional rack')).toBeTruthy()
  })

  test('closed: renders nothing', () => {
    renderWithApi(<ClusterEditorDialog cluster={null} onClose={() => {}} onSaved={() => {}} />, {})
    expect(screen.queryByText('New cluster')).toBeNull()
  })

  test('save: a successful PATCH calls onSaved and onClose', async () => {
    let saved = false
    let closed = false
    renderWithApi(
      <ClusterEditorDialog
        cluster={cluster}
        onClose={() => {
          closed = true
        }}
        onSaved={() => {
          saved = true
        }}
      />,
      { '/api/clusters/cluster-1': { body: { cluster } } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(saved).toBe(true))
    expect(closed).toBe(true)
  })
})
