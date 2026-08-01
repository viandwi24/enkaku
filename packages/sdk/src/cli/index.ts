#!/usr/bin/env bun
import { resolve } from 'node:path'
import { publish } from './publish'

const USAGE = `enkaku — CLI SDK Enkaku

Usage:
  enkaku publish <entry.ts> [--farm <url>] [--token <token>]

Options:
  --farm    URL core (default http://localhost:7700 atau env ENKAKU_FARM_URL)
  --token   token publish (default env ENKAKU_TOKEN)
`

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const argv = process.argv.slice(2)
const command = argv[0]

if (command !== 'publish') {
  console.log(USAGE)
  process.exit(command ? 1 : 0)
}

const entry = argv[1]
if (!entry || entry.startsWith('--')) {
  console.error('error: entry script wajib diisi\n')
  console.log(USAGE)
  process.exit(1)
}

try {
  await publish({
    entry: resolve(entry),
    farmUrl: flag(argv, 'farm') ?? process.env.ENKAKU_FARM_URL ?? 'http://localhost:7700',
    ...(flag(argv, 'token') ?? process.env.ENKAKU_TOKEN
      ? { token: flag(argv, 'token') ?? process.env.ENKAKU_TOKEN }
      : {}),
  })
} catch (err) {
  console.error(`✗ publish gagal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
