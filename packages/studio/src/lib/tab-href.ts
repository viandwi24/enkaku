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
export function tabHref(basePath: string, params: { toString(): string }, key: string, paramName = 'tab'): string {
  const next = new URLSearchParams(params.toString())
  next.set(paramName, key)
  const query = next.toString()
  return query ? `${basePath}?${query}` : basePath
}
