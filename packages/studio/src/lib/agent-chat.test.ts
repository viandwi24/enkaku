import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@enkaku/protocol'
import {
  blobUrl,
  clampComposerHeight,
  composerDraftKey,
  extractDeviceIdForDisplay,
  findImageBlock,
  historyToUIMessages,
  textOfToolResult,
  wireNameToCapabilityId,
  type AgentChatToolCallData,
} from './agent-chat'

describe('wireNameToCapabilityId', () => {
  test('reverses the sanitised wire name back to a dotted capability id', () => {
    expect(wireNameToCapabilityId('device_screenshot')).toBe('device.screenshot')
    expect(wireNameToCapabilityId('device_app_launch')).toBe('device.app.launch')
    expect(wireNameToCapabilityId('fs_read')).toBe('fs.read')
  })
})

describe('findImageBlock (plan 70 §3.2 — a tool_result carries blocks, not a string)', () => {
  test('finds the image block in a well-formed screenshot tool_result', () => {
    const content = [
      { type: 'text', text: '{"format":"png"}' },
      { type: 'image', blobId: 'sha256:abc', mediaType: 'image/png', bytes: 123, width: 1080, height: 2400 },
    ]
    expect(findImageBlock(content)).toEqual(content[1] as never)
  })
  test('returns null for an ordinary (text-only) tool_result', () => {
    expect(findImageBlock([{ type: 'text', text: 'device not found' }])).toBeNull()
  })
  test('returns null for a non-array or empty content', () => {
    expect(findImageBlock('device not found')).toBeNull()
    expect(findImageBlock([])).toBeNull()
    expect(findImageBlock(undefined)).toBeNull()
  })
})

describe('textOfToolResult', () => {
  test('joins every text block', () => {
    expect(textOfToolResult([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })
  test('null when there is no text block at all (an image-only result)', () => {
    expect(textOfToolResult([{ type: 'image', blobId: 'sha256:abc', mediaType: 'image/png', bytes: 1 }])).toBeNull()
  })
})

describe('blobUrl', () => {
  test('builds GET /api/v1/blobs/:id, url-encoded', () => {
    expect(blobUrl('sha256:abc')).toContain('/api/v1/blobs/sha256%3Aabc')
  })
})

describe('extractDeviceIdForDisplay', () => {
  test('reads deviceId off an object input', () => {
    expect(extractDeviceIdForDisplay({ deviceId: 'd1', x: 1 })).toBe('d1')
  })
  test('returns null when absent or input is not an object', () => {
    expect(extractDeviceIdForDisplay({ x: 1 })).toBeNull()
    expect(extractDeviceIdForDisplay('device.list')).toBeNull()
    expect(extractDeviceIdForDisplay(null)).toBeNull()
  })
})

describe("clampComposerHeight — the composer's auto-grow cap (plan 73 §4.2, criterion 4)", () => {
  test('under the cap: reports the natural height, not overflowing', () => {
    expect(clampComposerHeight(60, 20, 10)).toEqual({ heightPx: 60, overflowing: false })
  })
  test('over the cap: clamps to maxRows * lineHeight and reports overflowing', () => {
    expect(clampComposerHeight(400, 20, 10)).toEqual({ heightPx: 200, overflowing: true })
  })
  test('defaults to 10 rows when maxRows is omitted', () => {
    expect(clampComposerHeight(500, 20)).toEqual({ heightPx: 200, overflowing: true })
  })
})

describe('composerDraftKey', () => {
  test('namespaces by thread id, distinctly per thread', () => {
    expect(composerDraftKey('t1')).toBe('enkaku:composer-draft:t1')
    expect(composerDraftKey('t1')).not.toBe(composerDraftKey('t2'))
  })
})

function msg(id: string, seq: number, role: AgentMessage['role'], content: AgentMessage['content']): AgentMessage {
  return { id, threadId: 't1', runId: 'r1', seq, role, content, createdAt: 1000 + seq }
}

describe('historyToUIMessages (plan 78 §3.5, §4.2)', () => {
  test('a plain user/assistant text exchange becomes two UIMessages', () => {
    const out = historyToUIMessages([msg('u1', 1, 'user', [{ type: 'text', text: 'hi' }]), msg('a1', 2, 'assistant', [{ type: 'text', text: 'hello' }])])
    expect(out).toEqual([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi', state: 'done' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello', state: 'done' }] },
    ])
  })

  test("a 'tool' role message contributes NO UIMessage of its own — its result is folded into the matching tool_use's data-toolCall part", () => {
    const out = historyToUIMessages([
      msg('a1', 1, 'assistant', [{ type: 'tool_use', id: 'call-1', name: 'device_screenshot', input: { deviceId: 'd1' } }]),
      msg('t1', 2, 'tool', [{ type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'image', blobId: 'blob-1', mediaType: 'image/png', bytes: 10 }], isError: false }]),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('a1')
    const part = out[0]?.parts[0]
    expect(part?.type).toBe('data-toolCall')
    if (part?.type === 'data-toolCall') {
      const data = part.data as AgentChatToolCallData
      expect(data.callId).toBe('call-1')
      expect(data.capabilityId).toBe('device.screenshot')
      expect(data.status).toBe('finished')
      expect(data.resultContent).toEqual([{ type: 'image', blobId: 'blob-1', mediaType: 'image/png', bytes: 10 }])
      expect(data.isError).toBe(false)
    }
  })

  test('a tool_use with no matching result yet (still running when history was fetched) has no resultContent', () => {
    const out = historyToUIMessages([msg('a1', 1, 'assistant', [{ type: 'tool_use', id: 'call-1', name: 'device_tap', input: {} }])])
    const part = out[0]?.parts[0]
    expect(part?.type).toBe('data-toolCall')
    if (part?.type === 'data-toolCall') expect((part.data as AgentChatToolCallData).resultContent).toBeUndefined()
  })

  test('a thinking block becomes a reasoning part', () => {
    const out = historyToUIMessages([msg('a1', 1, 'assistant', [{ type: 'thinking', text: 'pondering' }])])
    expect(out[0]?.parts).toEqual([{ type: 'reasoning', text: 'pondering', state: 'done' }])
  })

  test("a person's own attached image (user role) becomes a file part", () => {
    const out = historyToUIMessages([msg('u1', 1, 'user', [{ type: 'image', blobId: 'blob-2', mediaType: 'image/png', bytes: 5 }])])
    expect(out[0]?.parts).toEqual([{ type: 'file', url: blobUrl('blob-2'), mediaType: 'image/png' }])
  })

  test('a message that contributes no renderable parts is dropped entirely', () => {
    const out = historyToUIMessages([msg('t-orphan', 1, 'tool', [{ type: 'tool_result', toolUseId: 'call-x', content: [], isError: false }])])
    expect(out).toEqual([])
  })

  test('order within one message is preserved — text, then a tool call, then more text', () => {
    const out = historyToUIMessages([
      msg('a1', 1, 'assistant', [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'call-1', name: 'device_screenshot', input: {} },
        { type: 'text', text: 'done' },
      ]),
    ])
    expect(out[0]?.parts.map((p) => p.type)).toEqual(['text', 'data-toolCall', 'text'])
  })
})
