import { toJsonSchema } from '@enkaku/protocol'
import type { AnyCoreCapability } from './types'

/** One capability entry plus the file it was declared in — carried through
 * boot so a duplicate-id failure can name BOTH files (plan 63 §6.2). */
export interface CapabilitySource {
  cap: AnyCoreCapability
  file: string
}

export interface CapabilityRegistry {
  all(): AnyCoreCapability[]
  get(id: string): AnyCoreCapability | undefined
  /** The registry filtered to what `ctx` may actually invoke (plan 63 §3.6,
   * acceptance #8) — `GET /api/v1/cap` and MCP's `tools/list` both call this
   * rather than filtering `all()` themselves, so the two can never disagree
   * about what "visible" means. */
  visibleTo(ctx: { hasPermission(permission: string): boolean }): AnyCoreCapability[]
}

const REQUIRED_FIELDS = ['id', 'input', 'output', 'permission', 'lease', 'deadline', 'effect', 'description'] as const
const LEASE_VALUES = new Set(['none', 'device', 'control'])
const EFFECT_VALUES = new Set(['read', 'write', 'destructive'])

/** Every capability has all eight declared fields, non-empty (plan 63 §6.1). */
function assertWellFormed(cap: AnyCoreCapability, file: string): void {
  for (const field of REQUIRED_FIELDS) {
    const value = (cap as unknown as Record<string, unknown>)[field]
    if (value === undefined || value === null || value === '') {
      throw new Error(`capability declared in ${file} is missing its "${field}" field`)
    }
  }
  if (typeof cap.id !== 'string' || cap.id.trim() === '') {
    throw new Error(`capability declared in ${file} has an empty id`)
  }
  if (typeof cap.input?.parse !== 'function' || typeof cap.output?.parse !== 'function') {
    throw new Error(`capability "${cap.id}" (${file}) must declare Zod "input"/"output" schemas`)
  }
  if (!LEASE_VALUES.has(cap.lease)) {
    throw new Error(`capability "${cap.id}" (${file}) has an invalid lease value: ${String(cap.lease)}`)
  }
  if (!EFFECT_VALUES.has(cap.effect)) {
    throw new Error(`capability "${cap.id}" (${file}) has an invalid effect value: ${String(cap.effect)}`)
  }
  if (typeof cap.deadline !== 'number' || !Number.isFinite(cap.deadline) || cap.deadline <= 0) {
    throw new Error(`capability "${cap.id}" (${file}) must declare a positive "deadline" in milliseconds`)
  }
  if (typeof cap.description !== 'string' || cap.description.trim().length === 0) {
    throw new Error(`capability "${cap.id}" (${file}) must declare a non-empty "description"`)
  }
  if (typeof cap.handler !== 'function') {
    throw new Error(`capability "${cap.id}" (${file}) must declare a "handler" function`)
  }
}

/**
 * Plan 70 §4.3, criterion 11 — a capability declaring `imageOutputs` with a
 * field absent from its own `output` schema fails the boot, naming the
 * capability and the field: a typo here would otherwise silently fall back
 * to serialising the image as text, which is the exact defect this plan
 * exists to fix. Only a plain `z.object(...)`-shaped `output` can be
 * introspected this way — a capability that declares `imageOutputs` against
 * anything else (no top-level `.shape`) fails the boot too, naming itself,
 * rather than silently skipping the check.
 */
function assertImageOutputsExist(cap: AnyCoreCapability, file: string): void {
  if (!cap.imageOutputs || cap.imageOutputs.length === 0) return
  const shape = (cap.output as unknown as { shape?: Record<string, unknown> }).shape
  if (!shape) {
    throw new Error(`capability "${cap.id}" (${file}) declares "imageOutputs" but its "output" schema is not a plain object schema that can be checked`)
  }
  for (const decl of cap.imageOutputs) {
    if (!(decl.dataField in shape)) {
      throw new Error(`capability "${cap.id}" (${file}) declares imageOutputs field "${decl.dataField}" that does not exist in its own output schema`)
    }
    if (decl.mediaTypeField && !(decl.mediaTypeField in shape)) {
      throw new Error(`capability "${cap.id}" (${file}) declares imageOutputs mediaTypeField "${decl.mediaTypeField}" that does not exist in its own output schema`)
    }
    if (!decl.mediaType && !decl.mediaTypeField) {
      throw new Error(`capability "${cap.id}" (${file}) declares an imageOutputs entry for "${decl.dataField}" with neither a fixed "mediaType" nor a "mediaTypeField"`)
    }
  }
}

/**
 * Builds the frozen registry at boot (plan 63 §4.2). Two checks are fatal —
 * both borrowed from the one genuinely good idea in the bitorex harness
 * analysis this plan cites:
 *
 * - **Duplicate id → the process does not start** (acceptance #2): a
 *   collision discovered at boot is discovered by whoever caused it, not by
 *   a user picking whichever entry the `Map` happened to keep.
 * - **Dry run: every entry's `input`/`output` convert to JSON Schema**
 *   (acceptance #3): a Zod construct that will not convert is a runtime
 *   failure in an agent's tool list otherwise, visible only when a model
 *   happens to call that tool.
 */
export function buildCapabilityRegistry(entries: CapabilitySource[]): CapabilityRegistry {
  const map = new Map<string, AnyCoreCapability>()
  const fileOf = new Map<string, string>()

  for (const { cap, file } of entries) {
    assertWellFormed(cap, file)
    assertImageOutputsExist(cap, file)

    try {
      toJsonSchema(cap.input)
    } catch (err) {
      throw new Error(`capability "${cap.id}" (${file}) has an "input" schema that will not convert to JSON Schema: ${String(err)}`)
    }
    try {
      toJsonSchema(cap.output)
    } catch (err) {
      throw new Error(`capability "${cap.id}" (${file}) has an "output" schema that will not convert to JSON Schema: ${String(err)}`)
    }

    const existingFile = fileOf.get(cap.id)
    if (existingFile) {
      throw new Error(`duplicate capability id "${cap.id}" declared in both ${existingFile} and ${file}`)
    }
    map.set(cap.id, cap)
    fileOf.set(cap.id, file)
  }

  return {
    all: () => [...map.values()],
    get: (id) => map.get(id),
    visibleTo: (ctx) => [...map.values()].filter((cap) => ctx.hasPermission(cap.permission)),
  }
}
