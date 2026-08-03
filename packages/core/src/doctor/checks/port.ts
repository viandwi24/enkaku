import type { Check } from '../types'

export const portCheck: Check = {
  id: 'port',
  title: 'Port',
  async run(ctx) {
    const cfg = ctx.config.load()
    if (!cfg.ok) {
      return { status: 'skip', observed: 'configuration failed to load — see the config check above' }
    }
    const { host, port } = cfg

    const health = await ctx.port.probeHealth(`http://${host}:${port}/api/health`)
    if (health.ok) {
      return {
        status: 'ok',
        observed: `port ${port} is held by a running enkaku core (v${health.version}, ${health.deviceCount} device(s))`,
      }
    }

    const free = await ctx.port.tryBind(port, host)
    if (free) {
      return { status: 'ok', observed: `port ${port} is free` }
    }

    const holder = await ctx.port.findHolder(port)
    const who = holder ? `pid ${holder.pid} (${holder.processName})` : 'another process'
    return {
      status: 'fail',
      observed: `port ${port} is held by ${who}, which did not answer as an enkaku core`,
      remedy: `stop ${who} or set ENKAKU_PORT to a free port`,
    }
  },
}
