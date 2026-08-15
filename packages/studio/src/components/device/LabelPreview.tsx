/**
 * The Physical labelling section's live preview (plan 89 §3.4, §4.4, §5 step
 * 89.8) — the "honesty trap" this step's own brief names explicitly.
 *
 * The image is rendered ON THE DEVICE (§3.4): this workspace ships no font
 * and no rasteriser (F11), so Android's own `Canvas`/`Paint` draws the real
 * bitmap, at the device's exact pixel dimensions, with its own font's exact
 * metrics. Nothing server-side or browser-side can reproduce that pixel for
 * pixel — a CSS box that LOOKED like a screenshot would promise a fidelity
 * it cannot keep, and the first phone whose real wallpaper differs even
 * slightly would teach the operator to trust the fake over the real thing.
 *
 * So this is deliberately styled as a diagram of CONTENT, not a mock of
 * PIXELS: no phone bezel, no notch, no "photo" framing — just the two
 * strings, roughly where they will sit, labelled as a preview in its own
 * caption. What IS faithful, because it costs nothing to keep faithful: the
 * device's own aspect ratio (`screenW`/`screenH`, already probed — F21), the
 * two-line layout order, and the relative size jump between the name and the
 * number (§4.4's 7%/22%, or 32% with the name hidden) — everything else
 * (the exact font, kerning, anti-aliasing) is the agent's job, not this
 * one's.
 */
export function LabelPreview({
  name,
  number,
  showName,
  screenW,
  screenH,
}: {
  /** The device's label text (already what `showName` gates) — `null`/empty renders the number alone. */
  name: string | null
  /** `null` when this device has no number assigned yet (plan 89 §3.1) — the preview says so instead of guessing one. */
  number: number | null
  showName: boolean
  screenW: number | null
  screenH: number | null
}) {
  // Falls back to a common phone aspect ratio when geometry has not been
  // probed yet (a device that has never connected) — an approximation
  // labelled as one, never a claim of that device's real panel.
  const ratio = screenW && screenH ? `${screenW} / ${screenH}` : '9 / 19.5'

  // §4.4's fractions are of `min(w, h)` — the SHORT edge — which for a
  // portrait phone is its width. This preview has a fixed CSS width
  // (`PREVIEW_WIDTH_PX`), so the same fractions translate to plain pixel
  // font sizes with no container-query dependency (broad browser support
  // over a CSS feature this workspace does not otherwise rely on).
  const PREVIEW_WIDTH_PX = 220
  const nameSizePx = Math.round(PREVIEW_WIDTH_PX * 0.07)
  const numberSizePx = Math.round(PREVIEW_WIDTH_PX * (showName ? 0.22 : 0.32))

  return (
    <div className="space-y-1.5" style={{ width: PREVIEW_WIDTH_PX }}>
      <div
        className="relative flex w-full flex-col items-center justify-center overflow-hidden rounded-md border border-line-strong bg-black"
        style={{ aspectRatio: ratio }}
      >
        {/* The centre-safe square (§4.4: `min(w,h) × 0.8`) — approximated
            here as inset padding, so the preview never pretends text can
            run edge to edge the way a real screenshot's crop would. */}
        <div className="flex w-[80%] flex-col items-center justify-center gap-2 px-2 text-center">
          {showName && name && (
            <span className="truncate font-sans font-normal text-white" style={{ fontSize: nameSizePx }}>
              {name}
            </span>
          )}
          <span className="readout font-bold text-white" style={{ fontSize: numberSizePx }}>
            {number !== null ? `#${number}` : '—'}
          </span>
        </div>
      </div>
      <p className="text-[10.5px] leading-snug text-fg-subtle">
        Preview of the words and layout only — the phone renders the real image itself, with its own font, so the
        exact look on screen will differ.
      </p>
    </div>
  )
}
