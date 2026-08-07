import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * shadcn's `TableCell` ships `whitespace-nowrap`, and under it a failed job's
 * error ran on one line forever and pushed every column to its right off the
 * screen. Three call sites had grown their own workaround before the default
 * was fixed — including a `line-clamp-1` on the jobs page that could never
 * have worked, since clamping needs text that is allowed to wrap.
 *
 * These tests pin the shape of the fix so `whitespace-nowrap` cannot drift
 * back into the cell on a future re-vendor of the primitive: the failure is
 * silent (a table simply gets wider than the viewport) and nothing else in
 * the suite would notice.
 */
describe('table primitives — cells wrap, headers do not', () => {
  test('a cell does NOT force one line', () => {
    const { container } = renderWithApi(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>cell</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )
    const cell = container.querySelector('[data-slot="table-cell"]')
    expect(cell).not.toBeNull()
    expect(cell?.className).not.toContain('whitespace-nowrap')
  })

  test('a cell breaks long unbroken strings — serials, paths, stack frames', () => {
    const { container } = renderWithApi(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>/very/long/workspace/path/with/no/spaces/at/all/in/it.ts</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )
    expect(container.querySelector('[data-slot="table-cell"]')?.className).toContain('break-words')
  })

  test('a header DOES stay on one line — a wrapped column title helps nobody', () => {
    const { container } = renderWithApi(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    )
    expect(container.querySelector('[data-slot="table-head"]')?.className).toContain('whitespace-nowrap')
  })

  test('a cell can still opt back into one line when a column wants it', () => {
    const { container } = renderWithApi(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell className="whitespace-nowrap">2m 14s</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )
    expect(container.querySelector('[data-slot="table-cell"]')?.className).toContain('whitespace-nowrap')
  })
})
