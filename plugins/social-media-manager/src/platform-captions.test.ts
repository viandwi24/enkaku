import { describe, expect, test } from 'bun:test'
import { HashtagRuleSchema, NO_HASHTAG_RULE } from './hashtags'
import {
  INSTAGRAM_CAPTION_MAX,
  INSTAGRAM_HASHTAG_MAX,
  PLATFORM_CAPTION_LIMITS,
  TIKTOK_CAPTION_MAX,
  TIKTOK_HASHTAG_MAX,
  YOUTUBE_TITLE_MAX,
  asciiText,
  checkPlatformCaption,
  fitPlatformCaption,
  fitPlatformCaptions,
  fitYouTubeTitle,
  hashtagsIn,
  platformPostText,
  platformPostTexts,
  withPlatformCaptions,
} from './platform-captions'
import { PENDING_STATE, PostSchema, applyPostEdit, newPost, postKeyFor, type Post } from './posts'
import retryFailed from './retry-failed'

const NOW = 1_770_000_000
const printable = /^[\x20-\x7e\n]*$/

function post(overrides: Partial<Post> = {}): Post {
  return { ...newPost({ videoArtifactId: 'vid-1', caption: 'Shared words', platforms: ['tiktok', 'youtube', 'instagram'], now: NOW }), ...overrides }
}

/** A caption per platform (0.27.0). */
describe('the limits, as the packs measured them', () => {
  test('each platform carries the number its pack enforces', () => {
    expect(TIKTOK_CAPTION_MAX).toBe(2_200)
    expect(TIKTOK_HASHTAG_MAX).toBe(5)
    expect(YOUTUBE_TITLE_MAX).toBe(100)
    expect(INSTAGRAM_CAPTION_MAX).toBe(2_200)
    expect(INSTAGRAM_HASHTAG_MAX).toBe(5)
    // adb carries printable ASCII only; TikTok types through the farm's IME.
    expect(PLATFORM_CAPTION_LIMITS.youtube.asciiOnly).toBe(true)
    expect(PLATFORM_CAPTION_LIMITS.instagram.asciiOnly).toBe(true)
    expect(PLATFORM_CAPTION_LIMITS.tiktok.asciiOnly).toBe(false)
  })
})

