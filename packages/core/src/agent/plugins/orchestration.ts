import { agentCancel, agentReply, agentSend, agentSpawn, agentStatus } from '../../capability/agent'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `agent.spawn`/`.send`/`.reply`/`.status`/`.cancel`: this plugin's section only
 * ever appears when the agent actually holds `agent.spawn` or a sibling (criterion 12) — an agent
 * with no orchestration capability should not read about a tree it cannot build. */
export const orchestrationPlugin = defineAgentPlugin({
  id: 'orchestration',
  title: 'Orchestration',
  prompt: [
    '# Orchestration',
    'agent_spawn starts a child agent run — its authority is the INTERSECTION of its own agent',
    'record and yours; spawning is never a way to gain more than you already have. Pass waitFor:',
    'true (the default) to block for the result, or false to let it run detached and report back',
    'later. agent_send delivers a message to a running descendant; agent_reply answers your own',
    'parent (there is no target — a reply only ever goes up). agent_status reads a descendant\'s',
    'progress; agent_cancel stops a descendant subtree. A parent that fails or is cancelled cascades',
    'to its still-running children automatically — you do not need to clean those up yourself.',
  ].join('\n'),
  tools: () => [agentSpawn, agentSend, agentReply, agentStatus, agentCancel],
})
