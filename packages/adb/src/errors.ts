/** Error ber-kode untuk @enkaku/adb (konvensi 00-overview §4.2). */
export class AdbError extends Error {
  constructor(
    public code: 'E_ADB_FAIL' | 'E_ADB_UNAVAILABLE' | 'E_ADB_PROTOCOL',
    message: string,
    public cause?: unknown,
  ) {
    super(message)
    this.name = 'AdbError'
  }
}
