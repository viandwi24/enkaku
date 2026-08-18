import { describe, expect, test } from 'bun:test'
import type { ArtifactApi, DeviceApi, FarmApi, JobsApi, KvApi, KvListItem, PluginStorage, ScriptContext, ScriptLogger } from '@enkaku/sdk'
import {
  FOLDER_POSTED_PREFIX,
  VIDEO_EXTENSIONS,
  filterVideoFiles,
  isVideoPath,
  mintVideoArtifact,
  parsePostedMemory,
  pickVideoInOrder,
  pickVideoRandom,
  postedMemoryKey,
  readPostedMemory,
  recordVideoPosted,
  resolveVideoFromFolder,
  type FolderEntry,
  type VideoCandidate,
} from './folder'

/**
 * Folder mode's pure logic (plan 115 §3.7, §3.8, §4.5, task instruction 6):
 * the extension filter (criterion 5), both picks (in-order/random), and the
 * posted-memory preference (criterion 6) need no `ctx` at all — the same
 * "pure function, no device" posture `captions.test.ts`'s `pickCaption`
 * suite and `queue.test.ts`'s `orderCandidates` suite already take.
 * `resolveVideoFromFolder`/`mintVideoArtifact`/`readPostedMemory`/
 * `recordVideoPosted` are exercised against a stubbed `ctx`, the same
 * `fakeCtx`/`fakeKv` shape `queue.test.ts` and `captions.test.ts` use.
 */

const enc = (s: string) => new TextEncoder().encode(s)

function entry(path: string, opts: { kind?: 'file' | 'dir'; hash?: string | null } = {}): FolderEntry {
  return { path, kind: opts.kind ?? 'file', hash: opts.hash === undefined ? `hash-of-${path}` : opts.hash }
}

function candidate(path: string, hash?: string): VideoCandidate {
  return { path, hash: hash ?? `hash-of-${path}` }
}

// ---- isVideoPath / VIDEO_EXTENSIONS ----

describe('isVideoPath — the extension filter, §4.5 verbatim', () => {
  test('recognises every declared video extension, case-insensitively', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(isVideoPath(`/folder/clip${ext}`)).toBe(true)
      expect(isVideoPath(`/folder/clip${ext.toUpperCase()}`)).toBe(true)
    }
  })

  test('".txt" is deliberately absent — the whole reason captions.txt is never chosen', () => {
    expect(VIDEO_EXTENSIONS as readonly string[]).not.toContain('.txt')
    expect(isVideoPath('/folder/captions.txt')).toBe(false)
  })

  test('rejects a non-video extension and an extensionless name', () => {
    expect(isVideoPath('/folder/notes.pdf')).toBe(false)
    expect(isVideoPath('/folder/README')).toBe(false)
  })
})

// ---- filterVideoFiles — criterion 5 ----

describe('filterVideoFiles — criterion 5: captions.txt, sitting in the same folder, is never the video', () => {
  test('a folder of videos plus captions.txt keeps only the videos, by the exact "captions.txt" filename the owner actually uses', () => {
    const entries: FolderEntry[] = [
      entry('/folder/one.mp4'),
      entry('/folder/two.mov'),
      entry('/folder/captions.txt'),
    ]
    const out = filterVideoFiles(entries)
    expect(out.map((c) => c.path).sort()).toEqual(['/folder/one.mp4', '/folder/two.mov'])
    expect(out.some((c) => c.path === '/folder/captions.txt')).toBe(false)
  })

  test('a synthesised directory entry is never a candidate, video-named or not', () => {
    const entries: FolderEntry[] = [entry('/folder/sub/', { kind: 'dir', hash: null }), entry('/folder/a.mp4')]
    expect(filterVideoFiles(entries).map((c) => c.path)).toEqual(['/folder/a.mp4'])
  })

  test('a video-named FILE entry with no hash is a store defect — throws rather than silently vanishing', () => {
    const entries: FolderEntry[] = [entry('/folder/a.mp4', { hash: null })]
    expect(() => filterVideoFiles(entries)).toThrow()
  })
})

// ---- pickVideoInOrder ----

