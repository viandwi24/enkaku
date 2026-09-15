import { parseForegroundPackages } from '@enkaku/session'

type Exec = (cmd: string) => Promise<{ stdout: string }>

/**
 * Never force-stopped by a hand-back: the farm's own agent and inspector, the platform, and Play
 * services (stopping it signs every app on the phone out of its Google session for a while). The
 * launcher and the active keyboard are skipped separately, read from the phone itself.
 */
const NEVER_STOP = [/^dev\.enkaku\.guestagent/, /^com\.github\.uiautomator/, /^com\.android\./, /^com\.google\.android\.gms$/]

/** The package half of a `pkg/Component` line, as `cmd package resolve-activity --brief` and `settings get` print it. */
function packageOf(output: string | null): string | null {
  const line = (output ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  const slash = line.indexOf('/')
  return slash > 0 ? line.slice(0, slash) : null
}

/**
 * Put a phone back on its home screen after a core restart killed the job that was driving it.
 *
 * The runner hands a phone back when a job ends (`@enkaku/session`'s `handBackDevice`), but a job
 * whose core process died never reaches that, nor its own `finish()`: the owner's production farm
 * (2026-09-15) was left with TikTok on its post screen, YouTube on a channel and Instagram on a
 * profile after an upgrade restarted the core mid-session. The job's own packages died with the
 * old process's memory, so this stops whatever non-system app is in the foreground instead, then
 * opens the launcher. Never throws; a step that fails is a warning.
 */
export async function handBackAfterRestart(exec: Exec): Promise<{ stopped: string[]; warnings: string[] }> {
  const warnings: string[] = []
  const run = async (cmd: string): Promise<string | null> => {
    try {
      return (await exec(cmd)).stdout
    } catch (err) {
      warnings.push(`${cmd}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  // Filtered ON THE DEVICE to the lines `parseForegroundPackages` reads: the whole `dumpsys activity processes` is
  // over the transport's 256 KB output cap on a phone with many processes (measured on the moto g06, 2026-09-15),
  // and a refused read left every app open. `grep` exits 1 when nothing matches, which is not an error here.
  const processes = await run('dumpsys activity processes | grep top-activity')
  const launcher = packageOf(await run('cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME'))
  const ime = packageOf(await run('settings get secure default_input_method'))
  const skip = new Set([launcher, ime].filter((p): p is string => p !== null))

  const stopped: string[] = []
  for (const pkg of parseForegroundPackages(processes ?? '')) {
    if (skip.has(pkg) || NEVER_STOP.some((re) => re.test(pkg))) continue
    if ((await run(`am force-stop '${pkg}'`)) !== null) stopped.push(pkg)
  }
  await run('am start -a android.intent.action.MAIN -c android.intent.category.HOME')
  return { stopped, warnings }
}
