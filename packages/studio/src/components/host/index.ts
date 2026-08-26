/**
 * `@enkaku/host` — Studio's OWN components, offered to a plugin UI through
 * the same host-module table `@enkaku/ui` uses (plan 129 §3.4, §4.4, step
 * 129.5).
 *
 * The seam is deliberate, and it is the opposite of the mistake a previous
 * round almost made. `DevicePicker` moved INTO `@enkaku/ui` because it is
 * pure. The component this barrel exists to carry is not: it streams video
 * over Studio's own `/ws` singleton, and moving that into a
 * framework-agnostic package would make `@enkaku/ui` lie about what it is.
 * `@enkaku/host` is explicitly "Studio's own, offered to plugins" — this
 * file is handed to a plugin LIVE, through `plugin-host.ts`'s host-module
 * table, exactly the way `@enkaku/ui` already is. It is never published as a
 * package a plugin depends on.
 *
 * Keeping this barrel's export list short IS the enforcement (plan §8 R2):
 * adding to it is meant to be a deliberate, visible edit to a file whose
 * whole purpose is to stay small — not a place a plugin author is invited to
 * reach into Studio at will. `DeviceWallWithPicker` (plan step 129.6) is
 * still the ONLY export.
 *
 * A plugin author gets types for this module from `enkaku-host.d.ts`'s
 * `declare module '@enkaku/host'` block. That block cannot be checked
 * against this file the way `PluginViewProps` is checked against
 * `@enkaku/protocol` — `@enkaku/host` has no published package for a plugin
 * project to import types from — so it has to be kept in sync with this
 * barrel BY HAND. Update both together.
 */
export { DeviceWallWithPicker, type DeviceWallPickerProps } from './DeviceWallWithPicker'
