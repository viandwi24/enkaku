#!/usr/bin/env bun
/**
 * Entry point agent (mode cloud).
 *
 * Enrollment cukup sekali: token ditukar dengan credential jangka panjang
 * yang disimpan di `<data-dir>/agent.json`. Setelah itu jalankan tanpa token.
 */
import { createAgent } from './index'

const USAGE = `enkaku-agent — agent device farm untuk mode cloud

Env:
  ENKAKU_CP_URL         URL control plane (wajib), mis. https://farm.example.com
  ENKAKU_ENROLL_TOKEN   token sekali pakai dari Studio (hanya saat pertama)
  ENKAKU_DATA_DIR       lokasi state & tool (default: ./.agent-data)
  ENKAKU_AGENT_NAME     nama agent yang tampil di Studio

Contoh:
  ENKAKU_CP_URL=http://localhost:7700 ENKAKU_ENROLL_TOKEN=abc123 bun run packages/agent/src/cli.ts
`

const controlPlaneUrl = process.env.ENKAKU_CP_URL
if (!controlPlaneUrl) {
  console.error('error: ENKAKU_CP_URL wajib diisi\n')
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
  console.error(`[agent] terima ${signal}, berhenti...`)
  await agent.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await agent.start()
} catch (err) {
  console.error(`[agent] gagal start: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
