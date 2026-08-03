import type { Check } from '../types'

export const devicesCheck: Check = {
  id: 'devices',
  title: 'Devices',
  async run(ctx) {
    const list = await ctx.devices.list()
    if (list.length === 0) {
      return { status: 'ok', observed: 'no devices seen by adb — connect one over USB and accept the RSA prompt' }
    }
    const summary = list.map((d) => `${d.serial}:${d.state}`).join(', ')
    const bad = list.filter((d) => d.state === 'unauthorized' || d.state === 'offline')
    if (bad.length === 0) {
      return { status: 'ok', observed: summary }
    }
    const remedy = bad
      .map((d) =>
        d.state === 'unauthorized'
          ? `${d.serial} is unauthorized — accept the RSA prompt on the device`
          : `${d.serial} is offline — reconnect the USB cable or the Wi-Fi debugging link`,
      )
      .join('; ')
    return { status: 'warn', observed: summary, remedy }
  },
}
