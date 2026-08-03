import type { Check } from '../types'

/** Bun 1.2 is the earliest version this repo is developed and tested against (00-overview §3). */
export const MIN_BUN_VERSION = '1.2.0'

export const runtimeCheck: Check = {
  id: 'runtime',
  title: 'Runtime',
  async run(ctx) {
    const { bunVersion, platform, arch } = ctx.runtime
    const ok = Bun.semver.satisfies(bunVersion, `>=${MIN_BUN_VERSION}`)
    if (!ok) {
      return {
        status: 'fail',
        observed: `Bun ${bunVersion} on ${platform}-${arch}`,
        remedy: `Bun ${MIN_BUN_VERSION}+ is required; you have ${bunVersion} — upgrade with \`bun upgrade\``,
      }
    }
    return { status: 'ok', observed: `Bun ${bunVersion} on ${platform}-${arch}` }
  },
}
