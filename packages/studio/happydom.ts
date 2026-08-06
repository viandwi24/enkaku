/**
 * Registers a global DOM for Studio's own component tests (plan 72 §3.5,
 * §4.4). Studio had fourteen test files and not one of them rendered a
 * component — `ToolCallCard.test.tsx`/`ApprovalCard.test.tsx` called a
 * hookless `…View` function directly and inspected the returned element
 * tree, because there was no DOM at all. That is why a crash on render, a
 * missing button, or a double scrollbar was invisible to `bun test`.
 *
 * This MUST be loaded as a genuine Bun preload (`packages/studio/bunfig.toml`
 * → `[test].preload`), not as a plain `import` at the top of a test file.
 * Proven by reproduction: `@testing-library/dom`'s `screen` export is a CJS
 * module-level binding computed ONCE, the first time `screen.js` is
 * evaluated (`typeof document !== 'undefined' ? getQueriesForElement(...) :
 * <a permanently-throwing fallback>`) — under Bun's module loading, that
 * evaluation happens before a same-file `import '../../../happydom'` runs,
 * so `screen`/`waitFor` fail with "a global document has to be available"
 * on every test, even the first, even purely synchronous ones, REGARDLESS
 * of import order in the test file. Only a real preload (which runs before
 * any test file's module graph is touched at all) is early enough.
 *
 * This is also why the preload cannot be global (root `bunfig.toml`): tried
 * it, and it broke 13 existing core tests that stub `globalThis.fetch`
 * themselves — happy-dom's registration installs its own
 * `fetch`/`WebSocket`/etc., which collided with them. So `bun test` from the
 * repo root excludes `packages/studio` entirely (`pathIgnorePatterns` in the
 * root `bunfig.toml`), and Studio's tests run as their own invocation
 * (`bun run --cwd packages/studio test`) where THIS package's `bunfig.toml`
 * — and only this one — is read. That is the actual mechanism behind
 * criterion 10, not the module-graph argument an earlier draft of this
 * comment made (which turned out to be necessary but not sufficient).
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof globalThis.document === 'undefined') {
  GlobalRegistrator.register()
}
