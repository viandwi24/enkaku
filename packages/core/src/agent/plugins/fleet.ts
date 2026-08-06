import { deviceGet, deviceList, deviceSleep, deviceWake } from '../../capability/device-state'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `device.list`/`.get`/`.wake`/`.sleep`: knowing what devices exist and their
 * readiness, as opposed to operating any one of them. */
export const fleetPlugin = defineAgentPlugin({
  id: 'fleet',
  title: 'Fleet',
  prompt: [
    '# Fleet',
    'device_list and device_get answer "what devices exist and what state are they in" — status,',
    'battery, temperature, readiness, tags, who (if anyone) currently holds them. device_wake and',
    'device_sleep change DESIRED readiness without opening a stream; a device already in the state',
    'you asked for is a no-op, not an error. Check device_list before assuming a deviceId is valid or',
    'available — a stale id from earlier in the conversation may no longer exist or may be offline.',
  ].join('\n'),
  tools: () => [deviceList, deviceGet, deviceWake, deviceSleep],
})
