# Design system — Enkaku Studio

This document records Studio's visual decisions and the reasoning behind them. The point is that a new screen can be built without guesswork, and that a change of style has somewhere to be argued before it spreads across many files.

> **A refresh is in flight — read this before using any value below.**
>
> Plan 101 (M66) adopts the `refs/ui` direction: a new palette, Outfit in place of Archivo, a collapsible floating sidebar, a dot-grid background. **The decisions are settled; the values are not shipped.** Sections marked **TARGET (plan 101)** describe what is being built. Everything else describes what is running today.
>
> Two things follow, and the second one matters more:
>
> 1. Until step 101.1 lands, `globals.css` still carries the previous values. A screen built now inherits the old palette and will inherit the new one automatically when 101.1 lands — **provided it uses token names**.
> 2. **Never hardcode a target value.** The whole reason the refresh costs one file instead of 125 is that every component names its colour (`bg-surface`) rather than stating it. A hex literal written today survives the migration unchanged and becomes the one element that did not update. `design-rules.test.ts` catches the Tailwind v3 bracket form; it cannot catch a hex you invented.

## Direction: an instrument panel, not a SaaS dashboard

The subject of this application is physical hardware — phones on a rack, cables, heat, batteries. So the look follows measuring equipment rather than an analytics app:

- **Cool graphite, not near-black.** The background `oklch(0.185 0.012 245)` has a blue cast, like anodised aluminium. Pure black makes status colours look like they are shouting.

  **TARGET (plan 101) — genuinely undecided, not a formality.** The `refs/ui` direction is near-black (`#0a0a0a`) with a dot grid, which contradicts the paragraph immediately above. Both positions are defensible and neither wins by seniority: plan 101 H3 renders the wall at both backgrounds with a mixed ok/warn/danger/off device set and the owner judges. Whichever way it goes, this bullet is rewritten in the same step — a design system whose own document argues against the background it ships is worse than having no document.
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

### TARGET (plan 101) — the values move, the system does not

The refresh changes what these tokens *are*, never how colour *arrives*. `globals.css` is the only file whose colours change; the 125 component files that name these tokens inherit the new palette without being edited. That property is the entire reason the migration is affordable, and it is worth protecting deliberately rather than by luck.

| Token | Source in `refs/ui` | Note |
| --- | --- | --- |
| `--color-bg` | `#0a0a0a` | Gated on H3 — see Direction above. |
| `--color-surface` | `#181818` | |
| `--color-surface-2` | `#0d0d0d` | |
| `--color-line` / `-strong` | `rgba(255,255,255,0.12)` / `0.14` | The reference uses alpha-white borders; kept as solid tokens so opacity modifiers stay usable. |
| `--color-fg` | `#f2f2f2` | |
| `--color-accent` | `#6db5ff` | |
| `--color-led-ok` / `-warn` / `-danger` | `#4ade80` / `#fefa3d` / `#ff5c5c` | The reference's yellow is markedly brighter than ours — check contrast on the new surface before adopting it verbatim. |
| `--color-led-active`, `--color-led-off` | **no counterpart** | Kept and re-derived, never dropped. |

**`led-active` and `led-off` have no equivalent in the reference**, because the reference never had to render an idle rack. `led-active` distinguishes a device that is streaming from one that is merely healthy; `led-off` distinguishes a device with no signal from one in trouble. A wall that cannot tell "asleep" from "broken" is a regression no amount of polish repays. A palette rewrite is exactly the kind of change that drops a token only one screen uses, so plan 101 asserts their survival in a test rather than trusting review.

`#ff5de7` appears once in the reference, in the logo gradient. It is deliberately **not** promoted to a token: naming it invites its use as a second accent, and "saturated colour is for status only" is the rule immediately above.

### Blur: one static element, never anything repeated per device

**TARGET (plan 101).** The refresh introduces `backdrop-filter: blur(20px) saturate(150%)` on the sidebar. It is permitted **there and nowhere else**.

Backdrop-filter forces a compositing layer. The wall is already the most GPU-contended surface in this product — it decodes 24–40 simultaneous H.264 streams, and plan 100 established that **browser decode capacity, not bandwidth, is what limits how many devices a wall can show**. A blur repeated per tile would spend exactly what plan 100 was built to win back.

So: permitted on the sidebar (one element, static). Forbidden on wall tiles, device cards, status rails, and anything else rendered once per device. Plan 101 makes this a test rather than a sentence, because this codebase has already recorded two cases (hotfix §96.22, §96.25) of a rule that nobody re-checked quietly ceasing to be true.

### Writing colour classes

