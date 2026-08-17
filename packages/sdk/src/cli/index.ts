#!/usr/bin/env bun
import { resolve } from 'node:path'
import { publish } from './publish'
import { devCommand } from './dev'
import { initCommand } from './init'

const USAGE = `enkaku — CLI SDK Enkaku

Usage:
  enkaku init <name>
  enkaku publish <entry.ts> [--farm <url>] [--token <token>] [--stage-only]
  enkaku dev <entry.ts> [--farm <url>] [--token <token>] [--name <name>] [--no-watch]

A plugin is the only thing the farm publishes — a script cannot exist outside
one. "enkaku init" scaffolds a plugin project that publishes with no edits.

Options:
  --farm         Core URL (defaults to http://localhost:7700 or the ENKAKU_FARM_URL env var)
  --token        token publish (default env ENKAKU_TOKEN)
  --stage-only   publish only: stage a plugin without verifying it in the same call
  --name         dev only: the plugin name to use on the farm (defaults to the bundle's own id)
  --no-watch     dev only: push once and exit, instead of watching for changes
`

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

const argv = process.argv.slice(2)
const command = argv[0]

if (command !== 'publish' && command !== 'dev' && command !== 'init') {
  console.log(USAGE)
  process.exit(command ? 1 : 0)
}

const target = argv[1]
if (!target || target.startsWith('--')) {
  console.error(command === 'init' ? 'error: a plugin name is required\n' : 'error: an entry script is required\n')
  console.log(USAGE)
  process.exit(1)
}

const farmUrl = flag(argv, 'farm') ?? process.env.ENKAKU_FARM_URL ?? 'http://localhost:7700'
const token = flag(argv, 'token') ?? process.env.ENKAKU_TOKEN

try {
  if (command === 'init') {
    initCommand({ name: target })
  } else if (command === 'publish') {
    await publish({
      entry: resolve(target),
      farmUrl,
      ...(token ? { token } : {}),
      ...(hasFlag(argv, 'stage-only') ? { stageOnly: true } : {}),
    })
  } else {
    await devCommand({
      entry: resolve(target),
      farmUrl,
      ...(token ? { token } : {}),
      ...(flag(argv, 'name') ? { name: flag(argv, 'name') } : {}),
      ...(hasFlag(argv, 'no-watch') ? { watch: false } : {}),
    })
  }
} catch (err) {
  console.error(`✗ ${command} failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
