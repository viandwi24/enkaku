import { describe, expect, test } from 'bun:test'
import { createJobLogBuffer } from './log-buffer'

/**
 * The gap this closes: `/ws` has no snapshot replay and the `job.log` artifact
 * is written once in the runner's `finally`, so a detail page opened mid-run
 * could read nothing that had already happened. Reported as "sometimes no
 * logs, or you wait for it to finish and then they all appear at once".
 */
function line(jobId: string, msg: string, ts = 1) {
  return { jobId, ts, level: 'info' as const, source: 'script' as const, msg }
}

describe('createJobLogBuffer', () => {
  test('returns what a job has logged, oldest first', () => {
    const b = createJobLogBuffer()
    b.append(line('j1', 'first', 1))
    b.append(line('j1', 'second', 2))
    expect(b.get('j1').map((l) => l.msg)).toEqual(['first', 'second'])
  })

  test('an unknown job is empty, not an error — a finished job asks for this too', () => {
    const b = createJobLogBuffer()
    expect(b.get('nope')).toEqual([])
    expect(b.truncated('nope')).toBe(false)
  })

  test('jobs do not see each other', () => {
    const b = createJobLogBuffer()
    b.append(line('j1', 'mine'))
    b.append(line('j2', 'theirs'))
    expect(b.get('j1').map((l) => l.msg)).toEqual(['mine'])
    expect(b.get('j2').map((l) => l.msg)).toEqual(['theirs'])
  })

  test('past the line cap it keeps the NEWEST and admits it dropped some', () => {
    const b = createJobLogBuffer({ maxLinesPerJob: 3 })
    for (let i = 1; i <= 5; i++) b.append(line('j1', `line-${i}`, i))
    expect(b.get('j1').map((l) => l.msg)).toEqual(['line-3', 'line-4', 'line-5'])
    expect(b.truncated('j1')).toBe(true)
  })

  test('under the cap it never claims truncation', () => {
    const b = createJobLogBuffer({ maxLinesPerJob: 10 })
    b.append(line('j1', 'only'))
    expect(b.truncated('j1')).toBe(false)
  })

  test('release frees a job — the artifact is the record from then on', () => {
    const b = createJobLogBuffer()
    b.append(line('j1', 'x'))
    expect(b.size()).toBe(1)
    b.release('j1')
    expect(b.get('j1')).toEqual([])
    expect(b.size()).toBe(0)
  })

  test('a job whose release never came does not pin memory forever', () => {
    // The runner died, the process was killed — `onJobFinished` never fired.
    // The oldest job is evicted rather than growing without bound.
    const b = createJobLogBuffer({ maxJobs: 2 })
    b.append(line('old', 'a'))
    b.append(line('mid', 'b'))
    b.append(line('new', 'c'))
    expect(b.size()).toBe(2)
    expect(b.get('old')).toEqual([])
    expect(b.get('new').map((l) => l.msg)).toEqual(['c'])
  })
})
