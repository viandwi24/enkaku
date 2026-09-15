import { describe, expect, test } from 'bun:test'
import { stalePhoneVideos, type PhoneFileEntry } from './clean-phone-videos'

const NOW = 1_789_500_000
const HOUR = 3600
const JOB = '6b022a1e-af47-4349-bf37-99fc92e8e80e'
const entry = (name: string, ageSec: number | null, kind: PhoneFileEntry['kind'] = 'file'): PhoneFileEntry => ({
  name,
  path: `/sdcard/DCIM/Camera/${name}`,
  kind,
  sizeBytes: 1_000,
  modifiedAt: ageSec === null ? null : NOW - ageSec,
})

describe('stalePhoneVideos — only farm-pushed videos older than the cutoff (0.35.0)', () => {
  test('old post-/ig-/yt- files go; fresh ones, unknown ages, a person\'s files and directories stay', () => {
    const entries = [
      entry(`post-${JOB}-1.mp4`, 7 * HOUR),
      entry(`ig-${JOB}-1.mp4`, 7 * HOUR),
      entry(`yt-${JOB}-2.mp4`, 7 * HOUR),
      entry(`post-${JOB}-3.mp4`, HOUR),
      entry(`ig-${JOB}-4.mp4`, null),
      entry('VID_20260916_101010.mp4', 100 * HOUR),
      entry('post-holiday.mp4', 100 * HOUR),
      entry(`yt-${JOB}-5.mp4`, 100 * HOUR, 'dir'),
    ]
    expect(stalePhoneVideos(entries, NOW, 6 * HOUR).map((e) => e.name)).toEqual([`post-${JOB}-1.mp4`, `ig-${JOB}-1.mp4`, `yt-${JOB}-2.mp4`])
  })
})
