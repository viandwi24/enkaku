/**
 * Error ber-kode seragam (00-overview §4.2). API mengembalikan
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
  ) {
    super(message)
    this.name = 'EnkakuError'
  }

  toJSON(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } }
  }
}
