import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { HOSTILE_BLOCKING, HOSTILE_PARAMS_FIXTURES } from './hostile-fixtures'
import { ENKAKU_META_KEY, ui } from './vocabulary'
import { checkDeclaredSchema, SCHEMA_LIMITS } from './limits'

function findingsFor(limit: string) {
  return (schema: unknown) => checkDeclaredSchema(schema).filter((f) => f.limit === limit)
}

describe('checkDeclaredSchema — no schema at all', () => {
  test('null and undefined find nothing (a script with no params is not a violation)', () => {
    expect(checkDeclaredSchema(null)).toEqual([])
    expect(checkDeclaredSchema(undefined)).toEqual([])
  })

  test('a non-object schema is refused', () => {
    expect(checkDeclaredSchema('not a schema').some((f) => f.limit === 'maxFields')).toBe(true)
  })
})

describe('checkDeclaredSchema — maxSchemaBytes (R3)', () => {
  test('a small schema passes', () => {
    const schema = z.toJSONSchema(z.object({ videos: z.number().int().default(1) }))
    expect(findingsFor('maxSchemaBytes')(schema)).toEqual([])
  })

  test('a schema over the byte limit is refused, naming the limit', () => {
    const bomb = { type: 'object', properties: { field: { type: 'string', description: 'x'.repeat(SCHEMA_LIMITS.maxSchemaBytes + 1) } } }
    const findings = findingsFor('maxSchemaBytes')(bomb)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]?.message).toContain('bytes')
  })
})

describe('checkDeclaredSchema — maxDepth (R1)', () => {
  function nested(depth: number): unknown {
    let node: unknown = { type: 'string' }
    for (let i = 0; i < depth; i++) {
      node = { type: 'object', properties: { next: node } }
    }
    return node
  }

  test('a schema within the depth cap passes', () => {
    expect(findingsFor('maxDepth')(nested(SCHEMA_LIMITS.maxDepth))).toEqual([])
  })

  test('a schema past the depth cap is refused, and does not hang', () => {
    const findings = findingsFor('maxDepth')(nested(SCHEMA_LIMITS.maxDepth + 3))
    expect(findings.length).toBeGreaterThan(0)
  })
})

describe('checkDeclaredSchema — maxFields (R5)', () => {
  test('a schema under the field cap passes', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 5; i++) properties[`field${i}`] = { type: 'string' }
    expect(findingsFor('maxFields')({ type: 'object', properties })).toEqual([])
  })

  test('a schema over the field cap is refused', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < SCHEMA_LIMITS.maxFields + 1; i++) properties[`field${i}`] = { type: 'string' }
    const findings = findingsFor('maxFields')({ type: 'object', properties })
    expect(findings.length).toBe(1)
    expect(findings[0]?.message).toContain(`${SCHEMA_LIMITS.maxFields}`)
  })
})

