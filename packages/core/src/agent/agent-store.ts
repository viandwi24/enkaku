import { desc, eq } from 'drizzle-orm'
import { AgentSchema, AgentSettingsSchema, AgentUpdateInputSchema, AgentWriteInputSchema, WorkspaceScopeSchema, type Agent, type AgentUpdateInput, type AgentWriteInput, type WorkspaceScope } from '@enkaku/protocol'
import { can, isPermission, type Permission } from '../auth/acl'
import type { Role } from '../auth/service'
import type { CapabilityRegistry } from '../capability/registry'
import type { Db } from '../db'
import { aiAgents, devices, users, type AiAgentRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { normaliseScopePrefix } from '../workspace/path'

/**
 * CRUD plus write-time validation for `ai_agents` (plan 65 §4.1, §4.5, §5.5).
 * Every JSON column is parsed through Zod on read (`AgentSchema.parse` in
 * `rowToAgent`) — never an `as`-cast (CLAUDE.md).
 */

export interface AgentStoreDeps {
  db: Db
  /** The real capability registry — an agent's `tools` are validated against it at write time (§4.5). */
  registry: Pick<CapabilityRegistry, 'get'>
}

function toSeconds(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function rowToAgent(row: AiAgentRow): Agent {
  return AgentSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    colour: row.colour,
    enabled: row.enabled ?? true,
    connectorId: row.connectorId,
    model: row.model,
    systemPrompt: row.systemPrompt,
    settings: row.settings ?? {},
    tools: row.tools ?? [],
    requiresApproval: row.requiresApproval ?? [],
    deviceGrants: row.deviceGrants ?? [],
    workspaceScope: row.workspaceScope ?? { read: ['/'], write: [] },
    permissions: row.permissions ?? [],
    wakeOnMessage: row.wakeOnMessage === 'always' || row.wakeOnMessage === 'never' ? row.wakeOnMessage : 'on-child-result',
    ownerId: row.ownerId,
    createdAt: toSeconds(row.createdAt),
    updatedAt: toSeconds(row.updatedAt),
  })
}

/** An agent's default workspace scope (plan 65 §3.5, §4.6, criterion 11): write to its own home, read everywhere. */
export function defaultWorkspaceScope(slug: string): WorkspaceScope {
  return { read: ['/'], write: [`/agents/${slug}/`] }
}

/** Exported for `agent/runner.ts` (plan 66) — resolving an agent OWNER's current role is what `effectivePermissions` needs, and re-deriving it from `agent-store.ts`'s own logic keeps "how do we find a user's role" in one place. */
export function roleOf(db: Db, userId: string | null): Role | null {
  if (!userId) return null
  const row = db.select().from(users).where(eq(users.id, userId)).get()
  if (!row) return null
  // No `as`-cast: `users.role` is a plain `text` column (same as `auth/service.ts`'s own
  // `toAuthUser`), so this narrows it explicitly rather than asserting the type.
  return row.role === 'admin' ? 'admin' : 'operator'
}

function validateTools(registry: Pick<CapabilityRegistry, 'get'>, tools: string[]): void {
  for (const id of tools) {
    if (!registry.get(id)) throw new EnkakuError('E_UNKNOWN_CAPABILITY', `unknown capability id: "${id}"`)
  }
}

function validateDeviceGrants(db: Db, deviceIds: string[]): void {
  for (const id of deviceIds) {
    const row = db.select({ id: devices.id }).from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('E_UNKNOWN_DEVICE', `unknown device id: "${id}"`)
  }
}

function validateWorkspaceScope(scope: WorkspaceScope): void {
  for (const prefix of [...scope.read, ...scope.write]) {
    // Throws E_BAD_PATH on anything outside the tree / malformed — never resolved (plan 64 §3.2).
    normaliseScopePrefix(prefix)
  }
}

/**
 * A ceiling, not a default (§3.5): every requested permission must be a
 * real permission name AND already held by the owner's role. Thrown at
 * create/update (§4.5); `effectivePermissions` below re-derives the SAME
 * intersection live, so a later demotion narrows an agent automatically
 * rather than needing a second write (criterion 9).
 */
function validatePermissions(permissions: string[], ownerRole: Role | null): Permission[] {
  const result: Permission[] = []
  for (const p of permissions) {
    if (!isPermission(p)) throw new EnkakuError('E_UNKNOWN_PERMISSION', `unknown permission: "${p}"`)
    if (!ownerRole || !can(ownerRole, p)) {
      throw new EnkakuError('E_OVER_PRIVILEGED', `permission "${p}" is not held by this agent's owner`)
    }
    result.push(p)
  }
  return result
}

/**
 * The permissions an agent may ACTUALLY act with right now — the stored
 * list intersected with whatever its owner currently holds (plan 65 §3.5,
 * criterion 9: "refused... if the owner is demoted afterwards"). Written
 * once at create/update time via `validatePermissions`, but re-derived here
 * on every read so a later demotion narrows the agent without a second
 * write ever happening.
 */
export function effectivePermissions(agent: Pick<Agent, 'permissions'>, ownerRole: Role | null): Permission[] {
  if (!ownerRole) return []
  return agent.permissions.filter((p): p is Permission => isPermission(p) && can(ownerRole, p))
}

