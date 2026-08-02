# Design system — Enkaku Studio

This document records Studio's visual decisions and the reasoning behind them. The point is that a new screen can be built without guesswork, and that a change of style has somewhere to be argued before it spreads across many files.

## Direction: an instrument panel, not a SaaS dashboard

The subject of this application is physical hardware — phones on a rack, cables, heat, batteries. So the look follows measuring equipment rather than an analytics app:

- **Cool graphite, not near-black.** The background `oklch(0.185 0.012 245)` has a blue cast, like anodised aluminium. Pure black makes status colours look like they are shouting.
- **Measurements are always monospaced.** Temperature, fps, battery percentage, resolution, serial — all of it uses the `.readout` class (IBM Plex Mono, `tabular-nums`). Digits that line up mean a changing number never shifts the layout.
- **Saturated colour is for status only.** One red dot among a dozen devices has to catch the eye immediately. If colour is spent on decoration, that signal is lost.

### The signature element: the status rail

Every device card carries a 3 px bar of colour down its left edge (`.status-rail`), exactly like the indicator lamp on a rack unit. Scanning a column of rails is far faster than reading status text one card at a time. The rail only pulses while a device is genuinely working (`data-live="true"`) — motion marks real activity, never decoration.

## Tokens

Every token lives in `packages/studio/src/app/globals.css` inside `@theme` blocks.

| Group | Tokens | Used for |
| --- | --- | --- |
| Surfaces | `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-surface-3` | page background, cards, inputs, popovers |
| Lines | `--color-line`, `--color-line-strong` | card borders, input borders |
| Text | `--color-fg`, `--color-fg-muted`, `--color-fg-subtle` | body, descriptions, labels |
| Interactive | `--color-accent`, `--color-accent-strong`, `--color-accent-fg` | primary buttons, focus, links |
| Status (LED) | `--color-led-ok`, `--color-led-active`, `--color-led-warn`, `--color-led-danger`, `--color-led-off` | status badges, the rail, out-of-range numbers |

A second `@theme` block maps the shadcn tokens (`--color-background`, `--color-primary`, …) onto the ones above, so shadcn components and our own draw from one palette rather than two.

### Writing colour classes

Tailwind v4 generates utilities straight from the token names: `--color-surface` becomes `bg-surface`, `--color-fg-muted` becomes `text-fg-muted`, and `--color-led-danger` becomes `border-led-danger` (accepting opacity modifiers, as in `bg-led-danger/10`).

**Do not write `bg-[--color-surface]`.** That form is Tailwind v3 syntax and produces no CSS at all in v4 — the class silently has no effect, which is far harder to spot than a visible error.

## Typography

- **Archivo** for the interface. A grotesk built for dense displays — industrial without turning decorative.
- **IBM Plex Mono** for `.readout` and `.rack-label`.
- Both load through `next/font/google`, so their files are self-hosted at build time. Nothing is requested from a third party at runtime — which matters for farms on closed networks.

`.rack-label` (10 px, uppercase, `letter-spacing: 0.12em`) is for small panel headings, imitating rack-unit markings.

## Screen patterns

- **`PageHeader`** is required on every screen: the title answers "where am I", and the right side carries the one primary action. Its position never moves, so it never has to be hunted for.
- **`AppShell`** holds navigation, per-item counts, and core connection status. Below 1024 px the sidebar becomes a sheet.
- **`states.tsx`** provides `LoadingRows`, `EmptyState`, and `ErrorState`. Every screen that fetches data must handle all three — an empty screen with no explanation is a defect, not a neutral state.
- **`ConfirmDialog`** guards actions that cannot be undone. Its title must name the thing at stake ("Delete script hello-no-device@1.0.0?"); a dialog that only asks "Are you sure?" helps nobody.
- **`useAction`** wraps async actions: one place for the busy state, the success toast, and the failure toast.

## Schema-driven forms

`SchemaForm` builds forms from the JSON Schema generated from Zod in the core — a single source of truth, where values outside the list are rejected by the server rather than merely hidden in the UI.

The consequence: **field labels and descriptions are written in the Zod schema**, not in a React component. Use `.meta({ title })` for the label and `.describe()` for the description. Without them the label falls back to a humanised key name ("Temp Threshold C"), which leaks internal naming to the user.

Enums use `.meta({ enumSource: 'registry.transports' })` so the dropdown pulls display names and availability from `/api/registry` — an engine that is not ready still appears, disabled, with its reason. People can then tell that something exists but is not ready, rather than assuming it is missing.

## Writing the words

- English, ordinary sentences, no Title Case.
- Name things from the user's side. "Screen capture", not "display engine".
- Error messages say what happened and what to do next. Raw adb output is translated first — "device 'X' not found" becomes "adb can no longer see this device. Check the cable or the wireless connection."
- A verb keeps its name through the whole flow: a "Run" button produces a "Job created" toast, not "Success".

## Quality floor

This applies to every screen, without being asked:

- Readable at 1440 px, 1024 px, and 768 px.
- Keyboard focus is always visible (a global `:focus-visible`).
- `prefers-reduced-motion` is honoured — animation is cut to near zero.
- A control that cannot be used is genuinely `disabled`, not a link that looks dead but is still clickable. If the reason is not obvious from context, add a tooltip that explains it.
