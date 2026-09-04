import { encodeGetClipboard, encodeSetClipboard } from './messages'
import type { DeviceMessage } from './device-messages'

/** scrcpy's own default: 2s (plan 38 §4.3) — a device that never answers must not hang a WS handler. */
const DEFAULT_TIMEOUT_MS = 2000

export interface ClipboardControlDeps {
  write(bytes: Uint8Array): void
  /** Subscribe to parsed device messages (already run through `createDeviceMessageReader`). Returns an unsubscribe function. */
  onDeviceMessage(cb: (m: DeviceMessage) => void): () => void
}

export interface ClipboardControl {
  getClipboard(opts?: { copyKey?: 'none' | 'copy' | 'cut'; timeoutMs?: number }): Promise<string>
  setClipboard(text: string, opts?: { paste?: boolean; timeoutMs?: number }): Promise<void>
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Promise-based clipboard get/set over an inherently async socket (plan 38
 * §4.3): `getClipboard` resolves on the next `clipboard` device message;
 * `setClipboard` resolves on the `ackClipboard` matching the sequence it
 * sent. Both reject `E_CLIPBOARD_TIMEOUT` if nothing matching arrives within
 * `timeoutMs` (default 2s).
 *
 * Only one clipboard request is in flight per session at a time — a second
 * concurrent call queues behind the first (§4.3), which matters because a
 * stray `clipboard`/`ackClipboard` from one call could otherwise resolve a
 * DIFFERENT, unrelated call waiting on the same message type.
 */
export function createClipboardControl(deps: ClipboardControlDeps): ClipboardControl {
  let sequence = 0n
  // Single-flight queue: at most one call is ever "active" (subscribed to
  // `onDeviceMessage` and waiting on its own write), so a stray reply can
  // never resolve the wrong pending call. The first call — the common case —
  // runs its `write` SYNCHRONOUSLY, on the same tick as the caller's
  // `getClipboard`/`setClipboard`, exactly like every other control message
  // in this package (`ScrcpyControl.injectTouch` and friends are not async).
  // A queued follow-up call runs the instant the active one settles, from
  // inside that settlement's own callback — never delayed by an extra tick
  // waiting on the promise machinery.
  const queue: Array<() => void> = []
  let active = false

  function runNext(): void {
    const task = queue.shift()
    if (!task) {
      active = false
      return
    }
    task()
  }

  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        run().then(
          (v) => {
            resolve(v)
            runNext()
          },
          (e) => {
            reject(e)
            runNext()
          },
        )
      }
      if (!active) {
        active = true
        task()
      } else {
        queue.push(task)
      }
    })
  }

  return {
    getClipboard(opts) {
      return enqueue(
        () =>
          new Promise<string>((resolve, reject) => {
            const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
            const timer = setTimeout(() => {
              unsubscribe()
              /*
               * Not necessarily a fault, and the old wording ("no clipboard
               * reply from the device") said it was. The device answers a
               * GET_CLIPBOARD with a CLIPBOARD message only when it has
               * something to say: an empty clipboard, or one whose text is
               * unchanged since the device last announced it, produces no
               * message at all and lands here. An operator saw this on a
               * device whose clipboard was working perfectly (2026-09-04),
               * which is exactly the case this sentence has to cover — so it
               * names the benign reading first and leaves the real fault as
               * the second possibility, rather than the other way round.
               */
              reject(
                codedError(
                  'E_CLIPBOARD_TIMEOUT',
                  `the device sent no clipboard within ${timeoutMs}ms — usually its clipboard is empty, or unchanged since it last announced one; less often the control channel is wedged`,
                ),
              )
            }, timeoutMs)
            const unsubscribe = deps.onDeviceMessage((m) => {
              if (m.type !== 'clipboard') return
              clearTimeout(timer)
              unsubscribe()
              resolve(m.text)
            })
            deps.write(encodeGetClipboard(opts?.copyKey ?? 'none'))
          }),
      )
    },

    setClipboard(text, opts) {
      return enqueue(
        () =>
          new Promise<void>((resolve, reject) => {
            const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
            sequence += 1n
            const seq = sequence
            const timer = setTimeout(() => {
              unsubscribe()
              reject(codedError('E_CLIPBOARD_TIMEOUT', `no ACK_CLIPBOARD from the device within ${timeoutMs}ms`))
            }, timeoutMs)
            const unsubscribe = deps.onDeviceMessage((m) => {
              if (m.type !== 'ackClipboard' || m.sequence !== seq) return
              clearTimeout(timer)
              unsubscribe()
              resolve()
            })
            deps.write(encodeSetClipboard(seq, text, opts?.paste ?? false))
          }),
      )
    },
  }
}
