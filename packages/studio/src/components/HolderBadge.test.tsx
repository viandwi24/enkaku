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

const GRANT_TTL_SEC = 300
const nowSec = () => Math.floor(Date.now() / 1000)
/** A grant `touch()`ed just now (`co-control.ts`'s own math: `expiresAt = now + grantTtlSec`) — reads "assisting". */
const justTouched = (holder: LeaseHolder): LeaseHolder => ({ ...holder, expiresAt: nowSec() + GRANT_TTL_SEC })
/** A grant touched long enough ago that it is well outside `ASSIST_ACTIVITY_WINDOW_SEC` but still holds — reads "may assist". */
const idleGrant = (holder: LeaseHolder): LeaseHolder => ({ ...holder, expiresAt: nowSec() + 30 })

/**
 * `variant: 'assists'` (plan 91 §3.4 item 4, §4.4) — the SAME shape as
 * `heldBy`'s badge, but painted amber (`--color-led-warn`, the one colour
 * `docs/design.md` reserves for a live, self-expiring condition) and worded
 * as an assist, never a control — an assist grant's `takeable` is always
 * `false` (plan 91 §3.2), so it must never read like a takeover candidate.
 *
 * Plan 105 §3.2 split this further: "Assisting" (present tense — input
 * within `ASSIST_ACTIVITY_WINDOW_SEC`) versus "May assist" (a held, idle
 * grant) — an authorization must never be worded as an activity it is not
 * currently performing (`docs/design.md`'s degraded/partial-state rule).
 */
describe('HolderBadge — variant="assists" (plan 91 §3.4 item 4, §4.4; split by plan 105 §3.2)', () => {
  test('the default variant ("holds") is unchanged — a person reads "Controlled by"', () => {
    renderWithApi(<HolderBadge holder={USER} />)
    expect(screen.getByTitle('Controlled by Alice')).toBeTruthy()
  })

  test('a person just touched reads "Assisting", never "Controlled by"', () => {
    renderWithApi(<HolderBadge holder={justTouched(USER)} variant="assists" grantTtlSec={GRANT_TTL_SEC} />)
    expect(screen.getByTitle('Assisting — Alice')).toBeTruthy()
    expect(screen.queryByTitle('Controlled by Alice')).toBeNull()
  })

  test('an idle grant reads "May assist", never "Assisting" — an authorization is not an activity', () => {
    renderWithApi(<HolderBadge holder={idleGrant(USER)} variant="assists" grantTtlSec={GRANT_TTL_SEC} />)
    expect(screen.getByTitle('May assist — Alice')).toBeTruthy()
    expect(screen.queryByTitle('Assisting — Alice')).toBeNull()
  })

  test('a grant with no expiry at all (a defensive fixture — a real grant always sets one) reads "May assist", never overclaiming activity', () => {
    renderWithApi(<HolderBadge holder={USER} variant="assists" />)
    expect(screen.getByTitle('May assist — Alice')).toBeTruthy()
  })

  test('a job shape being assisted reads "Assisting"/"May assist", not "Running"', () => {
    const { container } = renderWithApi(<HolderBadge holder={justTouched(JOB)} variant="assists" grantTtlSec={GRANT_TTL_SEC} />)
    expect(screen.getByTitle('Assisting — checkout@1.4.2 — open the job')).toBeTruthy()
    expect(container.querySelector('a[href="/jobs/detail?id=job-1"]')).toBeTruthy()
  })

  test('an agent shape being assisted reads "Assisting"/"May assist", not "Driven by"', () => {
    renderWithApi(<HolderBadge holder={justTouched(AGENT)} variant="assists" grantTtlSec={GRANT_TTL_SEC} />)
    expect(screen.getByTitle('Assisting — Triage bot — open the agent')).toBeTruthy()
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
