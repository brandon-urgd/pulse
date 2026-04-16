// @vitest-environment node
// Unit tests for click-to-reveal removal from Pulse Check synthesis lists
// Verifies that InlineQuotePreview is NOT used in synthesis list renders.
// Requirements: 9.1, 9.2

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC_PATH = path.resolve(
  __dirname,
  '../../apps/admin-ui/src/pages/PulseCheck.tsx',
)
const source = fs.readFileSync(SRC_PATH, 'utf-8')

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the code block between a `.map(` call on `identifier` and its
 * matching closing paren. Returns the body of the map callback.
 */
function extractMapBlock(src: string, identifier: string): string | null {
  // Find `identifier.map(` pattern
  const pattern = new RegExp(`${identifier}\\.map\\(`, 'g')
  const match = pattern.exec(src)
  if (!match) return null

  const start = match.index + match[0].length
  let depth = 1
  let i = start
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') depth--
    i++
  }
  return src.slice(start, i - 1)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Click-to-reveal removal — PulseCheck.tsx source verification', () => {
  it('sharedConvictions.map does NOT contain InlineQuotePreview', () => {
    const block = extractMapBlock(source, 'sharedConvictions')
    expect(block).not.toBeNull()
    expect(block).not.toContain('InlineQuotePreview')
  })

  it('repeatedTensions.map does NOT contain InlineQuotePreview', () => {
    const block = extractMapBlock(source, 'repeatedTensions')
    expect(block).not.toBeNull()
    expect(block).not.toContain('InlineQuotePreview')
  })

  it('openQuestions.map does NOT contain InlineQuotePreview (multi-session)', () => {
    // There are two openQuestions.map blocks (single-session + multi-session).
    // Verify NONE of them use InlineQuotePreview.
    const pattern = /openQuestions\.map\(/g
    let match: RegExpExecArray | null
    const blocks: string[] = []
    while ((match = pattern.exec(source)) !== null) {
      const start = match.index + match[0].length
      let depth = 1
      let i = start
      while (i < source.length && depth > 0) {
        if (source[i] === '(') depth++
        else if (source[i] === ')') depth--
        i++
      }
      blocks.push(source.slice(start, i - 1))
    }
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).not.toContain('InlineQuotePreview')
    }
  })

  it('single-session themes t.reviewerSignals.map does NOT contain InlineQuotePreview', () => {
    // Find all t.reviewerSignals.map or reviewerSignals.map blocks
    const pattern = /\.reviewerSignals\.map\(/g
    let match: RegExpExecArray | null
    const blocks: string[] = []
    while ((match = pattern.exec(source)) !== null) {
      const start = match.index + match[0].length
      let depth = 1
      let i = start
      while (i < source.length && depth > 0) {
        if (source[i] === '(') depth++
        else if (source[i] === ')') depth--
        i++
      }
      blocks.push(source.slice(start, i - 1))
    }
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).not.toContain('InlineQuotePreview')
    }
  })

  it('InlineQuotePreview component was removed from the file (refactored out)', () => {
    // The component was removed during the click-to-reveal refactoring
    expect(source).not.toContain('InlineQuotePreview')
  })
})
