import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { JsonSchemaNode } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { BatchResults, columnsOf, groupByValues, matchesFilter, omissionText, toCsv } from './BatchResults'

afterEach(cleanup)

/**
 * The schema `plugins/youtube-automation-pack`'s `search-channel` actually
 * declares, trimmed — a real one rather than an invented shape, because the
 * point of this table is that a script's own `result` declaration decides the
 * columns.
 */
const schema = {
  type: 'object',
  properties: {
    query: { type: 'string', title: 'Query' },
    channelOpened: { type: 'boolean', title: 'Channel opened' },
    channelTitle: { type: 'string', title: 'Channel' },
    resultCount: { type: 'integer', title: 'Results' },
    anchors: { type: 'object', title: 'Anchors used', additionalProperties: { type: 'string' } },
  },
} as unknown as JsonSchemaNode

const deviceLabel = (id: string) => ({ number: Number(id.replace(/\D/g, '')) || null, label: `Phone ${id}` })

function results(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    '/api/batches/b1/results': {
      body: { items, resultSchema: schema, omittedCount: 0, budgetBytes: 1048576, ...extra },
    },
  }
}

const member = (i: number, over: Record<string, unknown> = {}) => ({
  jobId: `j${i}`,
  deviceId: `d${i}`,
  batchSeq: i,
  status: 'success',
  resultStatus: 'valid',
  resultSummary: null,
  result: { query: 'eno bening', channelOpened: true, channelTitle: 'Eno Bening', resultCount: 4 },
  ...over,
})

describe('columnsOf', () => {
  test("takes its columns from the script's own result schema, in the schema's order", () => {
    expect(columnsOf(schema).map((c) => c.label)).toEqual(['Query', 'Channel opened', 'Channel', 'Results'])
  })

  /**
   * A nested object rendered into a table cell is raw JSON at 200px — unreadable,
   * and it pushes the columns that ARE readable off the screen. It stays in the
   * member's own panel, where there is room.
   */
  test('a nested object is not a column', () => {
    expect(columnsOf(schema).map((c) => c.key)).not.toContain('anchors')
  })

  test('a script with no declared result schema yields no columns rather than inventing them', () => {
    expect(columnsOf(null)).toEqual([])
  })
})

describe('omissionText', () => {
  /**
   * Never blank. A blank cell in a results table reads as "the script returned
   * nothing", which is a different and much worse claim than "this value did
   * not fit in the response".
   */
  test('every reason a value is absent has words', () => {
    expect(omissionText({ omitted: 'unfinished' } as never)).toBe('not finished yet')
    expect(omissionText({ omitted: 'budget' } as never)).toContain('open the member')
    expect(omissionText({ omitted: 'too-large' } as never)).toContain('too large')
    expect(omissionText({} as never)).toBe('no result')
  })

  test('a member that has its value gets no omission text at all', () => {
    expect(omissionText({ result: { ok: true } } as never)).toBeNull()
  })
})

