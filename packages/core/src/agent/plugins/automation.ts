import { jobCancel, jobGet, jobList, jobRun } from '../../capability/job'
import { jobTrace, jobTraceFrame, jobTraceUi } from '../../capability/job-trace'
import { scriptGet, scriptList, scriptPublish } from '../../capability/script'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `script.*`/`job.*`: publishing and running scripted work, as opposed to driving
 * a device interactively yourself. Plan 130 §0.2, step 130.1 adds `job.trace`/`.trace.ui`/
 * `.trace.frame`: without them the agent could start a job and read its final status, but could
 * not see a single action, frame or UI tree of what actually happened — backwards for the surface
 * where the trace is the part that explains a failure. */
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
    '',
    'When a job fails, or you need to know what it actually did rather than just whether it',
    'succeeded, reach for its trace before re-running anything: job_trace lists every action, log',
    'line, phase boundary and artifact on that job\'s timeline, oldest first, optionally filtered by',
    'kind. A trace event may carry a frameHash and/or a uiHash — read the UI tree with job_trace_ui',
    '(structured JSON, prefer this first: it is text, and it is exactly what explains "what element',
    'was on screen") and a screenshot with job_trace_frame (one PNG, decoded from base64). Never ask',
    'for more than one frame or tree per call — a trace can hold on the order of a hundred frames,',
    'and pulling them all would flood your own context for no benefit.',
  ].join('\n'),
  tools: () => [scriptList, scriptGet, scriptPublish, jobRun, jobGet, jobList, jobCancel, jobTrace, jobTraceUi, jobTraceFrame],
})
