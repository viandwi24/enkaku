import { jobCancel, jobGet, jobList, jobRun } from '../../capability/job'
import { scriptGet, scriptList, scriptPublish } from '../../capability/script'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `script.*`/`job.*`: publishing and running scripted work, as opposed to driving
 * a device interactively yourself. */
export const automationPlugin = defineAgentPlugin({
  id: 'automation',
  title: 'Scripts and jobs',
  prompt: [
    '# Scripts and jobs',
    'script_list and script_get read the published script catalogue; script_publish ships one from',
    'a workspace path (or an inline bundle) — it is a write, and never executes anything itself.',
    'job_run starts a script against a device or cluster; job_get and job_list read job state and',
    'results; job_cancel stops a running one. Prefer publishing and running a script for anything',
    'repeatable over driving the device by hand turn after turn.',
  ].join('\n'),
  tools: () => [scriptList, scriptGet, scriptPublish, jobRun, jobGet, jobList, jobCancel],
})