/** Whether `deviceId` is reachable by `agent` — empty/absent grants mean ALL devices (plan 65 §3.5, criterion 10). */
export function agentCanReachDevice(agent: Pick<Agent, 'deviceGrants'>, deviceId: string): boolean {
  if (agent.deviceGrants.length === 0) return true
  return agent.deviceGrants.includes(deviceId)
}

export function createAgentStore(deps: AgentStoreDeps) {
  const { db, registry } = deps

  function list(): Agent[] {
    return db.select().from(aiAgents).orderBy(desc(aiAgents.createdAt), desc(aiAgents.id)).all().map(rowToAgent)
  }

  function get(id: string): Agent | null {
    const row = db.select().from(aiAgents).where(eq(aiAgents.id, id)).get()
    return row ? rowToAgent(row) : null
  }

  function getBySlug(slug: string): Agent | null {
    const row = db.select().from(aiAgents).where(eq(aiAgents.slug, slug)).get()
    return row ? rowToAgent(row) : null
  }

  function mustGet(id: string): AiAgentRow {
    const row = db.select().from(aiAgents).where(eq(aiAgents.id, id)).get()
    if (!row) throw new EnkakuError('agent_not_found', `no such agent: ${id}`)
    return row
  }

  function create(input: AgentWriteInput, ownerId: string | null): Agent {
    const parsed = AgentWriteInputSchema.parse(input)
    if (getBySlug(parsed.slug)) throw new EnkakuError('E_SLUG_TAKEN', `an agent named "${parsed.slug}" already exists`)

    const ownerRole = roleOf(db, ownerId)
    const tools = parsed.tools ?? []
    validateTools(registry, tools)
    const requiresApproval = parsed.requiresApproval ?? []
    validateTools(registry, requiresApproval)
    const deviceGrants = parsed.deviceGrants ?? []
    validateDeviceGrants(db, deviceGrants)
    const workspaceScope = WorkspaceScopeSchema.parse(parsed.workspaceScope ?? defaultWorkspaceScope(parsed.slug))
    validateWorkspaceScope(workspaceScope)
    const permissions = validatePermissions(parsed.permissions ?? [], ownerRole)
    const settings = AgentSettingsSchema.parse(parsed.settings ?? {})

    const now = new Date()
    const row: AiAgentRow = {
      id: crypto.randomUUID(),
      slug: parsed.slug,
      name: parsed.name,
      description: parsed.description ?? null,
      colour: parsed.colour ?? null,
      enabled: parsed.enabled ?? true,
      connectorId: parsed.connectorId ?? null,
      model: parsed.model ?? null,
      systemPrompt: parsed.systemPrompt ?? null,
      settings,
      tools,
      requiresApproval,
      deviceGrants,
      workspaceScope,
      permissions,
      wakeOnMessage: parsed.wakeOnMessage ?? null,
      ownerId,
      createdAt: now,
      updatedAt: now,
    }
    db.insert(aiAgents).values(row).run()
    return rowToAgent(row)
  }

  function update(id: string, input: AgentUpdateInput): Agent {
    const existing = mustGet(id)
    const parsed = AgentUpdateInputSchema.parse(input)
    const ownerRole = roleOf(db, existing.ownerId)

    const patch: Partial<AiAgentRow> = {}

    if (parsed.name !== undefined) patch.name = parsed.name
    if (parsed.description !== undefined) patch.description = parsed.description
    if (parsed.colour !== undefined) patch.colour = parsed.colour
    if (parsed.enabled !== undefined) patch.enabled = parsed.enabled
    if (parsed.connectorId !== undefined) patch.connectorId = parsed.connectorId
    if (parsed.model !== undefined) patch.model = parsed.model
    if (parsed.systemPrompt !== undefined) patch.systemPrompt = parsed.systemPrompt
    if (parsed.settings !== undefined) patch.settings = AgentSettingsSchema.parse(parsed.settings)

    if (parsed.tools !== undefined) {
      validateTools(registry, parsed.tools)
      patch.tools = parsed.tools
    }
    if (parsed.requiresApproval !== undefined) {
      validateTools(registry, parsed.requiresApproval)
      patch.requiresApproval = parsed.requiresApproval
    }
    if (parsed.deviceGrants !== undefined) {
      validateDeviceGrants(db, parsed.deviceGrants)
      patch.deviceGrants = parsed.deviceGrants
    }
    if (parsed.workspaceScope !== undefined) {
      const scope = WorkspaceScopeSchema.parse(parsed.workspaceScope)
      validateWorkspaceScope(scope)
      patch.workspaceScope = scope
    }
    if (parsed.permissions !== undefined) {
      patch.permissions = validatePermissions(parsed.permissions, ownerRole)
    }
    if (parsed.wakeOnMessage !== undefined) {
      patch.wakeOnMessage = parsed.wakeOnMessage
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date()
      db.update(aiAgents).set(patch).where(eq(aiAgents.id, id)).run()
    }
    return rowToAgent(mustGet(id))
  }

  function remove(id: string): void {
    mustGet(id)
    db.delete(aiAgents).where(eq(aiAgents.id, id)).run()
  }

  return { list, get, getBySlug, create, update, remove }
}

export type AgentStore = ReturnType<typeof createAgentStore>
