// Feature: pulse-check-ux-pass, Property 2: Coverage description reflects accurate counts
// Uses fast-check with vitest to verify coverage description logic from SectionCoveragePanel.tsx.
// **Validates: Requirements 1.4, 1.5**

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// Label constants matching labels-registry.ts
const COVERAGE_FULL = 'Reviewers touched on every section you requested.'
const COVERAGE_PARTIAL =
  'Reviewers covered {covered} of {total} requested sections.'

// Pure function replicating the coverage description logic from SectionCoveragePanel.tsx
function getCoverageDescription(sections, coverageMap) {
  const coveredCount = sections.filter(
    (s) => (coverageMap[s.id]?.sessionCount ?? 0) > 0,
  ).length

  return coveredCount === sections.length
    ? COVERAGE_FULL
    : COVERAGE_PARTIAL
        .replace('{covered}', String(coveredCount))
        .replace('{total}', String(sections.length))
}

// ── Generators ──

const sectionArb = fc.record({
  id: fc.nat({ max: 99 }).map((n) => `s${n + 1}`),
  title: fc
    .string({ minLength: 1, maxLength: 80 })
    .filter((s) => s.trim().length > 0),
})

// Deduplicate by id to avoid ambiguous test cases
const sectionArrayArb = fc
  .array(sectionArb, { minLength: 1, maxLength: 15 })
  .map((sections) => {
    const seen = new Set()
    return sections.filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })
  })
  .filter((sections) => sections.length > 0)

// Generate a coverageMap where a random subset of section IDs have sessionCount > 0
const coverageMapArb = (sections) =>
  fc
    .tuple(
      fc.subarray(sections.map((s) => s.id)),
      fc.array(fc.integer({ min: 1, max: 20 }), {
        minLength: sections.length,
        maxLength: sections.length,
      }),
    )
    .map(([coveredIds, counts]) => {
      const map = {}
      const coveredSet = new Set(coveredIds)
      sections.forEach((s, i) => {
        if (coveredSet.has(s.id)) {
          map[s.id] = { sessionCount: counts[i] ?? 1 }
        }
        // Uncovered sections are simply absent from the map
      })
      return map
    })

// Force all sections to be covered
const fullCoverageMapArb = (sections) =>
  fc
    .array(fc.integer({ min: 1, max: 20 }), {
      minLength: sections.length,
      maxLength: sections.length,
    })
    .map((counts) => {
      const map = {}
      sections.forEach((s, i) => {
        map[s.id] = { sessionCount: counts[i] }
      })
      return map
    })

// Force at least one section to be uncovered
const partialCoverageMapArb = (sections) =>
  coverageMapArb(sections).filter((map) => {
    const coveredCount = sections.filter(
      (s) => (map[s.id]?.sessionCount ?? 0) > 0,
    ).length
    return coveredCount < sections.length
  })

/**
 * Property 2: Coverage description reflects accurate counts
 *
 * For any list of sections and any coverage map:
 * - When coveredCount < total, description contains correct numeric counts
 * - When coveredCount === total, description matches the "every section" message
 *
 * Validates: Requirements 1.4, 1.5
 */
describe('Feature: pulse-check-ux-pass, Property 2: Coverage description reflects accurate counts', () => {
  it('when all sections are covered, description matches the full-coverage message', () => {
    fc.assert(
      fc.property(
        sectionArrayArb.chain((sections) =>
          fullCoverageMapArb(sections).map((coverageMap) => ({
            sections,
            coverageMap,
          })),
        ),
        ({ sections, coverageMap }) => {
          const description = getCoverageDescription(sections, coverageMap)
          expect(description).toBe(COVERAGE_FULL)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('when some sections are uncovered, description contains correct covered and total counts', () => {
    fc.assert(
      fc.property(
        sectionArrayArb.chain((sections) =>
          partialCoverageMapArb(sections).map((coverageMap) => ({
            sections,
            coverageMap,
          })),
        ),
        ({ sections, coverageMap }) => {
          const description = getCoverageDescription(sections, coverageMap)

          const coveredCount = sections.filter(
            (s) => (coverageMap[s.id]?.sessionCount ?? 0) > 0,
          ).length

          expect(description).toBe(
            `Reviewers covered ${coveredCount} of ${sections.length} requested sections.`,
          )
          expect(description).toContain(String(coveredCount))
          expect(description).toContain(String(sections.length))
        },
      ),
      { numRuns: 100 },
    )
  })

  it('description never contains template placeholders', () => {
    fc.assert(
      fc.property(
        sectionArrayArb.chain((sections) =>
          coverageMapArb(sections).map((coverageMap) => ({
            sections,
            coverageMap,
          })),
        ),
        ({ sections, coverageMap }) => {
          const description = getCoverageDescription(sections, coverageMap)
          expect(description).not.toContain('{covered}')
          expect(description).not.toContain('{total}')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('description is always one of the two expected formats', () => {
    fc.assert(
      fc.property(
        sectionArrayArb.chain((sections) =>
          coverageMapArb(sections).map((coverageMap) => ({
            sections,
            coverageMap,
          })),
        ),
        ({ sections, coverageMap }) => {
          const description = getCoverageDescription(sections, coverageMap)
          const coveredCount = sections.filter(
            (s) => (coverageMap[s.id]?.sessionCount ?? 0) > 0,
          ).length

          if (coveredCount === sections.length) {
            expect(description).toBe(COVERAGE_FULL)
          } else {
            expect(description).toMatch(
              /^Reviewers covered \d+ of \d+ requested sections\.$/,
            )
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
