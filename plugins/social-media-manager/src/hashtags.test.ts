import { describe, expect, test } from 'bun:test'
import { HashtagRuleSchema, POST_TEXT_LIMIT, composePostText, hashtagsFor, normalizeHashtags, pickHashtagLine } from './hashtags'
import { PostSchema, applyPostEdit, newPost } from './posts'

/** Hashtags kept apart from the caption and joined only when a post is sent (0.19.0). */
describe('hashtags', () => {
  test('normalise: split on spaces, commas and newlines, one leading #, no punctuation, no duplicates in any case', () => {
    expect(normalizeHashtags(['#FYP, trading  #gold', '##gold\nxau!', 'fyp'])).toEqual(['#FYP', '#trading', '#gold', '#xau'])
    expect(normalizeHashtags('   ')).toEqual([])
    expect(normalizeHashtags(['#belajar_trading', '#saham2026'])).toEqual(['#belajar_trading', '#saham2026'])
  })

  test('a line is picked only when the rule asks for one and has lines', () => {
    const rule = HashtagRuleSchema.parse({ fixed: ['#fyp'], lines: ['#a #b', '#c'], randomLine: true })
    expect(pickHashtagLine(rule, () => 0)).toBe(0)
    expect(pickHashtagLine(rule, () => 0.99)).toBe(1)
    expect(pickHashtagLine({ ...rule, randomLine: false }, () => 0.5)).toBeNull()
    expect(pickHashtagLine({ ...rule, lines: [] }, () => 0.5)).toBeNull()
  })

  test('what a video posts with: fixed, then its line, then its own — deduplicated', () => {
    const rule = HashtagRuleSchema.parse({ fixed: ['#fyp'], lines: ['#trading #gold', '#forex'], randomLine: true })
    expect(hashtagsFor({ rule, line: 0, own: ['#gold', '#xau', 'fyp'] })).toEqual(['#fyp', '#trading', '#gold', '#xau'])
    expect(hashtagsFor({ rule, line: null, own: [] })).toEqual(['#fyp'])
  })

  test('the posted text is the caption, a blank line, the hashtags', () => {
    expect(composePostText('Ini Caption', ['#fyp', '#trading'])).toBe('Ini Caption\n\n#fyp #trading')
    expect(composePostText('', ['#fyp'])).toBe('#fyp')
    expect(composePostText('Only words', [])).toBe('Only words')
    expect(composePostText('  ', [])).toBe('')
  })

  test('over the limit, hashtags go from the END until it fits — the caption and the first (fixed) ones stay', () => {
    const caption = 'x'.repeat(POST_TEXT_LIMIT - 12)
    const text = composePostText(caption, ['#fyp', '#trading', '#gold', '#forex'])
    expect(text.length).toBeLessThanOrEqual(POST_TEXT_LIMIT)
    expect(text).toBe(`${caption}\n\n#fyp`)
  })

  test('a row written before hashtags existed parses, with no hashtags and no line', () => {
    const legacy = { ...newPost({ videoArtifactId: 'v1', caption: 'hello', platforms: ['tiktok'], now: 1 }) } as Record<string, unknown>
    delete legacy.hashtags
    delete legacy.hashtagLine
    const parsed = PostSchema.parse(legacy)
    expect(parsed.hashtags).toEqual([])
    expect(parsed.hashtagLine).toBeNull()
  })

  test('emptying the caption is allowed — with a warning when the video keeps no hashtags of its own', () => {
    const post = newPost({ videoArtifactId: 'v1', caption: 'hello', platforms: ['tiktok'], now: 1 })
    const bare = applyPostEdit({ post, edit: { caption: '' }, sessionRows: [] })
    expect(bare).toMatchObject({ ok: true, changed: ['caption'] })
    if (bare.ok) expect(bare.warnings.join(' ')).toContain('no caption and no hashtags')
    const withTags = applyPostEdit({ post, edit: { hashtags: ['fyp', '#trading'], caption: '' }, sessionRows: [] })
    expect(withTags).toMatchObject({ ok: true, changed: ['hashtags', 'caption'], warnings: [] })
    if (withTags.ok) expect(withTags.post).toMatchObject({ caption: '', hashtags: ['#fyp', '#trading'] })
  })
})
