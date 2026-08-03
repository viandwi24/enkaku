import type { Check } from '../types'

export const toolsCheck: Check = {
  id: 'tools',
  title: 'Toolchain',
  async run(ctx) {
    const rows = await ctx.tools.status()
    if (rows.length === 0) {
      return { status: 'skip', observed: 'no tools registered in the manifest' }
    }
    const problems = rows.filter((r) => !r.provisioned || r.healthOk === false)
    if (problems.length === 0) {
      return { status: 'ok', observed: rows.map((r) => `${r.id}@${r.version}`).join(', ') }
    }
    const detail = problems
      .map((p) => (p.provisioned ? `${p.id}: health check failed (${p.detail ?? 'no detail'})` : `${p.id}: not provisioned`))
      .join('; ')
    return {
      status: 'fail',
      observed: detail,
      remedy:
        'required tools download automatically on first run — check network/proxy access, or reinstall from the Tools page (`POST /api/tools/:id/install`)',
    }
  },
}
