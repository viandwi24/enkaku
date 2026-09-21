import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import youFixture from './__fixtures__/screen-you-sm-a075f-id.json'
import homeFixture from './__fixtures__/screen-home-sm-a075f-id.json'
import resultsFixture from './__fixtures__/screen-results-sm-a075f-id.json'
import motoYou from './__fixtures__/screen-you.json'
import { accountNameOf, onYouPage, youTabOf } from './check-profile'
import { BELL, homeTabOf, notificationsBellOf } from './check-notifications'
import { looksPlayable } from './watch-video'
import { resultRowsOf } from './search-channel'
import { judgeChannel, untitledYet } from './post-video'
import { flatten, tapTargetOf } from './tree'

/*
  The owner's production fleet, 2026-09-21: twenty SM-A075F phones, YouTube in `id-ID`. A warm-up
  over them failed 45 of 80 YouTube activities while TikTok and Instagram failed 13 and 11, and the
  recap's `my-videos` failed on every phone it was tried on.

  Each fixture is REDUCED from a real production artifact (ids in each file's `_provenance`): every
  node a reader here consults is copied verbatim, and only siblings no reader looks at were left out.
  Where a decoy matters — the status bar's per-app notification icons — it is kept on purpose.
*/
const you = youFixture as unknown as UiNode
const home = homeFixture as unknown as UiNode
const results = resultsFixture as unknown as UiNode

describe('the You page on the production fleet', () => {
  test('is recognised, although it has no control described "Akun"', () => {
    // It draws a chip row — "Ganti akun", "Akun Google", "Aktifkan Mode Samaran" — instead.
    expect(onYouPage(you)).toBe(true)
  })

  test('the moto layout it was first measured on is still recognised', () => {
    expect(onYouPage(motoYou as unknown as UiNode)).toBe(true)
  })

  test('the account name is read from INSIDE the header card, which carries no label of its own', () => {
    // Reading only the card's own label found nothing, so `my-videos` called a phone that had just
    // posted a Short "signed out of YouTube", and `check-profile` returned `signedIn: false`.
    expect(accountNameOf(you)).toBe('Bitorex Vault')
    // The handle beside it is not the name, and neither is "Lihat channel".
    expect(accountNameOf(you)).not.toBe('@BitorexVault')
  })

  test('the moto layout, whose clickable node carries the name itself, still reads the same', () => {
    expect(accountNameOf(motoYou as unknown as UiNode)).toBe('Channel Name')
  })

  test('its tab is found on the bottom navigation as "Anda"', () => {
    expect(youTabOf(you)?.desc).toBe('Anda')
  })

  test('"Lihat channel" is not clickable here, and the card around it is what opens the channel', () => {
    const label = flatten(you).find((n) => n.desc === 'Lihat channel')
    expect(label?.clickable).toBe(false)
    const target = tapTargetOf(you, label as UiNode)
    expect(target?.clickable).toBe(true)
    expect(target?.bounds).toEqual({ left: 23, top: 154, right: 697, bottom: 335 })
  })

  test('a label that is itself clickable is its own tap target', () => {
    const chip = flatten(you).find((n) => n.desc === 'Ganti akun' && n.clickable) as UiNode
    expect(tapTargetOf(you, chip)).toBe(chip)
  })
})

describe('the notifications bell on the production fleet', () => {
  test('is found with its unread count in the label', () => {
    // Home's toolbar describes it "Notifikasi, 9".
    expect(notificationsBellOf(home)?.desc).toBe('Notifikasi, 9')
  })

  test('is found without one too', () => {
    // The You page's toolbar describes the same bell as plain "Notifikasi".
    expect(notificationsBellOf(you)?.desc).toBe('Notifikasi')
  })

  test('the status bar\'s per-app notification icons are never taken for it', () => {
    // "Notifikasi Enkaku Guest Agent: " starts with the same word. A prefix match would need the
    // package check alone to keep it out; the pattern itself refuses it.
    expect(BELL.test('Notifikasi Enkaku Guest Agent:')).toBe(false)
    expect(BELL.test('Notifikasi Cuaca:')).toBe(false)
    expect(BELL.test('Notifikasi, 9+')).toBe(true)
  })

  test('Home is reachable by name when the run starts somewhere else', () => {
    expect(homeTabOf(home)?.desc).toBe('Beranda')
  })
})

