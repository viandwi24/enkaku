import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * App-data dir per platform (00-overview §5, spec §7.2).
 * `ENKAKU_DATA_DIR` overrides it for dev and test.
 */
export function resolveDataDir(): string {
  const override = process.env.ENKAKU_DATA_DIR
  let dir: string
  if (override && override.length > 0) {
    dir = override
  } else if (process.platform === 'darwin') {
    dir = join(homedir(), 'Library', 'Application Support', 'Enkaku')
  } else if (process.platform === 'win32') {
    dir = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Enkaku')
  } else {
    dir = join(homedir(), '.local', 'share', 'enkaku')
  }
  mkdirSync(dir, { recursive: true })
  return dir
}
