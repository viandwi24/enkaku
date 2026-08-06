/** Required tools: adb (M1) and the on-device inspector APKs (M4.5). M6 adds scrcpy-server. */
export const REQUIRED_TOOLS = ['adb', 'ui-server', 'ui-server-test', 'scrcpy-server']

/**
 * Of those, only adb gates the boot: without it there is no device subsystem at
 * all. The rest are device-side artifacts, installed onto a phone per session —
 * missing one costs a feature (inspector, mirroring), not the whole farm.
 */
export const CRITICAL_TOOLS = ['adb']
