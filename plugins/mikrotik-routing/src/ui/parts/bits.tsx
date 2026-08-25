import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComboboxOption } from '@enkaku/ui'

/**
 * What this pack needs beyond `@enkaku/ui`'s own components and behaviour
 * layer — one hook, copied from `plugins/proxy-manager/src/ui/parts/
 * bits.tsx`'s own `useLoader` (that file's header explains why this has no
 * canonical Studio version to share: every screen in this product rolls its
 * own load/reload shape), plus the egress-path option list both tabs build
 * (plan 124 §4.5, step 124.7).
 */

/**
 * Load once, reload on demand, and never write state into a component that
 * has already unmounted (switching tabs mid-fetch is the ordinary way to hit
 * that).
 *
 * A hook, in a plugin, using the HOST's React (plan 111 §3.2/T4) — if a
 * second React copy had been bundled, this line is where the screen would
 * die with `Invalid hook call`.
 */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const alive = useRef(true)
  const run = useRef(load)
  run.current = load

  useEffect(() => {
    alive.current = true
    setLoading(true)
    setError(null)
    run
      .current()
      .then((value) => {
        if (alive.current) setData(value)
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive.current) setLoading(false)
      })
    return () => {
      alive.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}

// ---------------------------------------------------------------------------
// The egress-path picker's options (plan 124 §4.5, step 124.7)
// ---------------------------------------------------------------------------

/**
 * The value a picker carries when a device is assigned to no path at all.
 * Purely a UI value — it is mapped back to `''` before anything is written,
 * and is never stored, sent or compared server-side.
 *
 * A sentinel has to be a string no real routing table can be named, because
 * every other value in the list IS a router path id. This was `' none'`
 * (`assignments.tsx`'s own `NONE`, from step 122.6), whose leading space made
 * it un-collidable under Radix `Select`. It cannot stay that under the
 * `Combobox` this step introduced: `cmdk` **trims** every item value it is
 * given (`dist/index.mjs`, `R.trim()`), so `' none'` collapses to `none`
 * inside the filter — and a routing table called `none` is entirely
 * plausible. Two items sharing one internal value would make keyboard
 * selection ambiguous, i.e. choosing the path `none` could unassign the
 * device instead. The underscored form survives trimming and no MikroTik
 * routing table is named it.
 */
export const UNASSIGNED_PATH = '__unassigned__'

/**
 * Why a stale path stays in the list instead of disappearing.
 *
 * A device can be *noted* as using a path that has since been deleted from
 * the router. Dropping that option would render the picker as "Unassigned",
 * which is a different and untrue statement — the note is still there and
 * will still be planned against — so the entry is kept, named, and marked.
 * This is `@enkaku/ui`'s `Combobox` behaviour 1 done properly by the caller:
 * the primitive would fall back to showing the raw id with no explanation,
 * and an explanation is the entire point of the row.
 */
export const STALE_PATH_SUFFIX = ' (no longer on the router)'

/**
 * The option list for one egress-path picker — shared by the Assignments
 * table (one per device row) and the group editor (one per group entry),
 * because both must treat a deleted path the same way and a rule implemented
 * twice is a rule that drifts.
 *
 * `paths` is taken structurally (`{ id, table }`) rather than as `api.ts`'s
 * `Path` so this module stays free of that file's Zod schemas — `bits.tsx` is
 * imported by every tab and has no other reason to pull them in.
 *
 * `unassigned` is opt-in: the Assignments table offers it (a device may
 * legitimately have no path), the group editor does not (an entry with no
 * path is refused on save — "Every device in this group needs a path
 * chosen").
 */
export function pathOptions({ paths, selectedPathId, unassigned }: { paths: readonly { id: string; table: string }[]; selectedPathId: string; unassigned?: boolean }): ComboboxOption[] {
  const options: ComboboxOption[] = []
  if (unassigned) options.push({ value: UNASSIGNED_PATH, label: 'Unassigned' })
  for (const p of paths) options.push({ value: p.id, label: p.table })
  // Only when the current selection is genuinely absent from the router's own
  // inventory — a path that exists needs no annotation, and an empty
  // selection is not a stale one.
  if (selectedPathId !== '' && selectedPathId !== UNASSIGNED_PATH && !paths.some((p) => p.id === selectedPathId)) {
    options.push({ value: selectedPathId, label: `${selectedPathId}${STALE_PATH_SUFFIX}`, hint: 'Still noted for this device, but the router no longer lists it.' })
  }
  return options
}
