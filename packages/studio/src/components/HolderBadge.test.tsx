import { afterEach, describe, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import '@/lib/test/nav'
import type { LeaseHolder } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { HolderBadge } from './HolderBadge'

afterEach(cleanup)

const USER: LeaseHolder = { kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: true, acquiredAt: 0, expiresAt: null }
const JOB: LeaseHolder = { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }
const AGENT: LeaseHolder = { kind: 'agent', id: 'agent-1', label: 'Triage bot', runId: 'run-1', takeable: true, acquiredAt: 0, expiresAt: null }

/**
 * `variant: 'assists'` (plan 91 §3.4 item 4, §4.4) — the SAME shape as
 * `heldBy`'s badge, but painted amber (`--color-led-warn`, the one colour
 * `docs/design.md` reserves for a live, self-expiring condition) and worded
 * as an assist, never a control — an assist grant's `takeable` is always
 * `false` (plan 91 §3.2), so it must never read like a takeover candidate.
 */
describe('HolderBadge — variant="assists" (plan 91 §3.4 item 4, §4.4)', () => {
  test('the default variant ("holds") is unchanged — a person reads "Controlled by"', () => {
    renderWithApi(<HolderBadge holder={USER} />)
    expect(screen.getByTitle('Controlled by Alice')).toBeTruthy()
  })

  test('a person assisting reads "Assisting", never "Controlled by"', () => {
    renderWithApi(<HolderBadge holder={USER} variant="assists" />)
    expect(screen.getByTitle('Assisting — Alice')).toBeTruthy()
    expect(screen.queryByTitle('Controlled by Alice')).toBeNull()
  })

  test('a job being assisted reads "Assisted by", not "Running"', () => {
    const { container } = renderWithApi(<HolderBadge holder={JOB} variant="assists" />)
    expect(screen.getByTitle('Assisted by checkout@1.4.2 — open the job')).toBeTruthy()
    expect(container.querySelector('a[href="/jobs/detail?id=job-1"]')).toBeTruthy()
  })

  test('an agent being assisted reads "Assisted by", not "Driven by"', () => {
    renderWithApi(<HolderBadge holder={AGENT} variant="assists" />)
    expect(screen.getByTitle('Assisted by Triage bot — open the agent')).toBeTruthy()
  })

  test('the assist variant paints amber (--color-led-warn), never the neutral "holds" colour', () => {
    const { container: assists } = renderWithApi(<HolderBadge holder={USER} variant="assists" />)
    expect(assists.querySelector('.border-led-warn\\/35')).toBeTruthy()
    const { container: holds } = renderWithApi(<HolderBadge holder={USER} />)
    expect(holds.querySelector('.border-led-warn\\/35')).toBeNull()
  })
})

/**
 * `asLink={false}` (plan 91 §3.4 item 4 gap 3) — a caller whose own root is
 * already a `next/link` (`WallTile`) cannot nest a second `Link` inside a
 * `job`/`agent` holder's badge without producing invalid HTML. `user` holders
 * were never a `Link` in the first place, so `asLink` has nothing to change
 * for them.
 */
describe('HolderBadge — asLink={false} (plan 91 §3.4 item 4 gap 3)', () => {
  test('a job holder renders as a span, not an anchor, and keeps its title without the "open the job" suffix', () => {
    const { container, getByTitle } = renderWithApi(<HolderBadge holder={JOB} asLink={false} />)
    expect(container.querySelector('a')).toBeNull()
    const badge = getByTitle('Running checkout@1.4.2')
    expect(badge.tagName).toBe('SPAN')
  })

  test('an agent holder renders as a span, not an anchor', () => {
    const { container, getByTitle } = renderWithApi(<HolderBadge holder={AGENT} asLink={false} />)
    expect(container.querySelector('a')).toBeNull()
    const badge = getByTitle('Driven by Triage bot')
    expect(badge.tagName).toBe('SPAN')
  })

  test('a user holder is unaffected — it was always a plain span', () => {
    const { getByTitle } = renderWithApi(<HolderBadge holder={USER} asLink={false} />)
    expect(getByTitle('Controlled by Alice')).toBeTruthy()
  })

  test('asLink defaults to true — every existing caller with no enclosing link keeps navigating', () => {
    const { container } = renderWithApi(<HolderBadge holder={JOB} />)
    expect(container.querySelector('a[href="/jobs/detail?id=job-1"]')).toBeTruthy()
  })
})
