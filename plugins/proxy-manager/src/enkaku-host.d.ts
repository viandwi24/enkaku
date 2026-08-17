import type { ComponentType } from 'react'
import type { PluginViewProps } from '@enkaku/ui'

/**
 * The one thing Studio puts in the page for a plugin: a registry to hand a
 * component to. `Window` is a global, so the declaration has to live in a
 * `.d.ts` like this one — but the PROPS no longer do.
 *
 * **This file used to restate `PluginViewProps` by hand**, because the host's
 * own copy lived in `packages/studio/src/lib/plugin-host.ts` and was exported
 * to nowhere a plugin could import. Nothing checked the two against each
 * other, on the one contract plan 111 §9 Q2 exists to define. The shape is now
 * declared once, in `@enkaku/protocol` (types only — it carries no React
 * dependency and keeps none), re-exported by `@enkaku/ui` because that is the
 * package a React plugin already has, and imported by `plugin-host.ts` too. A
 * change to it fails `bash scripts/typecheck.sh` here, at the pack, instead of
 * failing an operator's screen.
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
