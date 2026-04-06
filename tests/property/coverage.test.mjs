// Property-based tests for section coverage tracking and aggregation
// Properties P8, P9

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ── Coverage tracking logic mirroring chat lambda ──
function updateSectionCoverage(sectionCoverage, sectionNum, feedbackSections, depthPreferences) {
  const sectionIdx = sectionNum - 1
  if (sectionIdx >= 0 && sectionIdx < feedbackSections.length) {
    const sectionId = feedbackSections[sectionIdx]
    if (sectionId && sectionCoverage[sectionId] !== undefined) {
      return {
        ...sectionCoverage,
        [sectionId]: {
          touched: true,
          depth: depthPreferences?.[sectionId] || 'explore',
        },
      }
    }
  }
  return sectionCoverage
}

// ── Coverage aggregation logic mirroring updateItemCoverageMap ──
function aggregateCoverage(sessions) {
  const coverageMap = {}
  for (const session of sessions) {
    for (const [sectionId, data] of Object.entries(session.sectionCoverage)) {
      if (!coverageMap[sectionId]) {
        coverageMap[sectionId] = { sessionCount: 0, reviewerIds: [] }
      }
      if (data.touched) {
        coverageMap[sectionId].sessionCount++
        if (session.reviewerId && !coverageMap[sectionId].reviewerIds.includes(session.reviewerId)) {
          coverageMap[sectionId].reviewerIds.push(session.reviewerId)
        }
      }
    }
  }
  return coverageMap
}

// ── Generators ──
const sectionIdArb = fc.nat({ max: 9 }).map(n => `s${n + 1}`)

const feedbackSectionsArb = fc.array(sectionIdArb, { minLength: 1, maxLength: 8 })

function makeSectionCoverage(feedbackSections) {
  const coverage = {}
  for (const id of feedbackSections) {
    coverage[id] = { touched: false, depth: null }
  }
  return coverage
}

/**
 * Property P8: Section coverage tracking
 *
 * When [SECTION:N] tags appear in agent responses, sectionCoverage marks
 * referenced sections as touched: true with appropriate depth.
 * Unreferenced sections remain touched: false.
 *
 * Validates: Requirements 5.1
 */