describe('BatchResults', () => {
  test("renders one row per member with that member's own values", async () => {
    renderWithApi(<BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />, results([member(0), member(1, { result: { query: 'raditya dika', channelOpened: false, channelTitle: '', resultCount: 0 } })]))

    await waitFor(() => expect(screen.getByText('Eno Bening')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Show every member' }))
    expect(screen.getByText('raditya dika')).toBeTruthy()
    expect(screen.getByText('All 2')).toBeTruthy()
  })

  /**
   * The property the whole table rests on. On a farm where "which three devices
   * did NOT do the thing" is the question, a table that drops rows hides exactly
   * what is being looked for.
   */
  test('a member with no value still gets a row, and the row says why', async () => {
    renderWithApi(
      <BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />,
      results([member(0), { ...member(1), result: undefined, status: 'running', omitted: 'unfinished' }]),
    )

    await waitFor(() => expect(screen.getByText('Eno Bening')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Show every member' }))
    expect(screen.getByText('All 2')).toBeTruthy()
    expect(screen.getByText('not finished yet')).toBeTruthy()
  })

  test('values that did not fit are announced above the table, with a count', async () => {
    renderWithApi(
      <BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />,
      results([member(0), { ...member(1), result: undefined, omitted: 'budget' }], { omittedCount: 1 }),
    )

    await waitFor(() => expect(screen.getByText(/1 result is not shown here/)).toBeTruthy())
  })

  test('nothing is announced when everything fitted — no permanent warning for a healthy batch', async () => {
    renderWithApi(<BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />, results([member(0)]))
    await waitFor(() => expect(screen.getByText('Eno Bening')).toBeTruthy())
    expect(screen.queryByText(/not shown here/)).toBeNull()
  })

  test('a row opens that member in place rather than navigating', async () => {
    const opened: string[] = []
    renderWithApi(<BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={(id) => opened.push(id)} />, results([member(0)]))

    await screen.findByText('Eno Bening')
    fireEvent.click(screen.getByRole('button', { name: 'Show every member' }))
    const row = screen.getByText('Eno Bening')
    const open = within(row.closest('tr') as HTMLElement).getByRole('button', { name: 'Open' })
    expect(open.tagName).toBe('BUTTON')
    open.click()
    expect(opened).toEqual(['j0'])
  })

  test('a script with no result schema says so, instead of rendering an empty table', async () => {
    renderWithApi(<BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />, results([member(0)], { resultSchema: null }))
    await waitFor(() => expect(screen.getByText('This script declares no result fields')).toBeTruthy())
  })

  test('a failed fetch shows a named error with a retry, never an empty table', async () => {
    renderWithApi(<BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />, {
      '/api/batches/b1/results': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'results boom' } } },
    })
    await waitFor(() => expect(screen.getByText('results boom')).toBeTruthy())
  })
})


// ---------------------------------------------------------------------------
// Making forty rows readable.
// ---------------------------------------------------------------------------

describe('groupByValues', () => {
  const columns = columnsOf(schema)

  /**
   * The whole argument for grouping, in one assertion. On forty near-identical
   * devices the interesting fact is never the forty rows — it is that
   * thirty-seven agree and three do not, and a flat table makes an operator
   * find that by eye.
   */
  test('members that returned the same values collapse into one group, biggest first', () => {
    const same = { query: 'eno bening', channelOpened: true, channelTitle: 'Eno Bening', resultCount: 4 }
    const odd = { query: 'eno bening', channelOpened: false, channelTitle: '', resultCount: 0 }
    const groups = groupByValues([member(0), member(1), member(2, { result: odd }), member(3, { result: same })], columns)

    expect(groups).toHaveLength(2)
    expect(groups[0]?.members).toHaveLength(3)
    expect(groups[1]?.members.map((m) => m.jobId)).toEqual(['j2'])
  })

  /**
   * Grouped on the COLUMN values, not the whole result: two members whose
   * `anchors` differ by a millisecond of timing are the same outcome to an
   * operator, and grouping on the raw object would put each in its own group
   * and say nothing at all.
   */
  test('a difference in a field that is not a column does not split a group', () => {
    const a = member(0, { result: { query: 'q', channelOpened: true, channelTitle: 'C', resultCount: 1, anchors: { waited: '1000' } } })
    const b = member(1, { result: { query: 'q', channelOpened: true, channelTitle: 'C', resultCount: 1, anchors: { waited: '9999' } } })
    expect(groupByValues([a, b], columns)).toHaveLength(1)
  })

  test('members with no value are not a group — an absence is not an outcome several devices share', () => {
    expect(groupByValues([{ ...member(0), result: undefined }] as never, columns)).toEqual([])
  })
})

describe('matchesFilter', () => {
  test('the three questions an operator asks of a finished batch', () => {
    expect(matchesFilter({ status: 'success', result: {} } as never, 'ok')).toBe(true)
    expect(matchesFilter({ status: 'failed' } as never, 'failed')).toBe(true)
    expect(matchesFilter({ status: 'cancelled' } as never, 'failed')).toBe(true)
    expect(matchesFilter({ status: 'success' } as never, 'no-value')).toBe(true)
    expect(matchesFilter({ status: 'success', result: {} } as never, 'no-value')).toBe(false)
    expect(matchesFilter({ status: 'running' } as never, 'all')).toBe(true)
  })
})

describe('toCsv', () => {
  const columns = columnsOf(schema)

  /**
   * Built from the same formatter the table uses. An export that quietly
   * differs from the table it came from is worse than no export — it gets
   * pasted into a report and nobody re-checks it.
   */
  test('the file says what the screen said', () => {
    const csv = toCsv([member(0), member(7)], columns, deviceLabel)
    const [header, first, second] = csv.split('\n')
    expect(header).toBe('#,device,status,Query,Channel opened,Channel,Results')
    expect(first).toContain('Eno Bening')
    // A device with no number is named by its label alone — never `#null`, and
    // never a stray `#` (plan 124 §3.2's rule for naming a device to a human).
    expect(first).toContain('Phone d0')
    expect(first).not.toContain('#')
    expect(second).toContain('#7 Phone d7')
  })

  test('a value containing a comma or a quote is escaped rather than breaking the row', () => {
    const csv = toCsv([member(0, { result: { query: 'a,b', channelOpened: true, channelTitle: 'He said "hi"', resultCount: 1 } })], columns, deviceLabel)
    expect(csv).toContain('"a,b"')
    expect(csv).toContain('"He said ""hi"""')
  })

  test('a member with no value carries its reason into the file, not an empty cell', () => {
    const csv = toCsv([{ ...member(0), result: undefined, omitted: 'budget' }] as never, columns, deviceLabel)
    expect(csv).toContain('not loaded')
  })
})

describe('BatchResults — the controls', () => {
  test('grouping is the default, and every member is one toggle away', async () => {
    renderWithApi(<BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />, results([member(0), member(1)]))

    // Two members, one outcome: grouped, that is a single row saying "2".
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show every member' })).toBeTruthy())
    expect(screen.getByText('Devices')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show every member' }))
    expect(screen.getByRole('button', { name: 'Group identical' })).toBeTruthy()
  })

  test('a filter chip is offered only when it can match something', async () => {
    renderWithApi(<BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />, results([member(0)]))

    await waitFor(() => expect(screen.getByRole('button', { name: 'All 1' })).toBeTruthy())
    // A chip reading "Failed 0" invites a click that changes nothing.
    expect(screen.queryByRole('button', { name: /^Failed/ })).toBeNull()
  })

  test('a batch with failures offers the filter that finds them', async () => {
    renderWithApi(
      <BatchResults batchId="b1" deviceLabel={deviceLabel} onOpenMember={() => {}} />,
      results([member(0), { ...member(1), status: 'failed', result: undefined, omitted: 'unfinished' }]),
    )

    const failed = await screen.findByRole('button', { name: 'Failed 1' })
    fireEvent.click(failed)
    expect(failed.getAttribute('aria-pressed')).toBe('true')
  })
})
