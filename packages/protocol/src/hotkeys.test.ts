import { describe, expect, test } from 'bun:test'
import { isDomCode } from './keys'
import { chordLabel, DEVICE_CONTROL_HOTKEYS, HOTKEY_IDS, type Hotkey } from './hotkeys'

function byId(id: Hotkey['id']): Hotkey {
  const h = DEVICE_CONTROL_HOTKEYS.find((row) => row.id === id)
  if (!h) throw new Error(`no hotkey ${id}`)
  return h
}

describe('DEVICE_CONTROL_HOTKEYS', () => {
  test('the table has one row per hotkey id and no duplicate chord', () => {
    expect(DEVICE_CONTROL_HOTKEYS.length).toBe(HOTKEY_IDS.length)
    const chords = new Set(DEVICE_CONTROL_HOTKEYS.map((h) => `${h.alt}:${h.shift}:${h.code}`))
    expect(chords.size).toBe(12)
  })

  test("every code is a code plan 209's key table can send", () => {
    expect(DEVICE_CONTROL_HOTKEYS.every((h) => isDomCode(h.code))).toBe(true)
  })

  test('chordLabel renders the modifier order Alt then Shift', () => {
    expect(chordLabel(byId('release-focus'))).toBe('Alt+Shift+K')
    expect(chordLabel(byId('back'))).toBe('Esc')
  })
})
