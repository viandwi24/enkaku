import type { ParamIssue } from '@enkaku/protocol'

/**
 * Uniform coded errors (00-overview §4.2). The API returns
 * { error: { code, message } } konsisten via error handler Hono.
 *
 * Kode M0: E_ADB_FAIL, E_ADB_UNAVAILABLE, E_TOOL_NOT_FOUND, E_DB,
 * E_BAD_REQUEST, E_INTERNAL.
 */
export class EnkakuError extends Error {
  constructor(
    public code: string,
    message: string,
    public cause?: unknown,
    /**
     * Field-level failures (plan 95 §3.7, §4.3, F13) — set on
     * `invalid_job_params`, so a 400 carries `path`/`message` pairs a form
     * can attach to the field that caused them, instead of only a flat
     * joined string that already threw the paths away.
     */
    public issues?: ParamIssue[],
  ) {
    super(message)
    this.name = 'EnkakuError'
  }

  toJSON(): { error: { code: string; message: string; issues?: ParamIssue[] } } {
    return { error: { code: this.code, message: this.message, ...(this.issues ? { issues: this.issues } : {}) } }
  }
}
