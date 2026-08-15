import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { TileSkeleton } from './TileSkeleton'

afterEach(cleanup)

/**
 * The Wall's loading state (Plan 92 §4.7, fixes F16's neighbour finding —
 * `docs/design.md:49`): a tile-shaped skeleton, not `LoadingRows`' generic
 * full-width bars, so the grid does not reflow the moment real tiles land.
 */
describe('TileSkeleton (plan 92 §4.7)', () => {
  test('is marked busy for assistive tech, unlike a silent blank grid', () => {
    const { container } = render(<TileSkeleton />)
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('defaults to 8 placeholder tiles when no count is known yet', () => {
    const { container } = render(<TileSkeleton />)
    // Each skeleton tile draws exactly one screen-area placeholder — count those.
    expect(container.querySelectorAll('.aspect-\\[9\\/16\\]').length).toBe(8)
  })

  test('draws exactly `count` tiles once the real device count is known (settings still loading)', () => {
    const { container } = render(<TileSkeleton count={3} />)
    expect(container.querySelectorAll('.aspect-\\[9\\/16\\]').length).toBe(3)
  })

  test('forwards minTileWidthPx to the SAME TileGrid the real grid uses, so the layout does not jump', () => {
    const { container } = render(<TileSkeleton minTileWidthPx={260} />)
    const grid = container.querySelector('.grid') as HTMLElement
    expect(grid.style.gridTemplateColumns).toContain('260px')
  })
})
