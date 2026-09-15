import { describe, expect, test } from 'bun:test'
import { normalizeAdbCommand } from './adb-command'

function cmdOf(raw: string): string {
  const r = normalizeAdbCommand(raw)
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(raw)}, got: ${r.error}`)
  return r.cmd
}

function errorOf(raw: string): string {
  const r = normalizeAdbCommand(raw)
  if (r.ok) throw new Error(`expected an error for ${JSON.stringify(raw)}, got: ${r.cmd}`)
  return r.error
}

describe('normalizeAdbCommand', () => {
  test('the three forms mean the same command', () => {
    expect(normalizeAdbCommand('dumpsys battery')).toEqual({ ok: true, cmd: 'dumpsys battery', form: 'bare' })
    expect(normalizeAdbCommand('shell dumpsys battery')).toEqual({ ok: true, cmd: 'dumpsys battery', form: 'shell' })
    expect(normalizeAdbCommand('adb shell dumpsys battery')).toEqual({ ok: true, cmd: 'dumpsys battery', form: 'adb-shell' })
  })

  test('adb global options are skipped and the serial is ignored', () => {
    expect(cmdOf('adb -s emulator-5554 shell getprop ro.serialno')).toBe('getprop ro.serialno')
    expect(cmdOf('adb -s "192.168.1.20:5555" shell ls')).toBe('ls')
    expect(cmdOf('adb -d shell ls')).toBe('ls')
    expect(cmdOf('adb -H 127.0.0.1 -P 5037 -t 3 shell ls')).toBe('ls')
    expect(cmdOf('adb.exe shell ls')).toBe('ls')
    expect(cmdOf('ADB SHELL ls')).toBe('ls')
  })

  test('shell flags are skipped', () => {
    expect(cmdOf('adb shell -t top -n 1')).toBe('top -n 1')
    expect(cmdOf('shell -x -T ls')).toBe('ls')
    expect(cmdOf('adb shell -e ~ ls')).toBe('ls')
    expect(cmdOf('adb exec-out screencap -p')).toBe('screencap -p')
  })

  test('one wholly quoted command loses its quotes; anything else is verbatim', () => {
    expect(cmdOf('adb shell "pm list packages | grep google"')).toBe('pm list packages | grep google')
    expect(cmdOf("adb shell 'echo $HOME'")).toBe('echo $HOME')
    expect(cmdOf('shell "echo \\"hi\\" \\$USER"')).toBe('echo "hi" $USER')
    expect(cmdOf('adb shell input text "hello world"')).toBe('input text "hello world"')
    expect(cmdOf('adb shell echo "a" "b"')).toBe('echo "a" "b"')
    // A bare command is never unwrapped: its quotes belong to the device shell.
    expect(cmdOf('"echo hi"')).toBe('"echo hi"')
  })

  test('surrounding whitespace and a copied prompt are dropped', () => {
    expect(cmdOf('  \n adb shell ls -la \n')).toBe('ls -la')
    expect(cmdOf('$ adb shell ls')).toBe('ls')
  })

  test('only a whole word is a prefix', () => {
    expect(cmdOf('shellcheck foo')).toBe('shellcheck foo')
    expect(cmdOf('adbd --version')).toBe('adbd --version')
  })

  test('logcat is the same program inside the shell', () => {
    expect(cmdOf('adb logcat -d -t 50')).toBe('logcat -d -t 50')
    expect(cmdOf('adb -s abc logcat')).toBe('logcat')
  })

  test('an interactive shell, an empty line and a lone adb are refused', () => {
    expect(errorOf('adb shell')).toContain('interactive shell')
    expect(errorOf('shell   ')).toContain('interactive shell')
    expect(errorOf('adb shell ""')).toContain('empty')
    expect(errorOf('   ')).toContain('Type a command')
    expect(errorOf('adb')).toContain('Nothing follows')
    expect(errorOf('adb -s')).toContain('needs a value')
  })

  test('adb subcommands that are not shell commands are refused with what to use', () => {
    expect(errorOf('adb install app.apk')).toContain('Install apk')
    expect(errorOf('adb push a /sdcard/a')).toContain('Upload file')
    expect(errorOf('adb reboot')).toContain('svc power reboot')
    expect(errorOf('adb frobnicate')).toContain('not a shell command')
  })

  test('the output of a normal command normalises to itself', () => {
    for (const raw of ['adb shell dumpsys battery', 'shell "ls | wc -l"', 'cmd statusbar expand-notifications', 'adb -s x shell input keyevent 4']) {
      const once = cmdOf(raw)
      expect(cmdOf(once)).toBe(once)
    }
  })
})