describe('pickVideoInOrder — deterministic and stable', () => {
  const candidates = [candidate('/f/b.mp4'), candidate('/f/a.mp4'), candidate('/f/c.mp4')]

  test('sorts by path ascending regardless of input order, and cycles the cursor modulo the count', () => {
    expect(pickVideoInOrder(candidates, 0).path).toBe('/f/a.mp4')
    expect(pickVideoInOrder(candidates, 1).path).toBe('/f/b.mp4')
    expect(pickVideoInOrder(candidates, 2).path).toBe('/f/c.mp4')
    expect(pickVideoInOrder(candidates, 3).path).toBe('/f/a.mp4') // wraps
  })

  test('the reversed input list produces the IDENTICAL sequence — this is an explicit sort, not input order', () => {
    const reversed = [...candidates].reverse()
    for (let cursor = 0; cursor < 6; cursor++) {
      expect(pickVideoInOrder(reversed, cursor).path).toBe(pickVideoInOrder(candidates, cursor).path)
    }
  })

  test('copes with a negative cursor by wrapping into range rather than throwing or indexing negatively', () => {
    expect(pickVideoInOrder(candidates, -1).path).toBe('/f/c.mp4')
  })

  test('a single-candidate folder always returns that candidate', () => {
    const one = [candidate('/f/only.mp4')]
    expect(pickVideoInOrder(one, 0).path).toBe('/f/only.mp4')
    expect(pickVideoInOrder(one, 99).path).toBe('/f/only.mp4')
  })

  test('an empty candidate list throws rather than returning nothing', () => {
    expect(() => pickVideoInOrder([], 0)).toThrow()
  })
})

// ---- pickVideoRandom — stays in range, reaches every candidate ----

describe('pickVideoRandom — random stays within the candidate set and reaches every one of them', () => {
  test('every draw from an empty memory is one of the real candidates', () => {
    const candidates = [candidate('/f/a.mp4'), candidate('/f/b.mp4'), candidate('/f/c.mp4')]
    const paths = new Set(candidates.map((c) => c.path))
    for (let i = 0; i < 100; i++) {
      expect(paths.has(pickVideoRandom(candidates, new Map()).path)).toBe(true)
    }
  })

  test('over enough draws with an empty memory, every candidate is eventually picked (no candidate is structurally unreachable)', () => {
    const candidates = [candidate('/f/a.mp4'), candidate('/f/b.mp4'), candidate('/f/c.mp4'), candidate('/f/d.mp4')]
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(pickVideoRandom(candidates, new Map()).path)
    expect(seen.size).toBe(candidates.length)
  })

  test('a single candidate is always returned, empty memory or not', () => {
    const one = [candidate('/f/only.mp4')]
    expect(pickVideoRandom(one, new Map()).path).toBe('/f/only.mp4')
  })

  test('an empty candidate list throws rather than returning nothing', () => {
    expect(() => pickVideoRandom([], new Map())).toThrow()
  })
})

// ---- criterion 6: the posted-memory preference ----

describe('pickVideoRandom — criterion 6: an unposted file always wins over a posted one', () => {
  test('with two candidates, one already posted, the never-posted one is picked every time', () => {
    const posted = candidate('/f/posted.mp4', 'hash-posted')
    const fresh = candidate('/f/fresh.mp4', 'hash-fresh')
    const memory = new Map([[posted.hash, 1_000]])
    for (let i = 0; i < 50; i++) {
      expect(pickVideoRandom([posted, fresh], memory).hash).toBe(fresh.hash)
    }
  })

  test('with several unposted candidates, only the unposted ones are ever picked', () => {
    const posted = candidate('/f/posted.mp4', 'hash-posted')
    const freshA = candidate('/f/a.mp4', 'hash-a')
    const freshB = candidate('/f/b.mp4', 'hash-b')
    const memory = new Map([[posted.hash, 1_000]])
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(pickVideoRandom([posted, freshA, freshB], memory).hash)
    expect(seen.has(posted.hash)).toBe(false)
    expect(seen).toEqual(new Set([freshA.hash, freshB.hash]))
  })

  test('once every candidate has been posted, the LEAST recently posted one wins', () => {
    const older = candidate('/f/older.mp4', 'hash-older')
    const newer = candidate('/f/newer.mp4', 'hash-newer')
    const memory = new Map([
      [older.hash, 1_000], // posted longest ago
      [newer.hash, 5_000], // posted more recently
    ])
    for (let i = 0; i < 50; i++) {
      expect(pickVideoRandom([older, newer], memory).hash).toBe(older.hash)
    }
  })

  test('a tie among the least-recently-posted (or never-posted) candidates is broken uniformly, not always the same element', () => {
    const a = candidate('/f/a.mp4', 'hash-a')
    const b = candidate('/f/b.mp4', 'hash-b')
    const c = candidate('/f/c.mp4', 'hash-c')
    // All tied at "never posted".
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(pickVideoRandom([a, b, c], new Map()).hash)
    expect(seen).toEqual(new Set(['hash-a', 'hash-b', 'hash-c']))
  })

  test('keyed by content hash, NOT by path — a renamed file (same hash, different path) is still treated as already posted', () => {
    const originalHash = 'hash-stable'
    const memory = new Map([[originalHash, 1_000]])
    // The file was renamed in the workspace since it was posted — its candidate now carries a
    // different PATH but the identical hash.
    const renamed = candidate('/f/renamed-name.mp4', originalHash)
    const other = candidate('/f/other.mp4', 'hash-other')
    // `renamed` must never win over `other` here (never-posted) even though its path looks brand new.
    for (let i = 0; i < 50; i++) {
      expect(pickVideoRandom([renamed, other], memory).hash).toBe(other.hash)
    }
  })
})

