import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@enkaku/protocol'
import { assistantBlocksFromModelMessage, toModelMessages } from './messages'

/**
 * Unit tests for `toModelMessages`/`assistantBlocksFromModelMessage` (plan 76 §4.1, §7's "unit —
 * messages.ts: round-trip stored rows → ModelMessage[] → stored rows, including an image block
 * and an orphaned tool result").
 */

function msg(partial: Partial<AgentMessage> & Pick<AgentMessage, 'role' | 'content'>): AgentMessage {
  return { id: 'm', threadId: 't', runId: null, seq: 1, createdAt: 0, ...partial }
}

describe('toModelMessages — basic role mapping', () => {
  test('drops system-role messages entirely', () => {
    const out = toModelMessages([msg({ role: 'system', content: [{ type: 'text', text: 'cancelled' }] })])
    expect(out).toEqual([])
  })

  test('maps a plain user text message', () => {
    const out = toModelMessages([msg({ role: 'user', content: [{ type: 'text', text: 'hi' }] })])
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  test('maps an assistant tool_use to a tool-call part, dropping thinking blocks', () => {
    const out = toModelMessages([
      msg({
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'let me think' },
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'c1', name: 'device_tap', input: { x: 1 } },
        ],
      }),
    ])
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'device_tap', input: { x: 1 } },
        ],
      },
    ])
  })

  test('maps a tool_result to a role:tool message with a tool-result part', () => {
    const out = toModelMessages([
      msg({ role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', content: [{ type: 'text', text: '{"ok":true}' }], isError: false }] }),
    ])
    expect(out).toEqual([{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'c1', output: { type: 'text', value: '{"ok":true}' } }] }])
  })

  test('an error tool_result maps to an error-text output', () => {
    const out = toModelMessages([msg({ role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', content: [{ type: 'text', text: 'boom' }], isError: true }] })])
    const block = out[0]!.content
    expect(Array.isArray(block) && block[0]).toEqual({ type: 'tool-result', toolCallId: 'c1', toolName: 'c1', output: { type: 'error-text', value: 'boom' } })
  })
})

describe('toModelMessages — images (plan 70, plan 76 §3.6)', () => {
  test('a resolved image reaches the wire as a file content part', () => {
    const out = toModelMessages([msg({ role: 'user', content: [{ type: 'image', blobId: 'b1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }] })], {
      resolveBlob: (id) => (id === 'b1' ? { mediaType: 'image/png', data: 'AAAA' } : null),
      maxImagesPerRequest: 10,
    })
    expect(out).toEqual([{ role: 'user', content: [{ type: 'file', data: { type: 'data', data: 'AAAA' }, mediaType: 'image/png' }] }])
  })

  test('an image outside the per-request budget is replaced by a text placeholder, oldest first', () => {
    const messages: AgentMessage[] = [
      msg({ role: 'user', content: [{ type: 'image', blobId: 'old', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }] }),
      msg({ role: 'user', content: [{ type: 'image', blobId: 'new', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }] }),
    ]
    const out = toModelMessages(messages, { resolveBlob: (id) => ({ mediaType: 'image/png', data: `data-${id}` }), maxImagesPerRequest: 1 })
    const first = out[0]!.content
    const second = out[1]!.content
    expect(Array.isArray(first) && first[0]!.type).toBe('text') // dropped — the OLDER image
    expect(JSON.stringify(first)).toContain('dropped from context')
    expect(Array.isArray(second) && second[0]).toEqual({ type: 'file', data: { type: 'data', data: 'data-new' }, mediaType: 'image/png' })
  })

  test('with no resolveBlob at all, every image becomes a text placeholder (never silently sent as a blobId)', () => {
    const out = toModelMessages([msg({ role: 'user', content: [{ type: 'image', blobId: 'b1', mediaType: 'image/jpeg', bytes: 5, width: 2, height: 2 }] })])
    const content = out[0]!.content
    expect(Array.isArray(content) && content[0]!.type).toBe('text')
  })

  test('a tool_result image resolves the same way, inside a content-type output', () => {
    const out = toModelMessages(
      [
        msg({
          role: 'tool',
          content: [{ type: 'tool_result', toolUseId: 'c1', content: [{ type: 'image', blobId: 'b1', mediaType: 'image/png', bytes: 10 }], isError: false }],
        }),
      ],
      { resolveBlob: () => ({ mediaType: 'image/png', data: 'AAAA' }), maxImagesPerRequest: 10 },
    )
    const part = (out[0]!.content as { output: { type: string; value: unknown } }[])[0]!.output
    expect(part.type).toBe('content')
    expect(part.value).toEqual([{ type: 'file', data: { type: 'data', data: 'AAAA' }, mediaType: 'image/png' }])
  })
})

describe('assistantBlocksFromModelMessage — the inverse direction (a fresh model turn → stored blocks)', () => {
  test('text and tool-call parts map back to text/tool_use blocks', () => {
    const blocks = assistantBlocksFromModelMessage([
      { type: 'text', text: 'ok' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'device_tap', input: { x: 1 } },
    ])
    expect(blocks).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'c1', name: 'device_tap', input: { x: 1 } },
    ])
  })

  test('a reasoning part becomes a thinking block', () => {
    const blocks = assistantBlocksFromModelMessage([{ type: 'reasoning', text: 'hmm' }])
    expect(blocks).toEqual([{ type: 'thinking', text: 'hmm' }])
  })

  test('an empty string content produces no blocks', () => {
    expect(assistantBlocksFromModelMessage('')).toEqual([])
  })
})

describe('toModelMessages — an orphaned tool_result (its tool_use fell out of a compaction window) is still mapped, not thrown away here', () => {
  test('a tool_result with no matching tool_use in the SAME array is still rendered — sanitizeMessages, not this function, is what drops orphans', () => {
    const out = toModelMessages([msg({ role: 'tool', content: [{ type: 'tool_result', toolUseId: 'ghost', content: [{ type: 'text', text: 'x' }], isError: false }] })])
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('tool')
  })
})
