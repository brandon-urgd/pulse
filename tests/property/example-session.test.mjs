// Property-based tests for example session handling (P9 + P10)
// Uses fast-check with vitest to verify example record exclusion and deletability.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ─── Pure functions under test ────────────────────────────────────────────────

/**
 * Count non-example records from a list of items/sessions.
 * Example records (isExample: true) are excluded from all usage counts.
 */
function countNonExample(records) {
  return records.filter((r) => !r.isExample).length
}

/**
 * Determine whether an example item can be deleted.
 * Rejected when tenant has 0 real items; allowed when ≥1.
 */
function canDeleteExample(realItemCount) {
  return realItemCount >= 1
}

// ─── Generators ───────────────────────────────────────────────────────────────

/** Generate a random record with an isExample flag */
const recordArb = fc.record({
  id: fc.uuid(),
  isExample: fc.boolean(),
})

/** Generate a random array of records (0 to 50 items) */
const recordsArb = fc.array(recordArb, { minLength: 0, maxLength: 50 })

/** Generate a non-negative integer for real item count (0 to 100) */
const realItemCountArb = fc.nat({ max: 100 })

// ─── Property Tests ───────────────────────────────────────────────────────────

/**
 * Property 9: Example Record Exclusion from Usage Counts
 *
 * For any tenant with a mix of example records (isExample: true) and real records,
 * usage count queries SHALL return counts that exclude all example records.
 * For any tenant with only example records, all usage counts SHALL be 0.
 *
 * **Validates: Requirements 6.5**
 */
describe('Property P9: Example exclusion from counts', () => {
  it('count equals number of non-example records for any mix of records', () => {
    fc.assert(
      fc.property(recordsArb, (records) => {
        const count = countNonExample(records)
        const expected = records.filter((r) => !r.isExample).length
        expect(count).toBe(expected)
      }),
      { numRuns: 100 },
    )
  })

  it('count is 0 when all records are examples', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ id: fc.uuid(), isExample: fc.constant(true) }),
          { minLength: 1, maxLength: 50 },
        ),
        (records) => {
          expect(countNonExample(records)).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('count equals total when no records are examples', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ id: fc.uuid(), isExample: fc.constant(false) }),
          { minLength: 0, maxLength: 50 },
        ),
        (records) => {
          expect(countNonExample(records)).toBe(records.length)
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 10: Example Deletability Gate
 *
 * For any tenant with isExample items and zero real items, attempting to delete
 * the example item SHALL be rejected. For any tenant with at least one real item,
 * the example item SHALL be deletable.
 *
 * **Validates: Requirements 6.6**
 */
describe('Property P10: Example deletability gate', () => {
  it('delete rejected when 0 real items, allowed when ≥1', () => {
    fc.assert(
      fc.property(realItemCountArb, (realCount) => {
        const result = canDeleteExample(realCount)
        if (realCount === 0) {
          expect(result).toBe(false)
        } else {
          expect(result).toBe(true)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('boundary: exactly 0 real items → rejected', () => {
    expect(canDeleteExample(0)).toBe(false)
  })

  it('boundary: exactly 1 real item → allowed', () => {
    expect(canDeleteExample(1)).toBe(true)
  })
})
