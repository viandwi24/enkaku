# Plan 46 — M20 : Device Settings — Vertical Sub-tabs

> Status: draft — small, self-contained UI work. Safe to run at any point.
> Depends on: Plan 15 (design tokens), Plan 16 (screen patterns), Plan 42 (the `TabPanel` wrapper the device page now uses).
> Spec references: §13 (protocol — unchanged here), `docs/design.md` (tokens, screen patterns, writing rules).

---

## 1. Goals

- The device page's **Settings** tab is organised into sub-sections with a **vertical navigation column on the left**, instead of one long scrolling form.
- A section is reachable by URL, so a link can point at exactly the setting being discussed.
- The schema-driven form renderer keeps doing the rendering — this plan groups fields, it does not hand-write them.
- The same grouping pattern is available to the farm-wide Settings page, so the two do not diverge into different shapes.

## 2. Non-goals

- Changing any setting's meaning, default, or validation. This is layout only.
- Replacing the schema-driven renderer with hand-written fields. That would undo the property that new settings appear in the UI for free.
- Redesigning the farm Settings page in this plan. It gains the shared component; reorganising its own content is separate.
- New settings. If a section looks empty, that is information, not a gap to fill.

## 3. Context and design decisions

### 3.1 Why the current shape stopped working

The device Settings tab renders one form for everything a device has: engines, prep and keep-awake, timing, input mode, inspection. Each milestone has added to it — Plan 17 added keep-awake modes and standby, Plan 40 added the input profile and gesture fields, Plan 45 will add readiness — and it is now a long column where related settings are separated by unrelated ones.

A vertical sub-navigation fixes the specific problem: it makes the *shape* of the settings visible before you read any of them, and it keeps a section short enough to take in at once.

### 3.2 Left-vertical, not horizontal

The device page already has a horizontal tab strip (Control, Jobs, Monitor, Terminal, Files, Logs, Settings). A second horizontal strip underneath would read as a sibling of the first and be genuinely confusing about which level you are on.

A vertical column on the left is unambiguous at a glance: outer navigation runs across the top, inner navigation runs down the side. It also scales — a seventh section adds a row, where a horizontal strip would wrap or scroll.

### 3.3 Sections follow the schema, not the other way round

`DeviceSettingsSchema` already has a natural grouping: its top-level keys. So the sections are derived from those keys rather than a hand-maintained list that drifts the first time someone adds a setting.

Proposed sections, in this order — most-changed first, since that is what an operator opens Settings for:

| Section | Schema keys | Why here |
|---|---|---|
| General | label, owner, notes (whatever is not in a group) | identity first |
| Power & readiness | `prep` (keep-awake, standby), plus Plan 45's readiness when it lands | the settings people actually toggle |
| Engines | display, input, inspection, transport | changed rarely, consequential |
| Timing | `timing` (profile, jitter, gesture, typing cadence) | its own section since Plan 40 grew it |

If Plan 45 has not landed, the Power section simply has fewer fields — no coupling between the plans.

### 3.4 A section is a URL

The device page already carries `?id=…&tab=…`. Sub-sections add `&section=…`, so "check this device's timing settings" is a link rather than a set of directions. It also means the browser Back button steps through sections, which is what people expect once navigation looks like navigation.

Unknown or missing `section` falls back to the first one rather than rendering nothing.

## 4. Technical design

### 4.1 A shared component — `packages/studio/src/components/settings/SectionNav.tsx` (new)

```tsx
export interface SettingsSection {
  id: string
  title: string
  /** Rendered when the section is active. */
  render(): ReactNode
  /** Hidden entirely when false — e.g. a section whose feature is switched off farm-wide. */
  visible?: boolean
}

export function SectionNav({ sections, active, onChange }: {
  sections: SettingsSection[]
  active: string
  onChange(id: string): void
}): ReactNode
```

Layout: a two-column grid — a narrow left column of buttons, a content column. It collapses to a single column with the navigation as a horizontal scroller below ~640 px, because a fixed 200 px column on a phone leaves nothing for the form.

