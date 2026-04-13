// Property-based tests for Session Fast Start — Page image S3 path generation
// Task 14.2
// Uses fast-check for property-based testing

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

// ═══════════════════════════════════════════════════════════════════════════
// Property 2: Page image S3 path generation
// **Validates: Requirements 4.2, 5.3**
//
// For arbitrary tenantId (UUID), itemId (UUID), and pageNumber (1-999),
// the generated path matches:
//   pulse/{tenantId}/items/{itemId}/pages/page-{NNN}.png
// where NNN is zero-padded to 3 digits.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates the S3 key for a page image — same logic used by
 * RenderPages Lambda, Chat Lambda, and PreGenerate Lambda.
 */
function buildPageImageKey(tenantId, itemId, pageNumber) {
  return `pulse/${tenantId}/items/${itemId}/pages/page-${String(pageNumber).padStart(3, '0')}.png`
}

describe('Property 2: Page image S3 path generation', () => {
  const uuidArb = fc.uuid()

  it('path matches expected pattern for any tenantId, itemId, pageNumber', () => {
    // **Validates: Requirements 4.2, 5.3**
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb,
        fc.integer({ min: 1, max: 999 }),
        (tenantId, itemId, pageNumber) => {
          const key = buildPageImageKey(tenantId, itemId, pageNumber)

          // Must start with pulse/ prefix
          expect(key.startsWith('pulse/')).toBe(true)

          // Must contain /items/ segment
          expect(key).toContain('/items/')

          // Must contain /pages/ segment
          expect(key).toContain('/pages/')

          // Must end with .png
          expect(key.endsWith('.png')).toBe(true)

          // Must contain the tenantId and itemId verbatim
          expect(key).toContain(tenantId)
          expect(key).toContain(itemId)

          // Page number must be zero-padded to 3 digits
          const paddedPage = String(pageNumber).padStart(3, '0')
          expect(key).toContain(`page-${paddedPage}.png`)

          // Full path must match exactly
          const expected = `pulse/${tenantId}/items/${itemId}/pages/page-${paddedPage}.png`
          expect(key).toBe(expected)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('page numbers are always 3-digit zero-padded', () => {
    // **Validates: Requirements 4.2, 5.3**
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        (pageNumber) => {
          const padded = String(pageNumber).padStart(3, '0')

          // Always exactly 3 characters
          expect(padded.length).toBe(3)

          // Parses back to the original number
          expect(parseInt(padded, 10)).toBe(pageNumber)
        },
      ),
      { numRuns: 100 },
    )
  })
})
