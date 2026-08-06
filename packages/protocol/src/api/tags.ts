import { z } from 'zod'

/** `GET /api/tags` — farm-wide tag suggestions with a use count. */
export const TagSuggestionSchema = z.object({ tag: z.string(), count: z.number() })
export const TagsResponseSchema = z.object({ tags: z.array(TagSuggestionSchema) })
