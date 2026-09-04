/**
 * How a device is named, and how a device is found — the two rules that plan
 * 124 exists to make universal (§1 goals 1–3, §4.1).
 *
 * ## Why this file is in `@enkaku/ui` and not in Studio
 *
 * The core already has exactly one of these rules: `formatDeviceLabel` in
 * `packages/core/src/registry/device-number.ts`, which every log line, device
 * event and doctor row goes through. The web side had none — every surface
 * hand-composed `#N` beside the label, so out of roughly seventy render sites
 * four were correct (plan 124 §0.1) and the rest silently named three
 * physically identical phones `SM-F721U1, SM-F721U1, SM-F721U1`.
 *
 * A Studio-local helper would have fixed Studio and left the plugin UIs out,
 * because a plugin can import `@enkaku/ui` and nothing else (plan 111 §3.3).
 * That is the entire reason these three functions live here rather than in
 * `packages/studio/src/lib`: Studio, the Mikrotik tab, the Proxy Manager tab
 * and every future tier-C pack compose a device's name with the SAME code, so
 * the rule cannot drift a third time.
 *
 * ## Why the shapes are structural, not `DeviceInfo`
 *
 * `@enkaku/ui` depends on `@enkaku/protocol` and could name `DeviceInfo`
 * here — but almost none of the callers hold one. A Mikrotik `FleetDeviceRow`,
 * a Proxy Manager scan row, a plugin view's `$device.*` binding and a batch
 * artifact are all four-field projections of a device, built by four different
 * servers. Asking each of them to widen into a full `DeviceInfo` to render a
 * name would be a far larger change than plan 124 §3.7's "one nullable field,
 * never a widened object". So the parameter types below are the minimum each
 * function actually reads, and a real `DeviceInfo` satisfies them for free.
 */

/**
 * The minimum a device has to carry to be *named*: a label, and the number
 * that tells two identically labelled phones apart.
 *
 * `number` is optional AND nullable, and the two mean different things that
 * this module deliberately treats the same way. `null` is a real, legitimate
 * state — a device whose reservation was explicitly released, or one that was
 * never allocated a number (plan 89's own rule that a missing number is a
 * state, not an error). `undefined` is a payload or a hand-built test fixture
 * that predates the field. Neither may ever render as `#null` or `#undefined`
 * (plan 124 criterion 7), so every function here treats both as "no number".
 */
export type NamedDevice = {
  number?: number | null
  label: string
}

/**
 * The minimum a device has to carry to be *found*. `tags` is optional because
 * the projections described above mostly do not carry tags; a device without
 * them simply has fewer ways to match, never an error.
 */
export type SearchableDevice = NamedDevice & {
  stableId: string
  tags?: readonly string[]
}

/**
 * `#7 Galaxy A15`, or the bare label when the device has no number.
 *
 * **This mirrors `formatDeviceLabel` in
 * `packages/core/src/registry/device-number.ts` character for character, and
 * that is load-bearing rather than incidental** — the same device is named by
 * the core (in a log line, a device event, a doctor row) and by the browser
 * (in a dialog title, a toast, a table cell) within seconds of each other, and
 * an operator reading both has to see one string, not two spellings of it.
 * `device-name.test.ts` asserts the agreement against the core's actual source
 * text, so a change on either side fails a test instead of drifting quietly.
 *
 * The number is *composed* here and never written back into `devices.label`
 * (plan 124 §3.1, plan 89 §3.3). Nothing in the product parses `#7` back out
 * of a label, so nothing may put it in.
 *
 * Use this wherever a `string` is required — `aria-label`s, dialog titles,
 * toasts, `.join(', ')` lists, `<title>`s. Where the number can be a separate
 * span, prefer `<DeviceName>` (§4.2), which lets it be dimmed.
 */
export function formatDeviceName(number: number | null | undefined, label: string): string {
  // `== null` catches BOTH `null` and `undefined` in one comparison — the only
  // place in this file that leans on loose equality, and it does so because
  // the two cases are genuinely identical here (see `NamedDevice` above).
  return number == null ? label : `#${number} ${label}`
}

