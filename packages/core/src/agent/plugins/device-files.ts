import { deviceClipboardGet, deviceClipboardSet } from '../../capability/device-clipboard'
import { devicePull, devicePush } from '../../capability/device-files'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `device.push`/`.pull`/`.clipboard.*`: moving bytes on and off the DEVICE itself
 * (its filesystem, its clipboard) — distinct from `workspace`, which is the agent's OWN storage. */
export const deviceFilesPlugin = defineAgentPlugin({
  id: 'device-files',
  title: 'Device files and clipboard',
  prompt: [
    '# Device files and clipboard',
    "device_push writes a file onto the device; device_pull reads one off it. device_clipboard_get",
    "and device_clipboard_set read and write the device's own clipboard (over the scrcpy control",
    'socket) — useful for moving text into a field an app makes awkward to type into directly.',
    'These are separate from your own workspace (see the workspace tools): a device file lives on',
    'the phone, not in the farm.',
  ].join('\n'),
  tools: () => [devicePush, devicePull, deviceClipboardGet, deviceClipboardSet],
})
