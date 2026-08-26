import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { UiNode } from '@enkaku/protocol'
import { createTraceFrameStore } from './frame-store'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-trace-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

const frame = (marker: number): Uint8Array<ArrayBuffer> => new Uint8Array([0x89, 0x50, 0x4e, 0x47, marker, 1, 2, 3])

const node = (text: string): UiNode => ({
  resourceId: 'com.example:id/post',
  text,
  desc: '',
  className: 'android.widget.TextView',
  packageName: 'com.example',
  bounds: { left: 0, top: 0, right: 100, bottom: 40 },
  clickable: true,
  enabled: true,
  focused: false,
  index: 0,
  children: [],
})

describe('createTraceFrameStore', () => {
  test('identical bytes written twice produce one file, one hash, and no second write', async () => {
    const store = createTraceFrameStore({ dataDir })
    const bytes = frame(7)

    const first = await store.putFrame('job-1', bytes)
    const second = await store.putFrame('job-1', bytes)

    expect(second).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(readdirSync(store.jobDir('job-1'))).toEqual([`${first}.png`])

    // Proof the second put did not rewrite the file: overwrite it with a
    // sentinel, put the same bytes again, and see the sentinel survive.
    const abs = join(store.jobDir('job-1'), `${first}.png`)
    await Bun.write(abs, new Uint8Array([9, 9, 9]))
    expect(await store.putFrame('job-1', bytes)).toBe(first)
    expect(await Bun.file(abs).bytes()).toEqual(new Uint8Array([9, 9, 9]))
  })

  test('two different frames produce two files, and each reads back byte-identical', async () => {
    const store = createTraceFrameStore({ dataDir })

    const a = await store.putFrame('job-1', frame(1))
    const b = await store.putFrame('job-1', frame(2))

    expect(a).not.toBe(b)
    expect(readdirSync(store.jobDir('job-1')).sort()).toEqual([`${a}.png`, `${b}.png`].sort())
    expect(await store.readFrame('job-1', a)).toEqual(frame(1))
    expect(await store.readFrame('job-1', b)).toEqual(frame(2))
  })

  test('the hash is the SHA-256 of the bytes, and it is per-job addressed', async () => {
    const store = createTraceFrameStore({ dataDir })
    const bytes = frame(3)
    const expected = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

    expect(await store.putFrame('job-1', bytes)).toBe(expected)
    // The same frame in another job is a separate file — cross-job dedupe is
    // given up deliberately so the delete cascade cannot be got wrong (§3.5).
    expect(await store.putFrame('job-2', bytes)).toBe(expected)
    expect(await store.readFrame('job-2', expected)).toEqual(bytes)
    expect(readdirSync(store.jobDir('job-1'))).toHaveLength(1)
    expect(readdirSync(store.jobDir('job-2'))).toHaveLength(1)
  })

  test('a ui tree is gzipped on the way in and comes back as the same tree', async () => {
    const store = createTraceFrameStore({ dataDir })
    const tree = node('Post')

    const hash = await store.putUiTree('job-1', tree)

    expect(readdirSync(store.jobDir('job-1'))).toEqual([`${hash}.json.gz`])
    const raw = await Bun.file(join(store.jobDir('job-1'), `${hash}.json.gz`)).bytes()
    expect(raw[0]).toBe(0x1f) // gzip magic — stored compressed, not as plain JSON
    expect(raw[1]).toBe(0x8b)
    expect(await store.readUiTree('job-1', hash)).toEqual(tree)

    // Same tree, same hash, one file; a different tree is its own file.
    expect(await store.putUiTree('job-1', node('Post'))).toBe(hash)
    expect(await store.putUiTree('job-1', node('Repost'))).not.toBe(hash)
    expect(readdirSync(store.jobDir('job-1'))).toHaveLength(2)
  })

  test('a frame and a ui tree with the same hash never collide — the extension separates them', async () => {
    const store = createTraceFrameStore({ dataDir })
    const hash = await store.putFrame('job-1', frame(4))

    expect(await store.readUiTree('job-1', hash)).toBeNull()
    expect(await store.readFrame('job-1', hash)).toEqual(frame(4))
  })

  test('reading something that was never captured (or has been swept) is null, not a throw', async () => {
    const store = createTraceFrameStore({ dataDir })
    const absent = 'c'.repeat(64)

    expect(await store.readFrame('job-1', absent)).toBeNull()
    expect(await store.readUiTree('job-1', absent)).toBeNull()
    expect(await store.readFrame('never-ran', absent)).toBeNull()
  })

  test('removeJob deletes the whole directory and is idempotent', async () => {
    const store = createTraceFrameStore({ dataDir })
    await store.putFrame('job-1', frame(1))
    await store.putFrame('job-1', frame(2))
    await store.putUiTree('job-1', node('Post'))
    await store.putFrame('job-2', frame(1))

    expect(existsSync(store.jobDir('job-1'))).toBe(true)

    await store.removeJob('job-1')

    expect(existsSync(store.jobDir('job-1'))).toBe(false)
    // A neighbouring job keeps its own frames.
    expect(existsSync(store.jobDir('job-2'))).toBe(true)
    // A job that never captured anything has no directory; removing it is a no-op.
    await store.removeJob('never-ran')
    await store.removeJob('job-1')
  })

  test('a malformed or traversing hash is rejected, never turned into a path', async () => {
    const store = createTraceFrameStore({ dataDir })
    const real = await store.putFrame('job-1', frame(1))
    // A file the traversal would reach if the guard were missing.
    await Bun.write(join(dataDir, 'secret.png'), new Uint8Array([1, 2, 3]))

    const bad = [
      '../secret',
      '../../secret',
      `../job-1/${real}`,
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64), // uppercase hex is not what we write, so it is not what we accept
      `${real}\0`,
      '',
      'not-a-hash',
    ]
    for (const hash of bad) {
      await expect(store.readFrame('job-1', hash)).rejects.toThrow(/invalid trace content hash/)
      await expect(store.readUiTree('job-1', hash)).rejects.toThrow(/invalid trace content hash/)
    }
    expect(existsSync(join(dataDir, 'secret.png'))).toBe(true)
  })

  test('a job id that could escape the traces directory is rejected too', async () => {
    const store = createTraceFrameStore({ dataDir })
    const hash = 'd'.repeat(64)

    for (const jobId of ['../artifacts', 'job/1', 'job\\1', '..', '', 'job 1']) {
      expect(() => store.jobDir(jobId)).toThrow(/invalid job id/)
      await expect(store.readFrame(jobId, hash)).rejects.toThrow(/invalid job id/)
      await expect(store.putFrame(jobId, frame(1))).rejects.toThrow(/invalid job id/)
      await expect(store.removeJob(jobId)).rejects.toThrow(/invalid job id/)
    }
    // A real job id — a UUID — passes.
    expect(store.jobDir(crypto.randomUUID())).toContain(join(dataDir, 'traces'))
  })
})