describe('search results on the production fleet', () => {
  const rows = flatten(results)
  const video = rows.find((n) => / - Buka channel /.test(n.desc)) as UiNode
  const advert = rows.find((n) => /^Bersponsor - /.test(n.desc)) as UiNode

  test('a real video row, written in Indonesian, looks playable', () => {
    // "9.49" with a dot, "6,4 ribu x ditonton", "13 jam yang lalu" — none of it English.
    expect(looksPlayable(video)).toBe(true)
  })

  test('the advert above it does not', () => {
    expect(looksPlayable(advert)).toBe(false)
  })

  test('filtering the page\'s rows leaves the video and drops the advert', () => {
    const playable = resultRowsOf(results).filter(looksPlayable)
    expect(playable.some((n) => n.desc.includes('Buka channel'))).toBe(true)
    expect(playable.some((n) => /bersponsor/i.test(n.desc))).toBe(false)
  })
})

describe('confirming a post on the production fleet', () => {
  /*
    Channel cells read by `readChannelCells` on phone #21's own channel before and after a real post
    (production artifacts yt-02-channel-before and yt-11-channel-after-13, 2026-09-21), copied as
    they came out. The title was typed in full — the details screen shows it — and the fresh cell
    still carried no title at all thirteen looks later.
  */
  const title = 'Live Trade Sesi Sore: Persiapan Jelang News CPI #livetrade #sesisore #newsCPI'
  const before = [
    'Cara Pakai Fair Value Gap Gold di Time Frame 5 Menit #AkademiBitorex #fairvaluegap #xauusd, 142 x ditonton - putar video Shorts · Tindakan lainnya',
    'Akun Hancur Bukan karena Loss, tapi karena Nggak Terima #AkademiBitorex #trading #psikologitrading, 284 x ditonton - putar video Shorts · Tindakan lainnya',
    'Cara Baca Candle Engulfing: Anatomi dan Lokasi #AkademiBitorex #engulfing #priceaction, 541 x ditonton - putar video Shorts · Tindakan lainnya',
  ]
  const after = ['Tindakan lainnya · Belum ditonton', before[0] as string, before[1] as string]

  test('a fresh cell with no title on it is still processing, not a wrong title', () => {
    // It used to be `untitled-new`, reported as "the title may not have been typed in full".
    expect(judgeChannel(before, after, title)).toEqual({ kind: 'processing', words: 'Tindakan lainnya · Belum ditonton', titled: false })
  })

  test('the moment YouTube draws the title, the post is confirmed', () => {
    const titled = [`${title}, Belum ditonton - putar video Shorts · Tindakan lainnya`, before[0] as string, before[1] as string]
    expect(judgeChannel(before, titled, title)).toEqual({ kind: 'new' })
  })

  test('a fresh cell carrying a DIFFERENT title is still reported as such', () => {
    // The typing check this used to stand in for is not weakened: a wrong title is still `untitled-new`.
    const other = ['Something else entirely, Belum ditonton - putar video Shorts · Tindakan lainnya', before[0] as string, before[1] as string]
    expect(judgeChannel(before, other, title)).toEqual({ kind: 'untitled-new' })
  })

  test('only view-state words and buttons count as "no title"', () => {
    expect(untitledYet('Tindakan lainnya · Belum ditonton')).toBe(true)
    expect(untitledYet('More actions · No views')).toBe(true)
    expect(untitledYet('Belum ditonton · Live Trade Sesi Sore')).toBe(false)
  })
})