Accessibility is not optional here: the list is `role="tablist"` with `aria-orientation="vertical"`, each button is a `tab` with `aria-selected`, the panel is a `tabpanel` labelled by its tab, and Up/Down arrows move between tabs (Left/Right for the collapsed layout). A vertical tab strip that only responds to the mouse is a regression against the current plain form, which is fully keyboard-navigable.

Styling uses design tokens only — `bg-surface`, `text-fg-muted`, `border-border` — never Tailwind v3 bracket syntax, which compiles to nothing in v4 and fails silently (`docs/design.md`).

### 4.2 Device Settings tab — `packages/studio/src/app/device/page.tsx`

The Settings tab's body becomes a `SectionNav` whose sections each render the existing schema-driven form filtered to that section's schema keys. The renderer, the submit path, validation, and the dirty/saved states are untouched — this plan moves fields between containers, nothing else.

`section` is read from and written to the query string alongside `tab`, using the same mechanism the page already uses (and `next/link` for anything that navigates, per the static-export rule).

### 4.3 Farm Settings page

`packages/studio/src/app/settings/page.tsx` adopts the same `SectionNav` so the two pages share one shape. Its existing tab set (including the `adb`, `Jobs`, and `Sessions & Wall` tabs added by Plans 23, 35 and 42) becomes its section list, unchanged in content.

## 5. Implementation steps

**44.1 — `SectionNav`.** The component per §4.1, with the responsive collapse and full keyboard/ARIA support.

**44.2 — Device Settings sections.** Derive the sections from `DeviceSettingsSchema`'s top-level keys per §3.3; render each through the existing schema-driven form.

**44.3 — URL state.** `&section=…`, with an unknown value falling back to the first section.

**44.4 — Farm Settings.** Adopt the same component with its existing content.

**44.5 — Check the whole surface.** Every setting that existed before appears in exactly one section, and none was dropped in the move — this is the one way this plan can silently do damage.

## 6. Acceptance criteria

1. The device Settings tab shows a vertical section list on the left and the active section's fields on the right.
2. Every field that existed before the change is present in exactly one section — none lost, none duplicated.
3. Changing a setting still saves through the existing path, with unchanged validation and unchanged success/error states.
4. `?section=timing` opens directly on that section; an unknown value falls back to the first.
5. Arrow keys move between sections, focus is visible, and the tablist/tab/tabpanel roles are correct.
6. Below ~640 px the navigation collapses to a horizontal scroller and the form remains usable.
7. The farm Settings page uses the same component with its content unchanged.
8. No Tailwind bracket-syntax colour classes are introduced.
9. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `SectionNav.test.tsx` — active selection, keyboard navigation, ARIA roles, `visible: false` hiding a section, unknown-id fallback. A section-coverage test asserts the union of all sections' schema keys equals `DeviceSettingsSchema`'s top-level keys, so a future setting cannot be added to the schema and quietly appear nowhere.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. device page → Settings → sections on the left, first one active
# 2. click through every section; compare the field list against the pre-change form
# 3. change a setting, save, reload → persisted
# 4. copy the URL mid-section, open in a new tab → same section
# 5. keyboard only: Tab into the list, Up/Down between sections
# 6. narrow the window → navigation collapses, form still usable
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A setting is dropped during the regrouping and nobody notices for months. | §6.2 plus the schema-coverage test in §7 — the sections are derived from the schema keys, so a missing group fails the test rather than the eye. |
| A vertical tab strip is mouse-only and regresses keyboard users. | Full ARIA and arrow-key support is an acceptance criterion (§6.5), not a nice-to-have. |
| The two-column layout breaks on a phone. | Collapses below ~640 px, verified in the smoke test (§6.6). |
| Sections drift out of sync with the farm Settings page. | Both use the one `SectionNav`; §6.7 requires it. |

## 9. Open questions

1. Should the farm Settings page's content also be regrouped, or only its container swapped? This plan does the container only, deliberately.
2. Should a section show a marker when it holds unsaved changes? Useful once sections are separate; deferred until the layout is in use.