// ---- parsePostedMemory / postedMemoryKey ----

function listedPosted(hash: string, value: unknown): KvListItem {
  return { key: postedMemoryKey(hash), value, secret: false, hint: null, version: 1, expiresAt: null, updatedAt: 0 }
}

describe('postedMemoryKey / parsePostedMemory', () => {
  test('postedMemoryKey always prefixes with FOLDER_POSTED_PREFIX so a writer and a reader never drift', () => {
    expect(postedMemoryKey('abc123')).toBe(`${FOLDER_POSTED_PREFIX}abc123`)
  })

  test('parses a well-formed page into a hash -> lastPostedAt map', () => {
    const items = [listedPosted('h1', { version: 1, path: '/f/a.mp4', lastPostedAt: 100 }), listedPosted('h2', { version: 1, path: '/f/b.mp4', lastPostedAt: 200 })]
    const memory = parsePostedMemory(items)
    expect(memory.get('h1')).toBe(100)
    expect(memory.get('h2')).toBe(200)
  })

  test('ignores an item whose key does not carry the folder-posted prefix', () => {
    const items = [{ key: 'something-else', value: {}, secret: false, hint: null, version: 1, expiresAt: null, updatedAt: 0 }]
    expect(parsePostedMemory(items).size).toBe(0)
  })

  test('throws on a stored value with an incompatible shape, rather than silently reading it as "never posted"', () => {
    const items = [listedPosted('h1', { version: 2, path: '/f/a.mp4', lastPostedAt: 100 })]
    expect(() => parsePostedMemory(items)).toThrow()
  })
})

// ---- ctx-based: resolveVideoFromFolder, mintVideoArtifact, readPostedMemory, recordVideoPosted ----

const unused = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`folder.ts should not touch ctx.${String(prop)} in this test`)
    },
  },
)

/** A minimal `KvApi` fake for `ctx.storage.global` — mirrors `queue.test.ts`'s own `fakeKv`, narrowed to what `folder.ts` actually calls (`list`, `set`, `increment`). */
function fakeGlobalKv(opts: { listItems?: KvListItem[]; increment?: (key: string, delta: number) => Promise<number> } = {}): { kv: KvApi; setCalls: Array<{ key: string; value: unknown }> } {
  const setCalls: Array<{ key: string; value: unknown }> = []
  const kv: KvApi = {
    get: async () => {
      throw new Error('unused: get')
    },
    getRaw: async () => {
      throw new Error('unused: getRaw')
    },
    set: async (key, value) => {
      setCalls.push({ key, value })
      return { version: 1 }
    },
    setIfVersion: async () => {
      throw new Error('unused: setIfVersion')
    },
    increment: async (key: string, delta: number) => (opts.increment ? opts.increment(key, delta) : delta),
    delete: async () => {
      throw new Error('unused: delete')
    },
    list: async () => ({ items: opts.listItems ?? [], nextCursor: null }),
  }
  return { kv, setCalls }
}

function fakeCtx(opts: {
  farmCall?: FarmApi['call']
  globalKv?: KvApi
  artifactFile?: ArtifactApi['file']
}): ScriptContext<unknown> {
  return {
    device: unused as DeviceApi,
    params: undefined,
    artifact: { screenshot: unused as ArtifactApi['screenshot'], file: opts.artifactFile ?? (unused as ArtifactApi['file']) },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as ScriptLogger,
    job: { id: 'job-1', attempt: 1, deviceId: 'device-1' },
    kv: { device: unused as KvApi, global: unused as KvApi },
    storage: { global: opts.globalKv ?? (unused as KvApi), device: unused as KvApi, forDevice: () => unused as KvApi },
    farm: { call: opts.farmCall ?? (unused as FarmApi['call']), callRaw: unused as FarmApi['callRaw'] },
    jobs: unused as JobsApi,
    progress: () => {},
  }
}

