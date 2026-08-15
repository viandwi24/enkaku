import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { LabelPreview } from './LabelPreview'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * Plan 89 §3.4, §5 step 89.8 — the "honesty trap" this component exists to
 * avoid: this workspace has no font and no rasteriser (F11), so the real
 * image is drawn on the device, not here. This is a preview of what the
 * label will SAY, never a claim about how it will look pixel for pixel —
 * asserted here by checking the caption is always present, never by
 * asserting anything about exact pixel sizes (there is no honest pixel
 * size to assert).
 */
describe('LabelPreview', () => {
  test('shows the name and the number, and states plainly that it is a content preview', () => {
    const { container } = renderWithApi(
      <LabelPreview name="Pixel 5" number={7} showName={true} screenW={1080} screenH={2340} />,
    )
    expect(container.textContent).toContain('Pixel 5')
    expect(container.textContent).toContain('#7')
    expect(container.textContent).toContain('the phone renders the real image itself')
  })

  test('a null number renders a dash rather than guessing one', () => {
    const { container } = renderWithApi(<LabelPreview name="Pixel 5" number={null} showName={true} screenW={null} screenH={null} />)
    expect(container.textContent).toContain('—')
    expect(container.textContent).not.toContain('#')
  })

  test('showName: false hides the name entirely, per §4.4', () => {
    const { container } = renderWithApi(<LabelPreview name="Pixel 5" number={7} showName={false} screenW={1080} screenH={2340} />)
    expect(container.textContent).not.toContain('Pixel 5')
    expect(container.textContent).toContain('#7')
  })
})
