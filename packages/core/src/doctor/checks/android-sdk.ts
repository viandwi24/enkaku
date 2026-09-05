import type { Check } from '../types'
import { describeAndroidSdk, resolveAndroidSdk } from '../../vm/sdk'

/**
 * Which Android SDK the `vm` subsystem (plan 401) would resolve, whether the
 * `emulator` binary actually exists under it, and whether the host has a
 * usable accelerator — WITHOUT provisioning anything (plan 400 D3, mirroring
 * `checks/guest-agent.ts`'s own rule, `:19`: "a doctor check must never
 * trigger a download"). A system image is 1.5-3 GB and covered by the
 * Android SDK Terms, so this check can only ever report, never fetch.
 */

async function describeAccelerator(platform: string, exists: (path: string) => Promise<boolean>): Promise<{ ok: boolean; detail: string }> {
  if (platform === 'darwin') {
    // Hypervisor.framework is built into every supported macOS release (plan 400 R1) — nothing to probe.
    return { ok: true, detail: 'Hypervisor.framework (built in)' }
  }
  if (platform === 'linux') {
    const hasKvm = await exists('/dev/kvm')
    return hasKvm
      ? { ok: true, detail: '/dev/kvm present' }
      : { ok: false, detail: '/dev/kvm is missing — KVM is required on Linux (plan 400 R1)' }
  }
  if (platform === 'win32') {
    // WHPX vs AEHD cannot be told apart from the filesystem; the doctor can only name the
    // preference and the sunset date (plan 400 R2, K5) — the emulator itself decides at boot.
    return {
      ok: true,
      detail: 'WHPX is the recommended accelerator on Windows; AEHD still works but sunsets 2026-12-31 — prefer WHPX',
    }
  }
  return { ok: false, detail: `unrecognised platform: ${platform}` }
}

export const androidSdkCheck: Check = {
  id: 'android-sdk',
  title: 'Android SDK',
  async run(ctx) {
    const sdk = await describeAndroidSdk({ exists: ctx.fs.exists, platform: ctx.runtime.platform as NodeJS.Platform })
    if (sdk.source === 'missing') {
      return {
        status: 'fail',
        observed: sdk.detail,
        remedy: 'install the Android command-line tools and one system image, then set ANDROID_SDK_ROOT or ENKAKU_ANDROID_SDK_PATH',
      }
    }

    const resolved = await resolveAndroidSdk({ exists: ctx.fs.exists, platform: ctx.runtime.platform as NodeJS.Platform })
    const hasEmulator = await ctx.fs.exists(resolved.emulator)
    const accel = await describeAccelerator(ctx.runtime.platform, ctx.fs.exists)

    if (!hasEmulator) {
      return {
        status: 'warn',
        observed: `${sdk.detail}, but the emulator binary is missing at ${resolved.emulator}`,
        remedy: 'install the "emulator" package with sdkmanager',
      }
    }

    if (!accel.ok) {
      return {
        status: 'warn',
        observed: `${sdk.detail}; emulator binary present; ${accel.detail}`,
        remedy: 'enable a hardware accelerator for this host before starting a virtual device',
      }
    }

    return {
      status: 'ok',
      observed: `${sdk.detail}; emulator binary present; accelerator: ${accel.detail}`,
    }
  },
}
