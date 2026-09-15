import type { Bounds, UiNode } from '@enkaku/protocol'
import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  isArray: (name) => name === 'node',
})

const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/

export function parseBounds(raw: string | undefined): Bounds {
  const m = raw ? BOUNDS_RE.exec(raw) : null
  if (!m) return { left: 0, top: 0, right: 0, bottom: 0 }
  return {
    left: Number.parseInt(m[1]!, 10),
    top: Number.parseInt(m[2]!, 10),
    right: Number.parseInt(m[3]!, 10),
    bottom: Number.parseInt(m[4]!, 10),
  }
}

interface RawNode {
  '@resource-id'?: string
  '@text'?: string
  '@content-desc'?: string
  '@class'?: string
  '@package'?: string
  '@bounds'?: string
  '@clickable'?: string
  '@enabled'?: string
  '@focused'?: string
  '@index'?: string
  node?: RawNode[]
}

/**
 * Numeric character references back to their characters. `uiautomator` writes a newline inside an attribute as
 * `&#10;`, and the parser decodes only the five named XML entities, so a caption typed with ENTER read back as
 * "habis!&#10;&#10;#AkademiBitorex" (production SM-A075F #3, 2026-09-15) — correct on the phone, a mismatch to every
 * check that compared it with the text that was typed, and the run failed without sharing a caption that had landed.
 */
export function decodeCharRefs(value: string): string {
  if (!value.includes('&#')) return value
  const toChar = (code: number): string => (Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '')
  return value.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => toChar(Number.parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec: string) => toChar(Number.parseInt(dec, 10)))
}

function toUiNode(raw: RawNode): UiNode {
  return {
    resourceId: raw['@resource-id'] ?? '',
    text: decodeCharRefs(raw['@text'] ?? ''),
    desc: decodeCharRefs(raw['@content-desc'] ?? ''),
    className: raw['@class'] ?? '',
    packageName: raw['@package'] ?? '',
    bounds: parseBounds(raw['@bounds']),
    clickable: raw['@clickable'] === 'true',
    enabled: raw['@enabled'] !== 'false',
    focused: raw['@focused'] === 'true',
    index: Number.parseInt(raw['@index'] ?? '0', 10) || 0,
    children: (raw.node ?? []).map(toUiNode),
  }
}

/** `uiautomator dump` XML → UiNode tree (synthetic root from <hierarchy>). */
export function parseUiDump(xml: string): UiNode {
  // uiautomator output often starts with noise ("UI hierchary dumped to: ...").
  const start = xml.indexOf('<?xml')
  const cleaned = start >= 0 ? xml.slice(start) : xml
  const doc = parser.parse(cleaned) as { hierarchy?: RawNode }
  if (!doc.hierarchy) throw new Error('the XML dump has no <hierarchy> element')
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'hierarchy',
    packageName: '',
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: (doc.hierarchy.node ?? []).map(toUiNode),
  }
}
