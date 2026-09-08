import { describe, expect, test } from 'bun:test'
import { queueItemSchema } from '@enkaku/sdk'
import { QUEUE_PREFIX, QueuePayloadSchema, queueKeyFor, readLegacyQueueEntry } from './queue'

/**
 * The claim protocol itself moved to `@enkaku/sdk` (plan 800) and is tested
 * there — candidate ordering, stale reclaim, losing a CAS race, the
 * reclaimed-claim refusal. Duplicating those here would test the SDK twice and
 * this pack not at all.
 *
 * What IS this pack's, and what this file covers, is the migration: entries
 * written by every version of this plugin before plan 800 are sitting in real
 * farms in a flat shape, and the new envelope is `.strict()`. If
 * `readLegacyQueueEntry` is wrong, an operator's queue fails hard on data they
 * cannot get back.
 */

const ItemSchema = queueItemSchema(QueuePayloadSchema)

/** Exactly the shape this pack shipped from plan 113 until plan 800. */
const legacyEntry = (over: Record<string, unknown> = {}) => ({
  version: 1,
  artifactId: 'vid-1',
  caption: 'hello world',
  status: 'pending',
  claimedBy: null,
  claimedAt: null,
  postedAt: null,
  attempts: 0,
  lastError: null,
  ...over,
})

describe('readLegacyQueueEntry — the pre-plan-800 shape still reads', () => {
  test('a flat pending entry becomes a valid envelope with the caption nested', () => {
    const parsed = ItemSchema.safeParse(readLegacyQueueEntry(legacyEntry()))
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toMatchObject({
      version: 1,
      id: 'vid-1',
      payload: { caption: 'hello world' },
      status: 'pending',
      attempts: 0,
    })
  })

  /** `posted` was this pack's word for the SDK's terminal `done`. */
  test("status 'posted' reads as done", () => {
    const parsed = ItemSchema.safeParse(readLegacyQueueEntry(legacyEntry({ status: 'posted', postedAt: 1_725_000_000 })))
    expect(parsed.success && parsed.data.status).toBe('done')
  })

  /** `postedAt` was this pack's word for `settledAt` — losing it would lose when an item was posted. */
  test('postedAt becomes settledAt, keeping the timestamp', () => {
    const parsed = ItemSchema.safeParse(readLegacyQueueEntry(legacyEntry({ status: 'posted', postedAt: 1_725_000_000 })))
    expect(parsed.success && parsed.data.settledAt).toBe(1_725_000_000)
  })

  test('a claim in flight survives the translation intact', () => {
    const parsed = ItemSchema.safeParse(
      readLegacyQueueEntry(legacyEntry({ status: 'claimed', claimedBy: 'device-7', claimedAt: 1_725_000_000 })),
    )
    expect(parsed.success && parsed.data).toMatchObject({ status: 'claimed', claimedBy: 'device-7', claimedAt: 1_725_000_000 })
  })

  test('a failed entry keeps its attempts and its error', () => {
    const parsed = ItemSchema.safeParse(readLegacyQueueEntry(legacyEntry({ status: 'failed', attempts: 3, lastError: 'app crashed' })))
    expect(parsed.success && parsed.data).toMatchObject({ status: 'failed', attempts: 3, lastError: 'app crashed' })
  })

  test('a null caption stays null — it means "use the captions file", not "no caption"', () => {
    const parsed = ItemSchema.safeParse(readLegacyQueueEntry(legacyEntry({ caption: null })))
    expect(parsed.success && parsed.data.payload.caption).toBeNull()
  })

  /**
   * The translation must be idempotent: every read goes through it, including
   * reads of entries this version wrote. Treating an already-migrated row as
   * legacy would read `id` as undefined and fail.
   */
  test('an already-migrated entry passes through untouched', () => {
    const modern = {
      version: 1,
      id: 'vid-2',
      payload: { caption: 'new' },
      status: 'done',
      claimedBy: 'device-1',
      claimedAt: 1,
      settledAt: 2,
      attempts: 1,
      lastError: null,
    }
    expect(readLegacyQueueEntry(modern)).toEqual(modern)
    expect(readLegacyQueueEntry(readLegacyQueueEntry(legacyEntry()))).toEqual(readLegacyQueueEntry(legacyEntry()))
  })

  test('a non-object is handed back unchanged, for the schema to reject by itself', () => {
    expect(readLegacyQueueEntry(null)).toBeNull()
    expect(readLegacyQueueEntry('nonsense')).toBe('nonsense')
    expect(readLegacyQueueEntry([1, 2])).toEqual([1, 2])
  })

  /** A shape from neither era must still fail loudly rather than be half-understood. */
  test('an unrecognisable entry still fails the schema', () => {
    expect(ItemSchema.safeParse(readLegacyQueueEntry({ version: 9, nonsense: true })).success).toBe(false)
  })
})

describe('keys', () => {
  /** The prefix is UNCHANGED by the migration — the entries on real farms are under it, and so is the plugin's own surface. */
  test('the prefix is still "queue:"', () => {
    expect(QUEUE_PREFIX).toBe('queue:')
    expect(queueKeyFor('vid-1')).toBe('queue:vid-1')
  })
})
