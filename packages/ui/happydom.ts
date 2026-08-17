/**
 * Registers a global DOM for this package's component tests.
 *
 * This MUST be loaded as a genuine Bun preload (`packages/ui/bunfig.toml` →
 * `[test].preload`), never as a plain `import` at the top of a test file:
 * `@testing-library/dom`'s `screen` export is a module-level binding computed
 * ONCE, the first time `screen.js` is evaluated, and under Bun that happens
 * before any same-file import could take effect. Only a real preload runs
 * early enough. `packages/studio/happydom.ts` records the full reproduction —
 * this file is the same mechanism for the components after they moved out of
 * Studio.
 *
 * It cannot live in the root `bunfig.toml` either: happy-dom's registration
 * installs its own `fetch`/`WebSocket`, which broke core tests that stub
 * `globalThis.fetch` themselves. So the root `bunfig.toml` excludes
 * `packages/ui/**` from its scan and this package runs as its own invocation.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof globalThis.document === 'undefined') {
  GlobalRegistrator.register()
}
