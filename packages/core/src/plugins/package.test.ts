import { describe, expect, test } from 'bun:test'
import { SURFACE_LIMITS } from '@enkaku/protocol'
import { createTarGz, type TarEntry } from '../backup/tar'
import { EnkakuError } from '../util/errors'
import {
  PACKAGE_MANIFEST_ENTRY,
  PACKAGE_SCRIPTS_ENTRY,
  isPluginPackageContentType,
  isUiAssetPath,
  readPluginPackage,
  writePluginPackage,
} from './package'

const enc = new TextEncoder()
const dec = new TextDecoder()

const MANIFEST = { name: 'tiktok', version: '1.0.0' }
const BUNDLE = 'export default { id: "tiktok", version: "1.0.0", scripts: [] }\n'

/** A raw archive built entry-by-entry — the only way to produce a package `writePluginPackage` would never emit, which is exactly what the reader's allowlist exists for. */
function rawPackage(entries: TarEntry[]): Uint8Array<ArrayBuffer> {
  return createTarGz(entries)
}

function manifestEntry(manifest: unknown = MANIFEST): TarEntry {
  return { name: PACKAGE_MANIFEST_ENTRY, data: enc.encode(JSON.stringify(manifest)) }
}

function scriptsEntry(): TarEntry {
  return { name: PACKAGE_SCRIPTS_ENTRY, data: enc.encode(BUNDLE) }
}

/** Asserts the call refuses with `E_PLUGIN_PACKAGE_INVALID` and that its message NAMES the offending thing (plan 108 criterion 5). */
function expectRefusal(fn: () => unknown, ...mustContain: string[]): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(EnkakuError)
  const error = caught as EnkakuError
  expect(error.code).toBe('E_PLUGIN_PACKAGE_INVALID')
  for (const needle of mustContain) expect(error.message).toContain(needle)
}

describe('writePluginPackage / readPluginPackage — round trip', () => {
  test('a manifest and a bundle round-trip byte for byte', () => {
    const back = readPluginPackage(writePluginPackage({ manifest: MANIFEST, scripts: BUNDLE }))
    expect(back.manifest).toEqual({ name: 'tiktok', version: '1.0.0' })
    expect(back.scripts).toBe(BUNDLE)
    expect(back.ui).toEqual([])
  })

  test('`ui/` assets round-trip with paths RELATIVE to `ui/` — the same thing a view\'s `react.entry` names', () => {
    const archive = writePluginPackage({
      manifest: { ...MANIFEST, source: 'export default {}' },
      scripts: BUNDLE,
      ui: [
        { path: 'index.html', data: enc.encode('<h1>hi</h1>') },
        { path: 'assets/app.js', data: enc.encode('console.info(1)') },
      ],
    })
    const back = readPluginPackage(archive)
    expect(back.manifest.source).toBe('export default {}')
    expect(back.ui.map((a) => a.path)).toEqual(['assets/app.js', 'index.html']) // sorted on write, so a build is reproducible
    expect(dec.decode(back.ui.find((a) => a.path === 'index.html')?.data)).toBe('<h1>hi</h1>')
  })

  test('the archive really is gzip, and a fixed mtime makes two writes byte-identical', () => {
    const first = writePluginPackage({ manifest: MANIFEST, scripts: BUNDLE, mtimeSec: 1_700_000_000 })
    const second = writePluginPackage({ manifest: MANIFEST, scripts: BUNDLE, mtimeSec: 1_700_000_000 })
    expect(first[0]).toBe(0x1f)
    expect(first[1]).toBe(0x8b)
    expect(first).toEqual(second)
  })

  test('a package a writer would never emit is still readable when it is legal — order does not matter', () => {
    const back = readPluginPackage(rawPackage([scriptsEntry(), { name: 'ui/a.css', data: enc.encode('b{}') }, manifestEntry()]))
    expect(back.manifest.name).toBe('tiktok')
    expect(back.ui.map((a) => a.path)).toEqual(['a.css'])
  })
})

