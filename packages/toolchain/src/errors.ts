/** Error ber-kode toolchain (plan 02 §4.8). */
export type ToolchainErrorCode =
  | 'E_TOOL_NOT_FOUND'
  | 'E_VERSION_NOT_IN_MANIFEST'
  | 'E_NOT_SWAPPABLE'
  | 'E_CHECKSUM_MISMATCH'
  | 'E_CHECKSUM_MISSING'
  | 'E_DELETE_ACTIVE'
  | 'E_TOOL_IN_USE'
  | 'E_HEALTH_CHECK_FAILED'
  | 'E_ALREADY_INSTALLED'
  | 'E_MANIFEST_FETCH_FAILED'
  | 'E_TOOL_NOT_PROVISIONED'
  | 'E_PLATFORM_UNSUPPORTED'
  | 'E_DOWNLOAD_STALLED'
  | 'E_DOWNLOAD_FAILED'
  | 'E_EXTRACT_UNSAFE_PATH'
  | 'E_TOOL_UNKNOWN_ENTRYPOINT'
  | 'E_NOT_INSTALLED'

export class ToolchainError extends Error {
  constructor(
    public code: ToolchainErrorCode,
    message: string,
    public cause?: unknown,
  ) {
    super(message)
    this.name = 'ToolchainError'
  }

  toJSON(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } }
  }
}
