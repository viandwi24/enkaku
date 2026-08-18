import { describe, expect, test } from 'bun:test'
import { resolvePresenter, type FilePresenter } from './index'
import { downloadPresenter } from './download-presenter'
import { imagePresenter } from './image'
import { textPresenter } from './text-presenter'
import { videoPresenter } from './video'

/**
 * Plan 116, step 116.4 — the deliberate single testing pass for the
 * presenter plan. §7 names "presenter selection for each type and the
 * fallback" and the `maxBytes` refusal explicitly; criterion 4 requires
 * every non-editing presenter to explain itself, criterion 5 requires the
 * fallback to be an honest floor rather than a blank pane.
 */

describe('resolvePresenter — selection by content type (§3.3, criterion 5)', () => {
  test('text/plain resolves to the text presenter', () => {
    expect(resolvePresenter({ contentType: 'text/plain', path: '/a.txt' }).id).toBe('text')
  })

  test('application/json resolves to the text presenter (the JSON/JS/TS family, §3.3)', () => {
    expect(resolvePresenter({ contentType: 'application/json', path: '/a.json' }).id).toBe('text')
  })

  test('image/png resolves to the image presenter', () => {
    expect(resolvePresenter({ contentType: 'image/png', path: '/a.png' }).id).toBe('image')
  })

  test('video/mp4 resolves to the video presenter', () => {
    expect(resolvePresenter({ contentType: 'video/mp4', path: '/a.mp4' }).id).toBe('video')
  })

  test('an unknown/unrecognised type reaches the fallback — never nothing, never a crash', () => {
    const presenter = resolvePresenter({ contentType: 'application/x-enkaku-nonsense', path: '/a.bin' })
    expect(presenter.id).toBe('download')
  })
})

describe('the registry — order is meaning, not style (§3.3, §4.1\'s own comment)', () => {
  test('the fallback presenter\'s own `match` never refuses anything', () => {
    expect(downloadPresenter.match({ contentType: 'application/octet-stream', path: '/x' })).toBe(true)
    expect(downloadPresenter.match({ contentType: 'text/plain', path: '/x' })).toBe(true)
    expect(downloadPresenter.match({ contentType: '', path: '/x' })).toBe(true)
    expect(downloadPresenter.match({ contentType: 'video/mp4', path: '/x' })).toBe(true)
  })

  test('the fallback is what resolvePresenter reaches for a type NONE of the real presenters claim — proving it sits last, behind them', () => {
    // Every real presenter's own `match` genuinely refuses this type, so if the fallback were
    // ordered ahead of any of them, THAT presenter — not the fallback — would win instead.
    expect(textPresenter.match({ contentType: 'application/x-enkaku-nonsense', path: '/x' })).toBe(false)
    expect(imagePresenter.match({ contentType: 'application/x-enkaku-nonsense', path: '/x' })).toBe(false)
    expect(videoPresenter.match({ contentType: 'application/x-enkaku-nonsense', path: '/x' })).toBe(false)
    expect(resolvePresenter({ contentType: 'application/x-enkaku-nonsense', path: '/x' })).toBe(downloadPresenter)
  })
})

const ALL_PRESENTERS: FilePresenter[] = [textPresenter, imagePresenter, videoPresenter, downloadPresenter]

describe('every presenter with edit: false states WHY (criterion 4, §3.2)', () => {
  for (const presenter of ALL_PRESENTERS) {
    test(`${presenter.id}: capabilities.edit === false implies a non-empty readOnlyReason`, () => {
      if (presenter.capabilities.edit) {
        // The one editing presenter today — nothing to check here, but the loop still names it
        // so this test suite reads as exhaustive over the registry rather than hand-picked.
        expect(presenter.id).toBe('text')
        return
      }
      expect(typeof presenter.readOnlyReason).toBe('string')
      expect((presenter.readOnlyReason ?? '').length).toBeGreaterThan(0)
    })
  }
})

describe('every presenter declares a positive maxBytes (§3.6)', () => {
  for (const presenter of ALL_PRESENTERS) {
    test(`${presenter.id}: maxBytes is a positive number`, () => {
      expect(typeof presenter.maxBytes).toBe('number')
      expect(presenter.maxBytes).toBeGreaterThan(0)
    })
  }
})
