import { describe, expect, test } from 'bun:test'
import type { GuestAgentClientRunner } from '@enkaku/drivers'
import type { GuestAgentCapability, TextInputMode, Transport } from '@enkaku/protocol'
import type { Logger } from './logger'
import { applyTextInput, ENKAKU_IME_COMPONENT_ID, resolveTextRoute, type TextRung } from './text-input'

function silentLog(): { log: Logger; debugs: string[] } {
  const debugs: string[] = []
  const log: Logger = {
    debug: (msg) => debugs.push(msg),
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  }
  return { log, debugs }
}

/** Records every command issued, and answers from a prefix→output map — same shape `orientation.test.ts` uses. */
function recordingTransport(responses: Record<string, string> = {}) {
  const calls: string[] = []
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      for (const [prefix, out] of Object.entries(responses)) {
        if (cmd.startsWith(prefix)) return { stdout: out, stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  } as unknown as Transport
  return { transport, calls }
}

describe('resolveTextRoute — plan 90 §3.3, §4.5, §5 step 90.5', () => {
  test('rung 1 (agent-ime): the agent advertises text-input and its IME is current', () => {
    const decision = resolveTextRoute({
      text: 'こんにちは 👋',
      agentCapabilities: ['text-input', 'socks5-route'],
      imeCurrent: true,
      hasScrcpyControl: true,
      prefer: 'auto',
    })
    expect(decision).toEqual({ rung: 'agent-ime', clobbersClipboard: false, unmet: null })
  })

  test('rung 1 is skipped under prefer: "device" even when the agent is fully usable — that mode never touches the device\'s own IME', () => {
    const decision = resolveTextRoute({
      text: 'hello',
      agentCapabilities: ['text-input'],
      imeCurrent: true,
      hasScrcpyControl: true,
      prefer: 'device',
    })
    expect(decision.rung).not.toBe('agent-ime')
    expect(decision.unmet).toBeNull()
  })

  test('rung 2 (scrcpy-text): no usable agent, but a scrcpy control socket exists — unicode text still lands with no side effect', () => {
    const decision = resolveTextRoute({
      text: 'こんにちは 👋',
      agentCapabilities: null,
      imeCurrent: false,
      hasScrcpyControl: true,
      prefer: 'auto',
    })
    expect(decision).toEqual({ rung: 'scrcpy-text', clobbersClipboard: false, unmet: null })
  })

  test('rung 2 wins over rung 3 even for plain ASCII, when a scrcpy control socket is available', () => {
    const decision = resolveTextRoute({
      text: 'hello world',
      agentCapabilities: null,
      imeCurrent: false,
      hasScrcpyControl: true,
      prefer: 'auto',
    })
    expect(decision.rung).toBe('scrcpy-text')
  })

  test('rung 3 (adb-ascii): no agent, no scrcpy control socket, and the string is plain ASCII', () => {
    const decision = resolveTextRoute({
      text: 'hello world 123',
      agentCapabilities: null,
      imeCurrent: false,
      hasScrcpyControl: false,
      prefer: 'auto',
    })
    expect(decision).toEqual({ rung: 'adb-ascii', clobbersClipboard: false, unmet: null })
  })

  test('the named precondition (fixes F25): forcing adb-input on non-ASCII text refuses with a precondition instead of a silently dropped keystroke', () => {
    const decision = resolveTextRoute({
      text: 'こんにちは',
      agentCapabilities: null,
      imeCurrent: false,
      hasScrcpyControl: false,
      prefer: 'auto',
    })
    expect(decision.unmet).not.toBeNull()
    expect(decision.unmet?.code).toBe('E_TEXT_UNICODE_UNSUPPORTED')
    expect(decision.unmet?.action).toBe('install-agent')
    expect(decision.unmet?.message).toContain('install the guest agent')
    // `rung` still names the path that would have run had the text been ASCII — never a value
    // that lies about what was attempted.
    expect(decision.rung).toBe('adb-ascii')
  })

  test('the same precondition holds under prefer: "device" — that mode still refuses rather than dropping the keystroke', () => {
    const decision = resolveTextRoute({
      text: '👋',
      agentCapabilities: null,
      imeCurrent: false,
      hasScrcpyControl: false,
      prefer: 'device',
    })
    expect(decision.unmet).not.toBeNull()
    expect(decision.unmet?.code).toBe('E_TEXT_UNICODE_UNSUPPORTED')
  })

  test('prefer: "agent" with no agent installed at all refuses naming install-agent, never falling through to rung 2/3/4', () => {
    const decision = resolveTextRoute({
      text: 'hello', // plain ASCII — would otherwise sail through rung 3
      agentCapabilities: null,
      imeCurrent: false,
      hasScrcpyControl: true, // rung 2 would otherwise be trivially available
      prefer: 'agent',
    })
    expect(decision.rung).toBe('agent-ime')
    expect(decision.unmet).toEqual({
      code: 'E_TEXT_AGENT_UNAVAILABLE',
      message: "this device has no guest agent keyboard available — install the guest agent to type through it",
      action: 'install-agent',
    })
  })

  test('prefer: "agent" with the agent installed but not the current IME refuses naming update-agent — a different fix from "not installed"', () => {
    const decision = resolveTextRoute({
      text: 'hello',
      agentCapabilities: ['text-input'],
      imeCurrent: false,
      hasScrcpyControl: true,
      prefer: 'agent',
    })
    expect(decision.rung).toBe('agent-ime')
    expect(decision.unmet?.code).toBe('E_TEXT_AGENT_IME_NOT_CURRENT')
    expect(decision.unmet?.action).toBe('update-agent')
  })

  test('prefer: "agent" succeeds (no precondition) once the agent is both capable and current', () => {
    const decision = resolveTextRoute({
      text: 'hello',
      agentCapabilities: ['text-input'],
      imeCurrent: true,
      hasScrcpyControl: false,
      prefer: 'agent',
    })
    expect(decision).toEqual({ rung: 'agent-ime', clobbersClipboard: false, unmet: null })
  })

  test('an agent that advertises other capabilities but not text-input is treated as "no agent" for this purpose', () => {
    const decision = resolveTextRoute({
      text: 'hello',
      agentCapabilities: ['socks5-route', 'screen-label'],
      imeCurrent: true, // even a stale/irrelevant true here must not matter
      hasScrcpyControl: true,
      prefer: 'auto',
    })
    expect(decision.rung).toBe('scrcpy-text')
  })

  test('every unmet decision names an action a human can act on', () => {
    const decisions = [
      resolveTextRoute({ text: '日本語', agentCapabilities: null, imeCurrent: false, hasScrcpyControl: false, prefer: 'auto' }),
      resolveTextRoute({ text: 'x', agentCapabilities: null, imeCurrent: false, hasScrcpyControl: false, prefer: 'agent' }),
      resolveTextRoute({ text: 'x', agentCapabilities: ['text-input'], imeCurrent: false, hasScrcpyControl: false, prefer: 'agent' }),
    ]
    for (const d of decisions) {
      expect(d.unmet).not.toBeNull()
      expect(d.unmet?.action === 'install-agent' || d.unmet?.action === 'update-agent').toBe(true)
    }
  })

  test('the ladder is exhaustive: for ANY combination of inputs, resolveTextRoute always returns one of the three defined rungs — never anything else. This is the pin that used to prove `rung: \'clipboard\'` was unreachable (a fourth rung plan 90 §3.3 designed, proven architecturally impossible in this codebase, and removed — docs/plans/96-m61-hotfixes.md §96.7, §96.8) — now that `\'clipboard\'` is not even a value `TextRung` can hold, the pin generalises to "the ladder never produces a rung outside its own declared set", which is what actually matters as the ladder evolves. If this test starts failing because `decision.rung` is something other than one of the three listed below, either a real rung was added without updating this list (update it here) or something regressed.', () => {
    const texts = ['', 'hello', 'こんにちは 👋', '日本語']
    const agentCapabilitiesOptions: (GuestAgentCapability[] | null)[] = [
      null,
      [],
      ['text-input'],
      ['socks5-route', 'screen-label'],
    ]
    const imeCurrentOptions = [true, false]
    const hasScrcpyControlOptions = [true, false]
    const preferOptions: TextInputMode[] = ['auto', 'agent', 'device']
    const definedRungs: TextRung[] = ['agent-ime', 'scrcpy-text', 'adb-ascii']

    let checked = 0
    for (const text of texts) {
      for (const agentCapabilities of agentCapabilitiesOptions) {
        for (const imeCurrent of imeCurrentOptions) {
          for (const hasScrcpyControl of hasScrcpyControlOptions) {
            for (const prefer of preferOptions) {
              const decision = resolveTextRoute({ text, agentCapabilities, imeCurrent, hasScrcpyControl, prefer })
              expect(definedRungs).toContain(decision.rung)
              checked += 1
            }
          }
        }
      }
    }
    // The exhaustiveness itself is part of the pin — a shrinking product here would silently
    // narrow what this test actually proves.
    expect(checked).toBe(texts.length * agentCapabilitiesOptions.length * imeCurrentOptions.length * hasScrcpyControlOptions.length * preferOptions.length)
  })
})

describe('applyTextInput — plan 90 §3.2, §4.5, §5 step 90.5 (H4: no device is left wedged, idempotent on double-revert)', () => {
  test('mode "device" issues no commands and its revert is a no-op — today\'s behaviour, exactly', async () => {
    const { transport, calls } = recordingTransport()
    const { log } = silentLog()
    const setup = await applyTextInput(transport, { mode: 'device', log })
    expect(calls).toEqual([])
    expect(setup.agentCapabilities).toBeNull()
    expect(setup.imeCurrent).toBe(false)
    await setup.revert()
    expect(calls).toEqual([])
  })

  test('with no guest-agent client wired for this session, nothing is attempted — the same reading as "no agent installed"', async () => {
    const { transport, calls } = recordingTransport()
    const { log } = silentLog()
    const setup = await applyTextInput(transport, { mode: 'auto', log })
    expect(calls).toEqual([])
    expect(setup.agentCapabilities).toBeNull()
    expect(setup.imeCurrent).toBe(false)
  })

  function fakeRunner(capabilities: string[]): GuestAgentClientRunner {
    return (async (fn: (client: unknown) => unknown) =>
      fn({
        hello: async () => ({ protocol: 1, appVersion: '1.0', androidSdkInt: 34, capabilities }),
      })) as unknown as GuestAgentClientRunner
  }

  test('an agent that does not advertise text-input: no shell commands are issued, and imeCurrent is honestly false', async () => {
    const { transport, calls } = recordingTransport()
    const { log } = silentLog()
    const setup = await applyTextInput(transport, { mode: 'auto', withGuestAgentClient: fakeRunner(['socks5-route']), log })
    expect(calls).toEqual([])
    expect(setup.agentCapabilities).toEqual(['socks5-route'])
    expect(setup.imeCurrent).toBe(false)
  })

  test('an agent with text-input: reads the prior default IME, enables+sets the Enkaku IME, and confirms by reading it back', async () => {
    const { transport, calls } = recordingTransport({
      'settings get secure default_input_method': 'com.google.android.inputmethod.latin/.LatinIME',
    })
    const { log } = silentLog()
    const setup = await applyTextInput(transport, { mode: 'auto', withGuestAgentClient: fakeRunner(['text-input']), log })
    expect(calls[0]).toBe('settings get secure default_input_method')
    expect(calls).toContain(`ime enable ${ENKAKU_IME_COMPONENT_ID}`)
    expect(calls).toContain(`ime set ${ENKAKU_IME_COMPONENT_ID}`)
    // Read back AFTER the write, from the SAME fake responses (which always answer the ORIGINAL
    // latin IME) — so this session honestly reports the switch did NOT take, exactly the
    // "ime set was a silent no-op" case `text.commit`'s `not-current` precondition exists for.
    expect(setup.imeCurrent).toBe(false)
  })

  test('when the read-back confirms the switch took, imeCurrent is true', async () => {
    const responses: Record<string, string> = {
      'settings get secure default_input_method': 'com.google.android.inputmethod.latin/.LatinIME',
    }
    const { log } = silentLog()
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        // After the `ime set` write, flip what a read-back would answer — simulating the switch
        // actually taking, the same way a real device's `secure default_input_method` changes.
        if (cmd === `ime set ${ENKAKU_IME_COMPONENT_ID}`) responses['settings get secure default_input_method'] = ENKAKU_IME_COMPONENT_ID
        for (const [prefix, out] of Object.entries(responses)) {
          if (cmd.startsWith(prefix)) return { stdout: out, stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    const setup = await applyTextInput(transport, { mode: 'auto', withGuestAgentClient: fakeRunner(['text-input']), log })
    expect(setup.imeCurrent).toBe(true)
    expect(setup.agentCapabilities).toEqual(['text-input'])
  })

  test('revert restores the exact prior default_input_method that was read', async () => {
    const { transport, calls } = recordingTransport({
      'settings get secure default_input_method': 'com.google.android.inputmethod.latin/.LatinIME',
    })
    const { log } = silentLog()
    const setup = await applyTextInput(transport, { mode: 'auto', withGuestAgentClient: fakeRunner(['text-input']), log })
    calls.length = 0
    await setup.revert()
    expect(calls).toEqual(['ime set com.google.android.inputmethod.latin/.LatinIME'])
  })

  test('revert is idempotent: calling it twice issues the exact same restore command twice, and is safe (H4 — no device is left wedged after a SIGKILL mid-session)', async () => {
    const { transport, calls } = recordingTransport({
      'settings get secure default_input_method': 'com.google.android.inputmethod.latin/.LatinIME',
    })
    const { log } = silentLog()
    const setup = await applyTextInput(transport, { mode: 'auto', withGuestAgentClient: fakeRunner(['text-input']), log })
    calls.length = 0
    await setup.revert()
    await setup.revert()
    expect(calls).toEqual([
      'ime set com.google.android.inputmethod.latin/.LatinIME',
      'ime set com.google.android.inputmethod.latin/.LatinIME',
    ])
  })

  test('an unreadable prior default_input_method ("" or "null") leaves the revert a no-op rather than writing a guessed value', async () => {
    const { transport, calls } = recordingTransport({
      'settings get secure default_input_method': '',
    })
    const { log } = silentLog()
    const setup = await applyTextInput(transport, { mode: 'auto', withGuestAgentClient: fakeRunner(['text-input']), log })
    calls.length = 0
    await setup.revert()
    expect(calls).toEqual([])
  })

  test('a failing shell command is swallowed (best-effort) and apply still completes honestly', async () => {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd.startsWith('ime ')) throw new Error('boom')
        return { stdout: 'previous.ime/.Id', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    const { log, debugs } = silentLog()
    const setup = await applyTextInput(transport, { mode: 'auto', withGuestAgentClient: fakeRunner(['text-input']), log })
    expect(setup.imeCurrent).toBe(false) // the read-back still answers the ORIGINAL ime — the write never landed
    expect(debugs.some((m) => m.includes('ime enable failed'))).toBe(true)
    expect(debugs.some((m) => m.includes('ime set failed'))).toBe(true)
  })
})
