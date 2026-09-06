/**
 * The picture-in-picture panel's frame flag (plan 500 §3.7, G8).
 *
 * `PipPanel` loads its framed document at `` `${coreBase()}${href}?pip=1` ``.
 * Inside that document, `AppShell` and `DeviceControlHost` both call this to
 * suppress themselves: no rail, no status bar, no second Device Control
 * (which would mean a second scrcpy session against whatever device the
 * outer window is already showing — §3.7). Two independent call sites reading
 * the same flag is the belt to the `pip` nav flag's braces: even a plugin nav
 * entry someday rendering a device surface still cannot open a cast from
 * inside a frame.
 */
export function isPipFrame(searchParams: { get(name: string): string | null }): boolean {
  if (searchParams.get('pip') === '1') return true
  // Braces to the flag's belt: BEING framed is the fact, and `?pip=1` is only
  // how it is usually announced. A link inside the panel that rebuilds the
  // query string from scratch drops the flag — `/jobs?tab=workflows` did
  // exactly that — and the whole app shell, rail and status bar, appeared
  // inside the panel (owner, 2026-09-06). The links are fixed too, but a
  // guarantee that every future link must remember a parameter is not a
  // guarantee. This one holds whatever anyone writes.
  return isFramedDocument()
}

/**
 * Same-origin frame detection.
 *
 * A cross-origin parent makes the comparison itself throw, and that throw is
 * the answer: a document that cannot see its own top IS framed.
 */
function isFramedDocument(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}
