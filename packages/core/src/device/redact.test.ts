import { describe, expect, test } from 'bun:test'
import { redactShellCommand } from './redact'

describe('redactShellCommand (plan 26 §3.3, §7)', () => {
  test('a space-separated --password flag is redacted, the rest of the command is untouched', () => {
    const cmd = 'some-cli login --password hunter2 --verbose'
    const out = redactShellCommand(cmd)
    expect(out).not.toContain('hunter2')
    expect(out).toBe('some-cli login --password [redacted] --verbose')
  })

  test('an =-separated flag keeps the = shape', () => {
    expect(redactShellCommand('curl --token=abc123')).toBe('curl --token=[redacted]')
  })

  test('a quoted value containing spaces is redacted whole', () => {
    const cmd = `login --password "hunter two words"`
    const out = redactShellCommand(cmd)
    expect(out).not.toContain('hunter two words')
    expect(out).toBe('login --password [redacted]')
  })

  test('the short-form --pass alias is redacted', () => {
    expect(redactShellCommand('mysql --pass secretpass -u root')).toBe('mysql --pass [redacted] -u root')
  })

  test('api-key and apikey variants, and --auth / --secret / --credential', () => {
    expect(redactShellCommand('x --api-key ABCD')).toBe('x --api-key [redacted]')
    expect(redactShellCommand('x --apikey ABCD')).toBe('x --apikey [redacted]')
    expect(redactShellCommand('x --auth tok')).toBe('x --auth [redacted]')
    expect(redactShellCommand('x --secret s3cr3t')).toBe('x --secret [redacted]')
    expect(redactShellCommand('x --credential c1')).toBe('x --credential [redacted]')
  })

  test('a command with no credential flags is returned unchanged', () => {
    const cmd = 'getprop ro.serialno'
    expect(redactShellCommand(cmd)).toBe(cmd)
  })

  test('is case-insensitive on the flag name', () => {
    expect(redactShellCommand('x --PASSWORD hunter2')).toBe('x --PASSWORD [redacted]')
  })

  test('multiple credential flags in one command are each redacted', () => {
    const out = redactShellCommand('x --password a --token b')
    expect(out).toBe('x --password [redacted] --token [redacted]')
  })
})
