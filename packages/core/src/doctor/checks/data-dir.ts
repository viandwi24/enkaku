import type { Check } from '../types'

const LOW_SPACE_WARN_BYTES = 500 * 1024 * 1024 // 500 MiB

const gib = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MiB`

export const dataDirCheck: Check = {
  id: 'data-dir',
  title: 'Data directory',
  async run(ctx) {
    const dir = ctx.dataDir
    if (!(await ctx.fs.exists(dir))) {
      return {
        status: 'fail',
        observed: `${dir} does not exist`,
        remedy: `create it — the core creates it automatically on the next start, or run: mkdir -p "${dir}"`,
      }
    }
    if (!(await ctx.fs.writable(dir))) {
      return { status: 'fail', observed: `${dir} exists but is not writable`, remedy: `chmod u+w "${dir}"` }
    }
    const free = await ctx.fs.freeBytes(dir)
    if (free !== null && free < LOW_SPACE_WARN_BYTES) {
      return {
        status: 'warn',
        observed: `${dir} is writable but only has ${mib(free)} free`,
        remedy: 'free up disk space — job artifacts and logs accumulate under this directory over time',
      }
    }
    return { status: 'ok', observed: `${dir} exists and is writable${free !== null ? ` (${gib(free)} free)` : ''}` }
  },
}
