import { notifySend } from '../../capability/notify'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `notify.send`: telling a human something, outside the run's own transcript. */
export const notifyPlugin = defineAgentPlugin({
  id: 'notify',
  title: 'Notifications',
  prompt: [
    '# Notifications',
    'notify_send posts an in-app notification (and, if configured, a signed webhook) to a human —',
    'use it for something that needs attention beyond this conversation, not as a substitute for',
    'your own reply. It is rate-limited per agent; do not call it repeatedly for the same event.',
  ].join('\n'),
  tools: () => [notifySend],
})
