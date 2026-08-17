import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { WorkspaceListEntry } from '@enkaku/protocol'
import { cleanup, renderWithApi, type MockEntry } from '@/lib/test/render'
import type { FieldPlan } from '../plan'
import { WorkspacePathControl } from './WorkspacePathControl'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * The folder and file browsers (`kind: 'workspaceFolder'` /
 * `kind: 'workspaceFile'`), driven through the REAL `fs.list` capability
 * call the `/workspace` page uses — `POST /api/v1/cap/fs.list` is stubbed
 * here, not `@/lib/workspace`, so these tests would notice if the control
 * ever grew a second, Studio-only way to read the workspace.
 *
 * `fs.list` returns one level, with a DIRECTORY carrying a trailing slash
 * (`/videos/`) that is synthesised from the file rows beneath it — the
 * fixture below is shaped exactly like the store's own output, because the
 * trailing-slash conversion is the one thing in this control that a
 * plausible-looking wrong fixture would hide.
 */

const CAP_LIST = '/api/v1/cap/fs.list'

function dir(path: string): WorkspaceListEntry {
  return { path, kind: 'dir', size: null, hash: null, updatedAt: null }
}

function file(path: string): WorkspaceListEntry {
  return { path, kind: 'file', size: 12, hash: 'h', updatedAt: 1_700_000_000 }
}

/** One `fs.list` stub, keyed by the prefix the control asks for. */
function listing(byPrefix: Record<string, WorkspaceListEntry[]>): Record<string, MockEntry> {
  return {
    [CAP_LIST]: ({ body }) => {
      const prefix = (body as { prefix?: string } | undefined)?.prefix ?? '/'
      return { body: { ok: true, output: { entries: byPrefix[prefix] ?? [] } } }
    },
  }
}

const FOLDER_PLAN: Extract<FieldPlan, { control: 'workspacePath' }> = { control: 'workspacePath', target: 'folder' }
const FILE_PLAN: Extract<FieldPlan, { control: 'workspacePath' }> = { control: 'workspacePath', target: 'file' }

function render(
  plan: Extract<FieldPlan, { control: 'workspacePath' }>,
  responses: Record<string, MockEntry>,
  overrides: { value?: unknown; required?: boolean; onChange?: (path: string, value: unknown) => void; unmatched?: '404' | 'pending' } = {},
) {
  const onChange = overrides.onChange ?? mock((_path: string, _value: unknown) => {})
  const result = renderWithApi(
    <WorkspacePathControl
      id="f-out"
      path="out"
      label="Output folder"
      value={overrides.value}
      required={overrides.required}
      onChange={onChange}
      plan={plan}
    />,
    responses,
    { unmatched: overrides.unmatched ?? '404' },
  )
  return { ...result, onChange }
}