describe('Property P8: Section coverage tracking', () => {
  it('referenced section is marked touched: true', () => {
    fc.assert(
      fc.property(
        feedbackSectionsArb,
        fc.record({
          s1: fc.constantFrom('explore', 'skim', 'deep'),
          s2: fc.constantFrom('explore', 'skim', 'deep'),
        }),
        (feedbackSections, depthPrefs) => {
          const coverage = makeSectionCoverage(feedbackSections)

          // Reference section 1 (index 0)
          const updated = updateSectionCoverage(coverage, 1, feedbackSections, depthPrefs)

          const sectionId = feedbackSections[0]
          expect(updated[sectionId].touched).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('unreferenced sections remain touched: false', () => {
    fc.assert(
      fc.property(
        fc.array(sectionIdArb, { minLength: 2, maxLength: 8 }),
        (feedbackSections) => {
          const coverage = makeSectionCoverage(feedbackSections)
          const depthPrefs = {}
          for (const id of feedbackSections) depthPrefs[id] = 'explore'

          // Only reference section 1
          const updated = updateSectionCoverage(coverage, 1, feedbackSections, depthPrefs)

          // All sections except the first should remain untouched
          for (let i = 1; i < feedbackSections.length; i++) {
            const sId = feedbackSections[i]
            // Only check if it's a different id from feedbackSections[0]
            if (sId !== feedbackSections[0]) {
              expect(updated[sId].touched).toBe(false)
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('depth is set from depthPreferences when section is touched', () => {
    fc.assert(
      fc.property(
        fc.array(sectionIdArb, { minLength: 1, maxLength: 5 }),
        fc.constantFrom('explore', 'skim', 'deep'),
        (feedbackSections, depth) => {
          const coverage = makeSectionCoverage(feedbackSections)
          const depthPrefs = {}
          for (const id of feedbackSections) depthPrefs[id] = depth

          const updated = updateSectionCoverage(coverage, 1, feedbackSections, depthPrefs)
          const sectionId = feedbackSections[0]
          expect(updated[sectionId].depth).toBe(depth)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('out-of-range section number → coverage unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(sectionIdArb, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 100, max: 999 }),
        (feedbackSections, outOfRangeNum) => {
          const coverage = makeSectionCoverage(feedbackSections)
          const updated = updateSectionCoverage(coverage, outOfRangeNum, feedbackSections, {})

          // Coverage should be unchanged
          for (const id of feedbackSections) {
            expect(updated[id].touched).toBe(false)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('section 0 or negative → coverage unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(sectionIdArb, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: -100, max: 0 }),
        (feedbackSections, invalidNum) => {
          const coverage = makeSectionCoverage(feedbackSections)
          const updated = updateSectionCoverage(coverage, invalidNum, feedbackSections, {})

          for (const id of feedbackSections) {
            expect(updated[id].touched).toBe(false)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P9: Coverage map aggregation
 *
 * coverageMap.sessionCount equals number of sessions touching each section.
 * reviewerIds contains exactly the reviewer IDs from touching sessions (no duplicates).
 * Untouched sections have sessionCount: 0.
 *
 * Validates: Requirements 5.2
 */
describe('Property P9: Coverage map aggregation', () => {
  const sessionArb = fc.record({
    reviewerId: fc.string({ minLength: 1, maxLength: 20 }),
    sectionCoverage: fc.dictionary(
      sectionIdArb,
      fc.record({
        touched: fc.boolean(),
        depth: fc.constantFrom('explore', 'skim', 'deep', null),
      }),
    ),
  })

  it('sessionCount equals number of sessions that touched each section', () => {
    fc.assert(
      fc.property(
        fc.array(sessionArb, { minLength: 1, maxLength: 10 }),
        (sessions) => {
          const coverageMap = aggregateCoverage(sessions)

          for (const [sectionId, data] of Object.entries(coverageMap)) {
            const touchingCount = sessions.filter(s =>
              s.sectionCoverage[sectionId]?.touched === true
            ).length
            expect(data.sessionCount).toBe(touchingCount)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('reviewerIds contains no duplicates', () => {
    fc.assert(
      fc.property(
        fc.array(sessionArb, { minLength: 1, maxLength: 10 }),
        (sessions) => {
          const coverageMap = aggregateCoverage(sessions)

          for (const [, data] of Object.entries(coverageMap)) {
            const ids = data.reviewerIds
            const unique = new Set(ids)
            expect(ids.length).toBe(unique.size)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('untouched sections have sessionCount: 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            reviewerId: fc.string({ minLength: 1, maxLength: 20 }),
            sectionCoverage: fc.dictionary(
              sectionIdArb,
              fc.constant({ touched: false, depth: null }),
            ),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (sessions) => {
          const coverageMap = aggregateCoverage(sessions)

          for (const [, data] of Object.entries(coverageMap)) {
            expect(data.sessionCount).toBe(0)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('reviewerIds contains exactly the reviewers from touching sessions', () => {
    fc.assert(
      fc.property(
        fc.array(sessionArb, { minLength: 1, maxLength: 8 }),
        (sessions) => {
          const coverageMap = aggregateCoverage(sessions)

          for (const [sectionId, data] of Object.entries(coverageMap)) {
            const touchingReviewers = new Set(
              sessions
                .filter(s => s.sectionCoverage[sectionId]?.touched === true && s.reviewerId)
                .map(s => s.reviewerId)
            )
            expect(new Set(data.reviewerIds)).toEqual(touchingReviewers)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('sessionCount is non-negative for all sections', () => {
    fc.assert(
      fc.property(
        fc.array(sessionArb, { minLength: 0, maxLength: 10 }),
        (sessions) => {
          const coverageMap = aggregateCoverage(sessions)
          for (const [, data] of Object.entries(coverageMap)) {
            expect(data.sessionCount).toBeGreaterThanOrEqual(0)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Feature: pulse-check-polish, Property 2: Coverage aggregation preserves session counts and reviewer uniqueness
 *
 * For any sequence of session coverage records (each mapping section IDs to { touched, depth }
 * with a reviewer ID), aggregating all sessions SHALL produce a coverageMap where each section's
 * sessionCount equals the number of sessions that touched it, and reviewerIds contains exactly
 * the distinct reviewer IDs from touching sessions with no duplicates.
 *
 * Validates: Requirements 1.4
 */
describe('Feature: pulse-check-polish, Property 2: Coverage aggregation preserves session counts and reviewer uniqueness', () => {
  // Reviewer ID generator
  const reviewerIdArb = fc.stringMatching(/^[a-zA-Z0-9]{1,12}$/)

  // Session generator with explicit touched/depth per section
  const sessionWithSectionsArb = fc.record({
    reviewerId: reviewerIdArb,
    sectionCoverage: fc.dictionary(
      sectionIdArb,
      fc.record({
        touched: fc.boolean(),
        depth: fc.constantFrom('explore', 'skim', 'deep', null),
      }),
    ),
  })

  it('same reviewer completing multiple sessions for the same item produces no duplicate reviewerIds per section', () => {
    fc.assert(
      fc.property(
        reviewerIdArb,
        fc.array(
          fc.dictionary(
            sectionIdArb,
            fc.record({
              touched: fc.constant(true),
              depth: fc.constantFrom('explore', 'skim', 'deep'),
            }),
            { minKeys: 1, maxKeys: 5 },
          ),
          { minLength: 2, maxLength: 6 },
        ),
        (reviewerId, coverages) => {
          // All sessions from the same reviewer
          const sessions = coverages.map(sc => ({ reviewerId, sectionCoverage: sc }))
          const coverageMap = aggregateCoverage(sessions)

          for (const [, data] of Object.entries(coverageMap)) {
            const unique = new Set(data.reviewerIds)
            // No duplicates — reviewer appears at most once
            expect(data.reviewerIds.length).toBe(unique.size)
            // The single reviewer should appear at most once
            expect(data.reviewerIds.filter(id => id === reviewerId).length).toBeLessThanOrEqual(1)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('sessionCount increments for each session that touches a section, even from the same reviewer', () => {
    fc.assert(
      fc.property(
        reviewerIdArb,
        fc.array(
          fc.dictionary(
            sectionIdArb,
            fc.record({
              touched: fc.constant(true),
              depth: fc.constantFrom('explore', 'skim', 'deep'),
            }),
            { minKeys: 1, maxKeys: 5 },
          ),
          { minLength: 1, maxLength: 8 },
        ),
        (reviewerId, coverages) => {
          const sessions = coverages.map(sc => ({ reviewerId, sectionCoverage: sc }))
          const coverageMap = aggregateCoverage(sessions)

          for (const [sectionId, data] of Object.entries(coverageMap)) {
            // Count how many sessions actually have this section with touched: true
            const expectedCount = sessions.filter(
              s => s.sectionCoverage[sectionId]?.touched === true,
            ).length
            expect(data.sessionCount).toBe(expectedCount)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('multiple distinct reviewers touching the same section produces all reviewer IDs', () => {
    fc.assert(
      fc.property(
        fc.array(reviewerIdArb, { minLength: 2, maxLength: 6 }),
        sectionIdArb,
        (reviewerIds, sharedSectionId) => {
          // Each reviewer touches the same section
          const sessions = reviewerIds.map(rid => ({
            reviewerId: rid,
            sectionCoverage: {
              [sharedSectionId]: { touched: true, depth: 'explore' },
            },
          }))
          const coverageMap = aggregateCoverage(sessions)

          const sectionData = coverageMap[sharedSectionId]
          expect(sectionData).toBeDefined()

          // All distinct reviewer IDs should be present
          const expectedReviewers = new Set(reviewerIds)
          expect(new Set(sectionData.reviewerIds)).toEqual(expectedReviewers)
          // No duplicates
          expect(sectionData.reviewerIds.length).toBe(expectedReviewers.size)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('empty sectionCoverage does not corrupt existing coverage data', () => {
    fc.assert(
      fc.property(
        fc.array(sessionWithSectionsArb, { minLength: 1, maxLength: 6 }),
        reviewerIdArb,
        (realSessions, emptyReviewerId) => {
          // Aggregate real sessions first
          const baselineMap = aggregateCoverage(realSessions)

          // Now aggregate real sessions + an empty-coverage session (the bug scenario)
          const emptySession = { reviewerId: emptyReviewerId, sectionCoverage: {} }
          const withEmptyMap = aggregateCoverage([...realSessions, emptySession])

          // The empty session should not change any existing coverage data
          for (const [sectionId, baseData] of Object.entries(baselineMap)) {
            expect(withEmptyMap[sectionId]).toBeDefined()
            expect(withEmptyMap[sectionId].sessionCount).toBe(baseData.sessionCount)
            expect(new Set(withEmptyMap[sectionId].reviewerIds)).toEqual(
              new Set(baseData.reviewerIds),
            )
          }

          // No new sections should appear from the empty session
          expect(Object.keys(withEmptyMap).length).toBe(Object.keys(baselineMap).length)
        },
      ),
      { numRuns: 100 },
    )
  })
})
