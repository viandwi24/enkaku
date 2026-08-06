import { describe, expect, test } from 'bun:test'
import { ToolCallCardView } from './ToolCallCard'

/**
 * `ToolCallCard` (plan 69 §3.2, §7 — "for each outcome shape"). No DOM
 * renderer in this workspace (see `TileChips.test.tsx`) — `ToolCallCardView`
 * is the hookless half (`expanded` is a plain prop, the same split
 * `DeviceHeader` uses), so it can be called directly and its returned
 * element tree walked.
 */

type NodeLike = unknown
interface ElementLike {
  type: unknown
  props: Record<string, unknown>
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

function walk(node: NodeLike, visit: (el: ElementLike) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isElement(node)) return
  visit(node)
  for (const value of Object.values(node.props)) walk(value, visit)
}

function textOf(node: NodeLike): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!isElement(node)) return ''
  return textOf(node.props.children as NodeLike)
}

function classesOf(node: NodeLike): string[] {
  const out: string[] = []
  walk(node, (el) => {
    if (typeof el.props.className === 'string') out.push(el.props.className)
  })
  return out
}

function render(overrides: Partial<Parameters<typeof ToolCallCardView>[0]> = {}) {
  return ToolCallCardView({
    name: 'device.tap',
    input: { deviceId: 'dev-1', x: 10, y: 20 },
    status: 'running',
    expanded: false,
    onToggle: () => undefined,
    ...overrides,
  })
}

describe('ToolCallCardView — outcome shapes', () => {
  test('running shows a running indicator, no ok/error badge', () => {
    const el = render({ status: 'running' })
    expect(textOf(el)).toContain('running…')
    expect(textOf(el)).not.toContain('ok')
    expect(textOf(el)).not.toContain('error')
  })

  test('ok shows a secondary badge with the duration', () => {
    const el = render({ status: 'ok', durationMs: 42 })
    expect(textOf(el)).toContain('ok')
    expect(textOf(el)).toContain('42ms')
    expect(classesOf(el).join(' ')).not.toContain('led-danger')
  })

  test('error is visually distinct — the card border itself carries the danger colour', () => {
    const el = render({ status: 'error', resultContent: [{ type: 'text', text: 'device not found' }], expanded: true })
    expect(textOf(el)).toContain('error')
    expect(classesOf(el).some((c) => c.includes('border-led-danger'))).toBe(true)
    expect(textOf(el)).toContain('device not found')
  })

  test('the input is shown in FULL when expanded — never truncated (criterion 4)', () => {
    const longValue = 'x'.repeat(500)
    const el = render({ status: 'ok', expanded: true, input: { note: longValue }, resultContent: [{ type: 'text', text: '{}' }] })
    // The exact, complete value must appear — no ellipsis, no `.slice()`.
    expect(textOf(el)).toContain(longValue)
    expect(textOf(el)).not.toContain('…')
  })

  test('a wire-sanitised name is reversed to its dotted capability id for display', () => {
    const el = render({ name: 'device_screenshot', status: 'running' })
    expect(textOf(el)).toContain('device.screenshot')
  })

  test('device.screenshot with an image block renders an inline <img> from its blob URL (plan 70 §3.7), not a JSON blob', () => {
    const resultContent: Parameters<typeof ToolCallCardView>[0]['resultContent'] = [
      { type: 'text', text: '{"format":"png"}' },
      { type: 'image', blobId: 'sha256:abc123', mediaType: 'image/png', bytes: 42 },
    ]
    const el = render({ name: 'device.screenshot', status: 'ok', expanded: true, resultContent, input: { deviceId: 'dev-1' } })
    let imgSrc: unknown
    walk(el, (node) => {
      if (node.type === 'img') imgSrc = node.props.src
    })
    expect(String(imgSrc)).toContain('/api/v1/blobs/sha256%3Aabc123')
  })

  test('an image dropped from context (inContext: false) is marked, not silently rendered as current', () => {
    const resultContent: Parameters<typeof ToolCallCardView>[0]['resultContent'] = [{ type: 'image', blobId: 'sha256:abc', mediaType: 'image/png', bytes: 1 }]
    const el = render({ name: 'device.screenshot', status: 'ok', expanded: true, resultContent, inContext: false })
    expect(textOf(el)).toContain('no longer see this screen')
  })

  test('device.screenshot with no image block reports it plainly rather than crashing', () => {
    const el = render({ name: 'device.screenshot', status: 'ok', expanded: true, resultContent: [{ type: 'text', text: 'not an image' }], input: {} })
    expect(textOf(el)).toContain('could not be read')
  })

  test('a device id from the input is shown next to the capability id', () => {
    const el = render({ input: { deviceId: 'dev-42' } })
    expect(textOf(el)).toContain('dev-42')
  })
})