describe('the folder browser', () => {
  test('lists the folders under the workspace root, and only the folders', async () => {
    render(FOLDER_PLAN, listing({ '/': [dir('/videos/'), file('/captions.txt')] }))
    await waitFor(() => expect(screen.getByText('videos')).toBeDefined())
    // A folder picker offers folders. A file in the same directory is not a
    // choice here, so it is not drawn as one.
    expect(screen.queryByText('captions.txt')).toBeNull()
  })

  test('"Use this folder" stores the folder WITHOUT its trailing slash — fs.list says /videos/, every other fs.* call refuses that form', async () => {
    const { onChange } = render(FOLDER_PLAN, listing({ '/': [dir('/videos/')], '/videos/': [dir('/videos/raw/')] }))
    await waitFor(() => expect(screen.getByText('videos')).toBeDefined())

    fireEvent.click(screen.getByText('videos'))
    await waitFor(() => expect(screen.getByText('raw')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(onChange).toHaveBeenCalledWith('out', '/videos')
  })

  test('the workspace root is selectable, and is the one path that keeps its slash', async () => {
    const { onChange } = render(FOLDER_PLAN, listing({ '/': [dir('/videos/')] }))
    await waitFor(() => expect(screen.getByText('videos')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(onChange).toHaveBeenCalledWith('out', '/')
  })

  test('the current value is shown, and clearing it reports undefined', async () => {
    const { onChange } = render(FOLDER_PLAN, listing({ '/videos/': [dir('/videos/raw/')] }), { value: '/videos' })
    // A folder value opens INSIDE itself, so "Use this folder" re-selects
    // what is already selected rather than its parent.
    await waitFor(() => expect(screen.getByText('raw')).toBeDefined())
    expect(screen.getByText('/videos')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Clear Output folder' }))
    expect(onChange).toHaveBeenCalledWith('out', undefined)
  })

  test('a required field offers no clear — emptying a value the form will refuse is a dead end', async () => {
    render(FOLDER_PLAN, listing({ '/videos/': [dir('/videos/raw/')] }), { value: '/videos', required: true })
    await waitFor(() => expect(screen.getByText('raw')).toBeDefined())
    expect(screen.getByText('/videos')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Clear Output folder' })).toBeNull()
  })
})

describe('the file browser', () => {
  test('a file selects; the stored value is its own absolute workspace path', async () => {
    const { onChange } = render(FILE_PLAN, listing({ '/': [dir('/videos/'), file('/captions.txt')] }))
    await waitFor(() => expect(screen.getByText('captions.txt')).toBeDefined())
    fireEvent.click(screen.getByText('captions.txt'))
    expect(onChange).toHaveBeenCalledWith('out', '/captions.txt')
  })

  test('a folder in file mode navigates, it does not select', async () => {
    const { onChange } = render(FILE_PLAN, listing({ '/': [dir('/videos/')], '/videos/': [file('/videos/a.txt')] }))
    await waitFor(() => expect(screen.getByText('videos')).toBeDefined())
    fireEvent.click(screen.getByText('videos'))
    await waitFor(() => expect(screen.getByText('a.txt')).toBeDefined())
    expect(onChange).not.toHaveBeenCalled()
  })

  test('an extension filter disables what it does not offer, rather than hiding it', async () => {
    const { onChange } = render(
      { ...FILE_PLAN, extensions: ['.txt'] },
      listing({ '/': [file('/captions.txt'), file('/clip.mp4')] }),
    )
    await waitFor(() => expect(screen.getByText('captions.txt')).toBeDefined())

    // Shown, so an operator can tell "this file exists but is not what this
    // field is about" from "this file is missing" — the same rule the
    // unavailable-engine option in ChoiceControl already follows.
    const wrong = screen.getByText('clip.mp4').closest('button')
    expect(wrong?.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByText('clip.mp4'))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('captions.txt'))
    expect(onChange).toHaveBeenCalledWith('out', '/captions.txt')
    expect(screen.getByText('Only .txt files can be picked here.')).toBeDefined()
  })

  test('a value stored before a filter existed is still shown — a hint narrows what is offered, never what is accepted', async () => {
    render({ ...FILE_PLAN, extensions: ['.txt'] }, listing({ '/': [file('/clip.mp4')] }), { value: '/clip.mp4' })
    expect(screen.getByText('/clip.mp4')).toBeDefined()
    await waitFor(() => expect(screen.getByText('Nothing here matches .txt.')).toBeDefined())
  })

  test('a file browser opens in the folder its current value lives in', async () => {
    const { apiMock } = render(FILE_PLAN, listing({ '/videos/': [file('/videos/a.txt')] }), { value: '/videos/a.txt' })
    await waitFor(() => expect(screen.getByText('a.txt')).toBeDefined())
    expect(apiMock.calls[0]?.body).toEqual({ prefix: '/videos/' })
  })
})

describe('the three states (docs/design.md) hold inside a control too', () => {
  test('empty: the workspace root with nothing in it says so, and says where to fix it', async () => {
    render(FOLDER_PLAN, listing({ '/': [] }))
    await waitFor(() =>
      expect(screen.getByText(/The workspace is empty\. Add a file on the Workspace page first/)).toBeDefined(),
    )
  })

  test('empty: a folder with only files in it, browsed for folders, is not the same message', async () => {
    render(FOLDER_PLAN, listing({ '/': [dir('/videos/')], '/videos/': [file('/videos/a.txt')] }))
    await waitFor(() => expect(screen.getByText('videos')).toBeDefined())
    fireEvent.click(screen.getByText('videos'))
    await waitFor(() => expect(screen.getByText('No folders inside this one.')).toBeDefined())
  })

  test('failed: the reason is shown and the listing can be retried', async () => {
    let attempt = 0
    const { apiMock } = render(FOLDER_PLAN, {
      [CAP_LIST]: () => {
        attempt++
        return attempt === 1
          ? { status: 500, body: { error: { code: 'E_OUT_OF_SCOPE', message: 'outside this caller\'s workspace scope' } } }
          : { body: { ok: true, output: { entries: [dir('/videos/')] } } }
      },
    })

    await waitFor(() => expect(screen.getByText(/outside this caller's workspace scope/)).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText('videos')).toBeDefined())
    expect(apiMock.calls.length).toBe(2)
  })

  test('loading: the listing is announced as busy before it arrives', () => {
    render(FOLDER_PLAN, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })
})
