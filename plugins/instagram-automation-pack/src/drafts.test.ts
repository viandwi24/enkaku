import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { draftMenuDelete, draftRows, draftsListShowing, draftsManageButton, draftsTabButton, reelDraftDeleteConfirm, reelDraftMenuDelete, reelDraftRows, reelDraftsEntry, reelDraftsListShowing } from './drafts'

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('drafts — the new-post gallery, the drafts list and a row menu (0.10.0, moto g06 2026-09-16)', () => {
  test('the "Draf" tab and "Kelola (6)" are read only while the account has drafts', async () => {
    const withDrafts = await fixture('screen-new-post-drafts-tab.json')
    expect(draftsTabButton(withDrafts)?.bounds).toEqual({ left: 210, top: 888, right: 331, bottom: 979 })
    expect(draftsManageButton(withDrafts)?.count).toBe(6)
    const none = await fixture('screen-new-post-no-drafts.json')
    expect(draftsTabButton(none)).toBeNull()
    expect(draftsManageButton(none)).toBeNull()
  })

  test('the drafts list: six rows, each with its own "Lainnya" in its band', async () => {
    const list = await fixture('screen-drafts-manage.json')
    expect(draftsListShowing(list)).toBe(true)
    const rows = draftRows(list)
    expect(rows).toHaveLength(6)
    expect(rows[0]?.row.desc.startsWith('Draf 0915-1')).toBe(true)
    expect(rows.every((r) => r.more !== null)).toBe(true)
    expect(rows[0]?.more?.bounds).toEqual({ left: 629, top: 203, right: 713, bottom: 287 })
    expect(draftMenuDelete(list)).toBeNull()
  })

  test('the emptied list still reads as the list, with no rows', async () => {
    const empty = await fixture('screen-drafts-manage-empty.json')
    expect(draftsListShowing(empty)).toBe(true)
    expect(draftRows(empty)).toHaveLength(0)
  })

  test('the row menu offers "Hapus", and nothing else is taken for it', async () => {
    const menu = await fixture('screen-drafts-row-menu.json')
    expect(draftMenuDelete(menu)?.bounds).toEqual({ left: 426, top: 456, right: 508, bottom: 490 })
  })

  test('neither gallery reads as the drafts list', async () => {
    expect(draftsListShowing(await fixture('screen-new-post-drafts-tab.json'))).toBe(false)
    expect(draftsListShowing(await fixture('screen-reel-gallery.json'))).toBe(false)
    expect(draftsListShowing(await fixture('screen-home.json'))).toBe(false)
  })
})

describe('reel drafts — "Draf · 2", "Draf Reel", its row menu and "Hapus draf?" (0.10.0, moto g06 2026-09-16)', () => {
  test('the Reel gallery names its drafts entry with a count', async () => {
    const gallery = await fixture('screen-reel-gallery-drafts-entry.json')
    expect(reelDraftsEntry(gallery)?.count).toBe(2)
    expect(reelDraftsEntry(gallery)?.node.bounds).toEqual({ left: 25, top: 175, right: 222, bottom: 259 })
    expect(reelDraftsEntry(await fixture('screen-home.json'))).toBeNull()
  })

  test('"Draf Reel": two rows, each with its own "Opsi lainnya"', async () => {
    const list = await fixture('screen-reel-drafts-list.json')
    expect(reelDraftsListShowing(list)).toBe(true)
    const rows = reelDraftRows(list)
    expect(rows.map((r) => r.row.desc)).toEqual(['Video draf 0916-1', 'Video draf 0916'])
    expect(rows[0]?.more?.bounds).toEqual({ left: 636, top: 214, right: 706, bottom: 284 })
    expect(reelDraftMenuDelete(list)).toBeNull()
    expect(reelDraftDeleteConfirm(list)).toBeNull()
  })

  test('the row menu\'s "Hapus", then the sheet\'s "Hapus" — never its "Batal"', async () => {
    expect(reelDraftMenuDelete(await fixture('screen-reel-drafts-row-menu.json'))?.bounds).toEqual({ left: 354, top: 683, right: 706, bottom: 781 })
    const confirm = await fixture('screen-reel-drafts-delete-confirm.json')
    expect(reelDraftDeleteConfirm(confirm)?.text).toBe('Hapus')
    expect(reelDraftDeleteConfirm(confirm)?.bounds).toEqual({ left: 0, top: 1363, right: 720, bottom: 1447 })
  })

  test('the emptied "Draf Reel" is still the list, with no rows', async () => {
    const empty = await fixture('screen-reel-drafts-empty.json')
    expect(reelDraftsListShowing(empty)).toBe(true)
    expect(reelDraftRows(empty)).toHaveLength(0)
  })
})