/**
 * Every string by which a device can legitimately be recognised: its number
 * both bare and `#`-prefixed, its label, its stableId, and its tags.
 *
 * This is a *search index*, not a name. It exists because `cmdk` (the filter
 * behind `<Combobox>`) matches an item against its `value` plus a `keywords`
 * array, and a combobox row's `value` is an opaque device id that an operator
 * will never type. Feeding this array in as `keywords` is what makes typing
 * `7`, `#7`, `Galaxy`, `R5CW…` or `pool:smoke` all find the same row.
 *
 * Both `7` and `#7` are emitted deliberately: an operator reads the number off
 * a sticker or off the phone's own black wallpaper, where it is printed with
 * the `#`, and types it either way (plan 89 §3.3, "typing `7` matches `#7`").
 * Substring matching inside `cmdk` then makes the bare form redundant in
 * theory — but `matchesDeviceQuery` below is exact on the number, and the two
 * must agree on what a number match means, so both forms are listed here too.
 *
 * Never use this to build a visible name: it is unordered from the reader's
 * point of view and contains the stableId, which is noise in a dialog title.
 */
export function deviceSearchTerms(d: SearchableDevice): string[] {
  const terms: string[] = []
  if (d.number != null) terms.push(String(d.number), `#${d.number}`)
  terms.push(d.label, d.stableId)
  for (const t of d.tags ?? []) terms.push(t)
  // A device whose label is an empty string is not impossible (the enrolment
  // path defaults it, but a plugin's projection may not), and an empty keyword
  // makes `cmdk` score every row identically — so drop the empties rather than
  // hand the filter a term that matches everything.
  return terms.filter((t) => t.length > 0)
}

/**
 * True when `query` matches the device by number (`7` or `#7`), label,
 * stableId, or a tag.
 *
 * This is the four-way match `DevicePicker.tsx:73-88` has implemented since
 * plan 19, lifted verbatim so that every other device list in the product —
 * the Mikrotik assignments table, the Proxy Manager assignments table, the
 * agent device-grant list, the group members dialog — behaves identically
 * instead of each growing its own near-miss (plan 124 §1 goal 3, §4.1's
 * closing note that `DevicePicker` then calls this rather than keeping a
 * second copy).
 *
 * Two properties are worth stating because they are choices, not accidents:
 *
 * - **The number matches EXACTLY, everything else matches as a substring.**
 *   Typing `7` finds `#7` and must not also find `#17`, `#27` and `#70` — on
 *   a 45-device farm that is the difference between one hit and four, and the
 *   operator typing `7` is standing in front of the phone labelled `7`. Labels
 *   and stableIds are the opposite: nobody types a full stableId.
 * - **An empty or whitespace-only query matches everything.** A search box
 *   that has been cleared shows the whole list; it never shows nothing.
 */
export function matchesDeviceQuery(d: SearchableDevice, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  const number = d.number ?? null
  // `DevicePicker` wrote this as two comparisons — `String(number) === q` with
  // a leading `#` stripped, OR `` `#${number}` === q ``. The second is
  // redundant (stripping the `#` from `#7` already yields `7`, which the first
  // comparison then matches), so it is one comparison here. The behaviour is
  // identical for every input, which `device-name.test.ts` pins with both
  // forms of the query.
  const numberMatch = number !== null && String(number) === q.replace(/^#/, '')

  return (
    numberMatch ||
    d.label.toLowerCase().includes(q) ||
    d.stableId.toLowerCase().includes(q) ||
    // `DevicePicker` compared the tag WITHOUT lowercasing it while `q` was
    // already lowercased, so `pool:Smoke` was unfindable by typing `smoke`.
    // Tags are lowercase by convention, which is why nobody hit it. Fixed
    // here rather than reproduced, because this is now the single definition
    // and a case-insensitive tag match is a strict superset of the old
    // behaviour — no query that used to match stops matching.
    (d.tags ?? []).some((t) => t.toLowerCase().includes(q))
  )
}
