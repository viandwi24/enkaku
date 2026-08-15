import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ConfirmFanout } from './ConfirmFanout'

/**
 * Plan 93 §3.14 guard 2, step 93.7's own verifiable result: "the confirm
 * dialog blocks submission until the count is typed." Property 2 of this
 * step's brief: the acknowledgement is a SCALE confirmation, not the system
 * judging the command — the high-consequence notice is worded that way.
 */

afterEach(cleanup)

describe('ConfirmFanout', () => {
  test('below the threshold, Run is enabled immediately — no typed count required', () => {
    let confirmed = 0
    const { getByRole } = renderWithApi(
      <ConfirmFanout
        open
        onOpenChange={() => {}}
        cmd="getprop ro.build.version.release"
        targetCount={3}
        threshold={5}
        highConsequence={{ hit: false }}
        onConfirm={() => (confirmed += 1)}
      />,
    )
    const runButton = getByRole('button', { name: 'Run on 3 devices' })
    expect((runButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(runButton)
    expect(confirmed).toBe(1)
  })

  test('above the threshold, Run stays disabled until the exact count is typed', () => {
    const { getByRole, getByLabelText } = renderWithApi(
      <ConfirmFanout
        open
        onOpenChange={() => {}}
        cmd="pm uninstall com.example"
        targetCount={12}
        threshold={5}
        highConsequence={{ hit: false }}
        onConfirm={() => {}}
      />,
    )
    const runButton = getByRole('button', { name: 'Run on 12 devices' }) as HTMLButtonElement
    expect(runButton.disabled).toBe(true)

    const countInput = getByLabelText(/Type/)
    fireEvent.change(countInput, { target: { value: '11' } })
    expect(runButton.disabled).toBe(true)

    fireEvent.change(countInput, { target: { value: '12' } })
    expect(runButton.disabled).toBe(false)
  })

  test('a high-consequence command shows the scale-confirmation notice, worded as such — not a security judgement', () => {
    const { getByText } = renderWithApi(
      <ConfirmFanout
        open
        onOpenChange={() => {}}
        cmd="pm uninstall com.example"
        targetCount={3}
        threshold={5}
        highConsequence={{ hit: true, pattern: '\\bpm\\s+uninstall\\b' }}
        onConfirm={() => {}}
      />,
    )
    expect(getByText(/scale confirmation, not a security check/)).toBeTruthy()
    expect(getByText(/matches "\\bpm\\s\+uninstall\\b"/)).toBeTruthy()
  })

  test('a plain command with no high-consequence hit shows no such notice', () => {
    const { queryByText } = renderWithApi(
      <ConfirmFanout
        open
        onOpenChange={() => {}}
        cmd="getprop ro.serialno"
        targetCount={20}
        threshold={5}
        highConsequence={{ hit: false }}
        onConfirm={() => {}}
      />,
    )
    expect(queryByText(/scale confirmation/)).toBeNull()
  })

  test('reopening the dialog clears a previously typed count', () => {
    const { getByRole, getByLabelText, rerender } = renderWithApi(
      <ConfirmFanout open={true} onOpenChange={() => {}} cmd="reboot" targetCount={10} threshold={5} highConsequence={{ hit: false }} onConfirm={() => {}} />,
    )
    fireEvent.change(getByLabelText(/Type/), { target: { value: '10' } })
    expect((getByRole('button', { name: 'Run on 10 devices' }) as HTMLButtonElement).disabled).toBe(false)

    rerender(<ConfirmFanout open={false} onOpenChange={() => {}} cmd="reboot" targetCount={10} threshold={5} highConsequence={{ hit: false }} onConfirm={() => {}} />)
    rerender(<ConfirmFanout open={true} onOpenChange={() => {}} cmd="reboot" targetCount={10} threshold={5} highConsequence={{ hit: false }} onConfirm={() => {}} />)
    expect((getByRole('button', { name: 'Run on 10 devices' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