describe('fitting a text to one platform', () => {
  test('asciiText keeps the letter an accent sat on, drops emoji, keeps lines unless asked for one', () => {
    expect(asciiText('Café 🔥  mantap')).toBe('Cafe mantap')
    expect(asciiText('baris satu 😍\n\n\n\nbaris dua')).toBe('baris satu\n\nbaris dua')
    expect(asciiText('satu\ndua', true)).toBe('satu dua')
  })

  test('YouTube: one ASCII line of at most 100 characters, at most 3 hashtags, words cut at a boundary', () => {
    const text = 'Belajar trading emas untuk pemula 🔥 cara membaca candle dan menentukan entry yang tepat setiap hari tanpa panik'
    const title = fitPlatformCaption('youtube', { text, hashtags: ['#trading', '#emas', '#forex', '#xau', '#fyp'] })
    expect(title.length).toBeLessThanOrEqual(YOUTUBE_TITLE_MAX)
    expect(title).toMatch(printable)
    expect(title).not.toContain('\n')
    expect(hashtagsIn(title)).toEqual(['#trading', '#emas', '#forex'])
    expect(title.startsWith('Belajar trading emas untuk pemula cara')).toBe(true)
    // Cut at a word, never inside one.
    const words = text.replace('🔥 ', '').split(' ')
    const body = title.replace(/ #\S+/g, '').replace(/\.\.\.$/, '')
    expect(body.split(' ').every((w) => words.includes(w))).toBe(true)
  })

  test('YouTube: hashtags never take the first 40 characters of text, the rule the pack fits by', () => {
    const long = 'x'.repeat(90)
    expect(fitYouTubeTitle(long, ['#aaaaaaaaaa', '#bbbbbbbbbb', '#cccccccccc', '#dddddddddd', '#eeeeeeeeee', '#ffffffffff'])).toBe(
      `${'x'.repeat(100 - 60 - 3)}... #aaaaaaaaaa #bbbbbbbbbb #cccccccccc #dddddddddd #eeeeeeeeee`,
    )
    expect(fitYouTubeTitle('short words', ['#a', '#b'])).toBe('short words #a #b')
  })

  test('TikTok: emoji kept, at most 5 hashtags counting the ones already inside the text', () => {
    expect(fitPlatformCaption('tiktok', { text: 'Mantap 🔥 #fyp', hashtags: ['#fyp', '#a', '#b', '#c', '#d', '#e'] })).toBe('Mantap 🔥 #fyp\n\n#a #b #c #d')
  })

  test('Instagram: ASCII lines, at most 5 hashtags, the first (fixed) ones kept', () => {
    const fitted = fitPlatformCaption('instagram', { text: 'Keren banget 😍\nbaris dua', hashtags: ['#fyp', '#a', '#b', '#c', '#d', '#e', '#f'] })
    expect(fitted).toBe('Keren banget\nbaris dua\n\n#fyp #a #b #c #d')
  })

  test('over the length, hashtags go first and then the text is cut — never past the limit', () => {
    const body = 'kata '.repeat(440).trim()
    const tiktok = fitPlatformCaption('tiktok', { text: body, hashtags: ['#fyp'] })
    expect(tiktok.length).toBeLessThanOrEqual(TIKTOK_CAPTION_MAX)
    expect(tiktok).not.toContain('#fyp')
    const huge = fitPlatformCaption('instagram', { text: 'kata '.repeat(600), hashtags: [] })
    expect(huge.length).toBeLessThanOrEqual(INSTAGRAM_CAPTION_MAX)
    expect(huge.endsWith('kata...')).toBe(true)
  })

  test('a cut caption ends in "..." and the session\'s required hashtags are never the ones dropped (0.31.0)', () => {
    const long = 'Kenapa zona support sering jadi liquidity pool dan kenapa harga selalu balik lagi ke area yang sama setiap minggu'
    const title = fitPlatformCaption('youtube', { text: long, hashtags: ['#AkademiBitorex', '#fyp', '#liquidity', '#trading'], required: ['#AkademiBitorex'] })
    expect(title.length).toBeLessThanOrEqual(YOUTUBE_TITLE_MAX)
    expect(title).toContain('#AkademiBitorex')
    expect(title).toContain('...')
    // Required hashtags stay even when they alone leave little room for words.
    const requiredTags = ['#AkademiBitorex', '#BitorexIndonesia', '#TradingIndonesia', '#BelajarTrading']
    const many = fitPlatformCaption('youtube', { text: long, hashtags: [], required: requiredTags })
    expect(many.length).toBeLessThanOrEqual(YOUTUBE_TITLE_MAX)
    for (const tag of requiredTags) expect(many).toContain(tag)
    // TikTok: a caption past the limit with hashtags of its own keeps the required one and stays within 5 hashtags and 2200 characters.
    const tiktok = fitPlatformCaption('tiktok', { text: `${'kata '.repeat(500).trim()} #a #b #c #d #e`, hashtags: ['#x'], required: ['#Wajib'] })
    expect(tiktok.length).toBeLessThanOrEqual(TIKTOK_CAPTION_MAX)
    expect(tiktok).toContain('#Wajib')
    expect(tiktok).toContain('...')
    expect(hashtagsIn(tiktok).length).toBeLessThanOrEqual(TIKTOK_HASHTAG_MAX)
    // A session's post text carries the rule's fixed hashtag as required.
    const row = post({ caption: long, hashtags: ['#one', '#two', '#three'], hashtagLine: null })
    const sent = platformPostText(row, 'youtube', HashtagRuleSchema.parse({ fixed: ['#AkademiBitorex', '#BitorexIndonesia'], lines: [], randomLine: false }))
    expect(sent.length).toBeLessThanOrEqual(YOUTUBE_TITLE_MAX)
    expect(sent).toContain('#AkademiBitorex')
    expect(sent).toContain('#BitorexIndonesia')
  })

  test('all at once: only the requested platforms, the shared caption where the writer gave nothing, nothing for an empty result', () => {
    const out = fitPlatformCaptions({ platforms: ['youtube', 'tiktok'], caption: 'Shared caption', texts: { youtube: 'Short title' }, hashtags: ['#fyp'] })
    expect(out).toEqual({ youtube: 'Short title #fyp', tiktok: 'Shared caption\n\n#fyp' })
    // A caption adb cannot type at all, with no hashtags, leaves Instagram on the shared text.
    expect(fitPlatformCaptions({ platforms: ['instagram'], caption: '日本語のキャプション', hashtags: [] })).toEqual({})
  })
})

describe('checking a hand-written platform caption', () => {
  test('only a text over the platform length is refused; what the pack drops is a warning', () => {
    expect(checkPlatformCaption('youtube', 'x'.repeat(101)).error).toContain('at most 100')
    expect(checkPlatformCaption('youtube', 'x'.repeat(100))).toEqual({ error: null, warnings: [] })
    expect(checkPlatformCaption('instagram', 'mantap 🔥').warnings.join(' ')).toContain('emoji')
    expect(checkPlatformCaption('tiktok', 'mantap 🔥')).toEqual({ error: null, warnings: [] })
    expect(checkPlatformCaption('tiktok', 'a #1 #2 #3 #4 #5 #6').warnings.join(' ')).toContain('first 5 hashtags')
  })
})

describe('the stored row', () => {
  test('a row written before per-platform captions parses, with none', () => {
    const legacy = { ...post() } as Record<string, unknown>
    delete legacy.platformCaptions
    expect(PostSchema.parse(legacy).platformCaptions).toEqual({})
  })

  test('a fresh row round-trips; a platform this build does not know is refused, not dropped', () => {
    const fresh = post({ platformCaptions: { youtube: 'Title #fyp' } })
    expect(PostSchema.parse(fresh)).toEqual(fresh)
    expect(PostSchema.safeParse({ ...fresh, platformCaptions: { threads: 'hi' } }).success).toBe(false)
    expect(PostSchema.safeParse({ ...fresh, platformCaptions: { tiktok: '' } }).success).toBe(false)
  })

  test('an edit sets and replaces a platform caption, fits an emptied one again, and refuses a YouTube title over 100', () => {
    const set = applyPostEdit({ post: post(), edit: { platformCaptions: { youtube: '  Title #fyp ', instagram: 'Caption 🔥' } }, sessionRows: [] })
    expect(set).toMatchObject({ ok: true, changed: ['instagram caption', 'youtube caption'] })
    if (!set.ok) throw new Error('refused')
    // TikTok had none, so it is given the shared text fitted to it (0.28.0).
    expect(set.post.platformCaptions).toEqual({ youtube: 'Title #fyp', instagram: 'Caption 🔥', tiktok: 'Shared words' })
    expect(set.warnings.join(' ')).toContain('emoji')
    expect(PostSchema.parse(set.post)).toEqual(set.post)

    const cleared = applyPostEdit({ post: set.post, edit: { platformCaptions: { youtube: '', tiktok: '' } }, sessionRows: [] })
    expect(cleared).toMatchObject({ ok: true, changed: ['youtube caption'] })
    if (cleared.ok) expect(cleared.post.platformCaptions).toEqual({ instagram: 'Caption 🔥', youtube: 'Shared words', tiktok: 'Shared words' })

    const same = applyPostEdit({ post: set.post, edit: { platformCaptions: { youtube: 'Title #fyp' } }, sessionRows: [] })
    expect(same).toMatchObject({ ok: true, changed: [] })

    expect(applyPostEdit({ post: post(), edit: { platformCaptions: { youtube: 'x'.repeat(101) } }, sessionRows: [] })).toMatchObject({ ok: false, code: 'E_PARAMS_INVALID' })
  })
})

describe('what each platform is sent', () => {
  const rule = HashtagRuleSchema.parse({ fixed: ['#fyp'], lines: ['#trading #gold'], randomLine: true })

  test('a platform with its own caption gets exactly that; the others get the shared text', () => {
    const row = post({ hashtags: ['#xau'], hashtagLine: 0, platformCaptions: { youtube: 'Gold in 30 seconds #gold' } })
    expect(platformPostText(row, 'youtube', rule)).toBe('Gold in 30 seconds #gold')
    expect(platformPostText(row, 'tiktok', rule)).toBe('Shared words\n\n#fyp #trading #gold #xau')
    // A stored platform this build has no caption field for still gets the shared text.
    expect(platformPostText(row, 'threads', rule)).toBe('Shared words\n\n#fyp #trading #gold #xau')
  })

  test('a row with nothing shared still posts where it has its own caption, and is held only where it has none', () => {
    const row = post({ caption: '', platformCaptions: { youtube: 'Title only' } })
    const { texts, bare } = platformPostTexts(row, NO_HASHTAG_RULE)
    expect(bare).toEqual(['tiktok', 'instagram'])
    expect(texts.get('youtube')).toBe('Title only')
    expect(platformPostTexts(post(), NO_HASHTAG_RULE).bare).toEqual([])
  })

  test('Retry failed sends each platform its own text, and the shared text where it has none', async () => {
    const failed = (jobId: string) => ({
      ...PENDING_STATE,
      state: 'failed' as const,
      at: NOW,
      deviceCount: 1,
      attempts: [{ jobId, deviceId: 'd1', deviceName: 'phone', state: 'failed' as const, error: 'boom', at: NOW, settledAt: NOW, round: 1 }],
    })
    const row = post({
      platforms: ['tiktok', 'youtube'],
      hashtags: ['#fyp'],
      platformCaptions: { youtube: 'Short title #fyp' },
      dispatch: { tiktok: failed('j-tiktok'), youtube: failed('j-youtube') },
    })
    const rows = new Map<string, unknown>([[postKeyFor(row.videoArtifactId), PostSchema.parse(row)]])
    const sent: Array<{ scriptRef: string; params: { caption: string } }> = []
    const ctx = {
      params: { videoArtifactId: row.videoArtifactId },
      log: { info: () => {}, warn: () => {} },
      storage: {
        global: {
          get: async (key: string, schema: { parse: (v: unknown) => unknown }) => (rows.has(key) ? schema.parse(rows.get(key)) : null),
          set: async (key: string, value: unknown) => {
            rows.set(key, value)
          },
        },
      },
      farm: {
        call: async (_name: string, input: { scriptRef: string; params: { caption: string } }, schema: { parse: (v: unknown) => unknown }) => {
          sent.push(input)
          return schema.parse({ jobId: `job-${sent.length}` })
        },
      },
    }
    const result = await retryFailed.run(ctx as unknown as Parameters<typeof retryFailed.run>[0])
    expect(result).toMatchObject({ requeued: 2, platforms: ['tiktok', 'youtube'] })
    expect(sent.map((s) => [s.scriptRef, s.params.caption])).toEqual([
      ['tiktok/post-video@latest', 'Shared words\n\n#fyp'],
      ['youtube/post-video@latest', 'Short title #fyp'],
    ])
  })

  /** 0.28.0 — the owner (2026-09-15): every platform has its own caption, and this plugin knows each platform's limits. */
  test('a platform with no caption of its own is sent the shared text fitted to it — never more hashtags than it takes', () => {
    const row = post({ caption: 'Market aneh 😅 #a #b #c #d #e #f #g' })
    expect(platformPostText(row, 'tiktok', NO_HASHTAG_RULE)).toBe('Market aneh 😅 #a #b #c #d #e')
    expect(platformPostText(row, 'instagram', NO_HASHTAG_RULE)).toBe('Market aneh #a #b #c #d #e')
    expect(platformPostText(row, 'youtube', NO_HASHTAG_RULE)).toBe('Market aneh #a #b #c')
    const tagged = post({ hashtags: ['#xau', '#one', '#two', '#three'], hashtagLine: 0 })
    expect(platformPostText(tagged, 'tiktok', rule)).toBe('Shared words\n\n#fyp #trading #gold #xau #one')
  })

  test('a caption written for TikTok keeps its words but is sent at most 5 hashtags', () => {
    const row = post({ platformCaptions: { tiktok: 'Buat TikTok 🔥 #a #b #c #d #e #f #g' } })
    expect(platformPostText(row, 'tiktok', NO_HASHTAG_RULE)).toBe('Buat TikTok 🔥 #a #b #c #d #e')
  })

  test('an edited caption carries along every platform caption that was only fitted, and names the one written for its platform', () => {
    const start = post({ caption: 'Old words', platformCaptions: { tiktok: 'Old words', instagram: 'Old words', youtube: 'My own title' } })
    const out = applyPostEdit({ post: start, edit: { caption: 'New words' }, sessionRows: [], rule: NO_HASHTAG_RULE })
    if (!out.ok) throw new Error('refused')
    expect(out.post.platformCaptions).toEqual({ tiktok: 'New words', instagram: 'New words', youtube: 'My own title' })
    expect(out.warnings.join(' ')).toContain('YouTube keeps the caption written for it')
  })

  test('every chosen platform gets a caption of its own, fitted from the shared text; one it has is kept', () => {
    expect(withPlatformCaptions({ platforms: ['tiktok', 'youtube'], caption: 'Mantap 😍', hashtags: ['#fyp'], captions: { youtube: 'Title' } })).toEqual({
      tiktok: 'Mantap 😍\n\n#fyp',
      youtube: 'Title',
    })
  })
})
