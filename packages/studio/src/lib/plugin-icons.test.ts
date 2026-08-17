import { describe, expect, test } from 'bun:test'
import { ICON_NAMES } from '@enkaku/protocol'
import { FALLBACK_PLUGIN_ICON, PLUGIN_ICONS, pluginIcon } from './plugin-icons'

describe('plugin icon allowlist (plan 108 step 108.8)', () => {
  test('every name the protocol allows resolves to a real component', () => {
    const missing = ICON_NAMES.filter((name) => !PLUGIN_ICONS[name])
    expect(missing).toEqual([])
    for (const name of ICON_NAMES) expect(pluginIcon(name)).toBe(PLUGIN_ICONS[name])
  })

  test('an unknown, empty, or absent name falls back rather than throwing', () => {
    expect(pluginIcon('not-a-real-icon')).toBe(FALLBACK_PLUGIN_ICON)
    expect(pluginIcon('')).toBe(FALLBACK_PLUGIN_ICON)
    expect(pluginIcon(undefined)).toBe(FALLBACK_PLUGIN_ICON)
    expect(pluginIcon(null)).toBe(FALLBACK_PLUGIN_ICON)
  })

  test('a prototype key is not an icon', () => {
    expect(pluginIcon('constructor')).toBe(FALLBACK_PLUGIN_ICON)
    expect(pluginIcon('__proto__')).toBe(FALLBACK_PLUGIN_ICON)
  })
})
