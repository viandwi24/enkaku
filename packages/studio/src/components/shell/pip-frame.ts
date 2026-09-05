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
  return searchParams.get('pip') === '1'
}
