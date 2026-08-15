import { describe, expect, test } from 'bun:test'
import { createTar, createTarGz, readTar, readTarGz, type TarEntry } from './tar'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('tar (minimal USTAR writer/reader)', () => {
  test('round-trips a single small text entry', () => {
    const entries: TarEntry[] = [{ name: 'hello.txt', data: enc.encode('hello world') }]
    const tar = createTar(entries)
    const back = readTar(tar)
    expect(back).toHaveLength(1)
    expect(back[0]?.name).toBe('hello.txt')
    expect(dec.decode(back[0]?.data)).toBe('hello world')
  })

  test('round-trips several entries of different sizes, including one that is not a multiple of 512 bytes', () => {
    const entries: TarEntry[] = [
      { name: 'a.txt', data: enc.encode('a') },
      { name: 'b.bin', data: new Uint8Array(1000).map((_, i) => i % 256) },
      { name: 'c.bin', data: new Uint8Array(512) }, // exactly one block, all zero bytes
    ]
    const tar = createTar(entries)
    const back = readTar(tar)
    expect(back.map((e) => e.name)).toEqual(['a.txt', 'b.bin', 'c.bin'])
    for (const [i, entry] of entries.entries()) {
      expect(back[i]?.data).toEqual(entry.data)
    }
  })

  test('an empty entry round-trips to zero bytes', () => {
    const tar = createTar([{ name: 'empty.txt', data: new Uint8Array(0) }])
    const back = readTar(tar)
    expect(back).toHaveLength(1)
    expect(back[0]?.data.length).toBe(0)
  })

  test('createTarGz/readTarGz round-trip through gzip', () => {
    const entries: TarEntry[] = [
      { name: 'enkaku.db', data: new Uint8Array(4096).map((_, i) => (i * 7) % 256) },
      { name: 'secrets.key', data: new Uint8Array(32).map((_, i) => i) },
    ]
    const archive = createTarGz(entries)
    // Confirm it is actually gzip-compressed data, not a bare tar.
    expect(archive[0]).toBe(0x1f)
    expect(archive[1]).toBe(0x8b)
    const back = readTarGz(archive)
    expect(back.map((e) => e.name)).toEqual(['enkaku.db', 'secrets.key'])
    expect(back[0]?.data).toEqual(entries[0]!.data)
    expect(back[1]?.data).toEqual(entries[1]!.data)
  })

  test('rejects an entry name longer than 100 bytes rather than silently truncating it', () => {
    const longName = `${'x'.repeat(101)}.txt`
    expect(() => createTar([{ name: longName, data: new Uint8Array(0) }])).toThrow()
  })
})