describe('readPluginPackage — the entry allowlist (plan 108 §3.8, criterion 5)', () => {
  test('an entry outside the allowlist is refused, naming the entry', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: 'run.sh', data: enc.encode('rm -rf /') }])), 'run.sh', 'allowlist')
  })

  test('a `..` segment is refused, naming the entry — inside `ui/` and outside it alike', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: 'ui/../../etc/passwd', data: enc.encode('x') }])), 'ui/../../etc/passwd', '".."')
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: '../escape.mjs', data: enc.encode('x') }])), '../escape.mjs', '".."')
  })

  test('an absolute path is refused as absolute, before the allowlist is even consulted', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: '/etc/passwd', data: enc.encode('x') }])), '/etc/passwd', 'absolute path')
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: 'C:\\windows\\evil', data: enc.encode('x') }])), 'absolute path')
  })

  test('a backslash-separated path is refused rather than normalised', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: 'ui\\index.html', data: enc.encode('x') }])), 'ui\\index.html', 'backslash')
  })

  test('a directory entry, and `ui/` itself, are refused', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: 'ui/', data: new Uint8Array(0) }])), 'ui/', 'directory entry')
  })

  test('a `ui/` segment outside the permitted character set is refused, naming the segment', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: 'ui/we ird.html', data: enc.encode('x') }])), '"we ird.html"')
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: 'ui/.hidden', data: enc.encode('x') }])), '".hidden"')
  })

  test('the same entry twice is refused, naming it', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), scriptsEntry()])), PACKAGE_SCRIPTS_ENTRY, 'appears twice')
  })

  test('a missing required entry is refused, naming which one', () => {
    expectRefusal(() => readPluginPackage(rawPackage([scriptsEntry()])), PACKAGE_MANIFEST_ENTRY, 'required')
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry()])), PACKAGE_SCRIPTS_ENTRY, 'required')
  })

  test('bytes that are not a gzipped USTAR archive are refused, not thrown raw', () => {
    expectRefusal(() => readPluginPackage(new Uint8Array([1, 2, 3, 4])), 'readable .enkaku archive')
  })
})

describe('readPluginPackage — the `ui/` budget (§4.2 maxUiBytes)', () => {
  test('a `ui/` payload over maxUiBytes is refused, naming the limit', () => {
    const oversize = new Uint8Array(SURFACE_LIMITS.maxUiBytes + 1)
    expectRefusal(
      () => readPluginPackage(rawPackage([manifestEntry(), scriptsEntry(), { name: 'ui/big.bin', data: oversize }])),
      'maxUiBytes',
      String(SURFACE_LIMITS.maxUiBytes),
    )
  })

  test('the budget is the WHOLE directory, not one file — many small assets add up', () => {
    const half = new Uint8Array(SURFACE_LIMITS.maxUiBytes / 2 + 1)
    expectRefusal(
      () =>
        readPluginPackage(
          rawPackage([manifestEntry(), scriptsEntry(), { name: 'ui/a.bin', data: half }, { name: 'ui/b.bin', data: half }]),
        ),
      'maxUiBytes',
    )
  })

  test('the writer enforces the same budget, so it can never emit a package the reader refuses', () => {
    expectRefusal(
      () => writePluginPackage({ manifest: MANIFEST, scripts: BUNDLE, ui: [{ path: 'big.bin', data: new Uint8Array(SURFACE_LIMITS.maxUiBytes + 1) }] }),
      'maxUiBytes',
    )
  })
})

describe('readPluginPackage — plugin.json', () => {
  test('a `plugin.json` that is not JSON at all is refused, naming the file', () => {
    expectRefusal(() => readPluginPackage(rawPackage([{ name: PACKAGE_MANIFEST_ENTRY, data: enc.encode('{ not json') }, scriptsEntry()])), PACKAGE_MANIFEST_ENTRY, 'not valid JSON')
  })

  test('a `plugin.json` missing a required field is refused, naming the field', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry({ name: 'tiktok' }), scriptsEntry()])), 'version')
  })

  test('a non-semver version is refused', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry({ name: 'tiktok', version: 'v1' }), scriptsEntry()])), 'version')
  })

  test('an unknown key in `plugin.json` is a named refusal, never a silently ignored field', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry({ ...MANIFEST, surface: {} }), scriptsEntry()])), 'surface')
  })

  test('a `plugin.json` holding a JSON array rather than an object is refused', () => {
    expectRefusal(() => readPluginPackage(rawPackage([manifestEntry([]), scriptsEntry()])), PACKAGE_MANIFEST_ENTRY)
  })
})

describe('writePluginPackage — refuses what the reader would refuse', () => {
  test('a `ui/` asset path escaping its directory is refused at WRITE time', () => {
    expectRefusal(() => writePluginPackage({ manifest: MANIFEST, scripts: BUNDLE, ui: [{ path: '../escape.js', data: enc.encode('x') }] }), '".."')
  })

  test('an absolute `ui/` asset path is refused at write time', () => {
    expectRefusal(() => writePluginPackage({ manifest: MANIFEST, scripts: BUNDLE, ui: [{ path: '/etc/passwd', data: enc.encode('x') }] }), 'ui//etc/passwd')
  })

  test('a malformed manifest is refused at write time', () => {
    expectRefusal(() => writePluginPackage({ manifest: { name: '', version: '1.0.0' }, scripts: BUNDLE }), 'manifest')
  })

  test('an entry name too long for a plain USTAR header is refused by name, not by an opaque tar error', () => {
    expectRefusal(() => writePluginPackage({ manifest: MANIFEST, scripts: BUNDLE, ui: [{ path: `${'a'.repeat(120)}.js`, data: enc.encode('x') }] }), 'USTAR')
  })
})

