import { describe, expect, test } from 'bun:test'
import { UiNodeSchema, type UiNode } from './ui-node'

function leaf(overrides: Partial<UiNode> = {}): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.TextView',
    packageName: 'com.example',
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...overrides,
  }
}

describe('UiNodeSchema (plan 56 §5.1)', () => {
  test('a 4-deep tree round-trips', () => {
    const tree = leaf({
      className: 'android.widget.FrameLayout',
      children: [
        leaf({
          className: 'android.widget.LinearLayout',
          children: [
            leaf({
              className: 'android.widget.LinearLayout',
              children: [leaf({ className: 'android.widget.Button', text: 'Follow', resourceId: 'com.app:id/follow' })],
            }),
          ],
        }),
      ],
    })
    const parsed = UiNodeSchema.parse(tree)
    expect(parsed).toEqual(tree)
    // Depth check: the 4th level really is 4 deep.
    expect(parsed.children[0]?.children[0]?.children[0]?.text).toBe('Follow')
  })

  test('a node missing a required field is rejected', () => {
    const bad = leaf() as unknown as Record<string, unknown>
    delete bad.clickable
    expect(() => UiNodeSchema.parse(bad)).toThrow()
  })

  test('a node with a malformed bounds object is rejected', () => {
    const bad = { ...leaf(), bounds: { left: 0, top: 0 } }
    expect(() => UiNodeSchema.parse(bad)).toThrow()
  })

  test('children defaults to nothing being invented — an empty array must be given explicitly', () => {
    const bad = { ...leaf() } as Record<string, unknown>
    delete bad.children
    expect(() => UiNodeSchema.parse(bad)).toThrow()
  })

  test('an unknown extra field does not break parsing (zod objects strip by default)', () => {
    const withExtra = { ...leaf(), somethingUnexpected: true }
    const parsed = UiNodeSchema.parse(withExtra)
    expect('somethingUnexpected' in parsed).toBe(false)
  })
})
