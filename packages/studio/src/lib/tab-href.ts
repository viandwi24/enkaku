/**
 * Build a tab's href without throwing away the query string it is already in.
 *
 * Every tab strip in Studio wrote this by hand, and they did not agree. The
 * Scripts page rebuilt the params and kept them; Jobs and Agents hardcoded
 * `'/jobs?tab=workflows'`, which replaces the whole query string.
 *
 * That was invisible until the side panel arrived: it frames the app at
 * `?pip=1`, and a tab link that drops the query dropped the flag with it —
 * so switching to Workflows inside the panel brought the entire app shell,
 * rail and status bar, into the panel with it (owner, 2026-09-06). The same
 * bug also silently discarded a search term or a filter on every tab switch,
 * which nobody had noticed.
 *
 * One implementation, so a new tab strip inherits the behaviour instead of
 * re-deciding it.
 */
/**
 * `drop` is the other half, and it took a second bug to see it.
 *
 * Preserving the whole query string is right for everything that describes
 * HOW you are looking — the panel flag, a search term, a filter. It is wrong
 * for what you had SELECTED. A batch open at `?tab=batches&job=<batch id>`
 * carried that id onto the Workflows tab, which then looked it up among
 * workflow runs and reported "Could not load — no such job" (owner,
 * 2026-09-07). The hardcoded hrefs this helper replaced dropped everything,
 * so they got this half right by accident and the panel flag wrong.
 *
 * A tab switch means "show me this list", so the selection goes and the view
 * of it stays.
 */
export function tabHref(
  basePath: string,
  params: { toString(): string },
  key: string,
  opts?: { paramName?: string; drop?: readonly string[] },
): string {
  const next = new URLSearchParams(params.toString())
  for (const name of opts?.drop ?? []) next.delete(name)
  next.set(opts?.paramName ?? 'tab', key)
  const query = next.toString()
  return query ? `${basePath}?${query}` : basePath
}
