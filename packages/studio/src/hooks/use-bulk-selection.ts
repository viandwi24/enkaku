/**
 * Plan 83 §3.7, §4.4 — a group header selects/clears its whole group with a
 * tri-state checkbox (checked/unchecked/indeterminate), plus a Select all /
 * Clear all for the whole section. `ToolsSection`, and the device-grants
 * and permissions lists in `AccessSection` (all in `agents/detail/page.tsx`)
 * have the same shape and, before this plan, the same absence — this is the
 * one small helper all three wire into instead of drifting apart as three
 * hand-rolled copies.
 *
 * Deliberately generic over the id type (`string` everywhere today, but
 * kept as `T` rather than hard-coded) and deliberately NOT a hook that owns
 * state itself — `selected`/`setSelected` stay wherever the caller's draft
 * already lives (`draft.tools`, `draft.deviceGrants`, `draft.permissions`),
 * so this only ever computes derived booleans and produces ONE array to
 * hand back, never N individual toggles (criterion 20).
 */

export interface BulkSelection<T> {
  /** Every id in `allIds` is currently selected. */
  allChecked: boolean
  /** Some, but not all, of `allIds` are selected — renders as the checkbox's indeterminate state. */
  someChecked: boolean
  /** Selects every id in `allIds` if any is unselected; clears all of them if every one already is
   * (mirrors a native checkbox: indeterminate or unchecked → checked, checked → unchecked). One
   * `setSelected` call, not N. */
  toggleAll(): void
  /** The tri-state a GIVEN group's own ids are in — 'all' | 'some' | 'none' (criterion 19). */
  groupState(groupIds: T[]): 'all' | 'some' | 'none'
  /** Selects every id in `groupIds` if any is unselected; clears all of them if every one already
   * is — same rule as `toggleAll`, scoped to one group (criterion 18). One `setSelected` call. */
  toggleGroup(groupIds: T[]): void
}

export function useBulkSelection<T>(allIds: readonly T[], selected: readonly T[], setSelected: (ids: T[]) => void): BulkSelection<T> {
  const selectedSet = new Set(selected)

  const stateOf = (ids: readonly T[]): 'all' | 'some' | 'none' => {
    if (ids.length === 0) return 'none'
    const checked = ids.filter((id) => selectedSet.has(id)).length
    if (checked === 0) return 'none'
    return checked === ids.length ? 'all' : 'some'
  }

  const allState = stateOf(allIds)

  return {
    allChecked: allState === 'all',
    someChecked: allState === 'some',
    groupState: (groupIds) => stateOf(groupIds),
    toggleAll() {
      setSelected(allState === 'all' ? [] : [...allIds])
    },
    toggleGroup(groupIds) {
      const groupSet = new Set(groupIds)
      if (stateOf(groupIds) === 'all') {
        setSelected(selected.filter((id) => !groupSet.has(id)))
      } else {
        const merged = new Set(selected)
        for (const id of groupIds) merged.add(id)
        setSelected([...merged])
      }
    },
  }
}
