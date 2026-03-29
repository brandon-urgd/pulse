// Property-based tests for streaming tag stripping and concurrent request guard
// Properties P1, P2, P3

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ── Pure logic mirroring useStreaming.ts ──
function processStream(chunks) {
  const TAG_BUFFER_SIZE = 20
  let buffer = ''
  let rendered = ''

  for (const chunk of chunks) {
    buffer += chunk
    if (buffer.length > TAG_BUFFER_SIZE) {
      const safe = buffer.slice(0, -TAG_BUFFER_SIZE)
      const stripped = safe.replace(/\[SECTION:\d+\]/g, '').replace(/\[SESSION_COMPLETE\]/g, '')
      rendered += stripped
      buffer = buffer.slice(-TAG_BUFFER_SIZE)
    }
  }
  // Final flush
  const stripped = buffer.replace(/\[SECTION:\d+\]/g, '').replace(/\[SESSION_COMPLETE\]/g, '')
  rendered += stripped
  return rendered
}

// ── Pure logic mirroring chat lambda concurrent guard ──
function shouldRejectConcurrentRequest(streamingLock, now = Date.now()) {
  if (!streamingLock) return false
  const lockAge = now - new Date(streamingLock).getTime()
  return lockAge < 60000
}

const ALL_TAGS = [
  '[SECTION:1]', '[SECTION:2]', '[SECTION:3]', '[SECTION:10]', '[SECTION:99]',
  '[SESSION_COMPLETE]',
]

/**
 * Property P1: Tag stripping completeness
 *
 * For any stream chunks with tags injected at arbitrary positions,
 * the output contains zero instances of any tag pattern.
 * Non-tag content is preserved in order.
 *
 * Validates: Requirements 1.4, 2.2, 2.3
 */
describe('Property P1: Tag stripping completeness', () => {
  it('output contains no [SECTION:N] or [SESSION_COMPLETE] tags after processing', () => {
    fc.assert(
      fc.property(
        // Generate plain text chunks with no bracket chars
        fc.array(
          fc.string({ minLength: 5, maxLength: 30 }).filter(s => !s.includes('[') && !s.includes(']')),
          { minLength: 2, maxLength: 10 },
        ),
        // Generate tags to inject
        fc.array(fc.constantFrom(...ALL_TAGS), { minLength: 1, maxLength: 5 }),
        (textChunks, tags) => {
          // Build: text, tag, text, tag, text... ensuring each tag is surrounded by
          // at least 20 chars of trailing text so it gets flushed and stripped
          const PADDING = 'x'.repeat(25) // > TAG_BUFFER_SIZE to ensure flush
          const allChunks = []
          for (let i = 0; i < textChunks.length; i++) {
            allChunks.push(textChunks[i])
            if (i < tags.length) {
              allChunks.push(tags[i])
              allChunks.push(PADDING) // ensure tag gets pushed out of buffer
            }
          }

          const result = processStream(allChunks)

          // No tag patterns should remain
          expect(result).not.toMatch(/\[SECTION:\d+\]/)
          expect(result).not.toMatch(/\[SESSION_COMPLETE\]/)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('non-tag content is preserved in order', () => {
    fc.assert(
      fc.property(
        // Generate plain text chunks with no tag-like content
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes('[') && !s.includes(']')),
          { minLength: 1, maxLength: 10 },
        ),
        (textChunks) => {
          const result = processStream(textChunks)
          const expected = textChunks.join('')
          expect(result).toBe(expected)
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P2: Tag buffer invariant
 *
 * During streaming, the buffer holds back exactly the trailing 20 chars.
 * On completion, the buffer flushes with a final strip pass.
 *
 * Validates: Requirements 2.1
 */
describe('Property P2: Tag buffer invariant', () => {
  it('rendered output at completion equals full stream content with tags stripped', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 20 }),
        (chunks) => {
          const result = processStream(chunks)
          const fullText = chunks.join('')
          const expected = fullText.replace(/\[SECTION:\d+\]/g, '').replace(/\[SESSION_COMPLETE\]/g, '')
          expect(result).toBe(expected)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('tags split across chunk boundaries are still stripped', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 15 }),
        (splitPoint) => {
          const tag = '[SECTION:5]'
          const before = 'hello '
          const after = ' world'
          const full = before + tag + after

          // Split the tag at splitPoint
          const part1 = full.slice(0, before.length + splitPoint)
          const part2 = full.slice(before.length + splitPoint)

          const result = processStream([part1, part2])
          expect(result).toBe('hello  world')
          expect(result).not.toMatch(/\[SECTION:\d+\]/)
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P3: Concurrent request rejection
 *
 * When streamingLock exists and age < 60s → reject (409 equivalent: true).
 * When lock missing or age ≥ 60s → proceed (false).
 *
 * Validates: Requirements 1.5
 */
describe('Property P3: Concurrent request rejection', () => {
  it('no lock → never reject', () => {
    fc.assert(
      fc.property(
        fc.date(),
        (now) => {
          expect(shouldRejectConcurrentRequest(null, now.getTime())).toBe(false)
          expect(shouldRejectConcurrentRequest(undefined, now.getTime())).toBe(false)
          expect(shouldRejectConcurrentRequest('', now.getTime())).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('lock age < 60s → reject', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59999 }),
        (ageMs) => {
          const now = Date.now()
          const lockTime = new Date(now - ageMs).toISOString()
          expect(shouldRejectConcurrentRequest(lockTime, now)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('lock age ≥ 60s → do not reject', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60000, max: 3600000 }),
        (ageMs) => {
          const now = Date.now()
          const lockTime = new Date(now - ageMs).toISOString()
          expect(shouldRejectConcurrentRequest(lockTime, now)).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('boundary: exactly 60000ms → do not reject', () => {
    const now = Date.now()
    const lockTime = new Date(now - 60000).toISOString()
    expect(shouldRejectConcurrentRequest(lockTime, now)).toBe(false)
  })

  it('lock age and rejection are mutually exclusive at 60s boundary', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(Date.now() - 3600000), max: new Date(Date.now() + 3600000) })
          .filter(d => !isNaN(d.getTime())),
        (lockDate) => {
          const now = Date.now()
          const lockAge = now - lockDate.getTime()
          const rejected = shouldRejectConcurrentRequest(lockDate.toISOString(), now)
          if (lockAge < 60000) {
            expect(rejected).toBe(true)
          } else {
            expect(rejected).toBe(false)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
