// Property-based tests for coverage ratio computation
// Property P5

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ── Coverage ratio logic mirroring ItemDetail.tsx ──
function computeCoverageRatio(sections, coverageMap) {
  const total = sections.length
  if (total === 0) return 0
  const covered = sections.filter(
    s => (coverageMap[s.id]?.sessionCount ?? 0) > 0,
  ).length
  return covered / total
}

// ── Generators ──
const sectionIdArb = fc.stringMatching(/^[a-z0-9]{1,8}$/)

const sectionArb = fc.record({
  id: sectionIdArb,
  title: fc.string({ minLength: 1, maxLength: 30 }),
})

// Unique-ID sections array (no duplicate IDs)
const sectionsArb = fc
  .array(sectionArb, { minLength: 1, maxLength: 12 })
  .map(arr => {
    const seen = new Set()
    return arr.filter(s => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })
  })
  .filter(arr => arr.length > 0)

/**
 * Feature: pulse-check-polish, Property 5: Coverage ratio computation
 *
 * For any sectionMap (array of section objects) and coverageMap (mapping section IDs
 * to coverage entries), the computed coverage ratio SHALL equal the count of sections
 * with sessionCount > 0 divided by the total section count. When all sections are
 * covered, the ratio SHALL be 1. When no sections are covered, the ratio SHALL be 0.
 *
 * Validates: Requirements 2.1, 2.3, 2.4
 */
describe('Feature: pulse-check-polish, Property 5: Coverage ratio computation', () => {
  it('ratio equals count of sections with sessionCount > 0 divided by total', () => {
    fc.assert(
      fc.property(
        sectionsArb,
        (sections) => {
          // Build a random coverageMap: each section randomly covered or not
          const coverageMap = {}
          let expectedCovered = 0
          for (const s of sections) {
            const sessionCount = Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 5) + 1
            coverageMap[s.id] = { sessionCount }
            if (sessionCount > 0) expectedCovered++
          }

          const ratio = computeCoverageRatio(sections, coverageMap)
          const expected = expectedCovered / sections.length
          expect(ratio).toBeCloseTo(expected, 10)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('when all sections have sessionCount > 0, ratio is 1', () => {
    fc.assert(
      fc.property(
        sectionsArb,
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 12, maxLength: 20 }),
        (sections, counts) => {
          const coverageMap = {}
          for (let i = 0; i < sections.length; i++) {
            coverageMap[sections[i].id] = { sessionCount: counts[i % counts.length] }
          }

          const ratio = computeCoverageRatio(sections, coverageMap)
          expect(ratio).toBe(1)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('when no sections have sessionCount > 0, ratio is 0', () => {
    fc.assert(
      fc.property(
        sectionsArb,
        (sections) => {
          const coverageMap = {}
          for (const s of sections) {
            coverageMap[s.id] = { sessionCount: 0 }
          }

          const ratio = computeCoverageRatio(sections, coverageMap)
          expect(ratio).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('empty sections array → ratio is 0', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          sectionIdArb,
          fc.record({ sessionCount: fc.nat({ max: 10 }) }),
        ),
        (coverageMap) => {
          const ratio = computeCoverageRatio([], coverageMap)
          expect(ratio).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('ratio is always between 0 and 1 inclusive', () => {
    fc.assert(
      fc.property(
        sectionsArb,
        fc.dictionary(
          sectionIdArb,
          fc.record({ sessionCount: fc.nat({ max: 10 }) }),
        ),
        (sections, coverageMap) => {
          const ratio = computeCoverageRatio(sections, coverageMap)
          expect(ratio).toBeGreaterThanOrEqual(0)
          expect(ratio).toBeLessThanOrEqual(1)
        },
      ),
      { numRuns: 100 },
    )
  })
})
