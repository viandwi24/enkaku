import { describe, expect, test } from 'bun:test'
import { PUSHED_VIDEO_MAX_AGE_SEC, stalePushedVideos, type PushedVideoEntry } from './pushed-videos'

const NOW = 1_789_500_000
const JOB = '6b022a1e-af47-4349-bf37-99fc92e8e80e'
const entry = (name: string, ageSec: number | null, kind: PushedVideoEntry['kind'] = 'file'): PushedVideoEntry => ({
  name,
  path: `/sdcard/DCIM/Camera/${name}`,
  kind,
  modifiedAt: ageSec === null ? null : NOW - ageSec,
})

describe("stalePushedVideos — only this pack's own old pushed videos", () => {
  test("an old pushed video goes; a fresh one, an unknown age, a person's photo and video, another pack's file and a directory stay", () => {
    const old = PUSHED_VIDEO_MAX_AGE_SEC * 10
    const entries = [
      entry(`yt-${JOB}-1.mp4`, PUSHED_VIDEO_MAX_AGE_SEC + 60),
      entry(`yt-${JOB}-2.mp4`, 60),
      entry(`yt-${JOB}-3.mp4`, null),
      entry('IMG_20260916_101010.jpg', old),
      entry('VID_20260916_101010.mp4', old),
      entry(`post-${JOB}-1.mp4`, old),
      entry(`yt-${JOB}-4.mp4`, old, 'dir'),
    ]
    expect(stalePushedVideos(entries, NOW).map((e) => e.name)).toEqual([`yt-${JOB}-1.mp4`])
  })
})
