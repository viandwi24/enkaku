import type { Check } from '../types'

export const egressCheck: Check = {
  id: 'egress',
  title: 'Egress',
  async run(ctx) {
    const result = await ctx.egress.check()
    if (result.reachable) {
      return { status: 'ok', observed: `reached ${ctx.egress.host}` }
    }
    return {
      status: 'warn',
      observed: `could not reach ${ctx.egress.host}: ${result.error}`,
      remedy: 'set HTTPS_PROXY if you are behind a corporate proxy — first-run tool downloads need this host',
    }
  },
}
