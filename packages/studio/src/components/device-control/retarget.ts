/**
 * Design handoff README.md:243-245: "Double-clicking a different device
 * switches the window to it. If that device was already part of the
 * selection the selection is kept (host just moves); if it was not, the
 * selection collapses to just that device."
 *
 * Called by the Devices screen's double-click handler (plan 214's screen);
 * the window itself only ever receives the resulting `deviceId`.
 */
export function retargetSelection(next: string, selected: readonly string[]): string[] {
  return selected.includes(next) ? [...selected] : [next]
}
