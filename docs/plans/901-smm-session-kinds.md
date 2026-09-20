# Plan 901 — Warm-up in SMM, wave 1 : session kinds and warm-up settings

> Status: implemented — the model only; nothing writes a warm-up session yet (wave 2 does).
> Ships: plugins/social-media-manager/src/groups.ts
> Depends on: plan 900 (D4, D6)
> Spec references: §4.7, §12

## 1. Goals

- A stored session says which KIND it is, and an operator never infers it from
  an empty `videoArtifactIds`.
- A warm-up session carries the settings an operator tunes without a release.
- **Every session stored before this plan keeps working, unchanged, with no
  migration step.**

## 2. Non-goals

- Dispatching a warm-up session (wave 2/3).
- Any Studio surface (wave 4).
- Removing `smm/warmup-rotation` (wave 5) — it is untouched here.

## 3. Context and design decisions

### 3.1 Why `kind` is defaulted and not a discriminated union

A discriminated union is the shape this wants, and it is the wrong one here.

`index.ts`'s group reader is:

```ts
const parsed = GroupSchema.safeParse(entry.value)
if (parsed.success) out.set(parsed.data.id, parsed.data)
```

A row that fails to parse is **skipped in silence**. So a required
discriminator would not have produced an error on upgrade — it would have
emptied the operator's sessions list, with every stored session still on disk
and nothing on screen saying why.

`kind: z.enum(SESSION_KINDS).default('post')` makes the migration nothing at
all: a row written before this field existed IS a post session, and reads as
one. That is the same reason `hashtags`, `excludes` and `progress.skipped`
carry defaults, and it is now written down as the rule for this file.

### 3.2 Why the two fields are checked as one

`kind` and `warmup` are one fact. A warm-up session with no settings, or a post
session carrying them, is a row whose kind cannot be trusted — and the kind is
what every screen and every dispatch will branch on. A `.refine` ties them, and
`isWarmup()` narrows `warmup` to non-null so callers stop re-checking.

### 3.3 Why `styleWeights` is a record and not a list

The style ids belong to the engine, which is wave 2. A settings row written
before a style existed must keep working when that style ships, so a missing id
reads as weight 1 and an unknown id is stored untouched. A weight of `0` turns
a style off without removing it, so an operator can put it back — which a list
cannot express without a second "disabled" concept.

## 4. Technical design

```ts
export const SESSION_KINDS = ['post', 'warmup'] as const

export const WarmupSettingsSchema = z.object({
  keywords:       z.array(z.string().min(1).max(60)).min(1).max(10),
  amount:         z.number().min(0.2).max(3).default(1),
  gapSec:         z.tuple([…]).default([8, 20]),
  startJitterSec: z.number().int().min(0).max(1_800).default(120),
  slot:           z.number().int().min(0).max(5).default(0),
  phases:         z.number().int().min(1).max(3).default(1),
  like:           z.object({ chance: …, keywordBoost: … }).default({ chance: 0.1, keywordBoost: 3 }),
  styleWeights:   z.record(z.string().min(1), z.number().min(0).max(10)).default({}),
})

// on GroupSchema
kind:   z.enum(SESSION_KINDS).default('post'),
warmup: WarmupSettingsSchema.nullable().default(null),
// .refine((g) => (g.kind === 'warmup') === (g.warmup !== null))
```

Every field maps to a `warmup-rotation` param that already existed
(`slot`, `keywords`, `gapMinSec`/`gapMaxSec`, `amount`, `startDelayMaxSec`) or
to a script parameter the packs already expose (`likeProbability`,
`keywordBoostFactor`). Nothing here is invented; it is the same tuning surface,
moved off the graph.

## 5. Implementation steps

- **901.1** `SESSION_KINDS`, `WarmupSettingsSchema`, `defaultWarmupSettings()`
  in `groups.ts`. ✅
- **901.2** `kind` and `warmup` on `GroupSchema`, tied by `.refine`, plus
  `isWarmup()`. ✅
- **901.3** Tests in `groups.test.ts`: the legacy row reads as `post`, a
  warm-up row keeps its settings and defaults, a disagreeing row is refused,
  bounds hold, an unknown style weight survives. ✅

## 6. Acceptance criteria

| # | criterion | how |
|---|---|---|
| 1 | A session stored before this plan parses, and reads as `post` | `groups.test.ts` — "a session stored before warm-up existed reads as a post session" |
| 2 | `isWarmup` narrows and is false for a post session | same file |
| 3 | A kind that disagrees with its settings is refused | "a kind that disagrees with its settings is refused" |
| 4 | Bounds refuse a typo that would ask for an endless session | "warm-up settings are bounded…" |
| 5 | An unknown style id survives a round-trip | "an unknown style weight is stored…" |
| 6 | Nothing else in the plugin broke | `bun test src/` in the plugin — 285 pass |

## 7. Test plan

```bash
cd plugins/social-media-manager && bun test src/groups.test.ts
cd plugins/social-media-manager && bun test src/
bun run typecheck
```

No device is involved: this wave is a schema.

## 8. Risks and mitigations

| risk | mitigation |
|---|---|
| A later field added without a default silently drops every older session | §3.1 states the rule in the file itself, beside the schema |
| `styleWeights` grows into a second settings format | Wave 2 names the ids and is the only writer; a weight is a number and stays one |

## 9. Open questions

None. Plan 900 §6 Q1 (are any farms running `smm/warmup-rotation` on a
schedule) belongs to wave 5 and does not block this.
