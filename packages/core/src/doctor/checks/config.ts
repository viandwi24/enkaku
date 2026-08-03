import type { Check } from '../types'

export const configCheck: Check = {
  id: 'config',
  title: 'Configuration',
  async run(ctx) {
    const result = ctx.config.load()
    if (!result.ok) {
      return {
        status: 'fail',
        observed: `${result.code}: ${result.message}`,
        remedy: 'fix the offending config file or env var, then rerun `enkaku doctor`',
      }
    }
    const observed = `bind ${result.host}:${result.port}, auth mode "${result.authMode}", TLS ${result.tlsMode}${
      result.tlsConfigured ? ' (configured)' : ''
    }`
    if (result.tlsPolicyError) {
      return { status: 'fail', observed, remedy: result.tlsPolicyError }
    }
    if (result.authMode === 'server' && result.tlsMode === 'off') {
      return {
        status: 'warn',
        observed,
        remedy:
          'server mode is running without TLS via ENKAKU_ALLOW_INSECURE=1 — passwords and tokens travel in the clear; use this only on a trusted network',
      }
    }
    return { status: 'ok', observed }
  },
}