Tailwind v4 generates utilities straight from the token names: `--color-surface` becomes `bg-surface`, `--color-fg-muted` becomes `text-fg-muted`, and `--color-led-danger` becomes `border-led-danger` (accepting opacity modifiers, as in `bg-led-danger/10`).

**Do not write `bg-[--color-surface]`.** That form is Tailwind v3 syntax and produces no CSS at all in v4 — the class silently has no effect, which is far harder to spot than a visible error.

## Typography

- **Archivo** for the interface. A grotesk built for dense displays — industrial without turning decorative. **TARGET (plan 101): replaced by Outfit**, through the identical mechanism below.
- **IBM Plex Mono** for `.readout` and `.rack-label`. **Not changing.** The `refs/ui` reference has no monospace face at all, because it never had to render a temperature that changes twice a second beside one that does not. `.readout` is why a fluctuating number does not reflow the card it sits in; dropping it to match a mockup would trade a functional property for a cosmetic one.
- Both load through `next/font/google`, so their files are self-hosted at build time. Nothing is requested from a third party at runtime — which matters for farms on closed networks.

  **This constraint is why Outfit arrives through `fonts.ts`, never a `<link>`.** The reference loads it from the Google Fonts CDN, which is a runtime third-party request. Studio is a static export served by the core, routinely on closed networks — and on at least one real farm every request is routed through the guest agent's SOCKS5 tunnel, where an external font fetch does not degrade gracefully, it hangs.

`.rack-label` (10 px, uppercase, `letter-spacing: 0.12em`) is for small panel headings, imitating rack-unit markings.

## Screen patterns

- **`PageHeader`** is required on every screen: the title answers "where am I", and the right side carries the one primary action. Its position never moves, so it never has to be hunted for.
- **`AppShell`** holds navigation, per-item counts, and core connection status. Below 1024 px the sidebar becomes a sheet.

  **TARGET (plan 101): the sidebar collapses**, 222 px ↔ 72 px, floating with a 14 px margin and a 22 px radius. This is a wall feature, not decoration — at 40 devices the 150 px it returns is roughly one more tile column. Collapsed, every item stays reachable as an icon with a tooltip; nothing moves into a hidden overflow menu.

  **Every top-level page must appear here.** Three shipped screens — Workflows, Recordings, Topology — once existed with no nav entry, two of them reachable only through a deep link that appears *after* you have already done something else, so their list pages could not be opened at all (hotfix §96.29). `AppShell.test.tsx` now reads the router's own directory listing and fails if a top-level route has no way in. A redesign that copies a mockup's nav list verbatim will trip it, which is the point.
- **`states.tsx`** provides `LoadingRows`, `EmptyState`, and `ErrorState`. Every screen that fetches data must handle all three — an empty screen with no explanation is a defect, not a neutral state.
- **`ConfirmDialog`** guards actions that cannot be undone. Its title must name the thing at stake ("Delete script hello-no-device@1.0.0?"); a dialog that only asks "Are you sure?" helps nobody.
- **`useAction`** wraps async actions: one place for the busy state, the success toast, and the failure toast.

## Multi-device reports — outcome first, grouped by reason

Every report that shows what happened across more than one device — the Mirror rail's `ok/total`, a batch's `skipped`/`failed` split, the fleet command console's `RunReport`, `POST /:id/stop`'s `refusedDeviceIds` — has converged on one shape by trial rather than by plan, and it is worth stating as a rule so the next one does not invent a fourth style:

1. **Outcome first.** The thing that did not go as expected sorts above everything that did, regardless of group size — one failure among ninety-nine successes is the first row, not something scrolled to. A report that lists successes before failures is asking the reader to do the sorting themselves.
2. **Grouped by reason, not flattened into one row per device.** Devices that produced the *exact* same outcome — same exit code, same output, same skip reason — collapse into one row carrying a count, so a hundred identical `getprop` results read as one line, not a hundred. Grouping is always exact: any difference at all, including a differing exit code on otherwise-identical output, keeps a device out of the group. A skip is grouped by its reason string, not lumped into one undifferentiated "skipped (12)".
3. **Every count is reachable to the named devices behind it.** A number that cannot be expanded into a device list is not a real report — it is a rumour. Every group renders its member count and expands to name them; nothing in a bulk surface may say "3 failed" with no way to ask which three.

