#!/usr/bin/env bun
/**
 * Entry point agent (mode cloud).
 *
 * Enrollment happens once: the token is exchanged for a long-lived credential
 * stored in `<data-dir>/agent.json`. After that, run it without a token.
 */
import { createAgent } from './index'

const USAGE = `enkaku-agent — the device farm agent for cloud mode

Env:
  ENKAKU_CP_URL         Control plane URL (required), e.g. https://farm.example.com
  ENKAKU_ENROLL_TOKEN   Single-use token from Studio (first run only)
  ENKAKU_DATA_DIR       lokasi state & tool (default: ./.agent-data)
  ENKAKU_AGENT_NAME     Agent name shown in Studio

Example:
  ENKAKU_CP_URL=http://localhost:7700 ENKAKU_ENROLL_TOKEN=abc123 bun run packages/agent/src/cli.ts
`

const controlPlaneUrl = process.env.ENKAKU_CP_URL
if (!controlPlaneUrl) {
  console.error('error: ENKAKU_CP_URL is required\n')
  console.log(USAGE)
  process.exit(1)
}

const agent = createAgent({
  dataDir: process.env.ENKAKU_DATA_DIR ?? `${process.cwd()}/.agent-data`,
  controlPlaneUrl,
  ...(process.env.ENKAKU_ENROLL_TOKEN ? { enrollToken: process.env.ENKAKU_ENROLL_TOKEN } : {}),
  ...(process.env.ENKAKU_AGENT_NAME ? { name: process.env.ENKAKU_AGENT_NAME } : {}),
})

let stopping = false
const shutdown = async (signal: string) => {
  if (stopping) return
  stopping = true
  console.error(`[agent] received ${signal}, shutting down…`)
  await agent.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await agent.start()
} catch (err) {
  console.error(`[agent] failed to start: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
