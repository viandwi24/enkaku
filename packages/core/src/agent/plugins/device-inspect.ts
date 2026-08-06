import { deviceDump, deviceFind, deviceScreenshot, deviceWaitFor } from '../../capability/device-inspect'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `device.find`/`.dump`/`.waitFor`/`.screenshot`: reading what is actually on
 * screen before (and instead of) acting blind. */
export const deviceInspectPlugin = defineAgentPlugin({
  id: 'device-inspect',
  title: 'Device inspection',
  prompt: [
    '# Device inspection',
    'Before tapping something, look at it: device_find resolves a selector to an element (and tells',
    'you honestly when nothing matched, or when too much did, rather than guessing); device_dump',
    'returns the full UI tree; device_waitFor polls until a selector appears, which is almost always',
    'better than a fixed sleep after navigating; device_screenshot returns an actual image of the',
    'screen — use it when the UI tree alone does not explain what you are looking at.',
  ].join('\n'),
  tools: () => [deviceFind, deviceDump, deviceWaitFor, deviceScreenshot],
})
