import { join } from 'node:path'

/**
 * `runtime-host.fixture.ts`, bundled exactly the way a real publish bundles a
 * plugin (`Bun.build`, the same call `scripts/build.ts` makes) — **once per
 * test process**, and that is the reason this module exists rather than the
 * two lines living in each test file.
 *
 * `bun test` runs a whole directory in ONE process (core's suite is not
 * `--isolate`d; only Studio's is). Two test files each calling `Bun.build` on
 * this same entrypoint at module scope makes the SECOND one fail, on Bun
 * 1.3.14, with `EISDIR reading file: packages/sdk/src/index.ts` — a bundler
 * cache collision that looks nothing like its cause and takes down every test
 * in the file that lost the race. Importing one already-built string cannot
 * collide with itself.
 */
const FIXTURE_PATH = join(import.meta.dir, 'runtime-host.fixture.ts')
const built = await Bun.build({ entrypoints: [FIXTURE_PATH], target: 'bun', format: 'esm' })
if (!built.success) throw new Error(`the runtime-host fixture failed to bundle: ${built.logs.map(String).join('; ')}`)

export const FIXTURE_BUNDLE = await built.outputs[0]!.text()
