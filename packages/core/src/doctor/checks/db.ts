import type { Check } from '../types'

export const dbCheck: Check = {
  id: 'db',
  title: 'Database',
  async run(ctx) {
    const result = await ctx.db.inspect()
    if (result.state === 'absent') {
      return { status: 'ok', observed: 'enkaku.db has not been created yet — the core creates it on first start' }
    }
    if (result.state === 'corrupt') {
      return {
        status: 'fail',
        observed: `enkaku.db failed its integrity check: ${result.detail}`,
        remedy: 'restore enkaku.db from a backup, or move it aside and let the core create a fresh one (local history is lost)',
      }
    }
    if (result.pendingMigrations > 0) {
      return {
        status: 'warn',
        observed: `enkaku.db is reachable with ${result.pendingMigrations} pending migration(s)`,
        remedy: 'start the core once — migrations run automatically at boot',
      }
    }
    return { status: 'ok', observed: 'enkaku.db is reachable, integrity check passed, no pending migrations' }
  },
}
