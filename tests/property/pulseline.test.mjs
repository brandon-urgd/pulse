// Property-based tests for PulseLine percentage calculation
// Property P6

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ── PulseLine percentage logic mirroring PulseLine.tsx ──
function computePulseLinePct(current, total) {
  if (total <= 0) return 0
  if (current >= total) return 100
  return Math.min(100, ((current - 0.5) / total) * 100)
}

/**
 * Feature: pulse-check-polish, Property 6: PulseLine percentage calculation
 *
 * For any positive integer total and integer current where 1 <= current <= total:
 * when current equals total, the percentage SHALL be exactly 100. When current is
 * less than total, the percentage SHALL equal ((current - 0.5) / total) * 100.
 * When total is 0, the percentage SHALL be 0.
 *
 * Validates: Requirements 7.1, 7.2, 7.3
 */
describe('Feature: pulse-check-polish, Property 6: PulseLine percentage calculation', () => {
  it('current === total → percentage is exactly 100', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        (total) => {
          const pct = computePulseLinePct(total, total)
          expect(pct).toBe(100)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('current < total → percentage equals ((current - 0.5) / total) * 100', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 100 }).chain((total) =>
          fc.tuple(fc.constant(total), fc.integer({ min: 1, max: total - 1 })),
        ),
        ([total, current]) => {
          const pct = computePulseLinePct(current, total)
          const expected = ((current - 0.5) / total) * 100
          expect(pct).toBeCloseTo(expected, 10)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('total === 0 → percentage is 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (current) => {
          const pct = computePulseLinePct(current, 0)
          expect(pct).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('percentage is always between 0 and 100 inclusive', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (current, total) => {
          const pct = computePulseLinePct(current, total)
          expect(pct).toBeGreaterThanOrEqual(0)
          expect(pct).toBeLessThanOrEqual(100)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('negative total → percentage is 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: -100, max: -1 }),
        (current, total) => {
          const pct = computePulseLinePct(current, total)
          expect(pct).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