describe('resolveVideoFromFolder — an empty folder throws E_FOLDER_EMPTY rather than silently reporting success', () => {
  test('a folder with no video file (only captions.txt) throws E_FOLDER_EMPTY', async () => {
    const call: FarmApi['call'] = (async (capability: string) => {
      if (capability === 'fs.list') return { entries: [{ path: '/folder/captions.txt', kind: 'file', hash: 'h' }] }
      throw new Error(`unexpected capability: ${capability}`)
    }) as FarmApi['call']
    const ctx = fakeCtx({ farmCall: call })
    let caught: unknown
    try {
      await resolveVideoFromFolder(ctx, { folder: '/folder', pick: 'random' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('E_FOLDER_EMPTY')
  })

  test('a folder that is genuinely empty (fs.list returns no entries at all) also throws E_FOLDER_EMPTY', async () => {
    const call: FarmApi['call'] = (async () => ({ entries: [] })) as FarmApi['call']
    const ctx = fakeCtx({ farmCall: call })
    await expect(resolveVideoFromFolder(ctx, { folder: '/empty', pick: 'in-order' })).rejects.toThrow(/E_FOLDER_EMPTY|no video file/)
  })
})

describe('resolveVideoFromFolder — the happy path: list, filter, pick, read, mint (§4.5\'s flow)', () => {
  test('picks the one video candidate, reads its bytes, and mints an artifact through ctx.artifact.file', async () => {
    const videoBytes = new Uint8Array([1, 2, 3, 4])
    let readPath: string | undefined
    let mintedBytes: Uint8Array | undefined
    let mintedExt: string | undefined
    const call: FarmApi['call'] = (async (capability: string, args: unknown) => {
      if (capability === 'fs.list') return { entries: [{ path: '/folder/only.mp4', kind: 'file', hash: 'the-hash' }, { path: '/folder/captions.txt', kind: 'file', hash: 'h2' }] }
      if (capability === 'fs.read') {
        readPath = (args as { path: string }).path
        return { content: Buffer.from(videoBytes).toString('base64'), contentType: 'video/mp4' }
      }
      throw new Error(`unexpected capability: ${capability}`)
    }) as FarmApi['call']
    const { kv } = fakeGlobalKv({ listItems: [] }) // random pick reads posted-memory via list()
    const artifactFile: ArtifactApi['file'] = async (_label, data, opts) => {
      mintedBytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data)
      mintedExt = opts?.ext
      return { artifactId: 'artifact-minted-1' }
    }
    const ctx = fakeCtx({ farmCall: call, globalKv: kv, artifactFile })

    const result = await resolveVideoFromFolder(ctx, { folder: '/folder', pick: 'random' })

    expect(result).toEqual({ artifactId: 'artifact-minted-1', path: '/folder/only.mp4', hash: 'the-hash' })
    expect(readPath).toBe('/folder/only.mp4')
    expect(mintedBytes).toEqual(videoBytes)
    expect(mintedExt).toBe('mp4') // no leading dot — artifact-store.ts builds `${...}.${extension}` itself
  })
})

describe('mintVideoArtifact — the extension is passed WITHOUT its leading dot', () => {
  test('a ".mp4" path mints with ext "mp4"', async () => {
    let seenExt: string | undefined
    const ctx = fakeCtx({
      artifactFile: async (_label, _data, opts) => {
        seenExt = opts?.ext
        return { artifactId: 'a1' }
      },
    })
    await mintVideoArtifact(ctx, '/folder/clip.mp4', new Uint8Array([1]))
    expect(seenExt).toBe('mp4')
  })

  test('a path with no extension mints with ext undefined, rather than a bare trailing dot', async () => {
    let seenExt: string | undefined
    const ctx = fakeCtx({
      artifactFile: async (_label, _data, opts) => {
        seenExt = opts?.ext
        return { artifactId: 'a1' }
      },
    })
    await mintVideoArtifact(ctx, '/folder/noext', new Uint8Array([1]))
    expect(seenExt).toBeUndefined()
  })
})

describe('readPostedMemory / recordVideoPosted — the round trip through ctx.storage.global', () => {
  test('recordVideoPosted writes a version-1 record keyed by the hash, and readPostedMemory reads it back', async () => {
    const { kv, setCalls } = fakeGlobalKv({ listItems: [] })
    const ctx = fakeCtx({ globalKv: kv })
    await recordVideoPosted(ctx, 'hash-abc', '/folder/a.mp4')
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]?.key).toBe(postedMemoryKey('hash-abc'))
    const written = setCalls[0]?.value as { version: number; path: string; lastPostedAt: number }
    expect(written.version).toBe(1)
    expect(written.path).toBe('/folder/a.mp4')
    expect(written.lastPostedAt).toBeGreaterThan(0)

    const { kv: kv2 } = fakeGlobalKv({ listItems: [listedPosted('hash-abc', written)] })
    const ctx2 = fakeCtx({ globalKv: kv2 })
    const memory = await readPostedMemory(ctx2)
    expect(memory.get('hash-abc')).toBe(written.lastPostedAt)
  })
})
