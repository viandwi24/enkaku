#!/usr/bin/env bun
/**
 * Entry point node (mode cloud).
 *
 * Enrollment happens once: the token is exchanged for a long-lived credential
 * stored in `<data-dir>/node.json`. After that, run it without a token.
 */
import { createNode } from './index'

const USAGE = `enkaku-node — the device farm node for cloud mode

Env:
  ENKAKU_CP_URL         Control plane URL (required), e.g. https://farm.example.com
  ENKAKU_ENROLL_TOKEN   Single-use token from Studio (first run only)
  ENKAKU_DATA_DIR       state & tool location (default: ./.node-data)
  ENKAKU_NODE_NAME      Node name shown in Studio

Example:
  ENKAKU_CP_URL=http://localhost:7700 ENKAKU_ENROLL_TOKEN=abc123 bun run packages/node/src/cli.ts
`

const controlPlaneUrl = process.env.ENKAKU_CP_URL
if (!controlPlaneUrl) {
  console.error('error: ENKAKU_CP_URL is required\n')
  console.log(USAGE)
  process.exit(1)
}

const node = createNode({
  dataDir: process.env.ENKAKU_DATA_DIR ?? `${process.cwd()}/.node-data`,
  controlPlaneUrl,
  ...(process.env.ENKAKU_ENROLL_TOKEN ? { enrollToken: process.env.ENKAKU_ENROLL_TOKEN } : {}),
  ...(process.env.ENKAKU_NODE_NAME ? { name: process.env.ENKAKU_NODE_NAME } : {}),
})

let stopping = false
const shutdown = async (signal: string) => {
  if (stopping) return
  stopping = true
  console.error(`[node] received ${signal}, shutting down…`)
  await node.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await node.start()
} catch (err) {
  console.error(`[node] failed to start: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
