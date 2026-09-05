'use client'

import { PipPanel } from './PipPanel'
import { usePip, usePipRequest } from './pip-store'

/**
 * The picture-in-picture panel's host, mounted once by `AppShell` as a
 * sibling of the rail/column pair (plan 500 §4.4) — never inside a framed
 * document itself (`AppShell` renders no rail, no status bar and no
 * `PipHost` when `isPipFrame` is true, §3.7).
 *
 * Same shape as `DeviceControlHost`: render nothing while the store holds no
 * request, mount `PipPanel` keyed on the target `href` once it does, so
 * switching pages replaces the panel's content rather than reusing state
 * meant for a different page.
 */
export function PipHost(): React.JSX.Element | null {
  const request = usePipRequest()
  const { close } = usePip()
  if (!request) return null
  return <PipPanel key={request.href} request={request} onClose={close} />
}
