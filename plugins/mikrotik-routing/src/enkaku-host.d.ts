/**
 * The one thing Studio puts in the page for a plugin: a registry to hand a
 * component to. `Window` is a global, so the declaration has to live in a
 * `.d.ts` like this one — but the PROPS do not: they are declared once, in
 * `@enkaku/protocol`, re-exported by `@enkaku/ui`, and imported here. Copied
 * from `plugins/proxy-manager/src/enkaku-host.d.ts`, the reference tier-C
 * plugin this screen mirrors (plan 122 step 122.3) — see that file's own
 * header for why the props are not restated by hand any more.
 *
 * **This file is deliberately kept free of any TOP-LEVEL `import`/`export`**
 * (found while wiring plan 129 §5 step 129.7, not documented anywhere before
 * this). The moment it has one, TypeScript treats the whole file as a
 * module, and a `declare module '@enkaku/host'` written inside a module file
 * is MODULE AUGMENTATION, not a new ambient module — it silently requires
 * `'@enkaku/host'` to already resolve some other way, which it never can
 * (`@enkaku/host` is never published — see that block below). Verified
 * directly against this repo's `moduleResolution: "bundler"`
 * (`tsconfig.base.json`): with the top-level `import type` this file used to
 * have (and with a bare trailing `export {}`, tried as an alternative), `tsc`
 * reported exactly the `Cannot find module '@enkaku/host'` error this block
 * exists to prevent — for every file in the plugin that imports it, not just
 * this one. The canonical scaffold (`packages/sdk/src/cli/init.ts`'s
 * `hostTypes()`) has the same top-level imports and therefore the same bug;
 * it was not caught because nothing had used `@enkaku/host` from a plugin
 * before this step. `declare global { ... }` is dropped for the same reason:
 * it requires the file to already be a module (TS2669 otherwise), so with no
 * top-level import/export left, `Window` is augmented directly. Every type
 * this file needs is written as an inline `import('pkg').X` instead of a
 * top-level import.
 */
interface Window {
  __enkaku__: {
    /** Registers the component that renders one view id, as declared under `surface.views`. */
    register(viewId: string, component: import('react').ComponentType<import('@enkaku/ui').PluginViewProps>): void
  }
}

/**
 * `@enkaku/host` — Studio's OWN components, offered through the same
 * host-module table `@enkaku/ui` is (plan 129 §3.4, step 129.5). Unlike
 * `@enkaku/ui` this is never a published package: Studio hands your module
 * its own live namespace through an import map, so there is nothing on disk
 * for `tsc` to resolve without this block — and, unlike `PluginViewProps`
 * above, nothing checks this declaration against the real one, because there
 * is no shared package both sides import it from. If Studio's barrel
 * (`packages/studio/src/components/host/index.ts`) adds an export, this
 * block has to be updated by hand to see it.
 */
declare module '@enkaku/host' {
  import type { ReactElement } from 'react'
  import type { DeviceInfo } from '@enkaku/protocol'

  /**
   * Pick devices by name, in a dialog — the same `DevicePicker` every action
   * dialog in Studio renders (plan 216 §2.1, §4.10). It fetches the device
   * list itself, so pass none. `filter` narrows what is offered (for
   * example, devices not already in the group you are editing).
   */
  export function DevicePickerDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Ids already chosen — shown selected, and returned unchanged unless deselected. */
    value: string[]
    onConfirm: (ids: string[]) => void
    filter?: (device: DeviceInfo) => boolean
    title?: string
  }): ReactElement | null
}