describe('checkDeclaredSchema — maxEnumMembers', () => {
  test('an enum under the cap passes', () => {
    const schema = { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b', 'c'] } } }
    expect(findingsFor('maxEnumMembers')(schema)).toEqual([])
  })

  test('an enum over the cap is refused', () => {
    const enumValues = Array.from({ length: SCHEMA_LIMITS.maxEnumMembers + 1 }, (_, i) => `v${i}`)
    const schema = { type: 'object', properties: { mode: { type: 'string', enum: enumValues } } }
    expect(findingsFor('maxEnumMembers')(schema).length).toBe(1)
  })
})

describe('checkDeclaredSchema — maxTitleChars / maxDescriptionChars (R4)', () => {
  test('a title/description within budget passes', () => {
    const schema = { type: 'object', properties: { x: { type: 'string', title: 'ok', description: 'ok' } } }
    expect(findingsFor('maxTitleChars')(schema)).toEqual([])
    expect(findingsFor('maxDescriptionChars')(schema)).toEqual([])
  })

  test('an over-long title is refused', () => {
    const schema = { type: 'object', properties: { x: { type: 'string', title: 'a'.repeat(SCHEMA_LIMITS.maxTitleChars + 1) } } }
    expect(findingsFor('maxTitleChars')(schema).length).toBe(1)
  })

  test('an over-long description is refused', () => {
    const schema = { type: 'object', properties: { x: { type: 'string', description: 'a'.repeat(SCHEMA_LIMITS.maxDescriptionChars + 1) } } }
    expect(findingsFor('maxDescriptionChars')(schema).length).toBe(1)
  })
})

describe('checkDeclaredSchema — fieldNamePattern (H2, plan 95 §3.5)', () => {
  test('identifier-shaped names pass', () => {
    const schema = { type: 'object', properties: { videos: { type: 'number' }, save_chance: { type: 'number' } } }
    expect(findingsFor('fieldNamePattern')(schema)).toEqual([])
  })

  test('a non-identifier name (a space, a leading digit, a hyphen) is refused', () => {
    for (const badName of ['has space', '1leading', 'kebab-case']) {
      const schema = { type: 'object', properties: { [badName]: { type: 'string' } } }
      const findings = findingsFor('fieldNamePattern')(schema)
      expect(findings.length).toBe(1)
      expect(findings[0]?.path).toBe(badName)
    }
  })
})

describe('checkDeclaredSchema — x-enkaku hints (R2 territory: no pattern here, only Enkaku-owned checks)', () => {
  test('a well-formed ui() hint passes clean', () => {
    const schema = z.toJSONSchema(z.object({ saveChance: z.number().min(0).max(1).default(0).meta(ui({ title: 'Save chance', kind: 'chance' })) }))
    expect(checkDeclaredSchema(schema)).toEqual([])
  })

  test(`a non-object "${ENKAKU_META_KEY}" is refused under 'hints'`, () => {
    const schema = { type: 'object', properties: { x: { type: 'string', [ENKAKU_META_KEY]: 'not an object' } } }
    expect(findingsFor('hints')(schema).length).toBe(1)
  })

  test("kind: 'duration' with no unit is refused under 'hints'", () => {
    const schema = { type: 'object', properties: { x: { type: 'number', [ENKAKU_META_KEY]: { kind: 'duration' } } } }
    expect(findingsFor('hints')(schema).length).toBeGreaterThan(0)
  })

  test('an unknown kind is refused at publish time (unlike readHints, which is forgiving for forward compatibility)', () => {
    const schema = { type: 'object', properties: { x: { type: 'string', [ENKAKU_META_KEY]: { kind: 'percentage' } } } }
    expect(findingsFor('hints')(schema).length).toBeGreaterThan(0)
  })

  test('a group name over the char limit is refused', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string', [ENKAKU_META_KEY]: { group: 'g'.repeat(SCHEMA_LIMITS.maxGroupChars + 1) } } },
    }
    expect(findingsFor('maxGroupChars')(schema).length).toBe(1)
  })

  test('a label over the char limit is refused', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string', [ENKAKU_META_KEY]: { labels: { a: 'l'.repeat(SCHEMA_LIMITS.maxLabelChars + 1) } } } },
    }
    expect(findingsFor('maxLabelChars')(schema).length).toBe(1)
  })

  test('the two workspace path kinds pass the publish gate — they are embedded in plugin surfaces and published script params, and both are gated here', () => {
    const schema = z.toJSONSchema(
      z.object({
        outDir: z.string().default('/videos').meta(ui({ title: 'Output folder', kind: 'workspaceFolder' })),
        captions: z.string().default('/captions.txt').meta(ui({ title: 'Captions', kind: 'workspaceFile', extensions: ['.txt'] })),
      }),
    )
    expect(checkDeclaredSchema(schema)).toEqual([])
  })

  test("extensions on anything but kind: 'workspaceFile' is refused under 'hints', the same way a stray unit is", () => {
    const schema = { type: 'object', properties: { x: { type: 'string', [ENKAKU_META_KEY]: { kind: 'workspaceFolder', extensions: ['.txt'] } } } }
    expect(findingsFor('hints')(schema).length).toBeGreaterThan(0)
  })
})

describe('checkDeclaredSchema — showWhen sibling existence (plan 95 §3.6)', () => {
  test('a showWhen naming a real sibling passes', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['simple', 'advanced'] },
        region: { type: 'string', [ENKAKU_META_KEY]: { showWhen: { field: 'mode', is: 'advanced' } } },
      },
    }
    expect(findingsFor('showWhen')(schema)).toEqual([])
  })

  test('a showWhen naming a field that does not exist among siblings is refused', () => {
    const schema = {
      type: 'object',
      properties: {
        region: { type: 'string', [ENKAKU_META_KEY]: { showWhen: { field: 'doesNotExist', is: 'advanced' } } },
      },
    }
    const findings = findingsFor('showWhen')(schema)
    expect(findings.length).toBe(1)
    expect(findings[0]?.message).toContain('doesNotExist')
  })
})

