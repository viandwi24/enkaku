import { shellQuote } from '@enkaku/adb'
import type { DeviceSession } from './session'

/**
 * Session hygiene between jobs (plan 35). Two jobs running back-to-back on
 * one device currently inherit each other's application state — the
 * foreground activity, app data/caches, granted permissions, the clipboard,
 * background services, and any system dialog the previous run left open.
 *
 * The fix runs BEFORE a job, never only after (plan 35 §3.2): a job that
 * times out or crashes never reaches its own cleanup, so resetting before
 * each run is the only placement that makes the guarantee unconditional.
 */

export type ResetPolicy = 'none' | 'home' | 'declared' | 'aggressive'

export interface ResetPlan {
  policy: ResetPolicy
  /** From ScriptDefinition.reset (plan 35 §4.3). */
  packages?: string[]
  clearData?: boolean
}

export interface ResetOutcome {
  /** The steps that ran, in order. */
  applied: string[]
  /** Steps that failed (or were skipped once the budget ran out) — never thrown. */
  warnings: string[]
  durationMs: number
}

/**
 * Packages an `aggressive` reset must never force-stop, even though they run
 * as ordinary (non-system-uid) apps — killing the inspector mid-farm would be
 * self-defeating (plan 35 §4.2, §8 risks).
 */
const AGGRESSIVE_ALWAYS_SKIP = [/^com\.github\.uiautomator/]

/**
 * Every step goes through the per-device queue with the `appLifecycle`
 * profile (plan 35 §4.2) and races the shared deadline: once the budget is
 * gone, a step that has not started yet is recorded as skipped rather than
 * attempted, and a step already in flight is aborted through `signal` rather
 * than left running past `resetTimeoutMs` (plan 35 §6.6).
 */
function makeRunner(session: DeviceSession, controller: AbortController, applied: string[], warnings: string[]) {
  return async (label: string, cmd: string): Promise<string | null> => {
    if (controller.signal.aborted) {
      warnings.push(`${label}: skipped — the reset budget ran out`)
      return null
    }
    try {
      const out = await session.transport.exec(cmd, { profile: 'appLifecycle', signal: controller.signal })
      applied.push(label)
      return out
    } catch (err) {
      warnings.push(
        controller.signal.aborted
          ? `${label}: timed out`
          : `${label}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }
}

/** The package half of a `pkg/Component` line — `pm resolve-activity` and `settings get` both print this shape. */
function packageFromSlashPair(output: string): string | null {
  const line =
    output
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  const idx = line.indexOf('/')
  if (idx <= 0) return null
  return line.slice(0, idx)
}

/**
 * Non-system foreground packages from `dumpsys activity processes` (best
 * effort by design — OEM output varies, plan 35 §8 risks). A line naming a
 * foreground process carries `top-activity`; the package on it is kept only
 * when it runs under an ordinary per-app uid (`u0a…`), which is how a real
 * app is told apart from a platform process sharing the same section.
 */
export function parseForegroundPackages(dumpsysOutput: string): string[] {
  const packages = new Set<string>()
  const re = /(?:^|\s)\d+:([\w.]+)\/u0a\d+/g
  for (const line of dumpsysOutput.split('\n')) {
    if (!/top-activity/i.test(line)) continue
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      const pkg = m[1]
      if (pkg) packages.add(pkg)
    }
  }
  return [...packages]
}

export async function resetDevice(
  session: DeviceSession,
  plan: ResetPlan,
  opts: { timeoutMs: number },
): Promise<ResetOutcome> {
  const start = Date.now()
  const applied: string[] = []
  const warnings: string[] = []

  if (plan.policy === 'none') {
    return { applied, warnings, durationMs: Date.now() - start }
  }

  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), opts.timeoutMs)
  const run = makeRunner(session, controller, applied, warnings)

  try {
    // `home` (plan 35 §4.2): dismiss dialogs, return to the launcher, dismiss
    // a swipe-only keyguard. Closing recents is deliberately NOT done — it
    // varies too much per OEM to be reliable, and leaving them costs nothing.
    await run('back', 'input keyevent KEYCODE_BACK')
    await run('back', 'input keyevent KEYCODE_BACK')
    await run('home', 'am start -a android.intent.action.MAIN -c android.intent.category.HOME')
    if (!controller.signal.aborted) {
      const keyguardOut = await session.transport
        .exec('dumpsys window | grep -m1 isKeyguardShowing', { profile: 'appLifecycle', signal: controller.signal })
        .catch(() => '')
      // Reuses the idiom `session.ts:179-185` already uses for the same check.
      if (/isKeyguardShowing=true/.test(keyguardOut)) {
        await run('dismiss-keyguard', 'wm dismiss-keyguard')
      }
    }

    // `declared` (also the base of `aggressive`): stop the packages the
    // script declared, and only wipe their data when it opted into that.
    if (plan.policy === 'declared' || plan.policy === 'aggressive') {
      for (const pkg of plan.packages ?? []) {
        await run(`force-stop:${pkg}`, `am force-stop ${shellQuote(pkg)}`)
        if (plan.clearData) {
          await run(`pm-clear:${pkg}`, `pm clear ${shellQuote(pkg)}`)
        }
      }
    }

    // `aggressive`: force-stop every other non-system foreground package,
    // skipping the launcher, the active IME, and the inspector allowlist.
    if (plan.policy === 'aggressive' && !controller.signal.aborted) {
      const launcherOut = await session.transport
        .exec('cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME', {
          profile: 'appLifecycle',
          signal: controller.signal,
        })
        .catch(() => '')
      const imeOut = await session.transport
        .exec('settings get secure default_input_method', { profile: 'appLifecycle', signal: controller.signal })
        .catch(() => '')
      const dump = await run('dumpsys:activity-processes', 'dumpsys activity processes')
      if (dump !== null) {
        const launcher = packageFromSlashPair(launcherOut)
        const ime = packageFromSlashPair(imeOut)
        const skip = new Set([launcher, ime].filter((p): p is string => !!p))
        const targets = parseForegroundPackages(dump).filter(
          (pkg) => !skip.has(pkg) && !AGGRESSIVE_ALWAYS_SKIP.some((re) => re.test(pkg)),
        )
        for (const pkg of targets) {
          await run(`force-stop:${pkg}`, `am force-stop ${shellQuote(pkg)}`)
        }
      }
    }
  } finally {
    clearTimeout(deadline)
  }

  return { applied, warnings, durationMs: Date.now() - start }
}
