import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../../db'
import { createThreadStore } from '../thread/store'
import { createApprovalStore } from './store'

function setUp(ttlSec?: number) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const threads = createThreadStore(db)
  const thread = threads.createThread({ agentId: 'a1' })
  const run = threads.createRun(thread.id)
  return { db, threads, approvals: createApprovalStore({ db, ttlSec }), thread, run }
}

describe('approval store (plan 66 §3.6, §4.3, §7)', () => {
  test('create starts pending, with the exact input preserved', () => {
    const { approvals, run } = setUp()
    const approval = approvals.create({ runId: run.id, capabilityId: 'device.app.install', toolCallId: 'call-1', input: { deviceId: 'd1', path: '/artifacts/x.apk' } })
    expect(approval.status).toBe('pending')
    expect(approval.input).toEqual({ deviceId: 'd1', path: '/artifacts/x.apk' })
    expect(approval.runId).toBe(run.id)
  })

  test('approve resolves it and records who decided', () => {
    const { approvals, run } = setUp()
    const approval = approvals.create({ runId: run.id, capabilityId: 'device.app.install', toolCallId: 'call-1', input: {} })
    const decided = approvals.decide(approval.id, 'approve', 'user:u1')
    expect(decided.status).toBe('approved')
    expect(decided.decidedBy).toBe('user:u1')
    expect(decided.decidedAt).not.toBeNull()
  })

  test('deny resolves it as denied', () => {
    const { approvals, run } = setUp()
    const approval = approvals.create({ runId: run.id, capabilityId: 'device.app.install', toolCallId: 'call-1', input: {} })
    const decided = approvals.decide(approval.id, 'deny', 'user:u1')
    expect(decided.status).toBe('denied')
  })

  test('deciding an already-decided approval is refused, not silently overwritten', () => {
    const { approvals, run } = setUp()
    const approval = approvals.create({ runId: run.id, capabilityId: 'x', toolCallId: 'call-1', input: {} })
    approvals.decide(approval.id, 'approve', 'user:u1')
    expect(() => approvals.decide(approval.id, 'deny', 'user:u2')).toThrow()
  })

  test('sweepExpired moves overdue pending approvals to expired, and leaves fresh ones alone', () => {
    const { db, approvals, run } = setUp(-1) // already expired the instant it is created
    const overdue = approvals.create({ runId: run.id, capabilityId: 'x', toolCallId: 'call-1', input: {} })
    const swept = approvals.sweepExpired()
    expect(swept.map((r) => r.id)).toContain(overdue.id)
    expect(approvals.get(overdue.id)?.status).toBe('expired')
    void db
  })

  test('sweepExpired does not touch a still-fresh pending approval', () => {
    const { approvals, run } = setUp(3600)
    const fresh = approvals.create({ runId: run.id, capabilityId: 'x', toolCallId: 'call-1', input: {} })
    approvals.sweepExpired()
    expect(approvals.get(fresh.id)?.status).toBe('pending')
  })

  test('pendingForRun finds the one pending approval for a run, or null', () => {
    const { approvals, run } = setUp()
    expect(approvals.pendingForRun(run.id)).toBeNull()
    const approval = approvals.create({ runId: run.id, capabilityId: 'x', toolCallId: 'call-1', input: {} })
    expect(approvals.pendingForRun(run.id)?.id).toBe(approval.id)
    approvals.decide(approval.id, 'approve', null)
    expect(approvals.pendingForRun(run.id)).toBeNull()
  })

  test('findByToolCallId disambiguates two gated calls in the same run', () => {
    const { approvals, run } = setUp()
    const a = approvals.create({ runId: run.id, capabilityId: 'device.app.install', toolCallId: 'call-1', input: { path: 'a.apk' } })
    const b = approvals.create({ runId: run.id, capabilityId: 'device.app.install', toolCallId: 'call-2', input: { path: 'b.apk' } })
    expect(approvals.findByToolCallId(run.id, 'call-1')?.id).toBe(a.id)
    expect(approvals.findByToolCallId(run.id, 'call-2')?.id).toBe(b.id)
    expect(approvals.findByToolCallId(run.id, 'call-3')).toBeNull()
  })
})