describe('checkDeclaredSchema — returns every finding, not just the first', () => {
  test('a schema with two independent violations reports both', () => {
    const schema = {
      type: 'object',
      properties: {
        'bad name': { type: 'string', title: 'a'.repeat(SCHEMA_LIMITS.maxTitleChars + 1) },
      },
    }
    const limits = checkDeclaredSchema(schema).map((f) => f.limit)
    expect(limits).toContain('fieldNamePattern')
    expect(limits).toContain('maxTitleChars')
  })
})

describe('checkDeclaredSchema — $ref cycles (R1, F21)', () => {
  test('a self-referential $ref ($defs.A.properties.next → #/$defs/A, the exact shape z.lazy() emits) is refused, naming the cycle', () => {
    const findings = checkDeclaredSchema(HOSTILE_PARAMS_FIXTURES['self-ref-cycle'])
    const refFindings = findings.filter((f) => f.limit === '$ref')
    expect(refFindings.length).toBeGreaterThan(0)
    expect(refFindings[0]?.message).toContain('self-referential')
  })

  test('a mutual cycle (A → B → A) is refused too — a single-hop check would miss it', () => {
    const findings = checkDeclaredSchema(HOSTILE_PARAMS_FIXTURES['mutual-ref-cycle'])
    expect(findings.some((f) => f.limit === '$ref')).toBe(true)
  })

  test('the check terminates promptly on a cyclic schema — this is the function meant to REFUSE the hang, not fall into it', () => {
    const start = performance.now()
    checkDeclaredSchema(HOSTILE_PARAMS_FIXTURES['self-ref-cycle'])
    expect(performance.now() - start).toBeLessThan(200)
  })

  test('a $ref reused twice in UNRELATED places (no cycle) is never falsely flagged', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/Shared' },
        b: { $ref: '#/$defs/Shared' },
      },
      $defs: { Shared: { type: 'object', properties: { x: { type: 'string' } } } },
    }
    expect(checkDeclaredSchema(schema).some((f) => f.limit === '$ref')).toBe(false)
  })

  test('an unresolvable $ref is tolerated (nothing more can safely be checked), never thrown', () => {
    const schema = { type: 'object', properties: { a: { $ref: '#/$defs/DoesNotExist' } } }
    expect(() => checkDeclaredSchema(schema)).not.toThrow()
  })

  test('a schema that stays within depth/field limits through non-cyclic $ref reuse is not refused at all', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Shared' }, b: { $ref: '#/$defs/Shared' } },
      $defs: { Shared: { type: 'object', properties: { x: { type: 'string', title: 'X' } } } },
    }
    expect(checkDeclaredSchema(schema)).toEqual([])
  })
})

describe('checkDeclaredSchema — the walk itself cannot be made to hang (a $ref-reuse amplification bomb)', () => {
  test('five $defs levels, each with 50 siblings all $ref-ing the next (50^5 nodes if walked naively) is refused promptly, not hung', () => {
    const defs: Record<string, unknown> = { L5: { type: 'string' } }
    for (let level = 4; level >= 1; level--) {
      const properties: Record<string, unknown> = {}
      for (let i = 0; i < 50; i++) properties[`f${i}`] = { $ref: `#/$defs/L${level + 1}` }
      defs[`L${level}`] = { type: 'object', properties }
    }
    const schema = { type: 'object', properties: { root: { $ref: '#/$defs/L1' } }, $defs: defs }

    const start = performance.now()
    const findings = checkDeclaredSchema(schema)
    expect(performance.now() - start).toBeLessThan(200)
    // Refused SOMEHOW (the walk-budget finding, or maxFields once the
    // budget finding lets the outer field count through) — the important
    // property under test is TERMINATION, not which specific limit fires.
    expect(findings.length).toBeGreaterThan(0)
  })
})

describe('checkDeclaredSchema — non-consecutive group is a WARNING, not a rejection (plan 95 §3.5)', () => {
  test('A, A, B, A is warned about once, naming the interrupted group', () => {
    const schema = {
      type: 'object',
      properties: {
        a1: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
        a2: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
        b1: { type: 'string', [ENKAKU_META_KEY]: { group: 'B' } },
        a3: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
      },
    }
    const findings = checkDeclaredSchema(schema)
    const groupFindings = findings.filter((f) => f.limit === 'group')
    expect(groupFindings.length).toBe(1)
    expect(groupFindings[0]?.message).toContain('"A"')
  })

  test('A, A, B, B (consecutive runs only) warns about nothing', () => {
    const schema = {
      type: 'object',
      properties: {
        a1: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
        a2: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
        b1: { type: 'string', [ENKAKU_META_KEY]: { group: 'B' } },
        b2: { type: 'string', [ENKAKU_META_KEY]: { group: 'B' } },
      },
    }
    expect(checkDeclaredSchema(schema).filter((f) => f.limit === 'group')).toEqual([])
  })

  test('ungrouped fields between two runs of the same group do not themselves trigger the warning, but do not merge the runs either', () => {
    const schema = {
      type: 'object',
      properties: {
        a1: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
        plain: { type: 'string' },
        a2: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
      },
    }
    // "A" reappears after being interrupted by an ungrouped field — still non-consecutive.
    expect(checkDeclaredSchema(schema).some((f) => f.limit === 'group')).toBe(true)
  })

  test('a "group" finding alone does not make the schema otherwise invalid — filtering it out is the caller\'s job (§4.9)', () => {
    const schema = {
      type: 'object',
      properties: {
        a1: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
        b1: { type: 'string', [ENKAKU_META_KEY]: { group: 'B' } },
        a2: { type: 'string', [ENKAKU_META_KEY]: { group: 'A' } },
      },
    }
    const findings = checkDeclaredSchema(schema)
    expect(findings.every((f) => f.limit === 'group')).toBe(true)
  })
})

