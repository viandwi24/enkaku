import { afterEach, describe, expect, mock, test } from 'bun:test'
import { useState } from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cleanup, renderWithApi } from '@/lib/test/render'

// `ArtifactPicker` fetches directly through `coreBase()` (a raw fetch, not
// `api()` — F14's endpoint returns an untyped shape until 93.10 lands), and
// `coreBase()` falls through to `location.origin`, which is `null` under
// happy-dom with no configured URL — the exact quirk `FilesPanel.test.tsx`
// already works around this same way.
mock.module('@/lib/ws', () => ({ coreBase: () => 'http://localhost:7700' }))

const { ArtifactPicker } = await import('./ArtifactPicker')
type ArtifactSource = Parameters<typeof ArtifactPicker>[0]['value']

afterEach(cleanup)

function Harness({ initial = null }: { initial?: ArtifactSource | null }) {
  const [value, setValue] = useState<ArtifactSource | null>(initial)
  return <ArtifactPicker accept=".apk" value={value} onChange={setValue} />
}

describe('ArtifactPicker', () => {
  test('the gap, named: ?kind=upload still 400s on this tree (step 93.10 not landed here) and the tab degrades honestly', async () => {
    const user = userEvent.setup()
    renderWithApi(<Harness />, {
      '/api/artifacts*': { status: 400, body: { error: { code: 'E_BAD_REQUEST', message: 'either ?jobId= or ?deviceId= is required' } } },
    })
    await user.click(screen.getByRole('tab', { name: 'Choose existing' }))
    await waitFor(() => expect(screen.getByText(/isn.t available on this build yet/)).toBeTruthy())
  })

  test('lists upload-owned artifacts once ?kind=upload succeeds, and selecting one calls onChange', async () => {
    const user = userEvent.setup()
    renderWithApi(<Harness />, {
      '/api/artifacts*': {
        body: {
          items: [],
          nextCursor: null,
          total: 1,
          artifacts: [{ id: 'art-1', jobId: null, deviceId: null, kind: 'file', label: 'payload.apk', path: 'x', sizeBytes: 2048, createdAt: 0 }],
        },
      },
    })
    await user.click(screen.getByRole('tab', { name: 'Choose existing' }))
    await waitFor(() => expect(screen.getByText('payload.apk')).toBeTruthy())
    await user.click(screen.getByText('payload.apk'))
    // The picker is a controlled component — visible confirmation is the
    // selected row's own highlight class; the parent (BulkTransferDialog /
    // InstallBatchDialog) is what actually reads `onChange`'s argument,
    // exercised in each of THEIR own test files.
    expect(screen.getByText('payload.apk').closest('button')?.className).toContain('bg-accent/10')
  })
})
