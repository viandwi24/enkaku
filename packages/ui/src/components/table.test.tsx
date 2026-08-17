import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table'

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
    const { container } = render(
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

  test('a cell breaks long unbroken strings — serials, paths, a URL quoted in an error', () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>/very/long/workspace/path/with/no/spaces/at/all/in/it.ts</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )
    // `wrap-anywhere`, NOT `break-words`: both break a long word at render
    // time, but only `overflow-wrap: anywhere` reduces the cell's MIN-CONTENT
    // width, and a table sizes its columns from min-content. Under
    // `break-words` a 300-character unbroken string still widened the column
    // and pushed the rest off screen — reported twice before this was right.
    expect(container.querySelector('[data-slot="table-cell"]')?.className).toContain('wrap-anywhere')
  })

  test('a header DOES stay on one line — a wrapped column title helps nobody', () => {
    const { container } = render(
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
    const { container } = render(
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
