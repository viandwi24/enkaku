/**
 * Shared types and small constants for the AI agents screens (plan 65).
 * `Agent`/`Connector`/`ModelInfo` copy `@enkaku/protocol`'s `AgentSchema`/
 * `ConnectorSchema`/`ModelInfoSchema` field-for-field — Studio does not
 * import `@enkaku/core` (server-only), so the ACL's `Permission` union has
 * no shared type to import either; `ALL_PERMISSIONS` below is a plain
 * copy of `packages/core/src/auth/acl.ts`'s own list, kept in the same
 * order. The SERVER is the authority either way — this list is only a
 * convenience for building checkboxes, never a validator.
 */

export interface AgentSettings {
  effort?: 'low' | 'medium' | 'high'
  thinking?: boolean
  maxOutputTokens?: number
  maxSteps?: number
  maxRunSeconds?: number
  compactAtRatio?: number
  maxConcurrentRuns?: number
  /** Plan 70 §3.6 — images kept in the provider view of one request; oldest dropped first. */
  maxImagesPerRequest?: number
  /** Plan 70 §3.6 — per-image byte cap, matching the provider's own hard limit. */
  maxImageBytes?: number
}

export interface WorkspaceScope {
  read: string[]
  write: string[]
}

export interface Agent {
  id: string
  slug: string
  name: string
  description: string | null
  colour: string | null
  enabled: boolean
  connectorId: string | null
  model: string | null
  systemPrompt: string | null
  settings: AgentSettings
  tools: string[]
  /** Registry capability ids that pause for approval even when not `effect: 'destructive'` (plan 66 §3.6). */
  requiresApproval: string[]
  deviceGrants: string[]
  workspaceScope: WorkspaceScope
  permissions: string[]
  /** Plan 67 §3.3 — whether a message arriving after this agent's run has already finished starts a new run. */
  wakeOnMessage: 'on-child-result' | 'always' | 'never'
  ownerId: string | null
  createdAt: number
  updatedAt: number
}

export interface AgentDefaults {
  connectorId: string | null
  model: string
  systemPrompt: string
  effort: 'low' | 'medium' | 'high'
  thinking: boolean
  maxOutputTokens: number
  maxSteps: number
  maxRunSeconds: number
  compactAtRatio: number
  maxConcurrentRuns: number
  maxImagesPerRequest: number
  maxImageBytes: number
}

export type ConnectorKind = 'anthropic' | 'openrouter'

export interface Connector {
  id: string
  name: string
  kind: ConnectorKind
  baseUrl: string | null
  configured: boolean
  hint: string | null
  status: 'unknown' | 'ok' | 'unauthenticated' | 'unreachable'
  statusMessage: string | null
  checkedAt: number | null
  createdAt: number
}

export interface ModelInfo {
  id: string
  contextWindow: number
  supportsThinking: boolean
}

export interface CapabilityInfo {
  id: string
  description: string
  effect: 'read' | 'write' | 'destructive'
  permission: string
}

/** Mirrors `packages/core/src/auth/acl.ts`'s `ALL_PERMISSIONS` — the server validates for real; this only builds the checkbox list. */
export const ALL_PERMISSIONS: readonly string[] = [
  'device.view',
  'device.control',
  'device.settings',
  'device.enroll',
  'device.quarantine',
  'device.shell',
  'device.adb',
  'device.files',
  'device.network',
  'fs.read',
  'fs.write',
  'agent.view',
  'agent.manage',
  'script.view',
  'script.publish',
  'script.delete',
  'job.view',
  'job.run',
  'job.cancel.any',
  'tool.view',
  'tool.manage',
  'settings.view',
  'settings.manage',
  'user.manage',
  'audit.view',
]

/** Resolves an agent's config against farm defaults — the SAME merge `@enkaku/protocol`'s `resolveAgentConfig` performs server-side, mirrored here purely so the UI can show provenance (inherited vs overridden) without a round trip per keystroke. The server remains the one place that decides what actually runs. */
export function resolveForDisplay(defaults: AgentDefaults, agent: Pick<Agent, 'connectorId' | 'model' | 'systemPrompt' | 'settings'>) {
  const s = agent.settings
  return {
    connectorId: agent.connectorId ?? defaults.connectorId,
    model: agent.model ?? defaults.model,
    systemPrompt: agent.systemPrompt ?? defaults.systemPrompt,
    effort: s.effort ?? defaults.effort,
    thinking: s.thinking ?? defaults.thinking,
    maxOutputTokens: s.maxOutputTokens ?? defaults.maxOutputTokens,
    maxSteps: s.maxSteps ?? defaults.maxSteps,
    maxRunSeconds: s.maxRunSeconds ?? defaults.maxRunSeconds,
    compactAtRatio: s.compactAtRatio ?? defaults.compactAtRatio,
    maxConcurrentRuns: s.maxConcurrentRuns ?? defaults.maxConcurrentRuns,
    maxImagesPerRequest: s.maxImagesPerRequest ?? defaults.maxImagesPerRequest,
    maxImageBytes: s.maxImageBytes ?? defaults.maxImageBytes,
  }
}

/**
 * A slug for a duplicated agent (plan 73 §3.3, §4.3) — `AgentSlugSchema`
 * requires uniqueness (`E_SLUG_TAKEN`), and there is no cheap way from here
 * to check what is already taken before the create call, so a short random
 * suffix makes a collision astronomically unlikely rather than merely
 * *likely* unlikely (`-copy` alone would collide on a SECOND duplicate of
 * the same agent). Truncated to `AgentSlugSchema`'s own 64-char cap.
 */
export function duplicateSlug(base: string): string {
  const suffix = `-copy-${Math.random().toString(36).slice(2, 6)}`
  return `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`
}

/** Grouping prefix for the Tools section — everything up to (and including) the first dot. */
export function capabilityGroup(id: string): string {
  const dot = id.indexOf('.')
  return dot === -1 ? id : id.slice(0, dot)
}

/** A crude heuristic for "this system prompt looks like it contains something time-varying" (plan 65 §3.4, §3.8) — never authoritative, just a nudge in the editor. Flags an obvious date/time/count pattern or a live-looking placeholder. */
export function looksVolatile(text: string): string | null {
  if (/\{\{.*(now|date|time|today).*\}\}/i.test(text)) return 'contains a "{{...}}" placeholder that looks like a live value'
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) return 'contains what looks like a literal date'
  if (/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/i.test(text)) return 'contains what looks like a literal time'
  if (/\byou are running at\b/i.test(text)) return 'contains a phrase that reads like a live timestamp'
  return null
}
