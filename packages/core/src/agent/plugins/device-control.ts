import { deviceFling, deviceKey, deviceScroll, deviceSwipe, deviceTap, deviceType } from '../../capability/device-input'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `device.tap`/`.swipe`/`.scroll`/`.fling`/`.type`/`.key`: the raw input surface
 * a driving agent uses to actually operate a phone. */
export const deviceControlPlugin = defineAgentPlugin({
  id: 'device-control',
  title: 'Device control',
  prompt: [
    '# Device control',
    'You can drive a phone directly: tap, swipe, scroll, fling, type text, and press hardware/soft',
    'keys. Every call takes a deviceId and requires holding control of that device — most of these',
    'tools acquire it for you on first use. Prefer device_find or device_dump (device inspection)',
    'to locate a UI element before tapping it; do not guess coordinates from a screenshot alone when',
    'a resolvable selector is available.',
  ].join('\n'),
  tools: () => [deviceTap, deviceSwipe, deviceScroll, deviceFling, deviceType, deviceKey],
})
