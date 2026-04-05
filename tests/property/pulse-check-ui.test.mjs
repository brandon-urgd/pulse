// Feature: pulse-s2-s4-billing, Property 5: Quote Truncation
// Feature: pulse-s2-s4-billing, Property 6: Revision Weight Formatting
// Uses fast-check with vitest to verify quote truncation and revision weight formatting.
// **Validates: Requirements 11.1, 12.1, 12.2**

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// Pure functions extracted from the UI components for testing
function truncateQuote(quote) {
  if (quote.length > 60) return quote.slice(0, 60) + '…'
  return quote
}

function formatRevisionWeight(count, total) {
  if (count === 1 && total === 1) return '1 reviewer flagged this'
  return `${count} of ${total} reviewers flagged this`
}

/**
 * Property 5: Quote Truncation
 *
 * For any string >60 chars, the preview is the first 60 chars + "…".
 * For any string ≤60 chars, the full string is returned without ellipsis.
 *
 * Validates: Requirements 11.1
 */
describe('Property P5: Quote truncation', () => {
  it('strings > 60 chars are truncated to 60 + ellipsis', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 61, maxLength: 500 }),
        (quote) => {
          const result = truncateQuote(quote)
          expect(result.length).toBe(61) // 60 chars + 1 ellipsis
          expect(result.endsWith('…')).toBe(true)
          expect(result.slice(0, 60)).toBe(quote.slice(0, 60))
        }
      ),
      { numRuns: 100 }
    )
  })

  it('strings <= 60 chars are returned unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 60 }),
        (quote) => {
          const result = truncateQuote(quote)
          expect(result).toBe(quote)
          expect(result.endsWith('…')).toBe(false)
        }
      ),
      { numRuns: 100 }
    )
  })
})

/**
 * Property 6: Revision Weight Formatting
 *
 * For total > 1, format is "{count} of {total} reviewers flagged this".
 * For count = 1 and total = 1, format is "1 reviewer flagged this".
 *
 * Validates: Requirements 12.1, 12.2
 */
describe('Property P6: Revision weight formatting', () => {
  it('single reviewer shows "1 reviewer flagged this"', () => {
    expect(formatRevisionWeight(1, 1)).toBe('1 reviewer flagged this')
  })

  it('multiple reviewers shows "{count} of {total} reviewers flagged this"', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 2, max: 100 }),
        (count, total) => {
          const adjustedCount = Math.min(count, total)
          const result = formatRevisionWeight(adjustedCount, total)
          expect(result).toBe(`${adjustedCount} of ${total} reviewers flagged this`)
        }
      ),
      { numRuns: 100 }
    )
  })
})
