import { describe, expect, test } from 'bun:test'
import { validateRemotePath } from './path-validate'

describe('validateRemotePath', () => {
  test('accepts a plain absolute path', () => {
    expect(validateRemotePath('/data/local/tmp/f.txt')).toBe('/data/local/tmp/f.txt')
  })

  test('accepts underscores, dots, and dashes', () => {
    expect(validateRemotePath('/sdcard/My-File_v2.1.log')).toBe('/sdcard/My-File_v2.1.log')
  })

  test('rejects a relative path', () => {
    expect(() => validateRemotePath('relative/path')).toThrow()
  })

  test('rejects a path containing ".."', () => {
    expect(() => validateRemotePath('/data/local/tmp/../../etc/passwd')).toThrow()
  })

  test('rejects shell metacharacters', () => {
    for (const bad of ['/tmp/a;rm -rf /', '/tmp/a$(id)', '/tmp/a`id`', '/tmp/a|cat', '/tmp/a&&ls', '/tmp/a<x', '/tmp/a>x', '/tmp/a\nx', '/tmp/a x']) {
      expect(() => validateRemotePath(bad)).toThrow()
    }
  })

  test('rejects an empty or non-string path', () => {
    expect(() => validateRemotePath('')).toThrow()
    expect(() => validateRemotePath(undefined)).toThrow()
    expect(() => validateRemotePath(123)).toThrow()
  })

  test('rejects an absurdly long path', () => {
    expect(() => validateRemotePath(`/${'a'.repeat(5000)}`)).toThrow()
  })
})
