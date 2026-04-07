// Feature: pulse-check-ux-pass, Property 1: Section filtering produces correct subset
// Uses fast-check with vitest to verify section filtering logic from PulseCheck.tsx.
// **Validates: Requirements 1.1, 1.2**

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// Pure function replicating the filtering logic from PulseCheck.tsx
function filterSections(allSections, feedbackSections) {
  return feedbackSections && feedbackSections.length > 0
    ? allSections.filter((s) => feedbackSections.includes(s.id))
    : allSections
}

// ── Generators ──

const sectionArb = fc.record({
  id: fc.nat({ max: 99 }).map(n => `s${n + 1}`),
  title: fc.string({ minLength: 1, maxLength: 80 }).filter(s => s.trim().length > 0),
  classification: fc.constantFrom('substantive', 'lightweight'),
})

// Deduplicate by id to avoid ambiguous test cases
const sectionArrayArb = fc.array(sectionArb, { minLength: 1, maxLength: 15 }).map(sections => {
  const seen = new Set()
  return sections.filter(s => {
    if (seen.has(s.id)) return false
    seen.add(s.id)
    return true
  })
}).filter(sections => sections.length > 0)

// feedbackSections: a subset of valid section IDs, possibly with extra IDs not in allSections
const feedbackSectionsArb = (allSections) =>
  fc.tuple(
    fc.subarray(allSections.map(s => s.id)),
    fc.array(fc.nat({ max: 199 }).map(n => `s${n + 100}`), { minLength: 0, maxLength: 3 }),
  ).map(([subset, extras]) => [...subset, ...extras])

/**
 * Property 1: Section filtering produces correct subset
 *
 * For any array of sections and any feedbackSections array:
 * - When feedbackSections is non-empty, every returned section ID is in feedbackSections
 * - When feedbackSections is empty/undefined, all original sections are returned
 * - Result preserves original ordering
 *
 * Validates: Requirements 1.1, 1.2
 */
describe('Feature: pulse-check-ux-pass, Property 1: Section filtering produces correct subset', () => {
  it('when feedbackSections is non-empty, every returned section ID is in feedbackSections', () => {
    fc.assert(
      fc.property(
        sectionArrayArb.chain(sections =>
          feedbackSectionsArb(sections)
            .filter(fb => fb.length > 0)
            .map(fb => ({ sections, feedbackSections: fb }))
        ),
        ({ sections, feedbackSections }) => {
          const result = filterSections(sections, feedbackSections)
          for (const s of result) {
            expect(feedbackSections).toContain(s.id)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('when feedbackSections is empty, all original sections are returned', () => {
    fc.assert(
      fc.property(sectionArrayArb, (sections) => {
        const result = filterSections(sections, [])
        expect(result).toEqual(sections)
      }),
      { numRuns: 100 },
    )
  })

  it('when feedbackSections is undefined, all original sections are returned', () => {
    fc.assert(
      fc.property(sectionArrayArb, (sections) => {
        const result = filterSections(sections, undefined)
        expect(result).toEqual(sections)
      }),
      { numRuns: 100 },
    )
  })

  it('when feedbackSections is null, all original sections are returned', () => {
    fc.assert(
      fc.property(sectionArrayArb, (sections) => {
        const result = filterSections(sections, null)
        expect(result).toEqual(sections)
      }),
      { numRuns: 100 },
    )
  })

  it('result preserves original ordering', () => {
    fc.assert(
      fc.property(
        sectionArrayArb.chain(sections =>
          feedbackSectionsArb(sections).map(fb => ({ sections, feedbackSections: fb }))
        ),
        ({ sections, feedbackSections }) => {
          const result = filterSections(sections, feedbackSections)
          // Every consecutive pair in result must appear in the same order in allSections
          for (let i = 1; i < result.length; i++) {
            const prevIdx = sections.findIndex(s => s.id === result[i - 1].id)
            const currIdx = sections.findIndex(s => s.id === result[i].id)
            expect(prevIdx).toBeLessThan(currIdx)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('result is a subset of the original sections (no new elements)', () => {
    fc.assert(
      fc.property(
        sectionArrayArb.chain(sections =>
          feedbackSectionsArb(sections).map(fb => ({ sections, feedbackSections: fb }))
        ),
        ({ sections, feedbackSections }) => {
          const result = filterSections(sections, feedbackSections)
          const originalIds = new Set(sections.map(s => s.id))
          for (const s of result) {
            expect(originalIds.has(s.id)).toBe(true)
          }
          expect(result.length).toBeLessThanOrEqual(sections.length)
        },
      ),
      { numRuns: 100 },
    )
  })
})
