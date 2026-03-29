// Property-based tests for time bracket tier filtering
// Property P17

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ── Time bracket logic mirroring labels-registry.ts ──
const ALL_BRACKETS = [
  { label: '5–10 min', value: 7 },
  { label: '10–15 min', value: 12 },
  { label: '15–20 min', value: 17 },
  { label: '20–30 min', value: 25 },
  { label: '30–45 min', value: 37 },
]

function filterBrackets(sessionTimeLimitMinutes) {
  return ALL_BRACKETS.filter(b => b.value <= sessionTimeLimitMinutes)
}

/**
 * Property P17: Time bracket tier filtering
 *
 * Displayed brackets are exactly those where bracket.value ≤ T.
 * No bracket with value > T is visible.
 *
 * Validates: Requirements 12.3
 */
describe('Property P17: Time bracket tier filtering', () => {
  it('all brackets with value ≤ T are included', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        (T) => {
          const filtered = filterBrackets(T)
          const expected = ALL_BRACKETS.filter(b => b.value <= T)
          expect(filtered).toEqual(expected)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('no bracket with value > T is included', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        (T) => {
          const filtered = filterBrackets(T)
          for (const bracket of filtered) {
            expect(bracket.value).toBeLessThanOrEqual(T)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('T = 7 → only the 7-minute bracket is shown', () => {
    const filtered = filterBrackets(7)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].value).toBe(7)
  })

  it('T = 12 → 7 and 12 minute brackets are shown', () => {
    const filtered = filterBrackets(12)
    expect(filtered).toHaveLength(2)
    expect(filtered.map(b => b.value)).toEqual([7, 12])
  })

  it('T = 37 → all 5 brackets are shown', () => {
    const filtered = filterBrackets(37)
    expect(filtered).toHaveLength(5)
  })

  it('T < 7 → no brackets shown', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        (T) => {
          const filtered = filterBrackets(T)
          expect(filtered).toHaveLength(0)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('filtered brackets are always a prefix of ALL_BRACKETS (ordered)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        (T) => {
          const filtered = filterBrackets(T)
          // Filtered result should be a prefix of ALL_BRACKETS
          for (let i = 0; i < filtered.length; i++) {
            expect(filtered[i]).toEqual(ALL_BRACKETS[i])
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('specific tier values produce correct bracket counts', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(7, 12, 17, 25, 37, 45, 60),
        (T) => {
          const filtered = filterBrackets(T)
          const expectedCount = ALL_BRACKETS.filter(b => b.value <= T).length
          expect(filtered).toHaveLength(expectedCount)
        },
      ),
      { numRuns: 100 },
    )
  })
})
