import type { ComponentType } from 'react'
import type { PluginViewProps } from '@enkaku/ui'

/**
 * The one thing Studio puts in the page for a plugin: a registry to hand a
 * component to. `Window` is a global, so the declaration has to live in a
 * `.d.ts` like this one — but the PROPS do not: they are declared once, in
 * `@enkaku/protocol`, re-exported by `@enkaku/ui`, and imported here. Copied
 * from `plugins/proxy-manager/src/enkaku-host.d.ts`, the reference tier-C
 * plugin this screen mirrors (plan 122 step 122.3) — see that file's own
 * header for why the props are not restated by hand any more.
 */
declare global {
  interface Window {
    __enkaku__: {
      /** Registers the component that renders one view id, as declared under `surface.views`. */
      register(viewId: string, component: ComponentType<PluginViewProps>): void
    }
  }
}

export {}
