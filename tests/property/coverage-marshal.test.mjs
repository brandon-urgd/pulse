// Property-based tests for CoverageMap marshal/unmarshal round-trip
// Feature: pulse-check-polish, Property 1: CoverageMap marshal/unmarshal round-trip

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ── Marshal/unmarshal logic copied from urgd-pulse-chat/index.mjs ──

function unmarshalMap(m) {
  if (!m?.M) return null
  const result = {}
  for (const [key, val] of Object.entries(m.M)) {
    if ('S' in val) result[key] = val.S
    else if ('N' in val) result[key] = Number(val.N)
    else if ('BOOL' in val) result[key] = val.BOOL
    else if ('M' in val) result[key] = unmarshalMap(val)
    else if ('L' in val) result[key] = val.L.map(v => {
      if ('S' in v) return v.S
      if ('N' in v) return Number(v.N)
      if ('M' in v) return unmarshalMap(v)
      return null
    })
    else if ('NULL' in val) result[key] = null
  }
  return result
}

function marshalCoverageMap(coverageMap) {
  const m = {}
  for (const [sectionId, data] of Object.entries(coverageMap)) {
    m[sectionId] = {
      M: {
        sessionCount: { N: String(data.sessionCount) },
        avgDepth: data.avgDepth ? { S: data.avgDepth } : { NULL: true },
        reviewerIds: { L: (data.reviewerIds || []).map(id => ({ S: id })) },
      },
    }
  }
  return { M: m }
}

// ── Generators ──

const sectionIdArb = fc.stringMatching(/^[a-z0-9]{1,8}$/)

const depthArb = fc.constantFrom('deep', 'explore', 'skim', null)

const reviewerIdArb = fc.stringMatching(/^[a-zA-Z0-9]{1,12}$/)

const coverageEntryArb = fc.record({
  sessionCount: fc.nat({ max: 100 }),
  avgDepth: depthArb,
  reviewerIds: fc.array(reviewerIdArb, { minLength: 0, maxLength: 5 }),
})

const coverageMapArb = fc.dictionary(sectionIdArb, coverageEntryArb, {
  minKeys: 0,
  maxKeys: 6,
})

/**
 * Property 1: CoverageMap marshal/unmarshal round-trip
 *
 * For any valid coverageMap object (mapping section IDs to
 * { sessionCount, avgDepth, reviewerIds } entries), marshalling with
 * marshalCoverageMap then unmarshalling with unmarshalMap SHALL produce
 * an object equivalent to the original.
 *
 * Validates: Requirements 1.2, 1.3
 */
describe('Feature: pulse-check-polish, Property 1: CoverageMap marshal/unmarshal round-trip', () => {
  it('marshal → unmarshal produces equivalent object for any valid coverageMap', () => {
    fc.assert(
      fc.property(coverageMapArb, (original) => {
        const marshalled = marshalCoverageMap(original)
        const unmarshalled = unmarshalMap(marshalled)

        // Empty coverageMap marshals to { M: {} }, unmarshalMap returns {}
        if (Object.keys(original).length === 0) {
          expect(unmarshalled).toEqual({})
          return
        }

        for (const [sectionId, data] of Object.entries(original)) {
          const section = unmarshalled[sectionId]
          expect(section).toBeDefined()

          // sessionCount round-trips through N (string) → Number
          expect(section.sessionCount).toBe(data.sessionCount)

          // avgDepth round-trips through S or NULL
          expect(section.avgDepth).toBe(data.avgDepth)

          // reviewerIds round-trips through L of S
          expect(section.reviewerIds).toEqual(data.reviewerIds)
        }

        // No extra keys
        expect(Object.keys(unmarshalled).sort()).toEqual(Object.keys(original).sort())
      }),
      { numRuns: 100 },
    )
  })

  it('empty coverageMap round-trips correctly', () => {
    const marshalled = marshalCoverageMap({})
    expect(marshalled).toEqual({ M: {} })
    const unmarshalled = unmarshalMap(marshalled)
    expect(unmarshalled).toEqual({})
  })

  it('single section round-trips correctly', () => {
    fc.assert(
      fc.property(
        sectionIdArb,
        coverageEntryArb,
        (id, entry) => {
          const original = { [id]: entry }
          const unmarshalled = unmarshalMap(marshalCoverageMap(original))

          expect(unmarshalled[id].sessionCount).toBe(entry.sessionCount)
          expect(unmarshalled[id].avgDepth).toBe(entry.avgDepth)
          expect(unmarshalled[id].reviewerIds).toEqual(entry.reviewerIds)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('avgDepth null round-trips as null', () => {
    fc.assert(
      fc.property(
        sectionIdArb,
        fc.nat({ max: 50 }),
        fc.array(reviewerIdArb, { minLength: 0, maxLength: 3 }),
        (id, count, ids) => {
          const original = { [id]: { sessionCount: count, avgDepth: null, reviewerIds: ids } }
          const unmarshalled = unmarshalMap(marshalCoverageMap(original))
          expect(unmarshalled[id].avgDepth).toBeNull()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('empty reviewerIds array round-trips as empty array', () => {
    fc.assert(
      fc.property(
        sectionIdArb,
        fc.nat({ max: 50 }),
        depthArb,
        (id, count, depth) => {
          const original = { [id]: { sessionCount: count, avgDepth: depth, reviewerIds: [] } }
          const unmarshalled = unmarshalMap(marshalCoverageMap(original))
          expect(unmarshalled[id].reviewerIds).toEqual([])
        },
      ),
      { numRuns: 100 },
    )
  })
})
