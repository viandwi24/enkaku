import { describe, expect, test } from 'bun:test'
import { handBackAfterRestart } from './restart-hand-back'

function fakePhone(foreground: string[], opts: { failStop?: string } = {}) {
  const calls: string[] = []
  const exec = async (cmd: string) => {
    calls.push(cmd)
    if (cmd === 'dumpsys activity processes | grep top-activity') {
      const lines = foreground.map((pkg, i) => `    Proc # ${i}: fg     T/A/TOP  LCMNFUA  t: 0 ${1000 + i}:${pkg}/u0a${100 + i} (top-activity)`)
      return { stdout: ['ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)', ...lines].join('\n') }
    }
    if (cmd.startsWith('cmd package resolve-activity')) return { stdout: 'priority=0 preferredOrder=0\ncom.sec.android.app.launcher/.activities.LauncherActivity\n' }
    if (cmd.startsWith('settings get secure default_input_method')) return { stdout: 'com.samsung.android.honeyboard/.service.HoneyBoardService\n' }
    if (opts.failStop && cmd === `am force-stop '${opts.failStop}'`) throw new Error('device offline')
    return { stdout: '' }
  }
  return { exec, calls }
}

describe('handBackAfterRestart', () => {
  test('stops the app left in the foreground, then opens the launcher', async () => {
    const phone = fakePhone(['com.zhiliaoapp.musically'])
    const result = await handBackAfterRestart(phone.exec)
    expect(result).toEqual({ stopped: ['com.zhiliaoapp.musically'], warnings: [] })
    expect(phone.calls.slice(-2)).toEqual(["am force-stop 'com.zhiliaoapp.musically'", 'am start -a android.intent.action.MAIN -c android.intent.category.HOME'])
  })

  test('never stops the launcher, the keyboard, the farm agent or Play services', async () => {
    const phone = fakePhone(['com.sec.android.app.launcher', 'com.samsung.android.honeyboard', 'dev.enkaku.guestagent', 'com.google.android.gms'])
    const result = await handBackAfterRestart(phone.exec)
    expect(result.stopped).toEqual([])
    expect(phone.calls.filter((c) => c.startsWith('am force-stop'))).toEqual([])
    expect(phone.calls.at(-1)).toBe('am start -a android.intent.action.MAIN -c android.intent.category.HOME')
  })

  test('a stop that fails is a warning, and the launcher step still runs', async () => {
    const phone = fakePhone(['com.instagram.android'], { failStop: 'com.instagram.android' })
    const result = await handBackAfterRestart(phone.exec)
    expect(result.stopped).toEqual([])
    expect(result.warnings).toEqual(["am force-stop 'com.instagram.android': device offline"])
    expect(phone.calls.at(-1)).toBe('am start -a android.intent.action.MAIN -c android.intent.category.HOME')
  })
})