This is a rule to follow, not a precedent to copy verbatim — the next multi-device report should re-derive its own grouping key from what actually varies in its own domain (a command's output hash, a transfer's per-device error, a batch member's skip reason), but the three properties above — outcome first, grouped by exact reason, always expandable to names — are the contract. A screen that reports a count it cannot name, or that makes the reader scroll past ninety-nine `ok` rows to find the one that matters, has not implemented this pattern regardless of how it looks.

## Schema-driven forms

Every parameter form in Studio — a script run, a schedule, a device's Settings tab, the farm Settings page — is generated from a JSON Schema produced by Zod, never hand-built. Spec §19: *"every config panel is rendered from a schema through the schema-driven form renderer — no hardcoded UI per component."*

There are exactly two artefacts, in two different packages, and the boundary between them is enforced by the package graph rather than by discipline:

1. **The vocabulary** — `packages/protocol/src/schema/vocabulary.ts` (moved from `params/` by plan 97 step 97.1, once the same vocabulary, limits, validator and clamp became the shared description of *any* declared schema — a parameter's and a script's `result`'s alike — rather than params-only; every export kept its shape, three were renamed, `ui`/`ParamHints`/`readHints` were not). What an author may *say* about a parameter — or, since plan 97 (M62), a result field — as a closed, versioned, type-checked set. It lives in `@enkaku/protocol`, which Studio depends on and which does not depend on Studio, and it contains no word that names a control.
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

`summary` is the one vocabulary key plan 97 (M62) added, and it means something only on a script's **`result`**, never on `params`: `.meta(ui({ title: 'Videos watched', kind: 'count', summary: true }))` marks a field as one of at most three that answer "what did this run actually produce" — the sentence a jobs-list row builds once at settle (`"312 videos · 42 min"`) without loading the row's full result. It is meaning, not presentation, the same category as `kind`: it says which facts are the headline, and Studio still decides entirely how to draw that headline. `summaryFields` (`@enkaku/protocol`'s `schema/result.ts`) walks a result schema's **top-level** properties only, in declaration order, and stops at the third `summary: true` field it finds — a fourth is silently not included in the summary line rather than refused at publish, and a `summary: true` on a nested field is never read at all (the walk does not descend). Computed once per script version, cached on the registry entry, never recomputed per job.

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

## Result views — the same resolver, read after the value exists

A script may declare a `result` (plan 97, M62) the same way it declares `params` — a Zod schema, the same `x-enkaku` vocabulary above, `kind`/`unit`/`summary` and all. The job detail page renders a declared result as values, not as `JSON.stringify(result, null, 2)` in a `<pre>`, and it does so with **no second vocabulary and no second resolver**: `planField` and `formatValue` are reused unchanged, imported by `packages/studio/src/components/result-view/plan-result.ts` rather than reimplemented.

The one fact that makes a result view different from a form is that **a form plans *before* a value exists; a result view plans *after* one does.** Three rules follow from exactly that fact, live in `planResult(schema, value)` beside `planField` rather than inside it, and are the entire delta — nothing else about rendering a result differs from rendering a parameter:

| Rule | What it does | Why `planField` (a form) cannot have it |
| --- | --- | --- |
| **R1 — branch selection** | For `anyOf`/`oneOf` with several real branches, plan whichever branch the actual value validates against; no match falls through to `planField`'s own row 15 (`json`, "this parameter can take several different shapes"). | A form has no value to test a branch against, and switching branches under someone mid-edit would destroy what they typed. |
| **R2 — record expansion** | For an object with no declared `properties` (a `z.record`), render the **value's own keys** as rows, each planned from `additionalProperties` — instead of `planField`'s row 13 escape hatch ("this parameter is a free-form map"). | A form cannot draw an editor for keys that do not exist yet; a result has real keys to show. |
| **R3 — unknown keys, shown, never hidden** | A key present in the value but absent from the schema's own `properties` renders below the declared fields, under one quiet heading, never dropped. | A form produces the value, so it can never have extras — but the child stores a result **verbatim**, unstripped, precisely so this rule has something honest to show. |

Both rules and `planField` itself scope to the result's **top level only** — the same granularity `summary` above already uses. A field several levels deep that is itself a union or a record still renders through `planField`'s own `json` terminal, with a written reason, never as unexplained raw JSON.

**Five statuses, five different things the panel says**, driven by `jobs.result_status` — `undeclared` (no schema was declared; today's `<pre>` — nothing changes for the hundreds of scripts that say nothing), `valid` (`ResultView` renders the plan above), `invalid` (the same panel renders anyway, with a banner reading the actual `resultIssues` paths — the value is still shown, never replaced by an error page, because the device work already happened and hiding the value would throw away the one thing worth looking at), `partial` (a crashed run's salvage from `finish()`, banner: *"this run failed — these are the values it had reached"* — never checked against the schema, because there is no honest lenient schema to check it against), and `oversize` (`result` is `NULL` by construction; the banner names the byte count and `ctx.artifact.file` as the fix, checked first among the banners since it applies whether or not a schema even exists). `undeclared` and `oversize` are the two states that never reach `ResultView` at all.

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
