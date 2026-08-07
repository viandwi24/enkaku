import type { JobLogEntry } from '@enkaku/session'

/**
 * What a running job has logged so far, so a page opened mid-run is not blank.
 *
 * `/ws` deliberately has no snapshot replay (`CLAUDE.md`), so a client only
 * ever receives `job.log` lines emitted AFTER it subscribed. The other half of
 * the story — the `job.log` artifact — does not exist until the job ends:
 * `job-runner.ts` accumulates lines in memory and writes the file once, in its
 * `finally`. Between those two facts, opening a running job's detail page
 * showed nothing that had already happened, and every earlier line appeared at
 * once when the job finished. That was reported as "sometimes no logs, or you
 * wait for it to finish and then they all show up", and it is exactly what
 * this closes.
 *
 * A page now fetches this and then subscribes, which is the same
 * fetch-then-subscribe shape the device list and the agent chat already use.
 *
 * Deliberately in memory and deliberately bounded. The file on disk remains
 * the complete record; this is a window onto a job that is still running, and
 * a job that has finished is served from its artifact instead. A core restart
 * loses it, which is correct: a restart also fails every running job.
 */
export interface JobLogBuffer {
  /** Record a line. Called for every `job.log` the daemon broadcasts. */
  append(entry: JobLogEntry): void
  /** Everything retained for a job, oldest first. Empty for an unknown job. */
  get(jobId: string): JobLogEntry[]
  /** Whether anything was dropped for this job — the UI says so rather than lying by omission. */
  truncated(jobId: string): boolean
  /** Release a finished job's lines; its artifact is the record from then on. */
  release(jobId: string): void
  /** Live jobs currently retained. */
  size(): number
}

export interface JobLogBufferOptions {
  /** Lines kept per job. Older ones are dropped, and `truncated` starts reporting true. */
  maxLinesPerJob?: number
  /**
   * Jobs retained at once. A farm runs one job per device, so this bounds the
   * whole structure at `maxJobs × maxLinesPerJob` lines — with the defaults,
   * a fleet of 200 devices all logging hard.
   */
  maxJobs?: number
}

interface Entry {
  lines: JobLogEntry[]
  truncated: boolean
}

export function createJobLogBuffer(opts: JobLogBufferOptions = {}): JobLogBuffer {
  const maxLines = opts.maxLinesPerJob ?? 2_000
  const maxJobs = opts.maxJobs ?? 200
  // Insertion-ordered, so evicting the oldest job is `keys().next()`.
  const byJob = new Map<string, Entry>()

  return {
    append(entry) {
      let e = byJob.get(entry.jobId)
      if (!e) {
        // A job whose `release` never came — the runner died, the process was
        // killed — must not pin memory forever. Evicting the oldest is enough:
        // this is a window on live jobs, not a store.
        if (byJob.size >= maxJobs) {
          const oldest = byJob.keys().next()
          if (!oldest.done) byJob.delete(oldest.value)
        }
        e = { lines: [], truncated: false }
        byJob.set(entry.jobId, e)
      }
      e.lines.push(entry)
      if (e.lines.length > maxLines) {
        e.lines.splice(0, e.lines.length - maxLines)
        e.truncated = true
      }
    },

    get(jobId) {
      return byJob.get(jobId)?.lines ?? []
    },

    truncated(jobId) {
      return byJob.get(jobId)?.truncated ?? false
    },

    release(jobId) {
      byJob.delete(jobId)
    },

    size() {
      return byJob.size
    },
  }
}
