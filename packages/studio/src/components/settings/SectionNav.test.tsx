import { describe, expect, mock, test } from 'bun:test'
import { adjacentSectionId, resolveActiveSection, SectionNav, type SettingsSection } from './SectionNav'

/**
 * `SectionNav` (plan 46 §4.1, §7): active selection, keyboard navigation,
 * ARIA roles, `visible: false` hiding a section, and unknown-id fallback.
 *
 * There is no DOM/rendering library in this workspace (see
 * `TileChips.test.tsx` for the established pattern this follows) —
 * `SectionNav` takes no hooks and no internal state (fully controlled by
 * `sections`/`active`/`onChange`), so it can be called directly like any
 * other function; the call returns a plain React-element tree that these
 * small helpers walk, without needing `react-dom` or a browser DOM.
 */

interface ElementLike {
  type: unknown
  props: Record<string, unknown>
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

function asChildren(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.filter(isElement)
  return isElement(node) ? [node] : []
}

function section(id: string, title = id): SettingsSection {
  return { id, title, render: () => `panel:${id}` }
}

/** The tablist and tabpanel divs — the component's only two top-level children. */
function halves(tree: unknown): { tablist: ElementLike; tabpanel: ElementLike } {
  if (!isElement(tree)) throw new Error('SectionNav did not return an element')
  const [tablist, tabpanel] = asChildren(tree.props.children)
  if (!tablist || !tabpanel) throw new Error('expected a tablist and a tabpanel')
  return { tablist, tabpanel }
}

function tabButtons(tree: unknown): ElementLike[] {
  return asChildren(halves(tree).tablist.props.children)
}

function fakeKeyEvent(key: string) {
  let prevented = false
  return { event: { key, preventDefault: () => (prevented = true) }, wasPrevented: () => prevented }
}

describe('SectionNav — roles and structure', () => {
  test('the tab list is role=tablist, aria-orientation=vertical; each tab is role=tab; the panel is role=tabpanel', () => {
    const tree = SectionNav({ sections: [section('a'), section('b')], active: 'a', onChange: () => {} })
    const { tablist, tabpanel } = halves(tree)

    expect(tablist.props.role).toBe('tablist')
    expect(tablist.props['aria-orientation']).toBe('vertical')
    expect(tabpanel.props.role).toBe('tabpanel')

    for (const btn of tabButtons(tree)) {
      expect(btn.props.role).toBe('tab')
    }
  })

  test('the panel is labelled by the active tab, and the active tab points at the panel', () => {
    const tree = SectionNav({ sections: [section('a'), section('b')], active: 'b', onChange: () => {} })
    const { tabpanel } = halves(tree)
    const [tabA, tabB] = tabButtons(tree)

    expect(tabpanel.props.id).toBe(tabB!.props['aria-controls'])
    expect(tabpanel.props['aria-labelledby']).toBe(tabB!.props.id)
    expect(tabA!.props['aria-controls']).not.toBe(tabpanel.props.id)
  })

  test('renders the active section\'s content in the panel, not the others\'', () => {
    const tree = SectionNav({ sections: [section('a'), section('b')], active: 'b', onChange: () => {} })
    const { tabpanel } = halves(tree)
    expect(tabpanel.props.children).toBe('panel:b')
  })
})

describe('SectionNav — active selection', () => {
  test('only the active tab carries aria-selected=true and a 0 tabIndex; the rest are aria-selected=false, tabIndex=-1', () => {
    const tree = SectionNav({ sections: [section('a'), section('b'), section('c')], active: 'b', onChange: () => {} })
    const [a, b, c] = tabButtons(tree)

    expect(a!.props['aria-selected']).toBe(false)
    expect(a!.props.tabIndex).toBe(-1)
    expect(b!.props['aria-selected']).toBe(true)
    expect(b!.props.tabIndex).toBe(0)
    expect(c!.props['aria-selected']).toBe(false)
    expect(c!.props.tabIndex).toBe(-1)
  })
})

describe('SectionNav — visible: false', () => {
  test('a section with visible: false is not rendered as a tab at all', () => {
    const sections = [section('a'), { ...section('b'), visible: false }, section('c')]
    const tree = SectionNav({ sections, active: 'a', onChange: () => {} })
    const ids = tabButtons(tree).map((b) => b.props.id)
    expect(ids).toEqual(['section-tab-a', 'section-tab-c'])
  })

  test('an active id pointing at a now-hidden section falls back to the first visible one', () => {
    const sections = [{ ...section('a'), visible: false }, section('b'), section('c')]
    const tree = SectionNav({ sections, active: 'a', onChange: () => {} })
    const { tabpanel } = halves(tree)
    expect(tabpanel.props.children).toBe('panel:b')
  })
})

describe('SectionNav — unknown-id fallback', () => {
  test('an active id that matches no section renders the first section instead of nothing', () => {
    const sections = [section('a'), section('b')]
    const tree = SectionNav({ sections, active: 'does-not-exist', onChange: () => {} })
    const { tabpanel } = halves(tree)
    const [a] = tabButtons(tree)
    expect(tabpanel.props.children).toBe('panel:a')
    expect(a!.props['aria-selected']).toBe(true)
  })

  test('resolveActiveSection: the same fallback as a pure function', () => {
    const sections = [section('a'), section('b')]
    expect(resolveActiveSection(sections, 'b')?.id).toBe('b')
    expect(resolveActiveSection(sections, 'bogus')?.id).toBe('a')
    expect(resolveActiveSection([], 'a')).toBeUndefined()
  })
})

describe('adjacentSectionId — pure keyboard-navigation logic', () => {
  const sections = [section('a'), section('b'), section('c')]

  test('moves forward and backward within bounds', () => {
    expect(adjacentSectionId(sections, 'a', 1)).toBe('b')
    expect(adjacentSectionId(sections, 'b', 1)).toBe('c')
    expect(adjacentSectionId(sections, 'b', -1)).toBe('a')
  })

  test('wraps at either end', () => {
    expect(adjacentSectionId(sections, 'c', 1)).toBe('a')
    expect(adjacentSectionId(sections, 'a', -1)).toBe('c')
  })

  test('skips sections hidden by visible: false', () => {
    const withHidden = [section('a'), { ...section('b'), visible: false }, section('c')]
    expect(adjacentSectionId(withHidden, 'a', 1)).toBe('c')
    expect(adjacentSectionId(withHidden, 'c', 1)).toBe('a')
  })

  test('an unrecognised active id starts from the first section', () => {
    expect(adjacentSectionId(sections, 'bogus', 1)).toBe('b')
  })
})

describe('SectionNav — keyboard navigation wired through onKeyDown', () => {
  test('ArrowDown/ArrowRight moves to the next tab and calls onChange, preventing default', () => {
    const onChange = mock((_id: string) => {})
    const tree = SectionNav({ sections: [section('a'), section('b'), section('c')], active: 'a', onChange })
    const [a] = tabButtons(tree)
    const onKeyDown = a!.props.onKeyDown as (e: unknown) => void

    const down = fakeKeyEvent('ArrowDown')
    onKeyDown(down.event)
    expect(onChange).toHaveBeenCalledWith('b')
    expect(down.wasPrevented()).toBe(true)

    const right = fakeKeyEvent('ArrowRight')
    onKeyDown(right.event)
    expect(onChange).toHaveBeenCalledWith('b')
  })

  test('ArrowUp/ArrowLeft moves to the previous tab, wrapping from the first to the last', () => {
    const onChange = mock((_id: string) => {})
    const tree = SectionNav({ sections: [section('a'), section('b'), section('c')], active: 'a', onChange })
    const [a] = tabButtons(tree)
    const onKeyDown = a!.props.onKeyDown as (e: unknown) => void

    const up = fakeKeyEvent('ArrowUp')
    onKeyDown(up.event)
    expect(onChange).toHaveBeenCalledWith('c')
  })

  test('Home jumps to the first tab, End jumps to the last', () => {
    const onChange = mock((_id: string) => {})
    const tree = SectionNav({ sections: [section('a'), section('b'), section('c')], active: 'b', onChange })
    const [, b] = tabButtons(tree)
    const onKeyDown = b!.props.onKeyDown as (e: unknown) => void

    onKeyDown(fakeKeyEvent('Home').event)
    expect(onChange).toHaveBeenCalledWith('a')

    onKeyDown(fakeKeyEvent('End').event)
    expect(onChange).toHaveBeenCalledWith('c')
  })

  test('an unrelated key is ignored', () => {
    const onChange = mock((_id: string) => {})
    const tree = SectionNav({ sections: [section('a'), section('b')], active: 'a', onChange })
    const [a] = tabButtons(tree)
    const onKeyDown = a!.props.onKeyDown as (e: unknown) => void

    const tab = fakeKeyEvent('Tab')
    onKeyDown(tab.event)
    expect(onChange).not.toHaveBeenCalled()
    expect(tab.wasPrevented()).toBe(false)
  })

  test('clicking a tab calls onChange with its id', () => {
    const onChange = mock((_id: string) => {})
    const tree = SectionNav({ sections: [section('a'), section('b')], active: 'a', onChange })
    const [, b] = tabButtons(tree)
    const onClick = b!.props.onClick as () => void
    onClick()
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
