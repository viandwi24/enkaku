/** Error ber-kode untuk lapisan session (dipakai core & agent). */
export class SessionError extends Error {
  constructor(
    public code:
      | 'device_not_found'
      | 'device_not_ready'
      | 'engine_not_found'
      | 'port_range_exhausted'
      | 'element_not_found'
      | 'waitfor_timeout'
      | 'artifact_too_large'
      | 'unknown_script',
    message: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}
