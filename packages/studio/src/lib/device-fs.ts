import { z } from 'zod'
import {
  DeviceFsListResultSchema,
  DeviceFsOkResultSchema,
  DeviceFsStatResultSchema,
  type DeviceFsEntry,
  type DeviceFsListResult,
} from '@enkaku/protocol'
import { api, BadResponseError } from '@enkaku/ui'

/**
 * Thin client for the `device.fs.*` capabilities (plan 800 wave 3), through
 * the SAME `POST /api/v1/cap/:id` door every other capability caller uses —
 * the pattern `lib/workspace.ts` already established for `fs.*`.
 *
 * **This replaces a raw `adb` shell call.** The Device tab's Files section used
 * to run `ls -lA` through plan 207's generic `adb` action and parse the output
 * in the browser. Two things were wrong with that, and both are fixed by going
 * through the capability instead:
 *
 *   1. `ls -l` is a human report. Its date format varies by build and locale
 *      and its column count differs between toybox and BusyBox, so the parser
 *      had to guess at a layout. `device.fs.list` reads `stat -c` with an
 *      explicit format and is tested against that.
 *   2. The `adb` action is gated on running arbitrary shell — which an
 *      operator may legitimately have turned OFF on a network-exposed farm
 *      (`privacy.adbCommand`). Browsing files then failed for a reason that
 *      had nothing to do with files. `device.fs.*` is gated on `device.files`,
 *      the same permission push and pull already use.
 */

export type { DeviceFsEntry, DeviceFsListResult }

async function invokeCap<S extends z.ZodType>(id: string, input: unknown, outputSchema: S): Promise<z.infer<S>> {
  const path = `/api/v1/cap/${id}`
  const raw = await api(path, z.object({ ok: z.literal(true), output: z.unknown() }), { json: input })
  const parsed = outputSchema.safeParse(raw.output)
  if (!parsed.success) throw new BadResponseError(path, z.prettifyError(parsed.error))
  return parsed.data
}

export function listDeviceFiles(deviceId: string, path: string): Promise<DeviceFsListResult> {
  return invokeCap('device.fs.list', { deviceId, path }, DeviceFsListResultSchema)
}

export function statDeviceFile(deviceId: string, path: string) {
  return invokeCap('device.fs.stat', { deviceId, path }, DeviceFsStatResultSchema)
}

/** Rename in place: same directory, new final segment. The caller builds the destination so this never has to guess at path semantics. */
export function renameDeviceFile(deviceId: string, from: string, to: string) {
  return invokeCap('device.fs.move', { deviceId, from, to }, DeviceFsOkResultSchema)
}

export function deleteDeviceFile(deviceId: string, path: string, recursive: boolean) {
  return invokeCap('device.fs.delete', { deviceId, path, recursive }, DeviceFsOkResultSchema)
}

export function mkdirDeviceFile(deviceId: string, path: string) {
  return invokeCap('device.fs.mkdir', { deviceId, path }, DeviceFsOkResultSchema)
}

/** Joins a directory and a name without doubling the separator on `/`. */
export function joinDevicePath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** The directory holding `path`, or `/` at the top. */
export function parentDevicePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}
