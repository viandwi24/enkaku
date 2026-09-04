/**
 * Applied before first paint so a dark-theme reload never flashes light
 * (design handoff, Interactions: persisted in `localStorage` under
 * `enkaku-theme`). Inline, tiny, and dependency-free on purpose: it runs
 * before any bundle, which is the whole point of it.
 *
 * It sets nothing when there is no stored choice, `palette.css`'s
 * `@media (prefers-color-scheme: dark)` block already handles that case
 * (plan 204 §3.3), and writing an attribute here would defeat it.
 */
export const THEME_BOOT =
  "try{var t=localStorage.getItem('enkaku-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}"
