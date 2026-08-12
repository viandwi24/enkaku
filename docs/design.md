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

Every parameter form in Studio — a script run, a schedule, a device's Settings tab, the farm Settings page — is generated from a JSON Schema produced by Zod, never hand-built. Spec §19: *"every config panel is rendered from a schema through the schema-driven form renderer — no hardcoded UI per component."*

There are exactly two artefacts, in two different packages, and the boundary between them is enforced by the package graph rather than by discipline:

1. **The vocabulary** — `packages/protocol/src/params/vocabulary.ts`. What an author may *say* about a parameter, as a closed, versioned, type-checked set. It lives in `@enkaku/protocol`, which Studio depends on and which does not depend on Studio, and it contains no word that names a control.
2. **The resolver** — `packages/studio/src/components/schema-form/plan.ts`. The only place in the product that turns a schema node into a widget. Its contract, `planField(node, ctx) → FieldPlan`, is pure and total: no DOM, no fetching, no randomness, no throw. Every node — including one written before this system existed, and one written by someone hostile — comes back as something rendered, or as an explicit, labelled reason it could not be.

So the line between "what a parameter means" and "how it is drawn" is not a convention to remember. `@enkaku/protocol` cannot import from Studio, which makes it structurally impossible for a control name to leak backward into the vocabulary.

### The vocabulary — `x-enkaku`

Everything an author says beyond `title` and `.describe()` lives under one `.meta()` key, `x-enkaku`, written through the typed helper `ui()` (declared in `@enkaku/protocol`, re-exported from `@enkaku/sdk`):

```ts
videos: z.number().int().min(1).max(2_000).default(30)
  .describe('How many videos to watch before stopping. The real count varies ±30%.')
  .meta(ui({ title: 'Number of videos', kind: 'count', group: 'Core settings' }))
```

`kind` is the value's *meaning* — nine entries, closed:

| `kind` | domain | means |
| --- | --- | --- |
| `count` | integer ≥ 0 | a number of things |
| `chance` | number in `[0,1]` | a probability evaluated at runtime |
| `duration` | number + `unit` (`ms`\|`s`\|`min`\|`h`) | elapsed time |
| `bytes` | integer | a size in bytes |
| `bitrate` | integer | bits per second |
| `pixels` | integer | a length on screen |
| `temperature` | number | degrees Celsius |
| `text` | string | free text |
| `packageName` | string | an Android package id |

Structure, not `kind`, decides arity: a `[min, max]` tuple is already a range because `prefixItems` says so — `ordered` (default `true`) only says which end sorts first. There is no `kind: 'range'`, and there is no control name anywhere in the vocabulary at all: `slider`, `stepper`, `dropdown` are Studio's words, never the schema's, because a schema that named a widget would freeze the design system at the moment the script was published.

`source` is the second axis — where the *set of allowed values* comes from when the schema cannot list it literally (this is the renamed `enumSource`): `.meta(ui({ title: 'Transport', source: 'registry.transports' }))` pulls display names and availability from `/api/registry`, so an engine that is not ready still appears, disabled, with its reason. People can then tell that something exists but is not ready, rather than assuming it is missing. `source` is a closed allowlist kept in Studio — an unrecognised value is ignored, never fetched.

### The resolver — the precedence table

`planField` checks these rows top to bottom; the first match wins. An older script with a bare `z.number()` lands on row 9 and renders exactly as well as it always has — every row degrades to the next one on a mismatch rather than failing.

| # | Condition | Result |
| --- | --- | --- |
| 1 | `$ref` present | resolve against the root with a visited set; a cycle becomes a labelled escape hatch |
| 2 | past the depth cap | a labelled escape hatch ("too deeply nested to render") |
| 3 | `x-enkaku.kind` present, valid for this node's structural type | the control for that kind |
| 4 | `enum`/`const` present | a closed choice, decorated by `labels` then `source` |
| 5 | `type: 'boolean'` | a toggle |
| 6 | a 2-number tuple | a pair — `ordered` from `x-enkaku`, default `true` |
| 7 | a string with `format` in `{date-time, uri, email}` | the matching control |
| 8 | any other string | text (`multiline` from `x-enkaku`, else inferred past 200 characters) |
| 9 | a number or integer | a plain number, bounds from `minimum`/`maximum` |
| 10 | an array of objects | a row table, one column per property |
| 11 | an array of scalars | a list |
| 12 | an object with properties | a group, children in declaration order |
| 13 | an object with none (a `z.record`) | a labelled escape hatch ("this parameter is a free-form map") |
| 14 | `anyOf`/`oneOf`, exactly one real branch | that branch, unwrapped |
| 15 | `anyOf`/`oneOf`, several real branches | a labelled escape hatch ("this parameter can take several different shapes") |
| 16 | anything else | a labelled escape hatch — the terminal result, not a thrown error |

A **declared kind that does not fit its node** (a `kind: 'chance'` on a number whose bounds are not exactly `[0,1]`, a `kind: 'duration'` on a string) simply does not match row 3 and falls through to its structural row — a wrong hint never produces a blank field. The full reasoning behind each row, and the exact test for it, lives in `plan.ts`'s own doc comment; this table exists so the two can be diffed by eye whenever either changes.

### Writing the description

A parameter's `.describe()` is what an operator reads before running a script they did not write. The rule the reference UI taught:

> **A parameter's description says what the script will DO with it, including when it will do nothing.** *"Tap the sound disc, save the sound to Favourites, return to the feed. Skipped if no save button is found."* — not *"whether to save the sound."*

Field labels still come from `.meta(ui({ title }))`. Without a `title`, the label falls back to a humanised key name ("Temp Threshold C"), which leaks internal naming to the user — `title` is what turns that into "Temperature threshold".

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
