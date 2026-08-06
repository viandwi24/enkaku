import { deviceAppForceStop, deviceAppLaunch, deviceInstall } from '../../capability/device-app'
import { defineAgentPlugin } from './types'

/** Plan 77 §3.6 — `device.app.launch`/`.forceStop`/`device.install`: managing what is running on
 * the phone, not what is on screen within it. */
export const deviceAppsPlugin = defineAgentPlugin({
  id: 'device-apps',
  title: 'App lifecycle',
  prompt: [
    '# App lifecycle',
    'device_app_launch starts an app by package name; device_app_forceStop kills one that is stuck',
    'or needs a clean restart. device_install installs an APK from an artifact id (never a client',
    'URL) and is destructive — it pauses for a human to approve unless this agent is explicitly',
    'trusted with destructive capabilities.',
  ].join('\n'),
  tools: () => [deviceAppLaunch, deviceAppForceStop, deviceInstall],
})
