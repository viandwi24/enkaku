import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { LabelStateBadge } from './LabelStateBadge'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * Plan 89 §3.5, §5 step 89.8 — the one place `DeviceLabelState.state` turns
 * into a colour and a word. The failure this component exists to forbid: a
 * `partial`/`unavailable` device reading like an `applied` one.
 */
describe('LabelStateBadge', () => {
  test('applied renders "Labelled" in the ok tone', () => {
    const { container } = renderWithApi(<LabelStateBadge state={{ mode: 'wallpaper', state: 'applied', reason: null }} />)
    expect(container.textContent).toBe('Labelled')
    expect(container.querySelector('.text-led-ok')).not.toBeNull()
  })

  test('stale renders "Stale" in the warn tone, never the ok tone', () => {
    const { container } = renderWithApi(<LabelStateBadge state={{ mode: 'wallpaper', state: 'stale', reason: null }} />)
    expect(container.textContent).toBe('Stale')
    expect(container.querySelector('.text-led-warn')).not.toBeNull()
    expect(container.querySelector('.text-led-ok')).toBeNull()
  })

  test('partial names the reason and never renders the ok (success) tone', () => {
    const { container } = renderWithApi(
      <LabelStateBadge state={{ mode: 'wallpaper', state: 'partial', reason: 'the lock screen refused it' }} />,
    )
    expect(container.textContent).toBe('Partial — the lock screen refused it')
    expect(container.querySelector('.text-led-ok')).toBeNull()
  })

  test('unavailable names the reason in the danger tone, never the ok tone', () => {
    const { container } = renderWithApi(
      <LabelStateBadge state={{ mode: 'wallpaper', state: 'unavailable', reason: 'no guest agent' }} />,
    )
    expect(container.textContent).toBe('Unavailable — no guest agent')
    expect(container.querySelector('.text-led-danger')).not.toBeNull()
    expect(container.querySelector('.text-led-ok')).toBeNull()
  })

  test('off renders nothing — labelling was never asked for, which is not a failure', () => {
    const { container } = renderWithApi(<LabelStateBadge state={{ mode: 'off', state: 'off', reason: null }} />)
    expect(container.textContent).toBe('')
  })

  test('unknown renders nothing — never asked is not a claim either way', () => {
    const { container } = renderWithApi(<LabelStateBadge state={{ mode: 'lock-screen', state: 'unknown', reason: null }} />)
    expect(container.textContent).toBe('')
  })

  test('null (not yet fetched) renders nothing', () => {
    const { container } = renderWithApi(<LabelStateBadge state={null} />)
    expect(container.textContent).toBe('')
  })
})
