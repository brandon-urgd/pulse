// Property-based tests for PulseLine word-count-weighted progress
// Properties 5, 6 from the Pulse v1.1 Polish design

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

import { computeWeights } from '../../apps/session-ui/src/components/PulseLine.tsx'

/**
 * Property 5: PulseLine weights sum to 1.0
 *
 * For any section map where all sections have wordCount > 0, the sum of
 * all section weights computed by computeWeights() equals exactly 1.0
 * (within floating-point tolerance of ±0.0001), and each individual
 * weight is in the range [0.0, 1.0].
 *
 * **Validates: Requirements 4.1, 4.5**
 */
describe('Property 5: PulseLine weights sum to 1.0', () => {
  it('sum of weights equals 1.0 within ±0.0001 and each weight is in [0.0, 1.0]', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 2, maxLength: 20 }),
        (wordCounts) => {
          const sections = wordCounts.map((wc, i) => ({
            id: `s${i}`,
            wordCount: wc,
          }))

          const weights = computeWeights(sections)

          // Each weight is in [0.0, 1.0]
          for (const w of weights) {
            expect(w).toBeGreaterThanOrEqual(0.0)
            expect(w).toBeLessThanOrEqual(1.0)
          }

          // Sum of weights equals 1.0 within tolerance
          const sum = weights.reduce((a, b) => a + b, 0)
          expect(Math.abs(sum - 1.0)).toBeLessThanOrEqual(0.0001)
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 6: PulseLine fallback weights — no invalid values
 *
 * For any section map where any section lacks wordCount or has
 * wordCount = 0, computeWeights() produces weights where every value
 * equals 1/N, is finite, is non-negative, and is not NaN.
 *
 * **Validates: Requirements 4.2**
 */
describe('Property 6: PulseLine fallback weights — no invalid values', () => {
  it('all weights equal 1/N, are finite, non-negative, not NaN', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(fc.constant(0), fc.constant(undefined)),
          { minLength: 2, maxLength: 20 },
        ),
        (wordCounts) => {
          const sections = wordCounts.map((wc, i) => ({
            id: `s${i}`,
            wordCount: wc,
          }))

          const weights = computeWeights(sections)
          const N = sections.length
          const expected = 1 / N

          for (const w of weights) {
            expect(Number.isFinite(w)).toBe(true)
            expect(w).toBeGreaterThanOrEqual(0)
            expect(Number.isNaN(w)).toBe(false)
            expect(Math.abs(w - expected)).toBeLessThanOrEqual(0.0001)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