describe('checkDeclaredSchema — pattern is refused at publish, always (§3.8, R2)', () => {
  test('any pattern, catastrophic or not, is a named finding — no author-supplied regex is ever compiled, so publish does not store one to begin with', () => {
    const findings = checkDeclaredSchema(HOSTILE_PARAMS_FIXTURES['redos-pattern'])
    const patternFindings = findings.filter((f) => f.limit === 'pattern')
    expect(patternFindings.length).toBe(1)
    expect(patternFindings[0]?.message).toContain('never evaluated')
  })

  test('a harmless pattern is refused too — this is a blanket rule, not ReDoS detection', () => {
    const schema = { type: 'object', properties: { code: { type: 'string', pattern: '^[a-z]+$' } } }
    expect(checkDeclaredSchema(schema).some((f) => f.limit === 'pattern')).toBe(true)
  })
})

describe('checkDeclaredSchema — prototype-pollution field names (plan 95 §5 step 95.5)', () => {
  test('__proto__, constructor, and prototype are refused even though they are identifier-shaped', () => {
    for (const dangerous of ['__proto__', 'constructor', 'prototype']) {
      const schema = { type: 'object', properties: { [dangerous]: { type: 'string' } } }
      const findings = checkDeclaredSchema(schema).filter((f) => f.limit === 'fieldNamePattern')
      expect(findings.length).toBe(1)
      expect(findings[0]?.message).toContain(dangerous)
    }
  })

  test('the non-identifier-keys fixture is refused for all three reasons at once (digit-leading, hyphenated, AND __proto__)', () => {
    const findings = checkDeclaredSchema(HOSTILE_PARAMS_FIXTURES['non-identifier-keys'])
    const paths = findings.filter((f) => f.limit === 'fieldNamePattern').map((f) => f.path)
    expect(paths).toContain('1')
    expect(paths).toContain('a-b')
    expect(paths).toContain('__proto__')
  })

  test('the fixture itself carries __proto__ as a real OWN property, not as the prototype (guards the fixture file\'s own construction)', () => {
    const schema = HOSTILE_PARAMS_FIXTURES['non-identifier-keys'] as { properties: Record<string, unknown> }
    expect(Object.prototype.hasOwnProperty.call(schema.properties, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(schema.properties)).toBe(Object.prototype)
  })
})

describe('checkDeclaredSchema — the hostile fixture set (plan 95 §5 step 95.5\'s verifiable result)', () => {
  test('every fixture named in HOSTILE_BLOCKING is refused at publish with at least one named finding, and none of them hang', () => {
    for (const name of HOSTILE_BLOCKING) {
      const start = performance.now()
      const findings = checkDeclaredSchema(HOSTILE_PARAMS_FIXTURES[name])
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(200)
      // A lone "group" finding would not actually block a publish (it is a
      // warning) — every BLOCKING fixture must produce at least one finding
      // whose limit is something other than 'group'.
      expect(findings.some((f) => f.limit !== 'group')).toBe(true)
    }
  })

  test('a real (non-hostile) schema — the tiktok pack shape — is not touched by any of the new checks', () => {
    const schema = z.toJSONSchema(
      z.object({
        videos: z.number().int().min(1).max(2000).default(30).meta(ui({ title: 'Number of videos', kind: 'count', group: 'Core settings' })),
        chance: z.number().min(0).max(1).default(0).meta(ui({ title: 'Save chance', kind: 'chance', group: 'Interaction' })),
      }),
      { io: 'input' },
    )
    expect(checkDeclaredSchema(schema)).toEqual([])
  })
})