describe('isPluginPackageContentType', () => {
  test('recognises the raw-archive content types, with or without parameters', () => {
    expect(isPluginPackageContentType('application/octet-stream')).toBe(true)
    expect(isPluginPackageContentType('Application/Octet-Stream; charset=binary')).toBe(true)
    expect(isPluginPackageContentType('application/gzip')).toBe(true)
  })

  test('leaves the JSON transport alone — that is the whole point of branching on it', () => {
    expect(isPluginPackageContentType('application/json')).toBe(false)
    expect(isPluginPackageContentType('application/json; charset=utf-8')).toBe(false)
    expect(isPluginPackageContentType(undefined)).toBe(false)
  })
})

/**
 * Step 108.10 — `isUiAssetPath` is the grammar the ARCHIVE reader applies,
 * exported so the on-disk asset store can re-check a path it read back without
 * a second copy of the rule. These cases exist to pin that the two really are
 * one rule: everything the reader refuses as an entry name, this refuses as a
 * relative path.
 */
describe('isUiAssetPath — the same grammar, reusable off the archive', () => {
  test('accepts what a real package ships', () => {
    for (const path of ['index.html', 'app.js', 'assets/logo.png', 'a/b/c/d.css', 'LICENSE', '1.txt', 'a-b_c.d.js']) {
      expect(isUiAssetPath(path)).toBe(true)
    }
  })

  test('refuses every shape that could name something outside `ui/`', () => {
    for (const path of ['', '..', '../plugin.json', 'a/../../b', './a.js', '/etc/passwd', 'a//b', 'a/', 'a\\b', '.hidden', '__proto__', 'we ird.html', 'a\0b']) {
      expect(isUiAssetPath(path)).toBe(false)
    }
  })

  test('refuses a path too long for the plain USTAR header the writer emits', () => {
    expect(isUiAssetPath(`${'a'.repeat(90)}.js`)).toBe(true)
    expect(isUiAssetPath(`${'a'.repeat(120)}.js`)).toBe(false)
  })

  test('agrees with the reader: every path the reader accepted as `ui/<path>` passes', () => {
    const ui = [{ path: 'index.html', data: enc.encode('x') }, { path: 'assets/logo.png', data: enc.encode('y') }]
    const pkg = readPluginPackage(writePluginPackage({ manifest: MANIFEST, scripts: BUNDLE, ui }))
    for (const asset of pkg.ui) expect(isUiAssetPath(asset.path)).toBe(true)
  })
})

/**
 * Plan 111 §5 step 111.6 — the CLI writes this format too, and cannot import
 * this module to do it: `enkaku-core` depends on `@enkaku/sdk`, so the SDK
 * importing core back would close a cycle. `packages/sdk/src/cli/enkaku-package.ts`
 * therefore carries its own USTAR writer, and THIS is what keeps the two
 * honest — the farm's real reader, fed the CLI's real output. A drift in
 * either direction (a header field, the gzip wrapper, the entry names, the
 * budget) fails here rather than in an author's terminal.
 */
describe('the SDK writes packages this reader accepts (plan 111 §5 step 111.6)', () => {
  test('a CLI-written package with ui/ round-trips through readPluginPackage', async () => {
    const { writeEnkakuPackage } = await import('@enkaku/sdk/package-format')
    const bytes = writeEnkakuPackage({
      name: 'tiktok',
      version: '2.3.4',
      source: 'export default 1',
      scripts: 'export const x = 1',
      ui: [
        { path: 'index.js', data: enc.encode('import "react"') },
        { path: 'assets/logo.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      ],
    })

    const pkg = readPluginPackage(bytes)
    expect(pkg.manifest).toEqual({ name: 'tiktok', version: '2.3.4', source: 'export default 1' })
    expect(pkg.scripts).toBe('export const x = 1')
    expect(pkg.ui.map((a) => a.path).sort()).toEqual(['assets/logo.png', 'index.js'])
    expect(new TextDecoder().decode(pkg.ui.find((a) => a.path === 'index.js')?.data)).toBe('import "react"')
  })

  test('a CLI-written package with NO ui/ round-trips too', async () => {
    const { writeEnkakuPackage } = await import('@enkaku/sdk/package-format')
    const pkg = readPluginPackage(writeEnkakuPackage({ name: 'plain', version: '1.0.0', scripts: 'export {}' }))
    expect(pkg.manifest).toEqual({ name: 'plain', version: '1.0.0' })
    expect(pkg.ui).toEqual([])
  })

  test('the CLI refuses a ui/ path this reader would refuse, in the author’s own terminal', async () => {
    const { writeEnkakuPackage } = await import('@enkaku/sdk/package-format')
    expect(() => writeEnkakuPackage({ name: 'p', version: '1.0.0', scripts: 'export {}', ui: [{ path: '../escape.js', data: enc.encode('x') }] })).toThrow(/unusable path segment/)
  })

  test('the CLI’s archive is byte-reproducible for identical input', async () => {
    const { writeEnkakuPackage } = await import('@enkaku/sdk/package-format')
    const input = { name: 'p', version: '1.0.0', scripts: 'export {}', ui: [{ path: 'index.js', data: enc.encode('x') }] }
    expect(writeEnkakuPackage(input)).toEqual(writeEnkakuPackage(input))
  })
})
