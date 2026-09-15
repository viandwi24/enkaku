import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { channelDraftsCell, draftActionMenus, draftDeleteConfirm, draftMenuDelete, draftsPageEmpty, draftsPageShowing } from './drafts'

async function fixture(name: string): Promise<UiNode> {
  return (await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).json()) as UiNode
}

describe('drafts — the channel\'s "Draf" cell, the Drafts page, its menu and "Hapus draf ini?" (0.39.0, moto g06 2026-09-16)', () => {
  test('the channel shows a "Draf" cell only while it has drafts', async () => {
    expect(channelDraftsCell(await fixture('screen-channel-with-draft.json'))?.bounds).toEqual({ left: 0, top: 423, right: 239, bottom: 821 })
    expect(channelDraftsCell(await fixture('screen-channel-no-drafts.json'))).toBeNull()
  })

  test('the Drafts page: one draft, one "Action menu"; the channel page is not it', async () => {
    const page = await fixture('screen-drafts-list.json')
    expect(draftsPageShowing(page)).toBe(true)
    expect(draftsPageEmpty(page)).toBe(false)
    expect(draftActionMenus(page).map((n) => n.bounds)).toEqual([{ left: 314, top: 264, right: 346, bottom: 296 }])
    const channel = await fixture('screen-channel-with-draft.json')
    expect(draftsPageShowing(channel)).toBe(false)
    expect(draftActionMenus(channel)).toHaveLength(0)
  })

  test('the row menu\'s "Hapus", then the dialog\'s "Hapus" — never "Batal"', async () => {
    expect(draftMenuDelete(await fixture('screen-drafts-row-menu.json'))?.bounds).toEqual({ left: 405, top: 431, right: 492, bottom: 469 })
    const confirm = await fixture('screen-drafts-delete-confirm.json')
    expect(draftDeleteConfirm(confirm)?.text).toBe('Hapus')
    expect(draftDeleteConfirm(confirm)?.bounds).toEqual({ left: 361, top: 823, right: 622, bottom: 893 })
    expect(draftDeleteConfirm(await fixture('screen-drafts-list.json'))).toBeNull()
  })

  test('the emptied Drafts page says so and has no draft menus', async () => {
    const empty = await fixture('screen-drafts-empty.json')
    expect(draftsPageShowing(empty)).toBe(true)
    expect(draftsPageEmpty(empty)).toBe(true)
    expect(draftActionMenus(empty)).toHaveLength(0)
  })
})
