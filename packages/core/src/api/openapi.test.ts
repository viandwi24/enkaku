import { describe, expect, test } from 'bun:test'
import { buildCoreCapabilityRegistry } from '../capability'
import { buildOpenApiDocument } from './openapi'

describe('buildOpenApiDocument (plan 63 §4.5, acceptance #10)', () => {
  const registry = buildCoreCapabilityRegistry()
  const doc = buildOpenApiDocument(registry, '0.1.5')

  test('declares OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.title.length).toBeGreaterThan(0)
    expect(doc.info.version).toBe('0.1.5')
  })

  test('contains one path per registry entry', () => {
    const paths = Object.keys(doc.paths)
    expect(paths.length).toBe(registry.all().length)
    expect(paths).toContain('/api/v1/cap/device.tap')
    expect(paths).toContain('/api/v1/cap/script.publish')
  })

  test('every path declares a POST operation with a request body and a 200 response schema', () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      const post = (item as { post?: { requestBody?: unknown; responses?: Record<string, unknown> } }).post
      expect(post, `${path} should declare POST`).toBeTruthy()
      expect(post?.requestBody).toBeTruthy()
      expect(post?.responses?.['200']).toBeTruthy()
    }
  })

  test('the document round-trips through JSON.stringify (no cycles, no functions)', () => {
    expect(() => JSON.stringify(doc)).not.toThrow()
  })
})
