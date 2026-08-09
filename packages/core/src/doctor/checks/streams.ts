import type { Check } from '../types'

/**
 * Stream-lane occupancy against its budget (plan 85 §3.1, §4.2, §5 85.6).
 * `adb.maxStreams` autoscales with the fleet (`computeAutoStreams`) instead
 * of the fixed `4` that used to cap a farm at two fully-instrumented
 * devices (F1/F7) — this check makes the *effective* number, and how close
 * the farm is to it, visible from `enkaku doctor` rather than only from a
 * refused crash watch or ui-server attach after the fact.
 */
export const streamsCheck: Check = {
  id: 'streams',
  title: 'Stream lanes',
  async run(ctx) {
    const streams = await ctx.streams.probe()
    if (streams === null) {
      return { status: 'skip', observed: 'no running core detected — stream-lane occupancy is only known while the core is up' }
    }
    const { active, maxStreams, maxStreamsPerDevice, perDevice } = streams
    const perDeviceSummary = Object.entries(perDevice)
      .map(([deviceId, count]) => `${deviceId}:${count}`)
      .join(', ')
    const observed = `${active}/${maxStreams} farm-wide stream slot(s) in use (max ${maxStreamsPerDevice} per device)${perDeviceSummary ? ` — ${perDeviceSummary}` : ''}`
    if (maxStreams > 0 && active >= maxStreams) {
      return {
        status: 'warn',
        observed,
        remedy:
          'the farm is at its stream-lane budget — the next crash watch or ui-server attach will refuse with E_ADB_STREAM_LIMIT until a slot frees up. Raise adb.maxStreams, or leave it at 0 (auto) and check whether the reported device count matches what is actually connected',
      }
    }
    return { status: 'ok', observed }
  },
}
