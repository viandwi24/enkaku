import { z } from 'zod'

/**
 * The one keyset envelope every list endpoint in the core returns (spec: plan
 * 30 §4.1). `pageSchema(item)` builds the Zod shape for one item type so a
 * response envelope schema (§4.1 of plan 72) can say "a page of jobs" without
 * re-typing `nextCursor`/`total` at every call site.
 */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().nullable(),
  })
}

export type Page<T> = {
  items: T[]
  nextCursor: string | null
  total: number | null
}
